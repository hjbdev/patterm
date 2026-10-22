import net from 'node:net';
import { WebSocket, type RawData } from 'ws';
import { SandboxExecTimeout, type SandboxBackend, type SandboxExecOptions, type SandboxExecResult, type SandboxServiceSpec, type SandboxTunnel } from './SandboxBackend';

const API_URL = 'https://api.sprites.dev';
// Non-TTY exec frames start with a stream byte.
const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;
const EXIT = 3;
const STDIN_EOF = 4;
const STDIN_CHUNK = 256 * 1024;
const MAX_OUTPUT = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

// Fly.io Sprites, driven with the user's own token. The token stays in
// request headers and is never put on a command line.
export class SpritesBackend implements SandboxBackend {
  readonly id = 'sprites';

  constructor(private readonly token: string, private readonly baseUrl = API_URL) {}

  async verify(): Promise<void> {
    await this.request('GET', '/v1/sprites?max_results=1');
  }

  async create(name: string): Promise<void> {
    await this.request('POST', '/v1/sprites', { name });
  }

  async destroy(name: string): Promise<void> {
    try {
      await this.request('DELETE', `/v1/sprites/${encodeURIComponent(name)}`);
    } catch (error) {
      if (!(error instanceof SpritesApiError && error.status === 404)) throw error;
    }
  }

  async status(name: string): Promise<string | null> {
    try {
      const sprite = await this.request('GET', `/v1/sprites/${encodeURIComponent(name)}`) as { status?: unknown };
      return typeof sprite.status === 'string' ? sprite.status : 'unknown';
    } catch (error) {
      if (error instanceof SpritesApiError && error.status === 404) return null;
      throw error;
    }
  }

