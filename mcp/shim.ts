import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fromJsonSchema, McpServer, type JsonSchemaType, type RegisteredTool } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { StreamableHTTPClientTransport, type JSONRPCMessage } from '@modelcontextprotocol/client';
import type { McpToolDescriptor } from '../app/MCP/ToolRegistry';
import { withEnv } from '../app/Platform/Environment';
import { resolveCommand } from '../app/Platform/Executable';
import { ipcPath } from '../app/Platform/Ipc';
import { killProcessTree } from '../app/Platform/ProcessTree';

// The stdio server forwards direct tool calls to the application's registry.
// A catalogue request at startup keeps schemas and public names in one place.
// The catalogue is fetched again periodically, so a redeployed app's tools
// reach sessions that outlive it.
const CATALOGUE_REFRESH_MS = Number(process.env.PATTERM_MCP_CATALOGUE_REFRESH_MS) || 60_000;
// A client that honours tools/list_changed re-lists within this time.
const RELIST_GRACE_MS = Math.min(CATALOGUE_REFRESH_MS, 10_000);
function defaultSocketPath(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'patterm-desktop', 'mcp.sock');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'patterm-desktop', 'mcp.sock');
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(configHome, 'patterm-desktop', 'mcp.sock');
}

function resolveSocketPath(): string {
  return ipcPath(process.env.PATTERM_MCP_SOCKET ?? defaultSocketPath());
}

type ShimRequest =
  | { op: 'catalog' }
  | { op: 'open-url'; url: string }
  | { op: 'mcp-headers'; server: string; rejected?: string | null }
  | { op: 'mcp-endpoint'; server: string; rejected?: string | null }
  | { op: 'mcp-exec'; server: string }
  | { tool: string; args: unknown };

// OpenCode 2 sends `ai.opencode/sessionID`; earlier builds sent `sessionID`.
function openCodeSessionId(meta?: Record<string, unknown>): unknown {
  return meta?.['ai.opencode/sessionID'] ?? meta?.sessionID;
}

function registryRequest(request: ShimRequest, meta?: Record<string, unknown>): Promise<unknown> {
  const bridge = process.env.PATTERM_OPENCODE_BRIDGE;
  const sessionId = openCodeSessionId(meta);
  if (bridge && 'tool' in request && typeof sessionId !== 'string') return Promise.reject(new Error('OpenCode MCP call is missing session metadata'));
  return new Promise((resolve, reject) => {
    const client = net.createConnection(resolveSocketPath(), () => {
      // OpenCode's shared daemon runs one helper for all of its sessions, so
      // its helpers send the bridge token instead of an agent identity.
      client.write(`${JSON.stringify({ id: 1, version: 2, ...request, ...(bridge && 'tool' in request
        ? { opencodeBridge: bridge, opencodeSessionId: sessionId }
        : bridge && 'server' in request ? { opencodeBridge: bridge }
          : { identity: process.env.PATTERM_MCP_IDENTITY ?? null }) })}\n`);
    });
    client.setEncoding('utf8');
    let buffer = '';
    client.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      client.end();
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as { result?: unknown; error?: string };
        if (message.error) reject(new Error(message.error));
        else resolve(message.result);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    client.on('error', reject);
    // An interrupted mutating command must never be retried implicitly.
    client.once('close', () => reject(new Error('Patterm disconnected before responding. The command may have run and was not retried.')));
  });
}

type Signatures = Map<string, string>;

async function fetchCatalogue(): Promise<McpToolDescriptor[]> {
  const tools = await registryRequest({ op: 'catalog' }) as McpToolDescriptor[];
  if (!Array.isArray(tools)) throw new Error('Patterm returned an invalid MCP tool catalogue');
  return tools;
}

function describe(tool: McpToolDescriptor): string {
  return [tool.description, ...(tool.namespace.startsWith('cli.') ? tool.usageNotes ?? [] : [])].join(' ');
}

// Only what the client is shown counts as a change.
function signaturesOf(tools: McpToolDescriptor[]): Signatures {
  return new Map(tools.map((tool) => [tool.name, JSON.stringify([describe(tool), tool.inputSchema])]));
}

function sameSignatures(a: Signatures, b: Signatures): boolean {
  return a.size === b.size && [...a].every(([name, signature]) => b.get(name) === signature);
}

function toolConfig(tool: McpToolDescriptor) {
  return {
    description: describe(tool),
    inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType)
  };
}

