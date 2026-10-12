import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication, type PattermApplication } from '../app/App';
import { listCommandPaletteCommands, runCommandPaletteCommand } from '../app/Commands/CommandPalette';
import type { DebugLogService } from '../app/Services/DebugLogService';
import type { ProcessLauncherResult } from '../app/Services/ProcessLauncher';
import { DetachedHostSupervisor, type TerminalHostSupervisor } from '../app/Services/TerminalHostService';
import type { TerminalService } from '../app/Services/TerminalService';

interface FixturePids { pid: number; sleepPid: number }
interface ProcessRow { id: string; status: string; pty_process_id: string | null; exit_code: number | null; auto_restart: number }
interface ProcInfo { pid: number; parent: number; state: string; started: string }

const windows = process.platform === 'win32';
// PowerShell and ConPTY start more slowly than a POSIX shell.
const WAIT_MS = windows ? 20_000 : 5000;

async function main(): Promise<void> {
  assert.ok(process.platform === 'linux' || windows, 'persistent runtime smoke requires Linux or Windows');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-runtime-'));
  const supervisor = windows ? new WindowsSupervisor() : new TestSupervisor();
  let app: PattermApplication | undefined;
  try {
    const fixture = path.join(directory, 'fixture.cjs');
    // The sleep is detached from the fixture: on Linux it leaves the PTY's
    // process group, and on Windows it gets no console, but both stay
    // descendants of the terminal host.
    fs.writeFileSync(fixture, `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const [, , record, gate] = process.argv;
if (gate) {
  fs.writeFileSync(record, JSON.stringify({ pid: process.pid, parent: process.ppid }));
  setInterval(() => { if (fs.existsSync(gate)) process.exit(23); }, 10);
} else {
  const sleep = process.platform === 'win32'
    ? spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3600000)'], { detached: true, stdio: 'ignore' })
    : spawn('/bin/sleep', ['3600'], { detached: true, stdio: 'ignore' });
  fs.writeFileSync(record, JSON.stringify({ pid: process.pid, sleepPid: sleep.pid }));
  console.log('fixture ready');
  createInterface({ input: process.stdin }).on('line', line => console.log('reply:' + line));
}
`);
    const options = {
      appDataPath: path.join(directory, 'data'),
      sidecarPath: path.resolve('native/terminal-core/target/debug', windows ? 'patterm-terminal-core.exe' : 'patterm-terminal-core'),
      mcpShimPath: path.resolve('dist/mcp/patterm-mcp.js'),
      runtime: 'node' as const,
      terminalHosts: {
        appDataPath: path.join(directory, 'data'),
        serviceName: 'patterm-test',
        supervisor
      }
    };
    app = await createApplication(options);
    assert.equal(app.bootstrap().sidecarAvailable, true);
    const project = await app.mcp.call('project_create', { path: directory, name: 'Runtime fixture' }) as { project_id: string };
    const originalRecord = path.join(directory, 'original.json');
    const original = await app.mcp.call('process_create', {
      project_id: project.project_id,
      name: 'Uninterrupted sleep',
      command: command(fixture, originalRecord),
      auto_restart: true
    }) as ProcessLauncherResult;
    await until(() => fs.existsSync(originalRecord), 'original command starts');
    const originalPids = JSON.parse(fs.readFileSync(originalRecord, 'utf8')) as FixturePids;
    const originalStart = started(originalPids.pid);
    const sleepStart = started(originalPids.sleepPid);
    assert.ok(originalStart);
    assert.ok(sleepStart);

    const offlineRecord = path.join(directory, 'offline.json');
    const gate = path.join(directory, 'exit-gate');
    const offline = await app.mcp.call('process_create', {
      project_id: project.project_id, name: 'Exit while disconnected', command: command(fixture, offlineRecord, gate)
    }) as ProcessLauncherResult;
    await until(() => fs.existsSync(offlineRecord), 'offline command starts');
    const offlinePids = JSON.parse(fs.readFileSync(offlineRecord, 'utf8')) as { pid: number; parent: number };
    const originalHostPid = supervisor.hostPids()[0];
    assert.ok(originalHostPid);
    await app.dispose();
    app = undefined;
    assert.equal(supervisor.stops, 0, 'ordinary app disposal does not stop terminal hosts');
    assert.equal(started(originalPids.pid), originalStart);
    assert.equal(started(originalPids.sleepPid), sleepStart, 'a detached sleep keeps the same process and start time');
    fs.writeFileSync(gate, 'exit');
    await until(() => !running(offlinePids.pid), 'command exits while the application is disconnected');
    // PowerShell wraps the command on Windows; the PTY exits with it.
    if (windows) await until(() => !running(offlinePids.parent), 'command shell exits while the application is disconnected');

    app = await createApplication(options);
    assert.equal(supervisor.starts, 1, 'an unchanged binary reuses its existing host');
    assert.equal(supervisor.hostPids()[0], originalHostPid);
    assert.deepEqual(processRow(app, original.process_id), {
      id: original.process_id, status: 'running', pty_process_id: original.pty_process_id, exit_code: null, auto_restart: 1
    });
    assert.equal(started(originalPids.pid), originalStart);
    assert.equal(started(originalPids.sleepPid), sleepStart);
    const exited = processRow(app, offline.process_id);
    assert.equal(exited.status, 'failed');
    assert.equal(exited.exit_code, 23, 'reconciliation captures exits that occurred without an app connection');
    await echo(app, original.pty_process_id, 'after-reconnect');

    await app.dispose();
    app = undefined;
    const updatedBinary = path.join(directory, windows ? 'updated-terminal-core.exe' : 'updated-terminal-core');
    fs.copyFileSync(options.sidecarPath, updatedBinary);
    // Trailing bytes leave this ELF or PE executable valid while changing its hash.
    fs.appendFileSync(updatedBinary, '\nfixture generation two\n');
    const updatedOptions = { ...options, sidecarPath: updatedBinary };
    app = await createApplication(updatedOptions);
    assert.equal(supervisor.starts, 2, 'an updated binary starts another host generation');
    assert.equal(await supervisor.activeCount(), 2, 'the previous generation stays supervised while it has live processes');
    const nextRecord = path.join(directory, 'updated.json');
    const next = await app.mcp.call('process_create', {
      project_id: project.project_id, name: 'Updated host', command: command(fixture, nextRecord), auto_restart: true
    }) as ProcessLauncherResult;
    await until(() => fs.existsSync(nextRecord), 'updated command starts');
    const nextPids = JSON.parse(fs.readFileSync(nextRecord, 'utf8')) as FixturePids;
    assert.notEqual(original.pty_process_id.split('_')[1], next.pty_process_id.split('_')[1], 'new launches use the updated host generation');
    assert.equal(started(originalPids.pid), originalStart, 'updating the host binary preserves existing processes');
    assert.equal(started(originalPids.sleepPid), sleepStart);
    await echo(app, original.pty_process_id, 'old-generation');
    await echo(app, next.pty_process_id, 'new-generation');

    // Fault injection: drop one controller while its supervised host stays up.
    // A failed stop must not overwrite ownership of the still-running process.
    const connections = (app.terminal as unknown as {
      hosts: { processHosts: Map<string, { dispose(): Promise<void> }> }
    }).hosts.processHosts;
    await connections.get(original.pty_process_id)!.dispose();
    await assert.rejects(app.mcp.call('stop_process', { process_id: original.process_id }), /Terminal host is unavailable/);
    assert.equal(processRow(app, original.process_id).status, 'running');
    assert.equal(processRow(app, original.process_id).pty_process_id, original.pty_process_id);
    assert.equal(started(originalPids.pid), originalStart);
    await app.dispose();
    app = await createApplication(updatedOptions);
    await echo(app, original.pty_process_id, 'after-controller-loss');

    app.timers.setDelay({ seconds: 3600, ownerProcessId: original.process_id, body: 'cancel on Quit' });
    const context = { active_project_id: project.project_id, active_terminal_id: original.pty_process_id, active_tab: 'processes' };
    const quit = (await listCommandPaletteCommands(app, context)).commands.find((item) => item.id === 'renderer:quit');
    assert.match(quit?.confirmation ?? '', /0 agents and 2 commands/);
    assert.match(quit?.confirmation ?? '', /running sleeps.*Patterm timers/);
    await assert.rejects(runCommandPaletteCommand(app, { id: 'renderer:quit', context }), /Confirm Quit/);
    await assert.rejects(runCommandPaletteCommand(app, { id: 'renderer:quit', context, input: { confirmed: 'true' } }), /Confirm Quit/);
    assert.equal(await supervisor.activeCount(), 2, 'unconfirmed Quit has no shutdown side effects');
    assert.equal(app.timers.listMcp().length, 1);
    assert.equal(app.isShuttingDown(), false);
    await runCommandPaletteCommand(app, { id: 'renderer:quit', context, input: { confirmed: true } });
    assert.equal(app.isShuttingDown(), true);
    assert.equal(await supervisor.activeCount(), 0, 'Quit stops every registered host generation');
    for (const pid of [originalPids.pid, originalPids.sleepPid, nextPids.pid, nextPids.sleepPid]) {
      // A Windows host's job object ends its descendants as the host exits.
      if (windows) await until(() => !running(pid), `Quit stops managed process ${pid}, including detached sleeps`);
      assert.equal(running(pid), false, `Quit stops managed process ${pid}, including detached sleeps`);
    }
    assert.equal(app.timers.listMcp().length, 0);
    assert.equal(processRow(app, original.process_id).status, 'exited');
    assert.equal(processRow(app, next.process_id).status, 'exited');
    await assert.rejects(app.terminal.request('terminal.process.spawn', { command: '/bin/sleep', args: ['3600'] }), /shut/i);
    assert.equal(supervisor.starts, 2, 'shutdown cannot trigger configured automatic restarts');
    await app.dispose();
    app = undefined;

    app = await createApplication(updatedOptions);
    const inventory = await app.terminal.request('terminal.process.list') as { processes: unknown[] };
    assert.deepEqual(inventory.processes, [], 'starting after Quit does not revive old processes');
    assert.equal(app.timers.listMcp().length, 0, 'cancelled timers do not return after Quit');
    await app.shutdown();
    console.log('persistent runtime smoke passed: reconnect, uninterrupted sleeps, offline exits, host updates, confirmed Quit, descendant cleanup');
  } finally {
    try { await app?.dispose(); }
    finally {
      try { await supervisor.dispose(); }
      finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
  }
}

// Process commands run through the default shell: a POSIX shell, or
// PowerShell on Windows, which returns only 0 or 1 unless told to exit with
// the command's own code.
function command(...args: string[]): string {
  if (windows) return `& ${[process.execPath, ...args].map((value) => `'${value.replace(/'/g, "''")}'`).join(' ')}; exit $LASTEXITCODE`;
  return `exec ${[process.execPath, ...args].map((value) => `'${value.replace(/'/g, `'\\''`)}'`).join(' ')}`;
}