  async ensureService(name: string, service: string, spec: SandboxServiceSpec): Promise<void> {
    const body = { cmd: spec.command, args: spec.args, needs: [], ...(spec.env ? { env: spec.env } : {}), ...(spec.dir ? { dir: spec.dir } : {}) };
    const text = await this.request('PUT', `/v1/sprites/${encodeURIComponent(name)}/services/${encodeURIComponent(service)}`, body, true) as string;
    // Progress arrives as NDJSON; a failed start is reported in the stream.
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event: { type?: unknown; error?: unknown; data?: unknown };
      try { event = JSON.parse(line) as typeof event; } catch { continue; }
      if (event.type === 'error') throw new Error(`Sprite service ${service} failed: ${String(event.error ?? event.data ?? 'unknown error')}`);
    }
  }

  // The Tasks API on the sprite's management socket. A task is a hold that
  // keeps the sprite active until it expires or is deleted.
  async hold(name: string, key: string, seconds: number): Promise<void> {
    const task = `http://sprite/v1/tasks/${encodeURIComponent(key)}`;
    const body = JSON.stringify({ name: key, expire: `${Math.max(1, Math.round(seconds))}s` });
    const script = [
      'set -e',
      `code=$(curl -s -o /dev/null -w '%{http_code}' --unix-socket /.sprite/api.sock -H 'Content-Type: application/json' -X PUT ${shellQuote(task)} -d ${shellQuote(body)})`,
      `if [ "$code" = 404 ]; then curl -sf -o /dev/null --unix-socket /.sprite/api.sock -H 'Content-Type: application/json' -X POST http://sprite/v1/tasks -d ${shellQuote(body)}; fi`
    ].join('\n');
    const result = await this.exec(name, ['sh', '-c', script], { timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error(`Could not hold the sprite awake: ${result.stderr.toString('utf8').trim() || `exit ${result.exitCode}`}`);
  }

  async release(name: string, key: string): Promise<void> {
    await this.exec(name, ['curl', '-s', '-o', '/dev/null', '--unix-socket', '/.sprite/api.sock', '-X', 'DELETE', `http://sprite/v1/tasks/${encodeURIComponent(key)}`], { timeoutMs: 30_000 });
  }

  exec(name: string, argv: string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    if (!argv.length) return Promise.reject(new Error('Sandbox command is empty'));
    const url = new URL(`${this.socketBase()}/v1/sprites/${encodeURIComponent(name)}/exec`);
    for (const arg of argv) url.searchParams.append('cmd', arg);
    url.searchParams.set('path', argv[0]!);
    url.searchParams.set('stdin', 'true');
    if (options.cwd) url.searchParams.set('dir', options.cwd);
    for (const [key, value] of Object.entries(options.env ?? {})) url.searchParams.append('env', `${key}=${value}`);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<SandboxExecResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let settled = false;
      let opened = false;
      const ws = new WebSocket(url, { headers: this.headers() });
      const finish = (error: Error | null, exitCode = -1) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (ws.readyState === WebSocket.OPEN) {
          if (error) ws.send(JSON.stringify({ type: 'signal', signal: 'SIGKILL' }));
          ws.close(1000);
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
        if (error) reject(error);
        else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
      };
      const abort = () => finish(new Error('Sandbox command was cancelled'));
      const timer = setTimeout(() => finish(new SandboxExecTimeout(timeoutMs)), timeoutMs);
      if (options.signal?.aborted) return abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      ws.on('open', () => {
        opened = true;
        const input = options.stdin === undefined ? null : Buffer.isBuffer(options.stdin) ? options.stdin : Buffer.from(options.stdin, 'utf8');
        for (let offset = 0; input && offset < input.length; offset += STDIN_CHUNK) {
          ws.send(Buffer.concat([Buffer.from([STDIN]), input.subarray(offset, offset + STDIN_CHUNK)]));
        }
        ws.send(Buffer.from([STDIN_EOF]));
      });
      ws.on('message', (raw: RawData, binary: boolean) => {
        if (!binary) return;
        const data = rawBuffer(raw);
        if (!data.length) return;
        const payload = data.subarray(1);
        if (data[0] === STDOUT || data[0] === STDERR) {
          size += payload.length;
          if (size > MAX_OUTPUT) return finish(new Error('Sandbox command output exceeded 32 MiB'));
          (data[0] === STDOUT ? stdout : stderr).push(Buffer.from(payload));
        } else if (data[0] === EXIT) {
          finish(null, payload.length ? payload[0]! : 0);
        }
      });
      ws.on('unexpected-response', (_request, response) => {
        finish(new Error(response.statusCode === 401 || response.statusCode === 403 ? 'Sprites rejected the token' : `Could not connect to the sandbox (HTTP ${response.statusCode})`));
      });
      ws.on('error', () => finish(new Error(opened ? 'Sandbox connection failed' : 'Could not connect to the sandbox')));
      ws.on('close', (code: number, reason: Buffer) => {
        finish(new Error(`Sandbox connection closed before the command finished${reason.length ? `: ${reason.toString('utf8')}` : ` (code ${code})`}`));
      });
    });
  }

  async tunnel(name: string, remotePort: number, localPort = 0): Promise<SandboxTunnel> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      this.forward(name, remotePort, socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(localPort, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const port = (server.address() as net.AddressInfo).port;
    return {
      port,
      close: () => new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
    };
  }

  private forward(name: string, remotePort: number, socket: net.Socket): void {
    const ws = new WebSocket(`${this.socketBase()}/v1/sprites/${encodeURIComponent(name)}/proxy`, { headers: this.headers() });
    let connected = false;
    const pending: Buffer[] = [];
    const close = () => { if (ws.readyState === WebSocket.OPEN) ws.close(1000); else if (ws.readyState === WebSocket.CONNECTING) ws.terminate(); };
    socket.on('data', (data: Buffer) => {
      if (connected && ws.readyState === WebSocket.OPEN) ws.send(data);
      else pending.push(data);
    });
    socket.on('close', close);
    socket.on('error', () => socket.destroy());
    ws.on('open', () => ws.send(JSON.stringify({ host: '127.0.0.1', port: remotePort })));
    ws.on('message', (raw: RawData, binary: boolean) => {
      if (!connected) {
        if (binary) return;
        let reply: { status?: unknown } = {};
        try { reply = JSON.parse(rawBuffer(raw).toString('utf8')) as typeof reply; } catch { /* treated as a refusal */ }
        if (reply.status !== 'connected') { socket.destroy(); close(); return; }
        connected = true;
        for (const data of pending.splice(0)) ws.send(data);
        return;
      }
      if (binary && !socket.destroyed) socket.write(rawBuffer(raw));
    });
    ws.on('close', () => { if (!socket.destroyed) socket.end(); });
    ws.on('error', () => socket.destroy());
    ws.on('unexpected-response', () => { socket.destroy(); ws.terminate(); });
  }

  private socketBase(): string {
    return this.baseUrl.replace(/^http/, 'ws');
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async request(method: string, route: string, body?: unknown, text = false): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: { ...this.headers(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000)
    });
    const content = await response.text();
    if (!response.ok) {
      let message = content.trim();
      try {
        const parsed = JSON.parse(content) as { error?: unknown; message?: unknown };
        message = String(parsed.error ?? parsed.message ?? message);
      } catch { /* plain text */ }
      if (response.status === 401 || response.status === 403) message = 'Sprites rejected the token';
      throw new SpritesApiError(response.status, message || `Sprites API returned ${response.status}`);
    }
    if (text) return content;
    return content ? JSON.parse(content) as unknown : null;
  }
}

export class SpritesApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'SpritesApiError';
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function rawBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}
