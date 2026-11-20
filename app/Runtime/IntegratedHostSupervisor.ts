import './HostEnvironment';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ipcPath, removeStaleIpc, restrictIpc } from '../Platform/Ipc';
import { startAcpHostSession } from './AcpIntegratedHost';
import { startClaudeHostSession } from './ClaudeIntegratedHost';
import { startCodexHostSession } from './CodexIntegratedHost';

interface SessionHandle {
  harness: string;
  key: string;
  socketPath: string;
  stop(): Promise<void>;
}

interface StartParams {
  harness: string;
  key: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
}

interface SupervisorRequest {
  id?: unknown;
  op?: unknown;
  harness?: unknown;
  key?: unknown;
  configPath?: unknown;
  env?: unknown;
  socketPath?: unknown;
  exitIfEmpty?: unknown;
}

const supervisorSocket = process.argv[2]!;
if (!supervisorSocket) throw new Error('IntegratedHostSupervisor requires a socket path');
fs.mkdirSync(path.dirname(supervisorSocket), { recursive: true, mode: 0o700 });
removeStaleIpc(supervisorSocket);

const sessions = new Map<string, SessionHandle>();
const sockets = new Set<net.Socket>();
let shuttingDown = false;

function startSession(input: StartParams): SessionHandle {
  const existing = sessions.get(input.key);
  if (existing) return existing;
  const env = input.env && typeof input.env === 'object' ? input.env : process.env;
  const onExit = () => {
    const current = sessions.get(input.key);
    if (current === entry) sessions.delete(input.key);
  };
  let started: { socketPath: string; stop(): Promise<void> };
  if (input.harness === 'codex') started = startCodexHostSession(input.configPath, env, { onExit });
  else if (input.harness === 'claude') started = startClaudeHostSession(input.configPath, env, { onExit });
  else if (input.harness === 'agy') started = startAcpHostSession(input.configPath, env, { onExit });
  else throw new Error(`Unsupported Integrated harness: ${input.harness}`);
  const entry: SessionHandle = {
    harness: input.harness,
    key: input.key,
    socketPath: started.socketPath,
    stop: started.stop
  };
  sessions.set(input.key, entry);
  return entry;
}

function findSession(key?: string, socketPath?: string): SessionHandle | undefined {
  if (key && sessions.has(key)) return sessions.get(key);
  if (socketPath) {
    for (const session of sessions.values()) {
      if (session.socketPath === socketPath) return session;
    }
  }
  return undefined;
}

function respond(socket: net.Socket, id: unknown, result?: unknown, error?: unknown): void {
  if (socket.destroyed) return;
  const payload = error
    ? { id, error: error instanceof Error ? error.message : String(error) }
    : { id, result };
  socket.write(`${JSON.stringify(payload)}\n`);
}

async function handle(socket: net.Socket, request: SupervisorRequest): Promise<void> {
  const id = request.id ?? null;
  const op = String(request.op ?? '');
  if (op === 'ping') {
    respond(socket, id, { pid: process.pid, sessions: sessions.size });
    return;
  }
  if (op === 'list') {
    respond(socket, id, {
      pid: process.pid,
      sessions: [...sessions.values()].map(({ harness, key, socketPath }) => ({ harness, key, socketPath }))
    });
    return;
  }
  if (op === 'start') {
    if (shuttingDown) throw new Error('Integrated host supervisor is shutting down');
    const harness = String(request.harness ?? '');
    const key = String(request.key ?? '');
    const configPath = String(request.configPath ?? '');
    const env = request.env && typeof request.env === 'object' ? request.env as NodeJS.ProcessEnv : process.env;
    if (!harness || !key || !configPath) throw new Error('Missing start parameters');
    const session = startSession({ harness, key, configPath, env });
    respond(socket, id, { pid: process.pid, socketPath: session.socketPath });
    return;
  }
  if (op === 'stop') {
    const key = typeof request.key === 'string' ? request.key : undefined;
    const socketPath = typeof request.socketPath === 'string' ? request.socketPath : undefined;
    const session = findSession(key, socketPath);
    if (!session) {
      respond(socket, id, { pid: process.pid, stopped: false });
      return;
    }
    sessions.delete(session.key);
    await session.stop();
    respond(socket, id, { pid: process.pid, stopped: true });
    return;
  }
  if (op === 'stopHarness') {
    const harness = String(request.harness ?? '');
    const matches = [...sessions.values()].filter((session) => session.harness === harness);
    for (const session of matches) sessions.delete(session.key);
    await Promise.allSettled(matches.map((session) => session.stop()));
    respond(socket, id, { stopped: matches.length, remaining: sessions.size });
    if (request.exitIfEmpty === true && sessions.size === 0) {
      setImmediate(() => {
        if (sessions.size === 0) void shutdown();
      });
    }
    return;
  }
  if (op === 'shutdown') {
    respond(socket, id, { ok: true });
    setImmediate(() => { void shutdown(); });
    return;
  }
  throw new Error(`Unknown supervisor op: ${op}`);
}

const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => { sockets.delete(socket); socket.destroy(); });
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 32 * 1024 * 1024) { socket.destroy(); return; }
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let request: SupervisorRequest;
      try { request = JSON.parse(line) as SupervisorRequest; }
      catch { respond(socket, null, undefined, new Error('Invalid supervisor request')); continue; }
      void handle(socket, request).catch((error) => respond(socket, request.id ?? null, undefined, error));
    }
  });
});

server.listen(ipcPath(supervisorSocket), () => {
  restrictIpc(supervisorSocket);
  // Start the initial session from the private boot file (never in argv).
  const bootFile = process.env.PATTERM_SUPERVISOR_BOOT_FILE;
  if (bootFile) {
    delete process.env.PATTERM_SUPERVISOR_BOOT_FILE;
    try {
      const boot = JSON.parse(fs.readFileSync(bootFile, 'utf8')) as StartParams;
      fs.rmSync(bootFile, { force: true });
      if (boot?.harness && boot?.key && boot?.configPath) startSession(boot);
    } catch {
      try { fs.rmSync(bootFile, { force: true }); } catch {}
    }
  }
});

let shutdownPromise: Promise<void> | null = null;
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    const active = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(active.map((session) => session.stop()));
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeStaleIpc(supervisorSocket);
    process.exit(0);
  })();
  return shutdownPromise;
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
if (process.platform === 'win32') process.on('SIGBREAK', () => { void shutdown(); });
