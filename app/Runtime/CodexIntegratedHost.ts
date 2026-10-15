import './HostEnvironment';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import WebSocket from 'ws';
import { resolveCommand } from '../Platform/Executable';
import { ipcPath, removeStaleIpc, restrictIpc } from '../Platform/Ipc';
import { killProcessTree } from '../Platform/ProcessTree';

interface HostConfig {
  executable: string;
  args: string[];
  cwd: string;
  // Null when app-server speaks JSON-RPC over stdio (`--listen stdio://`).
  appServerSocketPath: string | null;
  controlSocketPath: string;
  logPath: string;
}

type JsonRecord = Record<string, unknown>;

const config = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as HostConfig;
const appServerSocketPath = config.appServerSocketPath ?? null;
for (const socketPath of [appServerSocketPath, config.controlSocketPath]) {
  if (socketPath) removeStaleIpc(socketPath);
}
const log = fs.openSync(config.logPath, 'a', 0o600);
// npm installs Codex as a .cmd shim on Windows, which Node cannot spawn.
const command = resolveCommand(config.executable, config.args, process.env);
const appServer = spawn(command.command, command.args, {
  cwd: config.cwd,
  env: process.env,
  stdio: appServerSocketPath ? ['ignore', log, log] : ['pipe', 'pipe', log],
  windowsHide: true,
  windowsVerbatimArguments: command.verbatim
});
fs.closeSync(log);
// A missing or unexecutable binary must not crash the host with an unhandled
// 'error' event; log it so the launch failure is actionable.
appServer.on('error', (error) => {
  fs.appendFileSync(config.logPath, `codex app-server could not start: ${error.message}\n`);
  process.exit(1);
});
const clients = new Set<net.Socket>();
const pendingServerRequests = new Map<string, string>();
let sendAppServer: (line: string) => void = () => {};
let shuttingDown = false;

void start().catch((error) => {
  fs.appendFileSync(config.logPath, `${error instanceof Error ? error.stack : String(error)}\n`);
  void stopAppServer().finally(() => process.exit(1));
});

async function start(): Promise<void> {
  if (appServerSocketPath) await connectWebSocket(appServerSocketPath);
  else connectStdio();

  const server = net.createServer((socket) => {
    let admitted = false;
    const admit = (): void => {
      admitted = true;
      clients.add(socket);
      for (const line of pendingServerRequests.values()) socket.write(`${line}\n`);
    };
    // A named pipe's default ACL lets every local user open it for reading but
    // only its owner for writing, so on Windows a client receives app-server
    // traffic once it has written (Patterm's first line is `initialize`).
    if (process.platform !== 'win32') admit();
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      if (!admitted) admit();
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = parse(line);
        if ('id' in message && !message.method) pendingServerRequests.delete(String(message.id));
        sendAppServer(line);
      }
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
  server.listen(ipcPath(config.controlSocketPath), () => restrictIpc(config.controlSocketPath));
  process.on('SIGTERM', () => server.close(shutdown));
  // Windows never delivers SIGTERM; Ctrl+Break is its console stop request.
  if (process.platform === 'win32') process.on('SIGBREAK', () => server.close(shutdown));
}

// POSIX app-servers listen on a unix socket. On Windows Codex binds an AF_UNIX
// socket file, which Node cannot connect to (it treats paths as named pipes),
// so there the host owns app-server's stdio instead. Either way Patterm
// reconnects to the host's control socket after a restart.
async function connectWebSocket(socketPath: string): Promise<void> {
  await waitForSocket(socketPath);
  const appSocket = new WebSocket('ws://localhost/', {
    createConnection: () => net.createConnection(socketPath),
    perMessageDeflate: false
  });
  appSocket.on('message', (chunk: WebSocket.RawData) => receiveAppServer(chunk.toString()));
  appSocket.on('error', shutdown);
  appSocket.on('close', shutdown);
  await new Promise<void>((resolve, reject) => { appSocket.once('open', resolve); appSocket.once('error', reject); });
  sendAppServer = (line) => appSocket.send(line);
}

// The stdio transport carries one JSON-RPC message per line each way. Its
// stdin closing on a forced host exit also ends app-server.
function connectStdio(): void {
  const output = appServer.stdout!;
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffer += chunk;
    const newline = buffer.lastIndexOf('\n');
    if (newline < 0) return;
    receiveAppServer(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
  });
  output.on('close', shutdown);
  appServer.stdin!.on('error', shutdown);
  sendAppServer = (line) => { appServer.stdin!.write(`${line}\n`); };
}

function receiveAppServer(text: string): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const message = parse(line);
    if ('id' in message && typeof message.method === 'string') pendingServerRequests.set(String(message.id), line);
    else forgetResolvedRequests(message);
    for (const client of clients) client.write(`${line}\n`);
  }
}

// Requests stored for replay must end when app-server settles them, or a
// reconnecting client is shown an approval nobody waits for. App-server
// resolves a request itself when its turn starts or ends, and announces each
// resolution; both are honoured so neither alone can leave one behind.
function forgetResolvedRequests(message: JsonRecord): void {
  const params = message.params && typeof message.params === 'object' ? message.params as JsonRecord : {};
  if (message.method === 'serverRequest/resolved') {
    if (typeof params.requestId === 'string' || typeof params.requestId === 'number') pendingServerRequests.delete(String(params.requestId));
    return;
  }
  if ((message.method !== 'turn/started' && message.method !== 'turn/completed') || typeof params.threadId !== 'string') return;
  for (const [id, line] of pendingServerRequests) {
    const request = parse(line);
    const requestParams = request.params && typeof request.params === 'object' ? request.params as JsonRecord : {};
    if (requestParams.threadId === params.threadId) pendingServerRequests.delete(id);
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
  if (shuttingDown) return;
  shuttingDown = true;
  for (const client of clients) client.destroy();
  void stopAppServer().finally(() => {
    for (const filename of [appServerSocketPath, config.controlSocketPath, process.argv[2]!]) {
      if (!filename) continue;
      try { fs.unlinkSync(filename); } catch {}
    }
    process.exit(0);
  });
}

// Windows has no SIGTERM, and npm's codex launcher runs the native binary as
// its own child, so the whole tree ends there.
function stopAppServer(): Promise<void> {
  if (process.platform !== 'win32') {
    appServer.kill('SIGTERM');
    return Promise.resolve();
  }
  return appServer.pid && appServer.exitCode === null ? killProcessTree(appServer.pid) : Promise.resolve();
}
