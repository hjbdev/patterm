import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { withEnv } from '../Platform/Environment';
import { ipcPath, removeStaleIpc } from '../Platform/Ipc';
import { killProcessTree } from '../Platform/ProcessTree';

export interface IntegratedHostSpawn {
  harness: string;
  key: string;
  nodePath: string;
  script: string;
  configPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface IntegratedHostLauncher {
  // Returns the host PID, which callers keep in the session argv.
  launch(input: IntegratedHostSpawn): Promise<number | null>;
  // Stops a single host session by its control socket without terminating a
  // shared supervisor that owns other live sessions.
  stop?(socketPath: string, pid: number | null): Promise<void>;
  // Stops every host this data directory started for the harness, including
  // hosts whose sessions were already reconciled as failed.
  stopAll(harness: string): Promise<void>;
}

const SUPERVISOR_SCRIPT = path.resolve(__dirname, '../Runtime/IntegratedHostSupervisor.js');
const SUPERVISOR_SOCKET_PATTERN = /^integrated-supervisor(?:-[0-9a-f]{12})?\.sock$/;
const SUPERVISOR_PID_PATTERN = /^(integrated-supervisor(?:-[0-9a-f]{12})?\.sock)\.pid$/;
const LOCAL_MODULE_IMPORT = /(?:require\(\s*|from\s+)(['"])(\.\.?\/[^'"]+)\1/g;

function resolveLocalModule(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

// Hashes the supervisor entrypoint and every local module it loads so a rebuilt
// Integrated host runtime launches a fresh supervisor generation without
// disturbing live sessions on older generations.
export function supervisorGeneration(supervisorScript = SUPERVISOR_SCRIPT): string {
  const entry = path.resolve(supervisorScript);
  const visited = new Map<string, Buffer>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    let content: Buffer;
    try {
      if (!fs.statSync(file).isFile()) continue;
      content = fs.readFileSync(file);
    } catch {
      continue;
    }
    visited.set(file, content);
    const source = content.toString('utf8');
    for (const match of source.matchAll(LOCAL_MODULE_IMPORT)) {
      const target = resolveLocalModule(file, match[2]!);
      if (target && !visited.has(target)) queue.push(target);
    }
  }
  const hash = createHash('sha256');
  if (!visited.size) {
    hash.update(entry);
    return hash.digest('hex').slice(0, 12);
  }
  const rootDir = path.dirname(entry);
  for (const file of [...visited.keys()].sort()) {
    hash.update(path.relative(rootDir, file));
    hash.update('\0');
    hash.update(visited.get(file)!);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

function discoverSupervisorSockets(runtimeDir: string, currentSocket: string): string[] {
  const found = new Set<string>([currentSocket]);
  try {
    for (const entry of fs.readdirSync(runtimeDir)) {
      if (SUPERVISOR_SOCKET_PATTERN.test(entry)) {
        found.add(path.join(runtimeDir, entry));
      } else {
        const pidMatch = SUPERVISOR_PID_PATTERN.exec(entry);
        if (pidMatch) found.add(path.join(runtimeDir, pidMatch[1]!));
      }
    }
  } catch {}
  // Include the legacy unversioned socket so sessions started before generation
  // versioning remain stoppable on Windows too, where named pipes have no .sock file.
  found.add(path.join(runtimeDir, 'integrated-supervisor.sock'));
  return [...found];
}

function cleanupDeadSupervisorFiles(socketPath: string): void {
  removeStaleIpc(socketPath);
  fs.rmSync(`${socketPath}.pid`, { force: true });
}

// Process-wide counter of launcher-initiated stops currently in flight per
// supervisor socket. Shared across launcher instances so a background legacy
// reaper never sends `shutdown` while another stop/stopAll is awaiting cleanup.
const activeSupervisorStops = new Map<string, number>();
// Serialises stop/stopHarness RPCs targeting a pre-versioning legacy supervisor
// (which deletes sessions from its map before awaiting native cleanup, so a
// concurrent `stopHarness(..., exitIfEmpty: true)` for another harness would
// otherwise shut it down mid-cleanup).
const legacyStopQueues = new Map<string, Promise<void>>();

function stopKey(socketPath: string): string {
  return path.resolve(socketPath);
}

function isLegacySupervisorSocket(socketPath: string): boolean {
  return path.basename(socketPath) === 'integrated-supervisor.sock';
}

function hasActiveStop(socketPath: string): boolean {
  return (activeSupervisorStops.get(stopKey(socketPath)) ?? 0) > 0;
}

function withActiveStop<T>(socketPath: string, fn: () => Promise<T>): Promise<T> {
  const key = stopKey(socketPath);
  activeSupervisorStops.set(key, (activeSupervisorStops.get(key) ?? 0) + 1);
  const run = isLegacySupervisorSocket(socketPath)
    ? (() => {
      const previous = legacyStopQueues.get(key) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(fn);
      const tail = current.then(() => undefined, () => undefined);
      legacyStopQueues.set(key, tail);
      void tail.finally(() => {
        if (legacyStopQueues.get(key) === tail) legacyStopQueues.delete(key);
      });
      return current;
    })()
    : fn();
  return run.finally(() => {
    const remaining = (activeSupervisorStops.get(key) ?? 1) - 1;
    if (remaining > 0) activeSupervisorStops.set(key, remaining);
    else activeSupervisorStops.delete(key);
  });
}

async function drainOlderSupervisor(socketPath: string): Promise<'done' | 'legacy-busy'> {
  if (hasActiveStop(socketPath)) return 'legacy-busy';
  if (!await integratedHostListening(socketPath, 200)) {
    if (!hasActiveStop(socketPath)) cleanupDeadSupervisorFiles(socketPath);
    return 'done';
  }
  try {
    await callSupervisor(socketPath, { op: 'drain' }, 2_000);
    return 'done';
  } catch {
    // Older supervisors predating `drain` still support `ping` and `shutdown`.
  }
  // Never probe or shut down a legacy supervisor while a launcher-initiated
  // stop or stopAll is in flight on it: pre-versioning supervisors remove
  // sessions from their map before awaiting native cleanup.
  if (hasActiveStop(socketPath)) return 'legacy-busy';
  try {
    const ping = await callSupervisor(socketPath, { op: 'ping' }, 2_000);
    if (hasActiveStop(socketPath)) return 'legacy-busy';
    const active = Number(ping.sessions);
    if (active === 0) {
      await callSupervisor(socketPath, { op: 'shutdown' }, 2_000);
      return 'done';
    }
    if (Number.isFinite(active) && active > 0) return 'legacy-busy';
  } catch {}
  return 'done';
}

function createOldSupervisorDrainer(runtimeDir: string, currentSocket: string): () => void {
  const configured = Number(process.env.PATTERM_LEGACY_SUPERVISOR_POLL_MS);
  const pollMs = Number.isFinite(configured) && configured > 0 ? configured : 5_000;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const candidates = discoverSupervisorSockets(runtimeDir, currentSocket).filter((socket) => socket !== currentSocket);
      const results = await Promise.allSettled(candidates.map((socket) => drainOlderSupervisor(socket)));
      const hasLegacyBusy = results.some((result) => result.status === 'fulfilled' && result.value === 'legacy-busy');
      if (hasLegacyBusy && !timer) {
        timer = setTimeout(() => {
          timer = null;
          void run();
        }, pollMs);
        timer.unref();
      }
    } finally {
      running = false;
    }
  };
  return () => { void run().catch(() => undefined); };
}

function isSupervisorGoneError(error: unknown): boolean {
  if (error instanceof IntegratedHostTransportError) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') return true;
  return error instanceof Error && error.message === 'Integrated host supervisor is shutting down';
}

async function waitForSupervisorExit(socketPath: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await integratedHostListening(socketPath, 200)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !await integratedHostListening(socketPath, 200);
}

async function waitForSystemdUnitInactive(unit: string, env: NodeJS.ProcessEnv, timeoutMs = 26_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = (await systemctl('systemctl', ['--user', 'show', '--property=ActiveState', '--value', unit], env)).trim();
      if (state !== 'active' && state !== 'deactivating' && state !== 'reloading' && state !== 'activating') return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function callSupervisor(socketPath: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(ipcPath(socketPath));
    let buffer = '';
    const timeout = setTimeout(() => { socket.destroy(); reject(new IntegratedHostTransportError(`Integrated host supervisor timed out: ${String(payload.op ?? '')}`)); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.once('error', (error) => { clearTimeout(timeout); socket.destroy(); reject(error); });
    socket.once('close', () => { clearTimeout(timeout); reject(new IntegratedHostTransportError(`Integrated host supervisor closed before replying: ${String(payload.op ?? '')}`)); });
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, ...payload })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as { id?: unknown; error?: unknown; result?: unknown };
        if (!response || response.id !== id) throw new IntegratedHostTransportError('Invalid supervisor response');
        if (response.error) reject(new Error(String(response.error)));
        else resolve((response.result && typeof response.result === 'object' ? response.result : {}) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof IntegratedHostTransportError ? error : new IntegratedHostTransportError('Invalid supervisor response', { cause: error }));
      }
    });
  });
}

