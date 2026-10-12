import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ReconcileRuntimeAction } from '../app/Actions/ReconcileRuntimeAction';
import { StopProcessAction } from '../app/Actions/StopProcessAction';
import { ProcessLauncher } from '../app/Services/ProcessLauncher';
import { RuntimeReconciler, type LifecycleSource } from '../app/Services/RuntimeReconciler';
import type { SpawnSink } from '../app/Services/HarnessLauncher';
import type { TerminalService } from '../app/Services/TerminalService';
import { DatabaseService } from '../app/Services/DatabaseService';
import { TimelineService } from '../app/Services/TimelineService';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { defaultShell, shellArgv } from '../app/Platform/Shell';
import { removeTree } from './fixtures/TempTree';

interface ProcessRow {
  id: string;
  kind: string;
  name: string;
  status: string;
  cwd: string | null;
  pty_process_id: string | null;
  auto_restart: number;
  argv: string | null;
  worktree_id: string | null;
  exited_at: string | null;
  exit_code: number | null;
}

type LifecycleFrame = { type: 'terminal-lifecycle'; processId: string; event: string; activity?: string; title?: string; exitCode?: number | null };

const SHELL = defaultShell();
// Spawn arguments for the shell running `command`, or an interactive shell.
const shellArgs = (command?: string): string[] => shellArgv(SHELL, command).slice(1);

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-process-'));
  try {
    const database = new DatabaseService(tempDir);
    database.initialize();
    const timeline = new TimelineService(database);
    const repo = new WorkbenchRepository(database);

    const projectId = 'project_test';
    const projectPath = path.join(tempDir, 'repo');
    const now = new Date().toISOString();
    database.connection
      .prepare(`insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)`)
      .run(projectId, 'Process Test', projectPath, now, now);
    const worktreePath = path.join(projectPath, '.worktrees', 'worktree-a');
    database.connection
      .prepare(
        `insert into worktrees (id, project_id, repo_path, worktree_path, branch, created_by, created_at)
         values (?, ?, ?, ?, ?, 'user', ?)`
      )
      .run('worktree_test', projectId, projectPath, worktreePath, 'patterm/worktree-a', now);

    const spawns: Array<Record<string, unknown>> = [];
    const stops: Array<Record<string, unknown>> = [];
    const closes: Array<Record<string, unknown>> = [];
    let ptyCounter = 0;
    const terminal: SpawnSink = {
      request: async (method, params) => {
        if (method === 'terminal.process.stop') {
          stops.push(params as Record<string, unknown>);
          return { ok: true };
        }
        if (method === 'terminal.process.close') {
          const id = (params as { process_id: string }).process_id;
          assert.equal(database.connection.prepare('select id from processes where pty_process_id = ?').get(id), undefined, 'release replaced runtime after recording its successor');
          closes.push(params as Record<string, unknown>);
          return { ok: true };
        }
        spawns.push(params as Record<string, unknown>);
        ptyCounter += 1;
        return { process_id: `proc_${ptyCounter}` };
      }
    };

    const launcher = new ProcessLauncher({ database, timeline, terminal, workbench: repo });

    // A freeform command is shell-wrapped and recorded as a running command process.
    const created = await launcher.create({ project_id: projectId, name: 'dev', command: 'npm run dev', auto_restart: true });
    assert.equal(created.pty_process_id, 'proc_1');
    const firstSpawn = spawns[0]!;
    assert.equal(firstSpawn.command, SHELL);
    assert.deepEqual(firstSpawn.args, shellArgs('npm run dev'));
    assert.equal(firstSpawn.kind, 'command');
    assert.equal(firstSpawn.cwd, projectPath, 'cwd defaults to the project path');

    const row = database.connection
      .prepare(`select * from processes where id = ?`)
      .get(created.process_id) as ProcessRow | undefined;
    assert.equal(row?.kind, 'command');
    assert.equal(row?.status, 'running');
    assert.equal(row?.pty_process_id, 'proc_1');
    assert.equal(row?.auto_restart, 1);
    assert.deepEqual(JSON.parse(row?.argv ?? '[]'), [SHELL, ...shellArgs('npm run dev')]);

    // A worktree-associated process uses the worktree cwd and stores the association.
    const inWorktree = await launcher.create({ project_id: projectId, worktree_id: 'worktree_test' });
    const worktreeSpawn = spawns[1]!;
    assert.equal(worktreeSpawn.cwd, worktreePath);
    const worktreeRow = database.connection.prepare(`select worktree_id from processes where id = ?`).get(inWorktree.process_id) as {
      worktree_id: string | null;
    };
    assert.equal(worktreeRow.worktree_id, 'worktree_test');

    // FK ordering: the process.started timeline event references the row id.
    const started = database.connection
      .prepare(`select count(*) as n from timeline_events where event_type = 'process.started' and process_id = ?`)
      .get(created.process_id) as { n: number };
    assert.equal(started.n, 1, 'process.started recorded against the process row');

    // "Open terminal" (no command) → interactive shell, no -lc.
    const shell = await launcher.create({ project_id: projectId });
    const shellSpawn = spawns[2]!;
    assert.equal(shellSpawn.command, SHELL);
    assert.deepEqual(shellSpawn.args, shellArgs());
    const shellRow = database.connection.prepare(`select name from processes where id = ?`).get(shell.process_id) as { name: string };
    assert.equal(shellRow.name, 'terminal');

    const lifecycleListeners = new Set<(frame: LifecycleFrame) => void>();
    const lifecycleSource: LifecycleSource = {
      onFrame: (listener) => {
        lifecycleListeners.add(listener as (frame: LifecycleFrame) => void);
        return () => lifecycleListeners.delete(listener as (frame: LifecycleFrame) => void);
      }
    };
    let changedCount = 0;
    const reconciler = new RuntimeReconciler(database, timeline, launcher, null, lifecycleSource, () => {
      changedCount += 1;
    });
    for (const listener of lifecycleListeners) {
      listener({ type: 'terminal-lifecycle', processId: created.pty_process_id, event: 'activity', activity: 'working' });
    }
    const activeProcess = repo.snapshot().projects[0]?.processes.find((process) => process.id === created.process_id);
    assert.equal(activeProcess?.activity, 'working', 'activity frame updates process snapshot');
    assert.equal(activeProcess?.command, 'npm run dev', 'process snapshot exposes editable command text');
    assert.equal(activeProcess?.cwd, projectPath, 'process snapshot exposes editable cwd');
    assert.deepEqual(activeProcess?.argv, [SHELL, ...shellArgs('npm run dev')], 'process snapshot exposes stored argv');
    database.connection.exec('pragma busy_timeout = 1');
    try {
      withWriterLock(database.dbPath, () => {
        assert.doesNotThrow(() => {
          for (const listener of lifecycleListeners) {
            listener({ type: 'terminal-lifecycle', processId: created.pty_process_id, event: 'activity', activity: 'idle' });
          }
        }, 'transient DB locks from background import do not crash lifecycle reconciliation');
      });
      await waitFor(() => {
        const row = database.connection.prepare(`select activity from processes where id = ?`).get(created.process_id) as { activity: string } | undefined;
        return row?.activity === 'idle';
      }, 'locked activity frame is applied after the DB lock clears');

      withWriterLock(database.dbPath, () => {
        for (const listener of lifecycleListeners) {
          listener({ type: 'terminal-lifecycle', processId: inWorktree.pty_process_id, event: 'exit', exitCode: 127 });
        }
      });
      await waitFor(() => {
        const row = database.connection.prepare(`select status from processes where id = ?`).get(inWorktree.process_id) as { status: string } | undefined;
        return row?.status === 'failed';
      }, 'locked exit frame is applied after the DB lock clears');
    } finally {
      database.connection.exec('pragma busy_timeout = 5000');
    }
    database.connection
      .prepare(
        `insert into sessions (id, project_id, session_role, resume_status, started_at, process_id)
         values (?, ?, 'orchestrator', 'unknown', ?, ?)`
      )
      .run('session_activity', projectId, now, created.process_id);
    const activeSession = repo.snapshot().projects[0]?.projectSessions.find((session) => session.id === 'session_activity');
    assert.equal(activeSession?.activity, 'idle', 'session activity is derived from the linked process');
    assert.ok(changedCount >= 1, 'activity change notifies renderer refresh');
    const titleChangesBefore = changedCount;
    for (const title of ['⠏ Investigating', '⠹ Investigating', '⠸ Investigating', 'Investigating']) {
      for (const listener of lifecycleListeners) {
        listener({ type: 'terminal-lifecycle', processId: created.pty_process_id, event: 'title', title });
      }
    }
    assert.equal(changedCount - titleChangesBefore, 1, 'spinner changes do not invalidate the workbench');
    assert.equal(repo.snapshot().projects[0]?.projectSessions.find(session => session.id === 'session_activity')?.lastTitle, 'Investigating');
    for (const listener of lifecycleListeners) {
      listener({ type: 'terminal-lifecycle', processId: created.pty_process_id, event: 'title', title: 'Reviewing results' });
    }
    assert.equal(changedCount - titleChangesBefore, 2, 'meaningful title changes still refresh the workbench');
    const failedWorktreeProcess = database.connection
      .prepare(`select status, exit_code, exited_at from processes where id = ?`)
      .get(inWorktree.process_id) as { status: string; exit_code: number | null; exited_at: string | null };
    assert.equal(failedWorktreeProcess.status, 'failed', 'non-zero process exits are marked failed');
    assert.equal(failedWorktreeProcess.exit_code, 127, 'process exit code is stored');
    assert.ok(failedWorktreeProcess.exited_at, 'process exit timestamp is stored');
    reconciler.dispose();

    // Relaunch re-attaches a fresh PTY reusing the stored argv.
    database.connection.prepare(`update processes set status = 'failed', exited_at = ?, exit_code = 127 where id = ?`).run(now, created.process_id);
    const relaunched = await launcher.relaunch(created.process_id);
    assert.equal(relaunched.pty_process_id, 'proc_4');
    const lastSpawn = spawns[3]!;
    assert.deepEqual(lastSpawn.args, shellArgs('npm run dev'), 'relaunch reuses the stored argv');
    const afterRelaunch = database.connection
      .prepare(`select status, pty_process_id, exited_at, exit_code from processes where id = ?`)
      .get(created.process_id) as { status: string; pty_process_id: string; exited_at: string | null; exit_code: number | null };
    assert.equal(afterRelaunch.status, 'running');
    assert.equal(afterRelaunch.pty_process_id, 'proc_4');
    assert.equal(afterRelaunch.exited_at, null, 'relaunch clears previous exit timestamp');
    assert.equal(afterRelaunch.exit_code, null, 'relaunch clears previous exit code');
    assert.deepEqual(closes, [{ process_id: 'proc_1' }], 'relaunch releases the previous exited terminal');

    // Editing labels/settings without command or cwd changes does not disturb the live PTY.
    const renamed = await launcher.update({ process_id: created.process_id, name: 'dev renamed', command: 'npm run dev', cwd: projectPath, auto_restart: false });
    assert.equal(renamed.restarted, false);
    assert.equal(spawns.length, 4, 'name/auto-restart-only updates do not spawn');
    if (process.platform === 'win32') {
      const respelled = await launcher.update({ process_id: created.process_id, name: 'dev renamed', command: 'npm run dev', cwd: projectPath.replace(/\\/g, '/').toUpperCase(), auto_restart: false });
      assert.equal(respelled.restarted, false, 'the same directory spelled with another case and separators is not a cwd change');
      assert.equal(spawns.length, 4);
    }
    const renamedRow = database.connection.prepare(`select name, auto_restart from processes where id = ?`).get(created.process_id) as {
      name: string;
      auto_restart: number;
    };
    assert.equal(renamedRow.name, 'dev renamed');
    assert.equal(renamedRow.auto_restart, 0);

    // Editing command/cwd on a running process restarts it immediately with the new launch settings.
    const edited = await launcher.update({ process_id: created.process_id, name: 'dev edited', command: 'pnpm dev', cwd: worktreePath, auto_restart: true });
    assert.equal(edited.restarted, true);
    assert.deepEqual(stops.at(-1), { process_id: 'proc_4' }, 'editing command/cwd stops the previous PTY');
    const editedSpawn = spawns.at(-1)!;
    assert.equal(editedSpawn.command, SHELL);
    assert.deepEqual(editedSpawn.args, shellArgs('pnpm dev'));
    assert.equal(editedSpawn.cwd, worktreePath);
    const editedRow = database.connection
      .prepare(`select name, cwd, argv, auto_restart, pty_process_id, status, exited_at, exit_code from processes where id = ?`)
      .get(created.process_id) as ProcessRow;
    assert.equal(editedRow.name, 'dev edited');
    assert.equal(editedRow.cwd, worktreePath);
    assert.deepEqual(JSON.parse(editedRow.argv ?? '[]'), [SHELL, ...shellArgs('pnpm dev')]);
    assert.equal(editedRow.auto_restart, 1);
    assert.equal(editedRow.pty_process_id, 'proc_5');
    assert.equal(editedRow.status, 'running');
    assert.equal(editedRow.exited_at, null);
    assert.equal(editedRow.exit_code, null);
    assert.deepEqual(closes.at(-1), { process_id: 'proc_4' }, 'successful editing releases the previous stopped terminal');

    const stopped = await new StopProcessAction(database, terminal as unknown as TerminalService).execute(created.process_id);
    assert.equal(stopped.status, 'stopped', 'stop action reports stopped status');
    assert.deepEqual(stops.at(-1), { process_id: 'proc_5' }, 'stop action stops the current PTY');
    const stoppedRow = database.connection.prepare(`select status, exited_at from processes where id = ?`).get(created.process_id) as {
      status: string;
      exited_at: string | null;
    };
    assert.equal(stoppedRow.status, 'stopped', 'stop action persists stopped process status');
    assert.ok(stoppedRow.exited_at, 'stop action stores a stopped timestamp');
    const stoppedSession = database.connection.prepare(`select exited_at from sessions where id = 'session_activity'`).get() as { exited_at: string | null };
    assert.ok(stoppedSession.exited_at, 'stop action marks linked sessions exited');

    const failedReplacement = new ProcessLauncher({ database, timeline, workbench: repo, terminal: {
      request: async () => { throw new Error('replacement spawn failed'); }
    } });
    const closeCount = closes.length;
    await assert.rejects(failedReplacement.relaunch(created.process_id), /replacement spawn failed/);
    assert.equal(closes.length, closeCount, 'failed replacement retains the previous terminal for inspection');
    assert.equal((database.connection.prepare('select pty_process_id from processes where id = ?').get(created.process_id) as ProcessRow).pty_process_id, 'proc_5');

    const cleanupFailure = new ProcessLauncher({ database, timeline, workbench: repo, terminal: {
      request: async (method, params) => {
        if (method === 'terminal.process.close') throw new Error('cleanup failed');
        return terminal.request(method, params);
      }
    } });
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const replacement = await cleanupFailure.relaunch(created.process_id);
      assert.equal(replacement.pty_process_id, 'proc_6', 'cleanup failure does not reject a successful relaunch');
      assert.equal((database.connection.prepare('select status from processes where id = ?').get(created.process_id) as ProcessRow).status, 'running');
      assert.equal(warnings.length, 1, 'cleanup failure remains visible in the application log');
    } finally {
      console.warn = originalWarn;
    }

    // A database failure after spawning must release only the unregistered PTY.
    const processCount = database.connection.prepare('select count(*) as count from processes').get() as { count: number };
    database.connection.exec(`create trigger fail_process_insert before insert on processes begin select raise(abort, 'registration failed'); end`);
    try {
      await assert.rejects(launcher.create({ project_id: projectId }), /registration failed/);
      assert.deepEqual(closes.at(-1), { process_id: 'proc_7' });
      assert.deepEqual(database.connection.prepare('select count(*) as count from processes').get(), processCount);
    } finally {
      database.connection.exec('drop trigger fail_process_insert');
    }
    database.connection.exec(`create trigger fail_process_update before update on processes begin select raise(abort, 'replacement registration failed'); end`);
    try {
      await assert.rejects(launcher.update({ process_id: created.process_id, name: 'failed edit', command: 'different command' }), /replacement registration failed/);
      assert.deepEqual(closes.at(-1), { process_id: 'proc_8' }, 'failed update releases its unregistered replacement');
      assert.equal((database.connection.prepare('select pty_process_id from processes where id = ?').get(created.process_id) as ProcessRow).pty_process_id, 'proc_6');
      await assert.rejects(launcher.relaunch(created.process_id), /replacement registration failed/);
      assert.deepEqual(closes.at(-1), { process_id: 'proc_9' }, 'failed relaunch releases its unregistered replacement');
      assert.equal((database.connection.prepare('select pty_process_id from processes where id = ?').get(created.process_id) as ProcessRow).pty_process_id, 'proc_6');
      assert.equal(closes.some((params) => params.process_id === 'proc_6'), false, 'failed registrations retain the previous terminal');
    } finally {
      database.connection.exec('drop trigger fail_process_update');
    }

    // Startup reconciliation marks leftover running rows dead.
    database.connection
      .prepare(
        `insert into sessions (id, project_id, session_role, resume_status, started_at, process_id)
         values (?, ?, 'orchestrator', 'unknown', ?, 'proc_99')`
      )
      .run(`session_${randomUUID()}`, projectId, now);
    const reconciled = new ReconcileRuntimeAction(database).execute();
    assert.ok(reconciled.processes >= 1, 'a running process was reconciled');
    assert.ok(reconciled.sessions >= 1, 'a live session was reconciled');
    const runningLeft = database.connection.prepare(`select count(*) as n from processes where status = 'running'`).get() as { n: number };
    assert.equal(runningLeft.n, 0, 'no processes remain running after reconciliation');
    const liveSessions = database.connection.prepare(`select count(*) as n from sessions where exited_at is null`).get() as { n: number };
    assert.equal(liveSessions.n, 0, 'no sessions remain live after reconciliation');
    const retainedHandles = database.connection.prepare(`select count(*) as n from processes where pty_process_id is not null`).get() as { n: number };
    assert.equal(retainedHandles.n, 0, 'startup discards handles owned by the previous sidecar');

    database.dispose();
    // eslint-disable-next-line no-console
    console.log('process launch smoke ok');
  } finally {
    removeTree(tempDir);
  }
}

function withWriterLock(dbPath: string, callback: () => void): void {
  const locker = new DatabaseSync(dbPath);
  try {
    locker.exec('pragma journal_mode = WAL');
    locker.exec('begin immediate');
    callback();
  } finally {
    locker.exec('rollback');
    locker.close();
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(label);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
