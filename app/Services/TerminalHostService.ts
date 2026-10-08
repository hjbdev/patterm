import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DebugLogService } from './DebugLogService';
import { TerminalService, type TerminalFrame } from './TerminalService';

export interface TerminalHostOptions {
  appDataPath: string;
  serviceName: string;
  // Tests run real hosts under an isolated process supervisor.
  controlUnit?: (action: 'start' | 'stop' | 'is-active', unit: string, directory: string) => Promise<boolean>;
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

// Hosts are independent systemd units. Disconnecting this controller never
// relinquishes supervision or signals the terminal processes.
export class TerminalHostService {
  private readonly hosts = new Map<string, TerminalService>();
  private readonly processHosts = new Map<string, TerminalService>();
  private readonly root: string;
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
    if (!/^[a-zA-Z0-9_-]+$/.test(options.serviceName)) throw new Error('Invalid terminal service name');
    this.root = path.join(options.appDataPath, 'terminal-hosts');
  }

  async start(): Promise<void> {
    const binary = await fs.readFile(this.sidecarPath);
    this.currentId = createHash('sha256').update(path.resolve(this.root)).update(binary).digest('hex').slice(0, 12);
    const directory = path.join(this.root, this.currentId);
    if (Buffer.byteLength(path.join(directory, 'control.sock')) > 103) throw new Error('Patterm data path is too long for terminal host sockets');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const candidate of [this.root, directory]) {
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Terminal host directories must be private and owned by the Patterm user');
    }
    const executable = path.join(directory, 'terminal-core');
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
    await this.control('start', this.currentId);
    try {
      for (const id of await this.registeredHosts()) {
        if (id !== this.currentId && !await this.control('is-active', id)) {
          await fs.rm(path.join(this.root, id), { recursive: true });
          continue;
        }
        const host = new TerminalService('', this.debugLog, this.env);
        try {
          await this.connect(host, path.join(this.root, id, 'control.sock'));
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
    // stops the entire unit cgroup, including descendants outside the PTY.
    const results = await Promise.allSettled((await this.registeredHosts()).map((id) => this.control('stop', id)));
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

  private async connect(host: TerminalService, socketPath: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try { await host.connect(socketPath); return; }
      catch (error) {
        if (attempt >= 49 || !['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  private async control(action: 'start' | 'stop' | 'is-active', id: string): Promise<boolean> {
    const unit = `${this.options.serviceName}@${id}.service`;
    if (this.options.controlUnit) return this.options.controlUnit(action, unit, path.join(this.root, id));
    return new Promise((resolve, reject) => {
      execFile('systemctl', ['--user', action, ...(action === 'is-active' ? ['--quiet'] : []), unit], { env: this.env, timeout: 35_000 }, (error) => {
        if (!error) resolve(true);
        else if (action === 'is-active' && !error.killed && [3, 4].includes(Number(error.code))) resolve(false);
        else reject(new Error(`Could not ${action} ${unit}; check the systemd user journal`, { cause: error }));
      });
    });
  }
}
