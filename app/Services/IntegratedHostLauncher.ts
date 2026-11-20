import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { withEnv } from '../Platform/Environment';
import { ipcPath } from '../Platform/Ipc';
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
  supervisorSocket: string,
  getSupervisorPid: () => number | null,
  setSupervisorPid: (pid: number) => void,
  socketPath: string,
  pid: number | null
): Promise<void> {
  const reachable = await integratedHostListening(supervisorSocket, 300);
  if (reachable) {
    try {
      const result = await callSupervisor(supervisorSocket, { op: 'stop', socketPath });
      const reportedPid = Number(result.pid);
      if (Number.isInteger(reportedPid) && reportedPid > 0) setSupervisorPid(reportedPid);
      if (result.stopped) return;
    } catch {
      // Fall through to ping check before considering legacy fallback.
    }
    if (getSupervisorPid() === null) {
      try {
        const ping = await callSupervisor(supervisorSocket, { op: 'ping' });
        const reportedPid = Number(ping.pid);
        if (Number.isInteger(reportedPid) && reportedPid > 0) setSupervisorPid(reportedPid);
      } catch {
        // Supervisor socket was reachable; never risk killing an unknown supervisor PID.
      }
    }
    const knownSupervisorPid = getSupervisorPid();
    if (!pid || knownSupervisorPid === null || pid === knownSupervisorPid) return;
    if (!await integratedHostListening(socketPath, 300)) return;
    await stopRecordedHostProcess(pid, socketPath);
    return;
  }
  if (pid && pid !== getSupervisorPid() && await integratedHostListening(socketPath, 300)) {
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

// Multiplexed desktop launcher: runs all Codex, Claude, and ACP Integrated
// hosts inside ONE persistent supervisor process, saving ~50-80 MB RSS per
// additional agent and launching agent #2..#N in ~1 ms.
export function supervisedHostLauncher(appDataPath: string, supervisorScript = SUPERVISOR_SCRIPT): IntegratedHostLauncher {
  const runtimeDir = path.join(appDataPath, 'runtime');
  const supervisorSocket = path.join(runtimeDir, 'integrated-supervisor.sock');
  let booting: Promise<void> | null = null;
  let supervisorPid: number | null = null;

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
            if (Number.isInteger(pid) && pid > 0) supervisorPid = pid;
            return Number.isInteger(pid) && pid > 0 ? pid : null;
          } catch {
            // Supervisor exited right as we connected; fall through to spawn a fresh one.
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
          supervisorPid = spawnedPid;
          if (!await waitForSupervisorSocket(supervisorSocket, spawnedPid)) {
            throw new Error('Integrated host supervisor did not start in time');
          }
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
      await stopSupervisedSession(
        supervisorSocket,
        () => supervisorPid,
        (reported) => { supervisorPid = reported; },
        socketPath,
        pid
      );
    },
    async stopAll(harness) {
      await stopSupervisorHarness(supervisorSocket, harness);
    }
  };
}

// Service mode: all Integrated hosts run inside ONE transient systemd user unit
// (the supervisor), so a restart of the web service's control group does not
// kill Integrated agents, and agent #2..#N launch in ~1 ms with 0 extra
// systemd-run/systemctl spawns. The unit name includes a data directory hash so
// an isolated server never stops another server's hosts. OOMPolicy=continue
// keeps the supervisor running when the kernel kills one of its children.
export function systemdHostLauncher(appDataPath: string, env: NodeJS.ProcessEnv, supervisorScript = SUPERVISOR_SCRIPT): IntegratedHostLauncher {
  const scope = createHash('sha256').update(path.resolve(appDataPath)).digest('hex').slice(0, 8);
  const supervisorUnit = `patterm-integrated-supervisor-${scope}.service`;
  const legacyPrefix = (harness: string) => `patterm-integrated-${scope}-${harness}`;
  const runtimeDir = path.join(appDataPath, 'runtime');
  const supervisorSocket = path.join(runtimeDir, 'integrated-supervisor.sock');
  let booting: Promise<void> | null = null;
  let supervisorPid: number | null = null;

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
            if (Number.isInteger(pid) && pid > 0) supervisorPid = pid;
            return Number.isInteger(pid) && pid > 0 ? pid : null;
          } catch {
            // Supervisor exited; fall through to start a fresh unit.
          }
        }
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
          supervisorPid = pid;
          if (!await waitForSupervisorSocket(supervisorSocket, pid)) {
            throw new Error('Integrated host supervisor did not start in time');
          }
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
      await stopSupervisedSession(
        supervisorSocket,
        () => supervisorPid,
        (reported) => { supervisorPid = reported; },
        socketPath,
        pid
      );
    },
    async stopAll(harness) {
      await stopSupervisorHarness(supervisorSocket, harness);
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

// Whether a starting host has created its control socket. A named pipe has no
// file to look for, so Windows asks whether it accepts a connection.
export async function integratedHostReady(socketPath: string): Promise<boolean> {
  if (process.platform !== 'win32') return fs.existsSync(socketPath);
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
