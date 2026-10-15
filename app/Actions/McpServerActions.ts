import { z } from 'zod';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpHttpServer, McpServer, McpServerRegistry } from '../Services/McpServerRegistry';
import type { McpOAuthService, McpSignInStatus } from '../Services/McpOAuthService';
import type { McpServerImportService } from '../Services/McpServerImportService';
import type { NativeOAuthCallbackService } from '../Services/NativeOAuthCallbackService';
import type { McpHelperCaller, McpServerSocketHandlers } from '../MCP/McpSocketServer';
import type { McpHelperAccess } from '../MCP/McpHelperAccess';

const TEST_TIMEOUT_MS = 20_000;

const idInput = z.object({ id: z.string().min(1).max(200) }).strict();
const signInInput = z.object({ id: z.string().min(1).max(200), via: z.enum(['auto', 'loopback']).default('auto') }).strict();
const urlInput = z.object({ url: z.string().trim().min(1).max(8192) }).strict();

export type McpServerView = McpServer & { sign_in: McpSignInStatus | null };

export interface McpServerList {
  servers: McpServerView[];
  // Where sign-in redirects land when no fallback is chosen.
  redirect: 'origin' | 'loopback';
}

export interface McpServerTestResult {
  ok: boolean;
  tools: string[];
  error: string | null;
}

// Settings → MCP servers: the registry, sign-in, import, and connection tests.
export class McpServerActions {
  constructor(
    private readonly registry: McpServerRegistry,
    private readonly oauth: McpOAuthService,
    private readonly importer: McpServerImportService,
    private readonly nativeCallbacks: NativeOAuthCallbackService,
    private readonly options: { redirectsToOrigin: boolean; env?: NodeJS.ProcessEnv; onChanged?: () => void } = { redirectsToOrigin: false }
  ) {}

  list(): McpServerList {
    return {
      servers: this.registry.list().map((server) => ({ ...server, sign_in: server.transport === 'http' && server.auth === 'oauth' ? this.oauth.status(server.id) : null })),
      redirect: this.options.redirectsToOrigin ? 'origin' : 'loopback'
    };
  }

  save(raw: unknown): McpServerView {
    const saved = this.registry.save(raw);
    // A changed endpoint drops its credentials; drop a sign-in in progress too.
    if (saved.transport !== 'http' || saved.auth !== 'oauth') this.oauth.cancelSignIn(saved.id);
    this.options.onChanged?.();
    return this.view(saved);
  }

  delete(raw: unknown): { deleted: boolean } {
    const { id } = idInput.parse(raw);
    this.oauth.cancelSignIn(id);
    const result = this.registry.delete(id);
    this.options.onChanged?.();
    return result;
  }

  import(): ReturnType<McpServerImportService['import']> {
    const result = this.importer.import();
    if (result.added.length > 0) this.options.onChanged?.();
    return result;
  }

  startSignIn(raw: unknown) {
    const input = signInInput.parse(raw);
    return this.oauth.startSignIn(input.id, input.via);
  }

  completeSignIn(raw: unknown) {
    return this.oauth.completeSignIn(urlInput.parse(raw).url);
  }

  cancelSignIn(raw: unknown): { cancelled: true } {
    this.oauth.cancelSignIn(idInput.parse(raw).id);
    this.options.onChanged?.();
    return { cancelled: true };
  }

  signOut(raw: unknown) {
    return this.oauth.signOut(idInput.parse(raw).id);
  }

  // A pasted address from a failed sign-in redirect: Patterm's own sign-in,
  // or one an agent CLI started. Anything else is left for normal pasting.
  async pasteCallback(raw: unknown): Promise<{ handled: false } | { handled: true; kind: 'patterm' | 'agent'; name?: string }> {
    const { url } = urlInput.parse(raw);
    if (this.oauth.matches(url)) {
      const { name } = await this.oauth.completeSignIn(url);
      return { handled: true, kind: 'patterm', name };
    }
    if (this.nativeCallbacks.matches(url)) {
      await this.nativeCallbacks.replay(url);
      return { handled: true, kind: 'agent' };
    }
    return { handled: false };
  }

  async test(raw: unknown): Promise<McpServerTestResult> {
    const server = this.registry.get(idInput.parse(raw).id);
    const client = new Client({ name: 'patterm-settings', version: '0.1.0' });
    let stderr = '';
    const transport = server.transport === 'http'
      ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: await this.oauth.headers(server.id) } })
      : new StdioClientTransport({ command: server.command, args: server.args, env: { ...stringEnv(this.options.env ?? process.env), ...server.env }, stderr: 'pipe' });
    if (transport instanceof StdioClientTransport) transport.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const tools = await Promise.race([
        (async () => {
          await client.connect(transport);
          const names: string[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.listTools(cursor ? { cursor } : {});
            names.push(...page.tools.map((tool) => tool.name));
            cursor = page.nextCursor;
          } while (cursor && names.length < 1000);
          return names;
        })(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The server did not answer within 20 seconds')), TEST_TIMEOUT_MS); })
      ]);
      return { ok: true, tools, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = stderr.trim().split('\n').slice(-3).join('\n');
      return { ok: false, tools: [], error: detail ? `${message}\n${detail}` : message };
    } finally {
      if (timer) clearTimeout(timer);
      await client.close().catch(() => undefined);
    }
  }

  socketHandlers(access: McpHelperAccess): McpServerSocketHandlers {
    // A helper gets only enabled servers assigned to its agent's harness.
    const allowed = (serverId: string, caller: McpHelperCaller): McpServer => {
      const server = this.registry.get(serverId);
      const harness = access.harness(caller);
      if (!server.enabled || (harness && !(server.harnesses as string[]).includes(harness))) throw new Error(`${server.name} is not enabled for this agent`);
      return server;
    };
    const remote = (serverId: string, caller: McpHelperCaller): McpHttpServer => {
      const server = allowed(serverId, caller);
      if (server.transport !== 'http') throw new Error(`${server.name} is not a remote server`);
      return server;
    };
    return {
      authorizeRemote: (serverId, caller) => { remote(serverId, caller); },
      headers: (serverId, rejected, caller) => {
        allowed(serverId, caller);
        return this.oauth.headers(serverId, rejected);
      },
      endpoint: async (serverId, rejected, caller) => {
        const server = remote(serverId, caller);
        return { url: server.url, headers: await this.oauth.headers(serverId, rejected) };
      },
      exec: (serverId, caller) => {
        const server = allowed(serverId, caller);
        if (server.transport !== 'stdio') throw new Error(`${server.name} is not a local server`);
        return { command: server.command, args: server.args, env: server.env };
      }
    };
  }

  private view(server: McpServer): McpServerView {
    return { ...server, sign_in: server.transport === 'http' && server.auth === 'oauth' ? this.oauth.status(server.id) : null };
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
