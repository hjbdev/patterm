import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DEFAULT_INJECTION, hostAllowed, normaliseHost, type SecretRecord } from './SecretService';

export interface SecretProxyCredentials {
  proxyCredential(id: string): { secret: SecretRecord; value: string };
}

// Request headers that belong to one hop, or that would let a caller steer
// the upstream connection.
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'origin', 'referer']);
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

// A reverse proxy that adds a secret's credential to requests bound for the
// hosts the user allowed. The value never enters the agent's processes, so
// it can't be printed or sent anywhere else. Each URL carries a signed secret
// ID and nonce: it works only while that secret is ready and its session runs.
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

  // A base URL that stands in for `https://<host>/`. Each one carries its own
  // nonce and reaches only the command it was made for, never a conversation,
  // where other agents could read it.
  url(secret: SecretRecord, host: string): string {
    const nonce = randomBytes(12).toString('base64url');
    return `http://127.0.0.1:${this.port}/${secret.id}.${nonce}.${this.sign(`${secret.id}.${nonce}`)}/${host}/`;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url').slice(0, 32);
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
    const match = /^\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\/([^/?#]+)(\/[^#]*)?$/.exec(request.url ?? '');
    if (!match) return fail(404, 'Use the URL secret_run gives your command');
    const [, id, nonce, signature, rawHost, rest] = match as unknown as [string, string, string, string, string, string | undefined];
    let host: string;
    try {
      host = normaliseHost(decodeURIComponent(rawHost));
    } catch {
      return fail(400, 'Invalid upstream host');
    }
    const expected = Buffer.from(this.sign(`${id}.${nonce}`));
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
