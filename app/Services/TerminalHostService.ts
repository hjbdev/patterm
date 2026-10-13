import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { killProcessTree } from '../Platform/ProcessTree';
import type { DebugLogService } from './DebugLogService';
import { TerminalService, type TerminalFrame } from './TerminalService';

// Starts, stops, and locates the host of one binary generation.
export interface TerminalHostSupervisor {
  // Starts the host unless it is already running.
  start(id: string, directory: string): Promise<void>;
  isActive(id: string, directory: string): Promise<boolean>;
  // Stops the host and all of its descendants. `connection` is this
  // controller's connection to the host, when it has one.
  stop(id: string, directory: string, connection: TerminalService | undefined): Promise<void>;
  // The control endpoint of a started host.
  endpoint(id: string, directory: string): Promise<string>;
}

export interface TerminalHostOptions {
  appDataPath: string;
  // systemd template unit that runs each generation on Linux; unused on Windows.
  serviceName?: string;
  // Tests run real hosts under an isolated process supervisor.
  supervisor?: TerminalHostSupervisor;
}

export const terminalInventory = z.object({ processes: z.array(z.object({
  process_id: z.string().min(1),
  status: z.enum(['running', 'exited', 'stopped']),
  exit_code: z.number().int().nullable(),
  activity: z.string(),
  title: z.string()
}).passthrough()) });
export type TerminalInventoryProcess = z.infer<typeof terminalInventory>['processes'][number];

const handshake = z.object({ protocol_version: z.literal(1), host_id: z.string(), incarnation: z.string().min(1) });
const HOST_ID = /^[a-f0-9]{12}$/;
const HOST_BINARY = process.platform === 'win32' ? 'terminal-core.exe' : 'terminal-core';

// Hosts are independent systemd units on Linux and detached processes on
// Windows. Disconnecting this controller never relinquishes supervision or
// signals the terminal processes.
export class TerminalHostService {
  private readonly hosts = new Map<string, TerminalService>();
  private readonly processHosts = new Map<string, TerminalService>();
  private readonly root: string;
  private readonly supervisor: TerminalHostSupervisor;
  private currentId = '';
  private disposing = false;

  constructor(
    private readonly sidecarPath: string,
    private readonly debugLog: DebugLogService,
    private readonly env: NodeJS.ProcessEnv,
    private readonly options: TerminalHostOptions,
    private readonly onFrame: (frame: TerminalFrame) => void,
    private readonly onExit: () => void
  ) {
    if (options.supervisor) this.supervisor = options.supervisor;
    else if (process.platform === 'win32') this.supervisor = new DetachedHostSupervisor(debugLog, env);
    else {
      if (!/^[a-zA-Z0-9_-]+$/.test(options.serviceName ?? '')) throw new Error('Invalid terminal service name');
      this.supervisor = new SystemdHostSupervisor(options.serviceName!, env);
    }
    this.root = path.join(options.appDataPath, 'terminal-hosts');
  }

