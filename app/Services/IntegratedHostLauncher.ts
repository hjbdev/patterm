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
  // Stops every host this data directory started for the harness, including
  // hosts whose sessions were already reconciled as failed.
  stopAll(harness: string): Promise<void>;
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

// Service mode: each host runs in its own transient systemd user unit, so a
// restart of the web service's control group does not kill Integrated agents.
// The unit prefix includes a data directory hash so an isolated server never
// stops another server's hosts. OOMPolicy=continue keeps the host running when
// the kernel kills one of its children, such as a browser an agent started;
// systemd's default stops the whole unit and ends the conversation.
export function systemdHostLauncher(appDataPath: string, env: NodeJS.ProcessEnv): IntegratedHostLauncher {
  const scope = createHash('sha256').update(path.resolve(appDataPath)).digest('hex').slice(0, 8);
  const prefix = (harness: string) => `patterm-integrated-${scope}-${harness}`;
  return {
    async launch(input) {
      const unit = `${prefix(input.harness)}-${input.key}.service`;
      // The host reads and deletes this file; secrets never reach argv.
      const envFile = input.configPath.replace(/\.json$/, '-env.json');
      fs.writeFileSync(envFile, JSON.stringify(input.env), { mode: 0o600 });
      try {
        await systemctl('systemd-run', [
          '--user', '--quiet', '--collect', `--unit=${unit}`, '--service-type=exec',
          '--property=KillMode=control-group', '--property=TimeoutStopSec=25', '--property=UMask=0077',
          '--property=OOMPolicy=continue',
          `--working-directory=${input.cwd}`, `--setenv=PATTERM_HOST_ENV_FILE=${envFile}`,
          '--', input.nodePath, input.script, input.configPath
        ], env);
      } catch (error) {
        fs.rmSync(envFile, { force: true });
        throw error;
      }
      const pid = Number((await systemctl('systemctl', ['--user', 'show', '--property=MainPID', '--value', unit], env)).trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    },
    async stopAll(harness) {
      await systemctl('systemctl', ['--user', 'stop', `${prefix(harness)}-*.service`], env);
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
