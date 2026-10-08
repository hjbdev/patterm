import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { QuitApplicationAction } from '../app/Actions/QuitApplicationAction';
import { ReconcileRuntimeAction } from '../app/Actions/ReconcileRuntimeAction';
import { DatabaseService } from '../app/Services/DatabaseService';
import type { OpenCodeServerService } from '../app/Services/OpenCodeServerService';
import type { ProcessLauncher } from '../app/Services/ProcessLauncher';
import { RuntimeReconciler, type LifecycleSource } from '../app/Services/RuntimeReconciler';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { TimerService } from '../app/Services/TimerService';

test('an exit captured after startup inventory is replayed after subscribing to live events', (t) => {
  const fixture = setup(t);
  new ReconcileRuntimeAction(fixture.database).execute([{
    process_id: 'pty_fixture', status: 'running', exit_code: null, activity: 'working', title: 'Fixture'
  }]);
  assert.equal(fixture.process().status, 'running');
  assert.equal(fixture.session().exited_at, null);

  let subscribed = false;
  let notifications = 0;
  const source: LifecycleSource = {
    onFrame: () => {
      subscribed = true;
      return () => { subscribed = false; };
    }
  };
  function* capturedFrames() {
    assert.equal(subscribed, true, 'subscribe before draining the startup buffer');
    yield { type: 'terminal-lifecycle', processId: 'pty_fixture', event: 'exit', exitCode: 41 };
  }
  const launcher = { relaunch: () => assert.fail('a process without auto-restart must stay exited') } as unknown as ProcessLauncher;
  const reconciler = new RuntimeReconciler(
    fixture.database, new TimelineService(fixture.database), launcher, null, source,
    () => { notifications++; }, null, null, capturedFrames()
  );
  t.after(() => reconciler.dispose());
  assert.equal(fixture.process().status, 'failed');
  assert.equal(fixture.process().exit_code, 41);
  assert.ok(fixture.process().exited_at);
  assert.equal(fixture.session().exit_code, 41);
  assert.ok(fixture.session().exited_at, 'the session cannot remain live after a buffered process exit');
  assert.equal(fixture.session().resume_id, 'ses_fixture');
  assert.ok(notifications > 0, 'replayed exits refresh the workbench');
});

for (const failure of ['terminal', 'opencode'] as const) {
  test(`failed ${failure} shutdown preserves ownership and retries before marking processes stopped`, async (t) => {
    const fixture = setup(t);
    let fail = true;
    const counts = { begin: 0, coordination: 0, opencode: 0, terminal: 0 };
    const originalProcess = fixture.process();
    const originalSession = fixture.session();
    const terminal = {
      beginShutdown: () => { counts.begin++; },
      shutdown: async () => {
        counts.terminal++;
        assert.deepEqual(fixture.process(), originalProcess, 'retain the PTY handle until all shutdown steps succeed');
        assert.equal(timers.listMcp().length, 0, 'cancel timers before stopping hosts');
        if (fail && failure === 'terminal') throw new Error('Simulated host stop failure');
      }
    } as unknown as TerminalService;
    const opencode = {
      interruptAll: async () => {
        counts.opencode++;
        assert.deepEqual(fixture.session(), originalSession, 'retain the active native session so interruption can be retried');
        if (fail && failure === 'opencode') throw new Error('Simulated native interruption failure');
      }
    } as unknown as OpenCodeServerService;
    const timers = new TimerService(fixture.database, terminal, { persistent: true });
    t.after(() => timers.dispose());
    timers.setDelay({ seconds: 3600, ownerProcessId: 'process_fixture', body: 'cancel this callback' });
    const action = new QuitApplicationAction(fixture.database, terminal, timers, opencode, async () => { counts.coordination++; });
    const pending = action.execute();
    assert.equal(action.execute(), pending, 'concurrent Quit requests share one shutdown attempt');
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.match(String(error.errors[0]), failure === 'terminal' ? /host stop failure/ : /native interruption failure/);
      return true;
    });
    assert.deepEqual(fixture.process(), originalProcess);
    assert.deepEqual(fixture.session(), originalSession);
    assert.deepEqual(counts, { begin: 1, coordination: 1, opencode: 1, terminal: 1 }, 'other cleanup steps still run after a failure');
    assert.equal(fixture.timerCount(), 0, 'failed Quit still removes durable timers');

    fail = false;
    timers.setDelay({ seconds: 3600, ownerProcessId: 'process_fixture', body: 'cancel on retry' });
    await action.execute();
    assert.deepEqual(counts, { begin: 2, coordination: 2, opencode: 2, terminal: 2 }, 'retry reattempts native interruption and host shutdown');
    assert.equal(fixture.process().status, 'exited');
    assert.equal(fixture.process().pty_process_id, null);
    assert.ok(fixture.process().exited_at);
    assert.ok(fixture.session().exited_at);
    assert.equal(fixture.session().resume_id, 'ses_fixture', 'successful shutdown keeps native resume metadata');
    assert.equal(fixture.timerCount(), 0);
    await action.execute();
    assert.deepEqual(counts, { begin: 2, coordination: 2, opencode: 2, terminal: 2 }, 'completed shutdown is idempotent');
  });
}

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-shutdown-'));
  const database = new DatabaseService(directory);
  database.initialize();
  const now = new Date().toISOString();
  database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)')
    .run('project', 'Shutdown fixture', directory, now, now);
  database.connection.prepare(`insert into processes (id,project_id,kind,name,status,activity,pty_process_id,created_at,updated_at)
    values ('process_fixture', 'project', 'agent', 'Fixture', 'running', 'working', 'pty_fixture', ?, ?)`).run(now, now);
  database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,mcp_identity,resume_id,started_at,session_role,resume_status,created_by_actor)
    values ('session_fixture', 'project', 'process_fixture', 'opencode', 'identity_fixture', 'ses_fixture', ?, 'orchestrator', 'found', 'user')`).run(now);
  t.after(() => {
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    database,
    process: () => database.connection.prepare('select status, pty_process_id, exit_code, exited_at from processes where id = ?').get('process_fixture') as {
      status: string; pty_process_id: string | null; exit_code: number | null; exited_at: string | null;
    },
    session: () => database.connection.prepare('select exited_at, exit_code, resume_id, mcp_identity from sessions where id = ?').get('session_fixture') as {
      exited_at: string | null; exit_code: number | null; resume_id: string; mcp_identity: string;
    },
    timerCount: () => (database.connection.prepare('select count(*) as n from runtime_timers').get() as { n: number }).n
  };
}
