import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { ipcPath, removeStaleIpc, restrictIpc } from '../Platform/Ipc';
import type { McpToolRegistry } from './ToolRegistry';
import type { ChangeTopic } from '../Services/ChangeTopics';

interface SocketRequest {
  id?: unknown;
  version?: unknown;
  op?: unknown;
  tool?: unknown;
  args?: unknown;
  identity?: unknown;
  url?: unknown;
  opencodeBridge?: unknown;
  opencodeSessionId?: unknown;
  server?: unknown;
  rejected?: unknown;
  refs?: unknown;
}

// Who asked for a server: an agent's identity, or OpenCode's shared daemon,
// which runs one helper for all of its sessions.
export interface McpHelperCaller {
  identity: string | null;
  opencodeBridge: unknown;
}

// Answers the shim's MCP server modes: header helpers, the stdio bridge, and
// the exec bridge. Each answers only for a server the caller's harness uses.
export interface McpServerSocketHandlers {
  headers(serverId: string, rejected: string | null, caller: McpHelperCaller): Promise<Record<string, string>>;
  endpoint(serverId: string, rejected: string | null, caller: McpHelperCaller): Promise<{ url: string; headers: Record<string, string> }>;
  exec(serverId: string, caller: McpHelperCaller): { command: string; args: string[]; env: Record<string, string> };
  // Checks the caller may use a remote server, without contacting it.
  authorizeRemote(serverId: string, caller: McpHelperCaller): void;
  proxyHeaders?(serverId: string, caller: McpHelperCaller): Promise<Record<string, string>>;
}

// Answers `patterm-secret`: the values an agent's command may receive, by
// `name` or `name.field`, and proxy URLs, by `name` or `name@host`.
export interface SecretSocketHandlers {
  env(identity: string | null, refs: string[]): string[];
  urls(identity: string | null, refs: string[]): string[];
}

const MCP_SERVER_OPS = new Set(['mcp-headers', 'mcp-proxy-headers', 'mcp-endpoint', 'mcp-exec']);

// A line-delimited JSON RPC over a local socket. The Electron app hosts the MCP
// registry; a thin stdio shim (launched by a harness) connects here and forwards
// tool calls, so terminal tools keep working in the main process. Version 2
// requests use the public catalogue and direct names.
export class McpSocketServer {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly socketPath: string,
    private readonly registry: McpToolRegistry,
    private readonly notifyChanged?: (topics: readonly ChangeTopic[]) => void,
    private readonly resolveOpenCodeIdentity?: (token: unknown, sessionId: unknown) => string,
    // The shim's `--open` mode, used as xdg-open inside agent terminals.
    private readonly openUrl?: (input: { identity: unknown; url: unknown }) => unknown,
    private readonly mcpServers?: McpServerSocketHandlers,
    private readonly secrets?: SecretSocketHandlers
  ) {}

  get address(): string {
    return ipcPath(this.socketPath);
  }

  start(): Promise<void> {
    this.cleanupStaleSocket();
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });

    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.once('error', reject);
      server.listen(ipcPath(this.socketPath), () => {
        try {
          restrictIpc(this.socketPath);
        } catch (error) {
          server.close();
          reject(error);
          return;
        }
        server.removeListener('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  stop(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = null;
    this.cleanupStaleSocket();
  }

  private handleConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.setEncoding('utf8');
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.trim()) {
        void this.handleLine(line, socket);
      }
    });
    socket.on('error', () => {
      /* a dropped client connection is not fatal */
    });
  }

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let id: unknown = null;
    try {
      const request = JSON.parse(line) as SocketRequest;
      id = request.id ?? null;
      if (request.version !== 2) throw new Error('unsupported MCP shim version');
      if (request.op === 'catalog') {
        // OpenCode's shared helpers list tools without an agent identity.
        this.write(socket, { id, result: this.registry.publicTools({ identity: typeof request.identity === 'string' && request.identity ? request.identity : null }) });
        return;
      }
      if (request.op === 'open-url') {
        if (!this.openUrl) throw new Error('Opening links is unavailable');
        this.write(socket, { id, result: this.openUrl({ identity: request.identity, url: request.url }) });
        return;
      }
      if (request.op === 'secret-env' || request.op === 'secret-url') {
        if (!this.secrets) throw new Error('Secrets are unavailable');
        if (!Array.isArray(request.refs) || !request.refs.every((ref) => typeof ref === 'string')) throw new Error('request is missing secret names');
        const identity = typeof request.identity === 'string' && request.identity ? request.identity : null;
        const values = request.op === 'secret-env' ? this.secrets.env(identity, request.refs as string[]) : this.secrets.urls(identity, request.refs as string[]);
        this.write(socket, { id, result: { values } });
        return;
      }
      if (typeof request.op === 'string' && MCP_SERVER_OPS.has(request.op)) {
        if (!this.mcpServers) throw new Error('MCP servers are unavailable');
        if (typeof request.server !== 'string' || !request.server) throw new Error('request is missing a server ID');
        const rejected = typeof request.rejected === 'string' ? request.rejected : null;
        const caller = { identity: typeof request.identity === 'string' && request.identity ? request.identity : null, opencodeBridge: request.opencodeBridge };
        if (request.op === 'mcp-proxy-headers' && !this.mcpServers.proxyHeaders) throw new Error('MCP proxy is unavailable');
        const result = request.op === 'mcp-proxy-headers' ? { headers: await this.mcpServers.proxyHeaders?.(request.server, caller) ?? {} }
          : request.op === 'mcp-headers' ? { headers: await this.mcpServers.headers(request.server, rejected, caller) }
          : request.op === 'mcp-endpoint' ? await this.mcpServers.endpoint(request.server, rejected, caller)
            : this.mcpServers.exec(request.server, caller);
        this.write(socket, { id, result });
        return;
      }
      if (typeof request.tool !== 'string') {
        throw new Error('request is missing a "tool" name');
      }
      let identity = typeof request.identity === 'string' && request.identity ? request.identity : null;
      if (request.opencodeBridge !== undefined || request.opencodeSessionId !== undefined) {
        if (!this.resolveOpenCodeIdentity) throw new Error('OpenCode bridge is unavailable');
        identity = this.resolveOpenCodeIdentity(request.opencodeBridge, request.opencodeSessionId);
      }
      // Only Patterm's own UI acts as the owner. A socket caller is always an
      // agent, and the registry refuses an identity it doesn't know.
      if (!identity) throw new Error('MCP call has no Patterm agent identity. Start the agent from Patterm.');
      const result = await this.registry.callPublic(request.tool, request.args, { identity });
      const topics = this.registry.changedTopics(request.tool);
      if (topics.length) this.notifyChanged?.(topics);
      this.write(socket, { id, result });
    } catch (error) {
      this.write(socket, { id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private write(socket: net.Socket, payload: unknown): void {
    if (!socket.destroyed) {
      socket.write(`${JSON.stringify(payload)}\n`);
    }
  }

  private cleanupStaleSocket(): void {
    try {
      removeStaleIpc(this.socketPath);
    } catch {
      /* best effort */
    }
  }
}
