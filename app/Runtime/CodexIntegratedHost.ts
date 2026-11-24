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

export interface CodexHostSession {
  socketPath: string;
  stop(): Promise<void>;
}

export interface CodexHostSessionOptions {
  onExit?: (code: number) => void;
}

export function startCodexHostSession(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: CodexHostSessionOptions = {}
): CodexHostSession {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as HostConfig;
  const appServerSocketPath = config.appServerSocketPath ?? null;
  for (const socketPath of [appServerSocketPath, config.controlSocketPath]) {
    if (socketPath) removeStaleIpc(socketPath);
  }
  const log = fs.openSync(config.logPath, 'a', 0o600);
  // npm installs Codex as a .cmd shim on Windows, which Node cannot spawn.
  const command = resolveCommand(config.executable, config.args, env);
  const appServer = spawn(command.command, command.args, {
    cwd: config.cwd,
    env,
    stdio: appServerSocketPath ? ['ignore', log, log] : ['pipe', 'pipe', log],
    windowsHide: true,
    windowsVerbatimArguments: command.verbatim
  });
  fs.closeSync(log);
  const clients = new Set<net.Socket>();
  const pendingServerRequests = new Map<string, string>();
  const latestTokenUsage = new Map<string, string>();
  const mcpStartupFailures = new Map<string, string>();
  let sendAppServer: (line: string) => void = () => {};
  let server: net.Server | null = null;
  let appSocket: WebSocket | null = null;
  let shutdownPromise: Promise<void> | null = null;

  // A missing or unexecutable binary must not crash the host with an unhandled
  // 'error' event; log it so the launch failure is actionable.
  appServer.on('error', (error) => {
    try { fs.appendFileSync(config.logPath, `codex app-server could not start: ${error.message}\n`); } catch {}
    void shutdown(1, false);
  });

  void start().catch((error) => {
    try { fs.appendFileSync(config.logPath, `${error instanceof Error ? error.stack : String(error)}\n`); } catch {}
    void shutdown(1, false);
  });

  async function start(): Promise<void> {
    if (appServerSocketPath) await connectWebSocket(appServerSocketPath);
    else connectStdio();
    if (shutdownPromise) return;

    const listening = net.createServer((socket) => {
      let admitted = false;
      const admit = (): void => {
        admitted = true;
        clients.add(socket);
        for (const line of pendingServerRequests.values()) socket.write(`${line}\n`);
        for (const line of latestTokenUsage.values()) socket.write(`${line}\n`);
        for (const line of mcpStartupFailures.values()) socket.write(`${line}\n`);
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
        if (buffer.length > 32 * 1024 * 1024) {
          clients.delete(socket);
          socket.destroy();
          return;
        }
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
    server = listening;
    listening.listen(ipcPath(config.controlSocketPath), () => restrictIpc(config.controlSocketPath));
  }

  // POSIX app-servers listen on a unix socket. On Windows Codex binds an AF_UNIX
  // socket file, which Node cannot connect to (it treats paths as named pipes),
  // so there the host owns app-server's stdio instead. Either way Patterm
  // reconnects to the host's control socket after a restart.
  async function connectWebSocket(socketPath: string): Promise<void> {
    await waitForSocket(socketPath);
    if (shutdownPromise) return;
    const ws = new WebSocket('ws://localhost/', {
      createConnection: () => net.createConnection(socketPath),
      perMessageDeflate: false
    });
    appSocket = ws;
    ws.on('message', (chunk: WebSocket.RawData) => receiveAppServer(chunk.toString()));
    ws.on('error', () => { void shutdown(0, true); });
    ws.on('close', () => { void shutdown(0, true); });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    sendAppServer = (line) => { if (ws.readyState === WebSocket.OPEN) ws.send(line); };
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
    output.on('close', () => { void shutdown(0, true); });
    appServer.stdin!.on('error', () => { void shutdown(0, true); });
    sendAppServer = (line) => { if (appServer.stdin?.writable) appServer.stdin.write(`${line}\n`); };
  }

  function receiveAppServer(text: string): void {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const message = parse(line);
      if ('id' in message && typeof message.method === 'string') pendingServerRequests.set(String(message.id), line);
      else {
        forgetResolvedRequests(message);
        rememberTelemetry(message, line);
      }
      for (const client of clients) {
        if (client.destroyed || client.writableLength > 1024 * 1024) {
          clients.delete(client);
          client.destroy();
        } else {
          client.write(`${line}\n`);
        }
      }
    }
  }

  function rememberTelemetry(message: JsonRecord, line: string): void {
    const params = message.params && typeof message.params === 'object' ? message.params as JsonRecord : {};
    if (message.method === 'thread/tokenUsage/updated' && typeof params.threadId === 'string') {
      latestTokenUsage.set(params.threadId, line);
    } else if (message.method === 'mcpServer/startupStatus/updated') {
      const name = typeof params.name === 'string' ? params.name : typeof params.server === 'string' ? params.server : '';
      if (!name) return;
      const key = `${typeof params.threadId === 'string' ? params.threadId : ''}\0${name}`;
      if (params.status === 'failed') mcpStartupFailures.set(key, line);
      else mcpStartupFailures.delete(key);
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

  async function waitForSocket(socketPath: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (shutdownPromise) return;
      if (fs.existsSync(socketPath)) return;
      if (appServer.exitCode !== null) throw new Error('Codex app-server exited during startup');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Codex app-server did not create its socket');
  }

  function shutdown(code = 0, removeLog = true): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      for (const client of clients) client.destroy();
      clients.clear();
      if (appSocket) {
        try { appSocket.terminate(); } catch {}
        appSocket = null;
      }
      if (server) {
        const active = server;
        server = null;
        await new Promise<void>((resolve) => active.close(() => resolve()));
      }
      await stopAppServer();
      const files = [appServerSocketPath, config.controlSocketPath, configPath, ...(removeLog ? [config.logPath] : [])];
      for (const filename of files) {
        if (!filename) continue;
        try { fs.unlinkSync(filename); } catch {}
      }
      options.onExit?.(code);
    })();
    return shutdownPromise;
  }

  // Windows has no SIGTERM, and npm's codex launcher runs the native binary as
  // its own child, so the whole tree ends there. On POSIX wait briefly for
  // SIGTERM exit so a rapid restart/wake cannot collide with the exiting daemon.
  function stopAppServer(): Promise<void> {
    if (appServer.exitCode !== null || appServer.signalCode !== null) return Promise.resolve();
    if (process.platform === 'win32') {
      return appServer.pid ? killProcessTree(appServer.pid) : Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        appServer.off('exit', finish);
        resolve();
      };
      const timer = setTimeout(() => {
        if (appServer.pid && appServer.exitCode === null && appServer.signalCode === null) {
          void killProcessTree(appServer.pid).catch(() => undefined).finally(finish);
        } else {
          finish();
        }
      }, 2_000);
      timer.unref?.();
      appServer.once('exit', finish);
      try { appServer.kill('SIGTERM'); } catch { finish(); }
    });
  }

  return {
    socketPath: config.controlSocketPath,
    stop: () => shutdown(0, true)
  };
}

function parse(line: string): JsonRecord {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
  } catch { return {}; }
}

if (require.main === module) {
  const session = startCodexHostSession(process.argv[2]!, process.env, { onExit: (code) => process.exit(code) });
  process.on('SIGTERM', () => { void session.stop(); });
  // Windows never delivers SIGTERM; Ctrl+Break is its console stop request.
  if (process.platform === 'win32') process.on('SIGBREAK', () => { void session.stop(); });
}