// Clients that ignore tools/list_changed, such as Codex, keep the list they
// fetched first. Their next tool response after a change, including a failed
// one, carries a one-time note telling the agent, so it can ask for a restart.
function staleNotice(listed: Signatures, current: Signatures): string {
  const added = [...current.keys()].filter((name) => !listed.has(name));
  const changed = [...current.keys()].filter((name) => listed.has(name) && listed.get(name) !== current.get(name));
  const removed = [...listed.keys()].filter((name) => !current.has(name));
  const parts = [['new', added], ['changed', changed], ['removed', removed]] as const;
  const summary = parts.filter(([, names]) => names.length).map(([label, names]) => `${label}: ${names.join(', ')}`).join('; ');
  return `[Patterm] Patterm's MCP tools changed after this session listed them (${summary}). This session cannot see the changes. Tell the user that restarting this agent will load them.`;
}

async function main(): Promise<void> {
  let catalogue = await fetchCatalogue();
  let signatures = signaturesOf(catalogue);
  let changedAt = 0;
  let listed: Signatures | null = null;
  let noticed: Signatures | null = null;
  const servers: Array<{ server: McpServer; tools: Map<string, RegisteredTool> }> = [];

  const handler = (name: string) => async (args: Record<string, unknown>, context: { mcpReq: { _meta?: Record<string, unknown> } }) => {
    const result = await registryRequest({ tool: name, args }, context.mcpReq._meta);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  };
  const pendingNotice = (): string | null => {
    if (!listed || noticed === signatures || Date.now() - changedAt < RELIST_GRACE_MS || sameSignatures(listed, signatures)) return null;
    noticed = signatures;
    return staleNotice(listed, signatures);
  };
  const register = (entry: (typeof servers)[number], tool: McpToolDescriptor) => {
    entry.tools.set(tool.name, entry.server.registerTool(tool.name, toolConfig(tool), handler(tool.name)));
  };

  // Each registration change sends tools/list_changed to the client.
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const next = await fetchCatalogue();
      const nextSignatures = signaturesOf(next);
      if (sameSignatures(signatures, nextSignatures)) return;
      for (const entry of servers) {
        for (const [name, registered] of entry.tools) {
          if (!nextSignatures.has(name)) { registered.remove(); entry.tools.delete(name); }
        }
        for (const tool of next) {
          const registered = entry.tools.get(tool.name);
          if (!registered) register(entry, tool);
          else if (signatures.get(tool.name) !== nextSignatures.get(tool.name)) {
            const { description, inputSchema } = toolConfig(tool);
            registered.update({ description, paramsSchema: inputSchema });
          }
        }
      }
      catalogue = next;
      signatures = nextSignatures;
      changedAt = Date.now();
    } catch {
      // Patterm may be restarting; try again next time.
    } finally {
      refreshing = false;
    }
  };

  const wire = new StdioServerTransport();
  serveStdio(() => {
    const entry = { server: new McpServer({ name: 'patterm', version: '0.1.0' }), tools: new Map<string, RegisteredTool>() };
    for (const tool of catalogue) register(entry, tool);
    servers.push(entry);
    return entry.server;
  }, { transport: wire });
  // Record which catalogue the client last listed, and add the note to tool
  // responses here so it also reaches calls the SDK rejects, such as a call
  // to a removed tool or with arguments its new schema refuses.
  const toolCalls = new Set<string | number>();
  const deliver = wire.onmessage!;
  wire.onmessage = (message: JSONRPCMessage) => {
    if ('method' in message && message.method === 'tools/list') listed = signatures;
    if ('method' in message && message.method === 'tools/call' && 'id' in message) toolCalls.add(message.id);
    deliver(message);
  };
  const send = wire.send.bind(wire);
  wire.send = (message, ...rest) => {
    const notice = 'id' in message && message.id !== undefined && toolCalls.delete(message.id) ? pendingNotice() : null;
    if (notice && 'result' in message && Array.isArray(message.result.content)) {
      message = { ...message, result: { ...message.result, content: [...message.result.content, { type: 'text', text: notice }] } };
    } else if (notice && 'error' in message) {
      message = { ...message, error: { ...message.error, message: `${message.error.message}\n\n${notice}` } };
    }
    return send(message, ...rest);
  };
  setInterval(() => void refresh(), CATALOGUE_REFRESH_MS).unref();
}

// Installed as xdg-open and $BROWSER in agent terminals: `--open <url>` asks
// Patterm to open the URL on the client viewing that terminal.
async function openUrl(args: string[]): Promise<void> {
  if (args.length !== 1) throw new Error('usage: xdg-open <url>');
  await registryRequest({ op: 'open-url', url: args[0]! });
}

// Header helper for Claude Code (`headersHelper`) and Codex
// (`http_headers_helper`): prints one server's headers as a JSON object.
async function printHeaders(serverId: string): Promise<void> {
  const { headers } = await registryRequest({ op: 'mcp-headers', server: serverId }) as { headers: Record<string, string> };
  process.stdout.write(JSON.stringify(headers));
}

