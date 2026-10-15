import http from 'node:http';
import fs from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { McpHelperCaller, McpServerSocketHandlers } from '../MCP/McpSocketServer';

// Codex recursively merges native HTTP entries with launch overrides. Keep
// their names and HTTP transport, but terminate authentication in Patterm.
// The port and signing key survive restarts so existing agents reconnect.
export class McpHttpProxyService {
  private readonly server: http.Server;
  private readonly secret: string;
  private port = 0;

  constructor(private readonly statePath: string, private readonly handlers: McpServerSocketHandlers) {
    let state: { port?: number; secret?: string } = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.port = Number.isInteger(state.port) && state.port! > 0 && state.port! < 65536 ? state.port! : 0;
    this.secret = /^[a-f0-9]{64}$/.test(state.secret ?? '') ? state.secret! : randomBytes(32).toString('hex');
    this.server = http.createServer((request, response) => { void this.forward(request, response); });
  }

  get url(): string { return `http://127.0.0.1:${this.port}`; }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        this.port = (this.server.address() as { port: number }).port;
        resolve();
      });
    });
    fs.writeFileSync(this.statePath, JSON.stringify({ port: this.port, secret: this.secret }), { mode: 0o600 });
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async headers(server: string, caller: McpHelperCaller): Promise<Record<string, string>> {
    if (!caller.identity || caller.opencodeBridge !== undefined) throw new Error('Proxy requires an agent identity');
    await this.handlers.endpoint(server, null, caller);
    const payload = Buffer.from(JSON.stringify({ server, identity: caller.identity })).toString('base64url');
    return { 'X-Patterm-Mcp-Authorization': `Bearer ${payload}.${this.sign(payload)}` };
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  private async forward(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const fail = (status: number, message: string) => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(status, { 'Content-Type': 'text/plain' });
      response.end(message);
    };
    // No browser access, DNS rebinding, caller-selected endpoints, or redirects.
    if (request.headers.host !== `127.0.0.1:${this.port}` || request.headers.origin) return fail(403, 'Forbidden');
    if (!['POST', 'GET', 'DELETE'].includes(request.method ?? '')) return fail(405, 'Method not allowed');
    const credential = request.headers['x-patterm-mcp-authorization'];
    const token = typeof credential === 'string' ? credential.match(/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/) : null;
    if (!token) return fail(401, 'Patterm proxy authentication required');
    const expected = Buffer.from(this.sign(token[1]!));
    const actual = Buffer.from(token[2]!);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail(401, 'Invalid proxy credentials');
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    try {
      const { server, identity } = JSON.parse(Buffer.from(token[1]!, 'base64url').toString()) as { server: string; identity: string };
      if (typeof server !== 'string' || typeof identity !== 'string' || request.url !== `/${encodeURIComponent(server)}`) return fail(403, 'Forbidden');
      const caller = { identity, opencodeBridge: undefined };
      let endpoint = await this.handlers.endpoint(server, null, caller);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) return fail(413, 'MCP request too large');
        chunks.push(Buffer.from(chunk));
      }
      const body = request.method === 'POST' ? Buffer.concat(chunks) : undefined;
      const send = () => {
        const headers = new Headers(endpoint.headers);
        for (const name of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
          const value = request.headers[name];
          if (typeof value === 'string' && !headers.has(name)) headers.set(name, value);
        }
        return fetch(endpoint.url, { method: request.method!, headers, ...(body ? { body } : {}), redirect: 'error', signal: abort.signal });
      };
      let upstream = await send();
      const authorization = new Headers(endpoint.headers).get('authorization');
      if (upstream.status === 401 && authorization) {
        const refreshed = await this.handlers.endpoint(server, authorization.replace(/^Bearer\s+/i, ''), caller);
        if (new Headers(refreshed.headers).get('authorization') !== authorization) {
          await upstream.body?.cancel();
          endpoint = refreshed;
          upstream = await send();
        }
      }
      // Upstream authentication belongs in Patterm settings, never Codex login.
      if (upstream.status === 401 || upstream.status === 403) {
        await upstream.body?.cancel();
        return fail(502, 'MCP authentication failed. Check this server in Patterm MCP settings.');
      }
      for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control']) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      response.writeHead(upstream.status);
      if (upstream.body) {
        const stream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
        stream.once('error', () => response.destroy());
        stream.pipe(response);
      } else response.end();
    } catch {
      fail(502, 'Patterm could not connect to this MCP server. Check Patterm MCP settings.');
    }
  }
}
