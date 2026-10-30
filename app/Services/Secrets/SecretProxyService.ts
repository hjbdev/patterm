import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DEFAULT_INJECTION, hostAllowed, normaliseHost, type SecretRecord } from './SecretService';

export interface SecretProxyCredentials {
  proxyCredential(id: string): { secret: SecretRecord; value: string };
}

// A proxy URL's credential: the secret ID and its signature.
const PROXY_TOKEN = /secret_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{32}/g;

// Proxy URLs reach their agent through its messages and secret_list, and from
// there its transcript and terminal, which other agents can read. Agents'
// reads show them hidden, so only the owner, through secret_list, can use one.
export function hideProxyTokens(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('secret_') ? value.replace(PROXY_TOKEN, '[proxy URL hidden; its agent gets it from secret_list]') : value;
  if (Array.isArray(value)) return value.map(hideProxyTokens);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, hideProxyTokens(entry)]));
  }
  return value;
}

// Request headers that belong to one hop, or that would let a caller steer
// the upstream connection.
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'origin', 'referer']);
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

// A reverse proxy that adds a secret's credential to requests bound for the
// hosts the user allowed. The value never enters the agent's processes, so
// it can't be printed or sent anywhere else. Each URL carries a signed secret
// ID: it works only while that secret is ready and its session runs.
export class SecretProxyService {
  private readonly server: http.Server;
  private readonly key: Buffer;
  private port = 0;

  constructor(private readonly statePath: string, private readonly credentials: SecretProxyCredentials) {
    let state: { port?: number; key?: string } = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A stable port and key keep URLs an agent already has working across restarts.
    this.port = Number.isInteger(state.port) && state.port! > 0 && state.port! < 65536 ? state.port! : 0;
    this.key = /^[a-f0-9]{64}$/.test(state.key ?? '') ? Buffer.from(state.key!, 'hex') : randomBytes(32);
    this.server = http.createServer((request, response) => this.forward(request, response));
  }

  async start(): Promise<void> {
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    // Another program may have taken the saved port while Patterm was stopped.
    await listen(this.port).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EADDRINUSE' || !this.port) throw error;
      return listen(0);
    });
    this.port = (this.server.address() as { port: number }).port;
    fs.writeFileSync(this.statePath, JSON.stringify({ port: this.port, key: this.key.toString('hex') }), { mode: 0o600 });
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // The base URL that stands in for each allowed host. Wildcard hosts take
  // any matching name in the same position.
  urls(secret: SecretRecord): Record<string, string> {
    const token = `${secret.id}.${this.sign(secret.id)}`;
    return Object.fromEntries(secret.allowed_hosts.map((host) => [host, `http://127.0.0.1:${this.port}/${token}/${host.replace(/^\*\./, '<subdomain>.')}/`]));
  }

  private sign(id: string): string {
    return createHmac('sha256', this.key).update(id).digest('base64url').slice(0, 32);
  }

  private forward(request: http.IncomingMessage, response: http.ServerResponse): void {
    const fail = (status: number, message: string) => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(status, { 'Content-Type': 'text/plain' });
      response.end(`${message}\n`);
    };
    // No browser pages or DNS rebinding.
    if (request.headers.host !== `127.0.0.1:${this.port}` && request.headers.host !== `localhost:${this.port}`) return fail(403, 'Forbidden');
    if (request.headers.origin) return fail(403, 'Browser requests are not allowed');
    const match = /^\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\/([^/?#]+)(\/[^#]*)?$/.exec(request.url ?? '');
    if (!match) return fail(404, 'Use the proxy URL from secret_list');
    const [, id, signature, rawHost, rest] = match as unknown as [string, string, string, string, string | undefined];
    let host: string;
    try {
      host = normaliseHost(decodeURIComponent(rawHost));
    } catch {
      return fail(400, 'Invalid upstream host');
    }
    if (host.startsWith('*.')) return fail(400, 'Replace <subdomain> with the host you want');
    const expected = Buffer.from(this.sign(id));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail(401, 'Invalid proxy URL');
    let credential: { secret: SecretRecord; value: string };
    try {
      credential = this.credentials.proxyCredential(id);
    } catch (error) {
      return fail(403, error instanceof Error ? error.message : 'Forbidden');
    }
    if (!hostAllowed(credential.secret.allowed_hosts, host)) return fail(403, `The user allowed this secret only for ${credential.secret.allowed_hosts.join(', ')}`);
    // Local development servers speak plain HTTP; everything else needs TLS.
    const secure = !LOOPBACK.test(host);
    let target: URL;
    try {
      target = new URL(`${secure ? 'https' : 'http'}://${host}${rest ?? '/'}`);
    } catch {
      return fail(400, 'Invalid upstream URL');
    }
    const injection = credential.secret.injection ?? DEFAULT_INJECTION;
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HOP_HEADERS.has(name) && value !== undefined) headers[name] = value;
    }
    headers.host = target.host;
    if (injection.in === 'header') {
      delete headers[injection.name.toLowerCase()];
      headers[injection.name] = `${injection.prefix}${credential.value}`;
    } else {
      target.searchParams.set(injection.name, `${injection.prefix}${credential.value}`);
    }
    let upstream: http.ClientRequest;
    try {
      upstream = (secure ? https : http).request(target, { method: request.method, headers }, (reply) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(reply.headers)) {
          if (!HOP_HEADERS.has(name) && value !== undefined) out[name] = value;
        }
        response.writeHead(reply.statusCode ?? 502, reply.statusMessage, out);
        reply.pipe(response);
        reply.once('error', () => response.destroy());
      });
    } catch {
      // An invalid header throws here, outside the request's error event.
      return fail(502, 'Patterm could not build the upstream request; check the secret\'s header settings');
    }
    upstream.once('error', (error) => fail(502, `Patterm could not reach ${host}: ${error.message}`));
    response.once('close', () => upstream.destroy());
    request.pipe(upstream);
  }
}