function processRow(app: PattermApplication, processId: string): ProcessRow {
  return app.database.connection.prepare('select id, status, pty_process_id, exit_code, auto_restart from processes where id = ?').get(processId) as ProcessRow;
}

async function echo(app: PattermApplication, processId: string, text: string): Promise<void> {
  // A console reads a line when Enter (CR) arrives.
  await app.terminal.request('terminal.process.input', { process_id: processId, text: `${text}${windows ? '\r' : '\n'}` });
  await until(async () => {
    const output = await app.terminal.request('terminal.process.output', { process_id: processId }) as { lines: string[] };
    return output.lines.some((line) => line.includes(`reply:${text}`));
  }, `input and output reconnect for ${text}`);
}

async function until(check: () => boolean | Promise<boolean>, message: string, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// A process start time, which tells a surviving process from a reused PID.
function started(pid: number): string | undefined {
  if (!windows) return procInfo(pid)?.started;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function procInfo(pid: number): ProcInfo | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, parent: Number(fields[1]), state: fields[0]!, started: fields[19]! };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

function running(pid: number): boolean {
  if (windows) return windowsRunning(pid);
  const process = procInfo(pid);
  return Boolean(process && process.state !== 'Z' && process.state !== 'X');
}

// Signal 0 reports a process that has exited as gone, even while open handles
// keep its object alive.
function windowsRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

interface SmokeSupervisor extends TerminalHostSupervisor {
  readonly starts: number;
  readonly stops: number;
  hostPids(): number[];
  activeCount(): Promise<number>;
  dispose(): Promise<void>;
}

// Reproduce cgroup cleanup without invoking systemd or changing live services.
// PTYs and detached children have separate process groups, so include the tree.
class TestSupervisor implements SmokeSupervisor {
  readonly children = new Map<string, ChildProcess>();
  starts = 0;
  stops = 0;

  async start(id: string, directory: string): Promise<void> {
    const previous = this.children.get(id);
    if (previous?.pid && running(previous.pid)) return;
    const log = fs.openSync(path.join(directory, 'fixture-host.log'), 'a', 0o600);
    let child: ChildProcess;
    try {
      child = spawn(path.join(directory, 'terminal-core'), ['--socket', path.join(directory, 'control.sock'), '--host-id', path.basename(directory)], {
        detached: true, stdio: ['ignore', log, log]
      });
    } finally {
      fs.closeSync(log);
    }
    this.children.set(id, child);
    this.starts++;
    await once(child, 'spawn');
  }

  async isActive(id: string): Promise<boolean> {
    const previous = this.children.get(id);
    return Boolean(previous?.pid && running(previous.pid));
  }

  async stop(id: string): Promise<void> {
    const previous = this.children.get(id);
    if (previous?.pid && running(previous.pid)) {
      this.stops++;
      await this.kill(previous.pid);
    }
  }

  async endpoint(_id: string, directory: string): Promise<string> {
    return path.join(directory, 'control.sock');
  }

  hostPids(): number[] {
    return [...this.children.values()].flatMap((child) => child.pid ? [child.pid] : []);
  }

  async activeCount(): Promise<number> {
    return [...this.children.values()].filter((child) => child.pid && running(child.pid)).length;
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.children.values()].map(async (child) => {
      if (child.pid && running(child.pid)) await this.kill(child.pid);
    }));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map((error) => error.reason), 'Test host cleanup failed');
  }

  private async kill(pid: number): Promise<void> {
    const tree = new Map<number, ProcInfo>();
    const root = procInfo(pid);
    if (!root) return;
    tree.set(pid, root);
    const processes = fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).map((entry) => procInfo(Number(entry))).filter((entry): entry is ProcInfo => Boolean(entry));
    for (let found = true; found;) {
      found = false;
      for (const process of processes) {
        if (tree.has(process.parent) && !tree.has(process.pid)) {
          tree.set(process.pid, process);
          found = true;
        }
      }
    }
    const signal = (kind: NodeJS.Signals) => {
      for (const processInfo of [...tree.values()].reverse()) {
        if (procInfo(processInfo.pid)?.started !== processInfo.started) continue;
        try { process.kill(processInfo.pid === pid ? -pid : processInfo.pid, kind); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    };
    signal('SIGTERM');
    try { await until(() => [...tree.keys()].every((id) => !running(id)), 'test host stops gracefully', 1500); }
    catch {
      signal('SIGKILL');
      await until(() => [...tree.keys()].every((id) => !running(id)), 'test host force cleanup', 1500);
    }
  }
}