// Relays JSON-RPC between stdio and a remote server's Streamable HTTP endpoint
// for harnesses that only take fixed headers (OpenCode). Headers come
// from Patterm per request, so a refreshed token is used without a restart.
async function bridge(serverId: string): Promise<void> {
  let endpoint = await registryRequest({ op: 'mcp-endpoint', server: serverId }) as { url: string; headers: Record<string, string> };
  const current = async (rejected?: string | null): Promise<Record<string, string>> => {
    try {
      endpoint = await registryRequest({ op: 'mcp-endpoint', server: serverId, rejected: rejected ?? null }) as typeof endpoint;
    } catch {
      // Patterm may be restarting; keep using the last headers.
    }
    return endpoint.headers;
  };
  const withHeaders = (init: RequestInit | undefined, headers: Record<string, string>): RequestInit => {
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return { ...init, headers: merged };
  };
  const upstream = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    fetch: async (input, init) => {
      let headers = await current();
      let response = await fetch(input, withHeaders(init, headers));
      const token = headers.Authorization;
      if (response.status === 401 && token) {
        headers = await current(token.replace(/^Bearer\s+/i, ''));
        if (headers.Authorization && headers.Authorization !== token) response = await fetch(input, withHeaders(init, headers));
      }
      return response;
    }
  });
  const downstream = new StdioServerTransport();
  const initializeIds = new Set<string | number>();
  downstream.onmessage = (message: JSONRPCMessage) => {
    if ('method' in message && message.method === 'initialize' && 'id' in message) initializeIds.add(message.id);
    upstream.send(message).catch((error: unknown) => {
      // A failed request still needs an answer, or the harness waits forever.
      if ('method' in message && 'id' in message) {
        void downstream.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
      }
    });
  };
  upstream.onmessage = (message: JSONRPCMessage) => {
    if ('id' in message && initializeIds.delete(message.id!) && 'result' in message) {
      const version = (message.result as { protocolVersion?: unknown }).protocolVersion;
      // The transport sends the negotiated version on every later request.
      if (typeof version === 'string') (upstream as unknown as { setProtocolVersion?(value: string): void }).setProtocolVersion?.(version);
    }
    void downstream.send(message);
  };
  const close = () => { void upstream.close(); void downstream.close(); process.exit(0); };
  downstream.onclose = close;
  upstream.onerror = (error: Error) => process.stderr.write(`patterm-mcp bridge: ${error.message}\n`);
  await upstream.start();
  await downstream.start();
}

// How long a Windows exec server may run on after its stdin closes.
const EXEC_STDIN_GRACE_MS = 2_000;

// Runs a local server with environment held by Patterm, so secrets stay out
// of the harness's command line.
async function exec(serverId: string): Promise<void> {
  const target = await registryRequest({ op: 'mcp-exec', server: serverId }) as { command: string; args: string[]; env: Record<string, string> };
  const env = withEnv(process.env, target.env);
  // npx and uvx are batch files on Windows.
  const run = resolveCommand(target.command, target.args, env);
  const windows = process.platform === 'win32';
  const child = spawn(run.command, run.args, {
    stdio: windows ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    env,
    windowsHide: true,
    windowsVerbatimArguments: run.verbatim
  });
  if (windows) {
    // Windows has no signals to forward. Harnesses close stdin, then may end
    // this process alone, which would orphan the server and any cmd.exe or
    // node it started. Relay stdin to see it close, and end the tree if the
    // server outlives it.
    child.stdin!.on('error', () => {});
    process.stdin.pipe(child.stdin!);
    process.stdin.once('end', () => setTimeout(() => { if (child.pid) void killProcessTree(child.pid); }, EXEC_STDIN_GRACE_MS));
  } else {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
  }
  child.on('error', (error) => {
    process.stderr.write(`patterm-mcp: could not start ${target.command}: ${error.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

const MODES: Record<string, (args: string[]) => Promise<void>> = {
  '--open': openUrl,
  '--mcp-headers': ([serverId]) => printHeaders(required(serverId)),
  '--mcp-bridge': ([serverId]) => bridge(required(serverId)),
  '--mcp-exec': ([serverId]) => exec(required(serverId))
};

function required(serverId: string | undefined): string {
  if (!serverId) throw new Error('missing MCP server ID');
  return serverId;
}

if (require.main === module) {
  const mode = process.argv[2] ?? '';
  const run = MODES[mode];
  (run ? run(process.argv.slice(3)) : main()).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(mode === '--open' ? `xdg-open: ${message}\n` : `patterm-mcp ${run ? mode.slice(2) : 'shim'} failed: ${message}\n`);
    process.exit(1);
  });
}
