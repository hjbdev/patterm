import './HostEnvironment';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import WebSocket from 'ws';

interface HostConfig {
  executable: string;
  args: string[];
  cwd: string;
  appServerSocketPath: string;
  controlSocketPath: string;
  logPath: string;
}

type JsonRecord = Record<string, unknown>;

const config = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as HostConfig;
for (const socketPath of [config.appServerSocketPath, config.controlSocketPath]) {
  try { fs.unlinkSync(socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const log = fs.openSync(config.logPath, 'a', 0o600);
const appServer = spawn(config.executable, config.args, { cwd: config.cwd, env: process.env, stdio: ['ignore', log, log] });
fs.closeSync(log);
// A missing or unexecutable binary must not crash the host with an unhandled
// 'error' event; log it so the launch failure is actionable.
appServer.on('error', (error) => {
  fs.appendFileSync(config.logPath, `codex app-server could not start: ${error.message}\n`);
  process.exit(1);
});
const clients = new Set<net.Socket>();
const pendingServerRequests = new Map<string, string>();
let appSocket: WebSocket;

void start().catch((error) => {
  fs.appendFileSync(config.logPath, `${error instanceof Error ? error.stack : String(error)}\n`);
  appServer.kill('SIGTERM');
  process.exit(1);
});

async function start(): Promise<void> {
  await waitForSocket(config.appServerSocketPath);
  appSocket = new WebSocket('ws://localhost/', {
    createConnection: () => net.createConnection(config.appServerSocketPath),
    perMessageDeflate: false
  });
  appSocket.on('message', receiveAppServer);
  appSocket.on('error', shutdown);
  appSocket.on('close', shutdown);
  await new Promise<void>((resolve, reject) => { appSocket.once('open', resolve); appSocket.once('error', reject); });

  const server = net.createServer((socket) => {
    clients.add(socket);
    for (const line of pendingServerRequests.values()) socket.write(`${line}\n`);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = parse(line);
        if ('id' in message && !message.method) pendingServerRequests.delete(String(message.id));
        appSocket.send(line);
      }
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
  server.listen(config.controlSocketPath, () => fs.chmodSync(config.controlSocketPath, 0o600));
  process.on('SIGTERM', () => server.close(shutdown));
}

function receiveAppServer(chunk: WebSocket.RawData): void {
  for (const line of chunk.toString().split('\n')) {
    if (!line.trim()) continue;
    const message = parse(line);
    if ('id' in message && typeof message.method === 'string') pendingServerRequests.set(String(message.id), line);
    for (const client of clients) client.write(`${line}\n`);
  }
}

function parse(line: string): JsonRecord {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
  } catch { return {}; }
}

async function waitForSocket(socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(socketPath)) return;
    if (appServer.exitCode !== null) throw new Error('Codex app-server exited during startup');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Codex app-server did not create its socket');
}

function shutdown(): void {
  for (const client of clients) client.destroy();
  appServer.kill('SIGTERM');
  for (const filename of [config.appServerSocketPath, config.controlSocketPath, process.argv[2]!]) {
    try { fs.unlinkSync(filename); } catch {}
  }
  process.exit(0);
}