async function waitForSupervisorSocket(socketPath: string, pid: number | null): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await integratedHostListening(socketPath, 250)) return true;
    if (pid) {
      try { process.kill(pid, 0); } catch { return false; }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

// Desktop mode: hosts are children of the application and end with it.
// On Windows only a detached child escapes the job object that ends Node's
// children with the application. It has no console, so the host starts each
// CLI hidden.
export const detachedHostLauncher: IntegratedHostLauncher = {
  async launch(input) {
    const child = spawn(input.nodePath, [input.script, input.configPath], {
      cwd: input.cwd,
      env: withEnv(input.env, { ELECTRON_RUN_AS_NODE: '1' }),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return child.pid ?? null;
  },
  async stopAll() {}
};

async function stopSupervisedSession(
  runtimeDir: string,
  currentSocket: string,
  knownSupervisorPids: Set<number>,
  socketPath: string,
  pid: number | null
): Promise<void> {
  const candidates = discoverSupervisorSockets(runtimeDir, currentSocket);
  let sawReachableWithoutPid = false;
  for (const candidate of candidates) {
    if (!await integratedHostListening(candidate, 300)) {
      if (candidate !== currentSocket && !hasActiveStop(candidate)) cleanupDeadSupervisorFiles(candidate);
      continue;
    }
    let reportedPid: number | null = null;
    let stopped = false;
    try {
      const result = await withActiveStop(candidate, () => callSupervisor(candidate, { op: 'stop', socketPath }));
      const candidatePid = Number(result.pid);
      if (Number.isInteger(candidatePid) && candidatePid > 0) {
        reportedPid = candidatePid;
        knownSupervisorPids.add(candidatePid);
      }
      stopped = Boolean(result.stopped);
    } catch {
      // Fall through to ping check before considering legacy fallback.
    }
    if (stopped) {
      if (candidate !== currentSocket) await drainOlderSupervisor(candidate);
      return;
    }
    if (reportedPid === null) {
      try {
        const ping = await callSupervisor(candidate, { op: 'ping' });
        const candidatePid = Number(ping.pid);
        if (Number.isInteger(candidatePid) && candidatePid > 0) {
          reportedPid = candidatePid;
          knownSupervisorPids.add(candidatePid);
        } else {
          sawReachableWithoutPid = true;
        }
      } catch {
        // Supervisor socket was reachable; never risk killing an unknown supervisor PID.
        sawReachableWithoutPid = true;
      }
    }
  }
  if (!pid || sawReachableWithoutPid || knownSupervisorPids.has(pid)) return;
  if (await integratedHostListening(socketPath, 300)) {
    await stopRecordedHostProcess(pid, socketPath);
  }
}

async function stopSupervisorHarness(supervisorSocket: string, harness: string): Promise<void> {
  if (!await integratedHostListening(supervisorSocket, 300)) return;
  try {
    await callSupervisor(supervisorSocket, { op: 'stopHarness', harness, exitIfEmpty: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ECONNREFUSED') return;
    if (
      (error instanceof IntegratedHostTransportError || code === 'ECONNRESET' || code === 'EPIPE')
      && !await integratedHostListening(supervisorSocket, 200)
    ) {
      return;
    }
    throw error;
  }
}

async function stopSupervisorHarnessAll(
  runtimeDir: string,
  currentSocket: string,
  harness: string
): Promise<void> {
  const candidates = discoverSupervisorSockets(runtimeDir, currentSocket);
  const results = await Promise.allSettled(candidates.map(async (candidate) => {
    if (!await integratedHostListening(candidate, 300)) {
      if (candidate !== currentSocket && !hasActiveStop(candidate)) cleanupDeadSupervisorFiles(candidate);
      return;
    }
    await withActiveStop(candidate, () => stopSupervisorHarness(candidate, harness));
  }));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length === 1) throw failures[0]!.reason;
  if (failures.length > 1) throw new AggregateError(failures.map((failure) => failure.reason), 'Could not stop every Integrated host supervisor');
}

// Multiplexed desktop launcher: runs all Codex, Claude, and ACP Integrated
// hosts of one build generation inside a shared supervisor process, saving
// ~50-80 MB RSS per additional agent and launching agent #2..#N in ~1 ms.
export function supervisedHostLauncher(appDataPath: string, supervisorScript = SUPERVISOR_SCRIPT): IntegratedHostLauncher {
  const runtimeDir = path.join(appDataPath, 'runtime');
  const generation = supervisorGeneration(supervisorScript);
  const supervisorSocket = path.join(runtimeDir, `integrated-supervisor-${generation}.sock`);
  const drainOlder = createOldSupervisorDrainer(runtimeDir, supervisorSocket);
  let booting: Promise<void> | null = null;
  const knownSupervisorPids = new Set<number>();

  return {
    async launch(input) {
      while (booting) await booting;
      let release!: () => void;
      const lock = new Promise<void>((resolve) => { release = resolve; });
      booting = lock;
      try {
        if (await integratedHostListening(supervisorSocket, 300)) {
          try {
            const result = await callSupervisor(supervisorSocket, {
              op: 'start', harness: input.harness, key: input.key, configPath: input.configPath, env: input.env
            });
            const pid = Number(result.pid);
            if (Number.isInteger(pid) && pid > 0) knownSupervisorPids.add(pid);
            drainOlder();
            return Number.isInteger(pid) && pid > 0 ? pid : null;
          } catch (error) {
            if (!isSupervisorGoneError(error)) throw error;
            // Wait for a shutting-down supervisor to finish releasing its
            // socket so a new process never unlinks a live supervisor's path.
            if (!await waitForSupervisorExit(supervisorSocket)) throw error;
          }
        }
        fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        const bootFile = path.join(runtimeDir, `supervisor-boot-${randomUUID()}.json`);
        fs.writeFileSync(bootFile, JSON.stringify({
          harness: input.harness, key: input.key, configPath: input.configPath, env: input.env
        }), { mode: 0o600 });
        try {
          const child = spawn(input.nodePath, [supervisorScript, supervisorSocket], {
            cwd: appDataPath,
            env: withEnv(process.env, { ELECTRON_RUN_AS_NODE: '1', PATTERM_SUPERVISOR_BOOT_FILE: bootFile }),
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          });
          child.unref();
          const spawnedPid = child.pid ?? null;
          if (spawnedPid) knownSupervisorPids.add(spawnedPid);
          if (!await waitForSupervisorSocket(supervisorSocket, spawnedPid)) {
            throw new Error('Integrated host supervisor did not start in time');
          }
          drainOlder();
          return spawnedPid;
        } catch (error) {
          fs.rmSync(bootFile, { force: true });
          throw error;
        }
      } finally {
        if (booting === lock) booting = null;
        release();
      }
    },
    async stop(socketPath, pid) {
      await stopSupervisedSession(runtimeDir, supervisorSocket, knownSupervisorPids, socketPath, pid);
    },
    async stopAll(harness) {
      await stopSupervisorHarnessAll(runtimeDir, supervisorSocket, harness);
    }
  };
}

// Service mode: all Integrated hosts of one build generation run inside a
// versioned transient systemd user unit, so a restart of the web service does
// not kill live Integrated agents while newly launched agents immediately run
// on the rebuilt runtime. The unit name includes a data directory hash so an
// isolated server never stops another server's hosts. OOMPolicy=continue keeps
// the supervisor running when the kernel kills one of its children.
export function systemdHostLauncher(appDataPath: string, env: NodeJS.ProcessEnv, supervisorScript = SUPERVISOR_SCRIPT): IntegratedHostLauncher {
  const scope = createHash('sha256').update(path.resolve(appDataPath)).digest('hex').slice(0, 8);
  const generation = supervisorGeneration(supervisorScript);
  const supervisorUnit = `patterm-integrated-supervisor-${scope}-${generation}.service`;
  const legacyPrefix = (harness: string) => `patterm-integrated-${scope}-${harness}`;
  const runtimeDir = path.join(appDataPath, 'runtime');
  const supervisorSocket = path.join(runtimeDir, `integrated-supervisor-${generation}.sock`);
  const drainOlder = createOldSupervisorDrainer(runtimeDir, supervisorSocket);
  let booting: Promise<void> | null = null;
  const knownSupervisorPids = new Set<number>();

  return {
    async launch(input) {
      while (booting) await booting;
      let release!: () => void;
      const lock = new Promise<void>((resolve) => { release = resolve; });
      booting = lock;
      try {
        if (await integratedHostListening(supervisorSocket, 300)) {
          try {
            const result = await callSupervisor(supervisorSocket, {
              op: 'start', harness: input.harness, key: input.key, configPath: input.configPath, env: input.env
            });
            const pid = Number(result.pid);
            if (Number.isInteger(pid) && pid > 0) knownSupervisorPids.add(pid);
            drainOlder();
            return Number.isInteger(pid) && pid > 0 ? pid : null;
          } catch (error) {
            if (!isSupervisorGoneError(error)) throw error;
            if (!await waitForSupervisorExit(supervisorSocket)) throw error;
          }
        }
        await waitForSystemdUnitInactive(supervisorUnit, env);
        fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        // The supervisor reads and deletes this file; secrets never reach argv.
        const bootFile = path.join(runtimeDir, `supervisor-boot-${randomUUID()}.json`);
        fs.writeFileSync(bootFile, JSON.stringify({
          harness: input.harness, key: input.key, configPath: input.configPath, env: input.env
        }), { mode: 0o600 });
        try {
          await systemctl('systemd-run', [
            '--user', '--quiet', '--collect', `--unit=${supervisorUnit}`, '--service-type=exec',
            '--property=KillMode=control-group', '--property=TimeoutStopSec=25', '--property=UMask=0077',
            '--property=OOMPolicy=continue',
            `--working-directory=${appDataPath}`, `--setenv=PATTERM_SUPERVISOR_BOOT_FILE=${bootFile}`,
            '--', input.nodePath, supervisorScript, supervisorSocket
          ], env);
          const rawPid = Number((await systemctl('systemctl', ['--user', 'show', '--property=MainPID', '--value', supervisorUnit], env)).trim());
          const pid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : null;
          if (pid) knownSupervisorPids.add(pid);
          if (!await waitForSupervisorSocket(supervisorSocket, pid)) {
            throw new Error('Integrated host supervisor did not start in time');
          }
          drainOlder();
          return pid;
        } catch (error) {
          fs.rmSync(bootFile, { force: true });
          throw error;
        }
      } finally {
        if (booting === lock) booting = null;
        release();
      }
    },
    async stop(socketPath, pid) {
      await stopSupervisedSession(runtimeDir, supervisorSocket, knownSupervisorPids, socketPath, pid);
    },
    async stopAll(harness) {
      await stopSupervisorHarnessAll(runtimeDir, supervisorSocket, harness);
      // Clean up any legacy per-agent transient units from older generations.
      await systemctl('systemctl', ['--user', 'stop', `${legacyPrefix(harness)}-*.service`], env);
    }
  };
}

function systemctl(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout: 35_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${String(stderr).trim() || error.message}`, { cause: error }));
      else resolve(String(stdout));
    });
  });
}

// A missing or refusing host socket means the host has ended, for example
// after a restart that predates service-mode hosts. The code is kept so
// delivery classification still sees the transport failure.
export function hostConnectionError(error: Error, label: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT' && code !== 'ECONNREFUSED') return error;
  return Object.assign(new Error(`The ${label} host is no longer running. Resume the conversation to continue.`, { cause: error }), { code });
}

// Transport failures cannot establish whether the host accepted a request.
// Explicit host error responses stay ordinary Errors and remain definitive.
export class IntegratedHostTransportError extends Error {
  override name = 'IntegratedHostTransportError';
}

export function callIntegratedHost(socketPath: string, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(ipcPath(socketPath));
    let buffer = '';
    const timeout = setTimeout(() => { socket.destroy(); reject(new IntegratedHostTransportError(`Integrated host timed out: ${method}`)); }, 10_000);
    socket.setEncoding('utf8');
    socket.once('error', (error) => { clearTimeout(timeout); socket.destroy(); reject(hostConnectionError(error, 'Integrated agent')); });
    socket.once('close', () => { clearTimeout(timeout); reject(new IntegratedHostTransportError(`Integrated host closed before replying: ${method}`)); });
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as { id?: unknown; error?: unknown; result?: unknown };
        if (!response || response.id !== id) throw new IntegratedHostTransportError('Invalid Integrated host response');
        if (response.error) reject(new Error(String(response.error)));
        else resolve(response.result);
      } catch (error) {
        reject(error instanceof IntegratedHostTransportError ? error : new IntegratedHostTransportError('Invalid Integrated host response', { cause: error }));
      }
    });
  });
}

// Whether a host's control socket accepts a connection.
export function integratedHostListening(socketPath: string, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(ipcPath(socketPath));
    const done = (listening: boolean) => { socket.destroy(); resolve(listening); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    // A named pipe whose instances are all in use reports EBUSY: its host is
    // alive, just busy.
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'EBUSY'));
  });
}

// Whether a starting host accepts connections on its control socket. A Unix
// socket file appears at bind, before listen, so its existence alone can still
// refuse a connection on a busy machine. A named pipe has no file to look for.
export async function integratedHostReady(socketPath: string): Promise<boolean> {
  if (process.platform !== 'win32' && !fs.existsSync(socketPath)) return false;
  return integratedHostListening(socketPath, 1_000);
}

// Ends a host the caller just started. POSIX hosts handle SIGTERM by stopping
// their CLI. Windows has no SIGTERM: ending only the host would orphan the CLI
// with its MCP servers and tool shells, so the whole tree ends.
export async function stopHostProcess(pid: number | null): Promise<void> {
  if (!pid) return;
  if (process.platform === 'win32') return killProcessTree(pid);
  try { process.kill(pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

// Ends a host by a PID recorded earlier. Once that host has gone the PID may
// name an unrelated process, so on Windows, where its whole tree would end,
// only a host whose control socket still listens is stopped.
export async function stopRecordedHostProcess(pid: number | null, socketPath: string): Promise<void> {
  if (!pid) return;
  if (process.platform !== 'win32') return stopHostProcess(pid);
  if (!await integratedHostListening(socketPath)) return;
  await stopHostProcess(pid);
  // Termination completes asynchronously; return once the pipe has closed so
  // callers never mistake a dying host for a live one.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && await integratedHostListening(socketPath, 250)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
