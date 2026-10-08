import http from 'node:http';

// Agent CLIs sign in to MCP servers with a redirect to a listener on
// 127.0.0.1. When the browser runs on another machine that redirect fails, so
// the user pastes the failed address into Patterm and it is replayed on this
// machine. Only callbacks for authorize URLs that went through Patterm's
// xdg-open shim are replayed, and only to the loopback port and path they named.

const TTL_MS = 10 * 60_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

interface ExpectedCallback {
  host: string;
  port: string;
  pathname: string;
  expiresAt: number;
}

export interface ReplayResult {
  status: number;
}

export class NativeOAuthCallbackService {
  private readonly expected = new Map<string, ExpectedCallback>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly send: (target: { port: number; path: string; host: string }) => Promise<ReplayResult> = replay
  ) {}

  // Called with every URL an agent asks Patterm to open.
  observe(rawUrl: string): void {
    const url = safeUrl(rawUrl);
    const redirect = safeUrl(url?.searchParams.get('redirect_uri') ?? '');
    const state = url?.searchParams.get('state');
    if (!url || !redirect || !state || url.searchParams.get('response_type') !== 'code') return;
    if (redirect.protocol !== 'http:' || !LOOPBACK_HOSTS.has(redirect.hostname) || !redirect.port) return;
    this.prune();
    this.expected.set(state, { host: redirect.hostname, port: redirect.port, pathname: redirect.pathname, expiresAt: this.now() + TTL_MS });
  }

  matches(rawUrl: string): boolean {
    return this.lookup(rawUrl) !== null;
  }

  async replay(rawUrl: string): Promise<ReplayResult> {
    const match = this.lookup(rawUrl);
    if (!match) throw new Error('That address does not belong to a sign-in started by an agent in Patterm');
    this.expected.delete(match.state);
    const result = await this.send({ port: Number(match.expected.port), path: `${match.url.pathname}${match.url.search}`, host: `${match.expected.host}:${match.expected.port}` });
    if (result.status >= 400) throw new Error(`The agent's sign-in listener answered with HTTP ${result.status}`);
    return result;
  }

  private lookup(rawUrl: string): { url: URL; state: string; expected: ExpectedCallback } | null {
    this.prune();
    const url = safeUrl(rawUrl.trim());
    const state = url?.searchParams.get('state') ?? '';
    const expected = this.expected.get(state);
    if (!url || !expected || url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return null;
    if (url.port !== expected.port || url.pathname !== expected.pathname) return null;
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) return null;
    return { url, state, expected };
  }

  private prune(): void {
    const now = this.now();
    for (const [state, entry] of this.expected) if (entry.expiresAt <= now) this.expected.delete(state);
  }
}

// Listeners bind 127.0.0.1 even when the redirect says localhost, and some
// check the Host header, so connect by address and keep the original host.
function replay(target: { port: number; path: string; host: string }): Promise<ReplayResult> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: target.port, path: target.path, method: 'GET', headers: { Host: target.host }, timeout: 15_000 }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode ?? 0 }));
    });
    request.on('timeout', () => request.destroy(new Error('The agent\'s sign-in listener did not answer')));
    request.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ECONNREFUSED' ? new Error('The agent is no longer waiting for this sign-in. Start it again.') : error);
    });
    request.end();
  });
}

function safeUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}