  async start(): Promise<void> {
    const binary = await fs.readFile(this.sidecarPath);
    this.currentId = createHash('sha256').update(path.resolve(this.root)).update(binary).digest('hex').slice(0, 12);
    const directory = path.join(this.root, this.currentId);
    // Windows has no socket path limit or mode bits. The directory lies in the
    // per-user %LOCALAPPDATA% profile, and the host's pipe DACL admits only
    // this user.
    if (process.platform !== 'win32' && Buffer.byteLength(path.join(directory, 'control.sock')) > 103) throw new Error('Patterm data path is too long for terminal host sockets');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      for (const candidate of [this.root, directory]) {
        const stat = await fs.lstat(candidate);
        if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Terminal host directories must be private and owned by the Patterm user');
      }
    }
    const executable = path.join(directory, HOST_BINARY);
    try {
      const installed = await fs.readFile(executable);
      if (!binary.equals(installed)) throw new Error('Registered terminal host binary does not match its generation');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const temporary = `${executable}.${process.pid}.tmp`;
      try {
        await fs.writeFile(temporary, binary, { flag: 'wx', mode: 0o700 });
        await fs.rename(temporary, executable);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
    await this.supervisor.start(this.currentId, directory);
    try {
      for (const id of await this.registeredHosts()) {
        const hostDirectory = path.join(this.root, id);
        if (id !== this.currentId && !await this.supervisor.isActive(id, hostDirectory)) {
          await this.removeGeneration(hostDirectory);
          continue;
        }
        const host = new TerminalService('', this.debugLog, this.env);
        try {
          await this.connect(host, await this.supervisor.endpoint(id, hostDirectory));
          const hello = handshake.parse(await host.request('terminal.host.handshake'));
          if (hello.host_id !== id) throw new Error('Terminal host identity mismatch');
          this.hosts.set(id, host);
          host.onFrame(this.onFrame);
          host.onExit(() => { if (!this.disposing && this.hosts.has(id)) this.onExit(); });
        } catch (error) {
          await host.dispose();
          throw error;
        }
      }
      await this.inventory();
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  isAvailable(): boolean {
    return this.hosts.get(this.currentId)?.isAvailable() === true;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (method === 'terminal.process.list') return { processes: await this.inventory() };
    const processId = params && typeof params === 'object' ? (params as { process_id?: unknown }).process_id : undefined;
    const host = typeof processId === 'string' ? this.processHosts.get(processId) : this.hosts.get(this.currentId);
    if (!host?.isAvailable()) throw new Error('Terminal host is unavailable for this process');
    const result = await host.request(method, params);
    if (method === 'terminal.process.spawn') {
      const spawned = z.object({ process_id: z.string() }).parse(result);
      this.processHosts.set(spawned.process_id, host);
    }
    if (method === 'terminal.process.close' && typeof processId === 'string') this.processHosts.delete(processId);
    return result;
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    await Promise.all([...this.hosts.values()].map((host) => host.dispose()));
    this.hosts.clear();
    this.processHosts.clear();
  }

  async shutdown(): Promise<void> {
    this.disposing = true;
    // Use the registry, including hosts this app could not attach to. systemd
    // stops the entire unit cgroup, and a Windows host's job object ends every
    // descendant, including those outside the PTY.
    const results = await Promise.allSettled((await this.registeredHosts()).map((id) =>
      this.supervisor.stop(id, path.join(this.root, id), this.hosts.get(id))));
    await this.dispose();
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map((result) => result.reason), 'Some terminal hosts could not be stopped');
  }

  private async inventory(): Promise<TerminalInventoryProcess[]> {
    const processes: TerminalInventoryProcess[] = [];
    for (const host of this.hosts.values()) {
      const inventory = terminalInventory.parse(await host.request('terminal.process.list'));
      for (const process of inventory.processes) {
        this.processHosts.set(process.process_id, host);
        processes.push(process);
      }
    }
    return processes;
  }

  private async registeredHosts(): Promise<string[]> {
    // Retain active generations until Quit. An exited PTY can still have
    // background descendants, so terminal status alone cannot retire a host.
    return (await fs.readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && HOST_ID.test(entry.name)).map((entry) => entry.name);
  }

  private async removeGeneration(directory: string): Promise<void> {
    try {
      await fs.rm(directory, { recursive: true });
    } catch (error) {
      // Windows keeps a stopped host's executable locked until the process is
      // gone. Leave the generation for a later start instead of failing this one.
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      this.debugLog.write('terminal-hosts', 'generation.remove-deferred', { directory, code: (error as NodeJS.ErrnoException).code });
    }
  }

  private async connect(host: TerminalService, socketPath: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try { await host.connect(socketPath); return; }
      catch (error) {
        if (attempt >= 49 || !['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

// Linux: each generation is an instance of the installed template unit.
class SystemdHostSupervisor implements TerminalHostSupervisor {
  constructor(private readonly serviceName: string, private readonly env: NodeJS.ProcessEnv) {}

  async start(id: string): Promise<void> {
    await this.control('start', id);
  }

  isActive(id: string): Promise<boolean> {
    return this.control('is-active', id);
  }

  async stop(id: string): Promise<void> {
    await this.control('stop', id);
  }

  async endpoint(_id: string, directory: string): Promise<string> {
    return path.join(directory, 'control.sock');
  }

  private control(action: 'start' | 'stop' | 'is-active', id: string): Promise<boolean> {
    const unit = `${this.serviceName}@${id}.service`;
    return new Promise((resolve, reject) => {
      execFile('systemctl', ['--user', action, ...(action === 'is-active' ? ['--quiet'] : []), unit], { env: this.env, timeout: 35_000 }, (error) => {
        if (!error) resolve(true);
        else if (action === 'is-active' && !error.killed && [3, 4].includes(Number(error.code))) resolve(false);
        else reject(new Error(`Could not ${action} ${unit}; check the systemd user journal`, { cause: error }));
      });
    });
  }
}

const PIPE_DIRECTORY = '\\\\.\\pipe\\';
const hostRecord = z.object({
  pipe: z.string().regex(/^\\\\\.\\pipe\\patterm-host-[a-f0-9]{12}-[a-f0-9]{32}$/),
  pid: z.number().int().positive().optional()
});
type HostRecord = z.infer<typeof hostRecord>;

// Windows: each generation is a detached process that outlives the app and
// owns its PTYs through a kill-on-close job object. The pipe name is random per
// start and recorded in the private generation directory, so another local
// user cannot serve a predictable name before the host does.
export class DetachedHostSupervisor implements TerminalHostSupervisor {
  constructor(private readonly debugLog: DebugLogService, private readonly env: NodeJS.ProcessEnv) {}

  async start(id: string, directory: string): Promise<void> {
    if (await this.isActive(id, directory)) return;
    const pipe = `${PIPE_DIRECTORY}patterm-host-${id}-${randomBytes(16).toString('hex')}`;
    // Record the pipe first so Quit can still reach a host whose launcher
    // stopped before recording its PID.
    await writeHostRecord(directory, { pipe });
    const child = spawn(path.join(directory, HOST_BINARY), ['--socket', pipe, '--host-id', id], {
      cwd: directory, env: this.env, detached: true, stdio: 'ignore', windowsHide: true
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    await writeHostRecord(directory, { pipe, pid: child.pid! });
    this.debugLog.write('terminal-hosts', 'host.started', { id, pid: child.pid });
  }

  // Lists the pipe namespace instead of connecting, because a probe would
  // briefly hold the single controller slot that the real connection needs.
  async isActive(_id: string, directory: string): Promise<boolean> {
    const record = await readHostRecord(directory);
    return record !== null && await pipeExists(record.pipe);
  }

  async stop(id: string, directory: string, connection: TerminalService | undefined): Promise<void> {
    const record = await readHostRecord(directory);
    if (!record || !await pipeExists(record.pipe)) return;
    let owned: TerminalService | undefined;
    try {
      let host = connection?.isAvailable() ? connection : undefined;
      if (!host) {
        owned = new TerminalService('', this.debugLog, this.env);
        await owned.connect(record.pipe);
        host = owned;
      }
      await host.request('terminal.host.shutdown');
      // The host releases its pipe after its terminals have stopped, then
      // exits; closing its job object ends any remaining descendants.
      if (record.pid !== undefined && !await exited(record.pid, 5_000)) throw new Error('Terminal host did not exit after shutdown');
    } catch (error) {
      // The pipe name is unique to one start, so while it exists the recorded
      // PID is still this host. A host without its pipe has already stopped.
      if (!await pipeExists(record.pipe)) return;
      if (record.pid === undefined) throw new Error(`Could not stop terminal host ${id}`, { cause: error });
      this.debugLog.write('terminal-hosts', 'host.kill', { id, pid: record.pid, error: String(error) });
      await killProcessTree(record.pid);
      if (!await exited(record.pid, 5_000)) throw new Error(`Could not stop terminal host ${id}`, { cause: error });
    } finally {
      await owned?.dispose();
    }
  }

  async endpoint(id: string, directory: string): Promise<string> {
    const record = await readHostRecord(directory);
    if (!record) throw new Error(`Terminal host ${id} has no recorded pipe`);
    return record.pipe;
  }
}

async function readHostRecord(directory: string): Promise<HostRecord | null> {
  try {
    return hostRecord.parse(JSON.parse(await fs.readFile(path.join(directory, 'host.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeHostRecord(directory: string, record: HostRecord): Promise<void> {
  const filename = path.join(directory, 'host.json');
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function pipeExists(pipe: string): Promise<boolean> {
  const name = pipe.slice(PIPE_DIRECTORY.length).toLowerCase();
  return (await fs.readdir(PIPE_DIRECTORY)).some((entry) => entry.toLowerCase() === name);
}

async function exited(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
