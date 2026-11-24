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
const stopping = new Set<Promise<void>>();
const sockets = new Set<net.Socket>();
let draining = false;
let shuttingDown = false;
const pidMarkerPath = process.platform === 'win32' ? `${supervisorSocket}.pid` : null;

function trackStop(promise: Promise<void>): Promise<void> {
  const tracked = promise.then(() => undefined, () => undefined);
  stopping.add(tracked);
  void tracked.finally(() => {
    stopping.delete(tracked);
    maybeExitIfDrained();
  });
  return promise;
}

function maybeExitIfDrained(): void {
  if (!draining || shuttingDown || sessions.size > 0 || stopping.size > 0) return;
  setImmediate(() => {
    if (draining && !shuttingDown && sessions.size === 0 && stopping.size === 0) void shutdown();
  });
}

type HostFactory = (
  configPath: string,
  env: NodeJS.ProcessEnv,
  hooks: { onExit: () => void }
) => { socketPath: string; stop(): Promise<void> };

const HOST_FACTORIES: Record<string, HostFactory> = {
  codex: startCodexHostSession,
  claude: startClaudeHostSession,
  agy: startAcpHostSession
};

function startSession(input: StartParams): SessionHandle {
  const existing = sessions.get(input.key);
  if (existing) return existing;
  const factory = HOST_FACTORIES[input.harness];
  if (!factory) throw new Error(`Unsupported Integrated harness: ${input.harness}`);
  const env = input.env && typeof input.env === 'object' ? input.env : process.env;
  const onExit = () => {
    const current = sessions.get(input.key);
    if (current === entry) sessions.delete(input.key);
    maybeExitIfDrained();
  };
  const started = factory(input.configPath, env, { onExit });
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
    // A launcher targeting this exact generation hash means this runtime is
    // active again (e.g. after rolling back a build); cancel draining so we
    // reuse this live supervisor instead of colliding on its socket or unit.
    draining = false;
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
      respond(socket, id, { pid: process.pid, stopped: false, remaining: sessions.size });
      maybeExitIfDrained();
      return;
    }
    sessions.delete(session.key);
    await trackStop(session.stop());
    respond(socket, id, { pid: process.pid, stopped: true, remaining: sessions.size });
    if (request.exitIfEmpty === true && sessions.size === 0 && stopping.size === 0) {
      setImmediate(() => {
        if (sessions.size === 0 && stopping.size === 0) void shutdown();
      });
    } else {
      maybeExitIfDrained();
    }
    return;
  }
  if (op === 'stopHarness') {
    const harness = String(request.harness ?? '');
    const matches = [...sessions.values()].filter((session) => session.harness === harness);
    for (const session of matches) sessions.delete(session.key);
    await Promise.allSettled(matches.map((session) => trackStop(session.stop())));
    respond(socket, id, { stopped: matches.length, remaining: sessions.size });
    if ((request.exitIfEmpty === true || draining) && sessions.size === 0 && stopping.size === 0) {
      setImmediate(() => {
        if (sessions.size === 0 && stopping.size === 0) void shutdown();
      });
    }
    return;
  }
  if (op === 'drain') {
    draining = true;
    respond(socket, id, { pid: process.pid, draining: true, sessions: sessions.size });
    maybeExitIfDrained();
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
  if (pidMarkerPath) {
    try { fs.writeFileSync(pidMarkerPath, String(process.pid), { mode: 0o600 }); } catch {}
  }
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
    await Promise.allSettled([
      ...active.map((session) => trackStop(session.stop())),
      ...stopping
    ]);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeStaleIpc(supervisorSocket);
    if (pidMarkerPath) fs.rmSync(pidMarkerPath, { force: true });
    process.exit(0);
  })();
  return shutdownPromise;
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
if (process.platform === 'win32') process.on('SIGBREAK', () => { void shutdown(); });