// The production Windows supervisor, counted. Hosts are real detached
// processes in the test's data directory.
class WindowsSupervisor implements SmokeSupervisor {
  private readonly inner = new DetachedHostSupervisor({ write() {} } as unknown as DebugLogService, process.env);
  private readonly directories = new Map<string, string>();
  starts = 0;
  stops = 0;

  async start(id: string, directory: string): Promise<void> {
    this.directories.set(id, directory);
    if (!await this.inner.isActive(id, directory)) this.starts++;
    await this.inner.start(id, directory);
  }

  isActive(id: string, directory: string): Promise<boolean> {
    return this.inner.isActive(id, directory);
  }

  async stop(id: string, directory: string, connection: TerminalService | undefined): Promise<void> {
    this.directories.set(id, directory);
    if (await this.inner.isActive(id, directory)) this.stops++;
    await this.inner.stop(id, directory, connection);
  }

  endpoint(id: string, directory: string): Promise<string> {
    return this.inner.endpoint(id, directory);
  }

  hostPids(): number[] {
    return [...this.directories.values()].flatMap((directory) => {
      try { return [(JSON.parse(fs.readFileSync(path.join(directory, 'host.json'), 'utf8')) as { pid: number }).pid]; }
      catch { return []; }
    });
  }

  async activeCount(): Promise<number> {
    let active = 0;
    for (const [id, directory] of this.directories) if (await this.inner.isActive(id, directory)) active++;
    return active;
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.directories].map(([id, directory]) => this.inner.stop(id, directory, undefined)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map((error) => error.reason), 'Test host cleanup failed');
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
