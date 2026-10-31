import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { CloseProcessAction } from '../app/Actions/CloseProcessAction';
import { DatabaseService } from '../app/Services/DatabaseService';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimerService } from '../app/Services/TimerService';

test('overdue timers retain their deadline and wait for runtime reconciliation', (t) => {
  const fixture = setup(t);
  let timers = fixture.create();
  timers.activate();
  const original = timers.setDelay({ seconds: 10, ownerProcessId: 'owner', body: 'deadline', label: 'wait' });
  t.mock.timers.tick(4_000);
  timers.dispose();
  fixture.database.dispose();
  t.mock.timers.tick(8_000);
  fixture.database.initialize();
  timers = fixture.create();
  assert.equal(timers.listMcp()[0]?.fires_at_unix_ms, original.firesAtUnixMs);
  t.mock.timers.tick(1_000);
  assert.equal(fixture.delivery.calls.length, 0, 'loading records must not deliver to unreconciled processes');
  timers.activate();
  t.mock.timers.tick(1);
  assert.deepEqual(fixture.delivery.calls, [{ process_id: 'pty_owner', kind: 'text', text: `[Patterm timer ${original.id} (wait): time elapsed]\ndeadline`, submit: true }]);
  timers.dispose();
  assert.deepEqual(fixture.create().listMcp(), [], 'delivered callbacks are not restored');
});

test('paused delays and watcher rescue deadlines survive restart', (t) => {
  const fixture = setup(t);
  let timers = fixture.create();
  timers.activate();
  const delay = timers.setDelay({ seconds: 10, ownerProcessId: 'owner', body: 'delay' });
  const report = timers.setReport({ kind: 'report_all', watched: ['child'], ownerProcessId: 'owner', body: 'rescue', maxWaitSeconds: 10, label: 'child report' });
  t.mock.timers.tick(4_000);
  timers.pause(delay.id);
  timers.pause(report.id);
  timers.dispose();
  t.mock.timers.tick(3_600_000);
  timers = fixture.create();
  timers.activate();
  assert.equal(timers.listMcp().find((timer) => timer.timer_id === report.id)?.paused_remaining_ms, 6_000);
  assert.deepEqual(timers.listMcp().find((timer) => timer.timer_id === report.id)?.watched, ['child']);
  assert.equal(timers.listMcp().find((timer) => timer.timer_id === report.id)?.label, 'child report');
  assert.equal(fixture.delivery.calls.length, 0);
  timers.resume(delay.id);
  timers.resume(report.id);
  timers.dispose();
  timers = fixture.create();
  timers.activate();
  t.mock.timers.tick(5_999);
  assert.equal(fixture.delivery.calls.length, 0);
  t.mock.timers.tick(1);
  // Watch timers lead with why they fired; the caller's body comes last.
  assert.deepEqual(fixture.delivery.calls.map((call) => call.text.split('\n').at(-1)).sort(), ['delay', 'rescue']);
  assert.match(fixture.delivery.calls.find((call) => call.text.endsWith('rescue'))!.text, /^\[Patterm timer timer_\w+ \(child report\): max_wait elapsed\]\n- child "child": still /);
});

test('a restarted owner\'s callbacks move to its successor and stay moved after restart', (t) => {
  const fixture = setup(t);
  let timers = fixture.create();
  timers.activate();
  timers.setDelay({ seconds: 10, ownerProcessId: 'owner', body: 'moved' });
  timers.setDelay({ seconds: 10, ownerProcessId: 'other', body: 'kept' });
  timers.transferOwner(['owner'], 'successor');
  timers.dispose();
  timers = fixture.create();
  assert.deepEqual(timers.listMcp().map((timer) => `${timer.owner_process_id}:${timer.body}`).sort(), ['other:kept', 'successor:moved']);
  timers.activate();
  t.mock.timers.tick(10_000);
  assert.deepEqual(fixture.delivery.calls.map((call) => `${call.process_id}:${call.text.split('\n').at(-1)}`).sort(), ['other:kept', 'successor:moved']);
});

test('idle watchers retain evidence that a child was busy before restart', (t) => {
  const fixture = setup(t);
  let timers = fixture.create();
  timers.activate();
  timers.setIdle({ kind: 'idle_all', watched: ['child'], ownerProcessId: 'owner', body: 'idle' });
  timers.dispose();
  // Keep equal timestamps so this can only be satisfied by saved busy evidence.
  fixture.database.connection.prepare("update processes set activity = 'idle' where id = 'child'").run();
  timers = fixture.create();
  assert.equal(fixture.delivery.calls.length, 0);
  timers.activate();
  assert.equal(fixture.delivery.calls.length, 1);
  assert.match(fixture.delivery.calls[0]!.text, /^\[Patterm timer timer_\w+: condition met\]\n- child "child": idle \(its turn ended\)\nidle$/);
});

test('an Integrated turn that ended with an error satisfies idle watchers', (t) => {
  const fixture = setup(t);
  const timers = fixture.create();
  timers.activate();
  fixture.database.connection.prepare("update processes set activity = 'working' where id = 'child'").run();
  timers.setIdle({ kind: 'idle_all', watched: ['child'], ownerProcessId: 'owner', body: 'ended' });
  assert.equal(fixture.delivery.calls.length, 0);
  fixture.database.connection.prepare("update processes set activity = 'error' where id = 'child'").run();
  t.mock.timers.tick(5_000);
  assert.equal(fixture.delivery.calls.length, 1);
  assert.match(fixture.delivery.calls[0]!.text, /^\[Patterm timer timer_\w+: condition met\]\n- child "child": its turn ended with an error\nended$/);
});

test('report watchers retain their original report cutoff after restart', (t) => {
  const fixture = setup(t);
  let timers = fixture.create();
  timers.activate();
  timers.setReport({ kind: 'report_all', watched: ['child', 'child_2'], ownerProcessId: 'owner', body: 'reported' });
  t.mock.timers.tick(1_000);
  fixture.report('child');
  timers.dispose();
  t.mock.timers.tick(2_000);
  timers = fixture.create();
  timers.activate();
  assert.equal(fixture.delivery.calls.length, 0, 'one report cannot satisfy report_all');
  fixture.report('child_2');
  t.mock.timers.tick(500);
  assert.equal(fixture.delivery.calls.length, 1);
  assert.match(fixture.delivery.calls[0]!.text, /^\[Patterm timer timer_\w+: condition met\]\n- child "child": reported completed at \S+\n- child_2 "child_2": reported completed at \S+\nRead full results with get_conversation_output\.\nreported$/);
});

test('explicit cancellation removes durable timers and failed sends are not replayed', async (t) => {
  const fixture = setup(t);
  let timers = fixture.create();
  timers.activate();
  const cancelled = timers.setDelay({ seconds: 10, ownerProcessId: 'owner', body: 'cancelled' });
  timers.cancel(cancelled.id);
  timers.setDelay({ seconds: 10, ownerProcessId: 'owner', body: 'quit' });
  timers.cancelAll();
  timers.dispose();
  timers = fixture.create();
  assert.deepEqual(timers.listMcp(), []);
  timers.activate();
  fixture.delivery.fail = true;
  timers.setDelay({ seconds: 0, ownerProcessId: 'owner', body: 'ambiguous delivery' });
  t.mock.timers.tick(1);
  await Promise.resolve();
  timers.dispose();
  timers = fixture.create();
  timers.activate();
  t.mock.timers.tick(60_000);
  assert.equal(fixture.delivery.calls.length, 1, 'a failed acknowledgement must not duplicate terminal input');
  assert.deepEqual(timers.listMcp(), []);
});

// Output watches search asynchronously; let their searches settle.
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

test('an output watch fires once when its literal text appears', async (t) => {
  const fixture = setup(t);
  const timers = fixture.create();
  timers.activate();
  fixture.output.set('pty_child', 'chunk 1/2');
  const watch = timers.setOutput({ processId: 'child', pattern: 'Done in|FAILED', ownerProcessId: 'owner', body: 'summarise it', label: 'backfill' });
  assert.equal(timers.listMcp()[0]?.pattern, 'Done in|FAILED');
  await settle();
  fixture.output.set('pty_child', 'chunk 1/2\nDone in 1.6 min');
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(fixture.delivery.calls.length, 0, 'the pattern is literal text, not a regex alternation');
  fixture.output.set('pty_child', 'chunk 1/2\nDone in 1.6 min\nDone in|FAILED marker');
  t.mock.timers.tick(1_000);
  await settle();
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(fixture.delivery.calls.length, 1, 'a watch delivers one callback');
  assert.equal(fixture.delivery.calls[0]!.process_id, 'pty_owner');
  assert.equal(fixture.delivery.calls[0]!.text, `[Patterm wait_for_pattern ${watch.id} (backfill): matched]\n- child "child": printed "Done in|FAILED": Done in|FAILED marker\nRead output with get_process_output or search_output.\nsummarise it`);
  assert.deepEqual(timers.listMcp(), []);
});

test('an output watch reports a process that ends without the text, with its exit code', async (t) => {
  const fixture = setup(t);
  const timers = fixture.create();
  timers.activate();
  timers.setOutput({ processId: 'child', pattern: 'Done in', ownerProcessId: 'owner', body: '' });
  await settle();
  fixture.database.connection.prepare("update processes set status = 'failed', exit_code = 3 where id = 'child'").run();
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(fixture.delivery.calls.length, 1);
  assert.match(fixture.delivery.calls[0]!.text, /^\[Patterm wait_for_pattern timer_\w+: ended without a match\]\n- child "child": failed with code 3 without printing "Done in"\n/);
});

test('output watches time out, cancel, and end with their owner', async (t) => {
  const fixture = setup(t);
  const timers = fixture.create();
  timers.activate();
  timers.setOutput({ processId: 'child', pattern: 'ready', ownerProcessId: 'owner', body: '', maxWaitSeconds: 3 });
  const cancelled = timers.setOutput({ processId: 'child', pattern: 'ready', ownerProcessId: 'owner', body: 'cancelled' });
  timers.setOutput({ processId: 'child', pattern: 'ready', ownerProcessId: 'child_2', body: 'owner closed' });
  timers.cancel(cancelled.id);
  timers.cancelOwnedBy(['child_2']);
  await settle();
  t.mock.timers.tick(3_000);
  await settle();
  assert.equal(fixture.delivery.calls.length, 1);
  assert.match(fixture.delivery.calls[0]!.text, /^\[Patterm wait_for_pattern timer_\w+: timed out\]\n- child "child": still running without printing "ready"\n/);
  fixture.output.set('pty_child', 'ready');
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(fixture.delivery.calls.length, 1, 'cancelled and owner-closed watches never fire');
});

test('closing its owner ends an output watch', async (t) => {
  const fixture = setup(t);
  const timers = fixture.create();
  timers.activate();
  timers.setOutput({ processId: 'child', pattern: 'ready', ownerProcessId: 'child_2', body: '' });
  timers.setOutput({ processId: 'child', pattern: 'ready', ownerProcessId: 'owner', body: 'kept' });
  await settle();
  await new CloseProcessAction(fixture.database, fixture.terminal).execute('child_2');
  fixture.output.set('pty_child', 'ready');
  t.mock.timers.tick(1_000);
  await settle();
  assert.deepEqual(fixture.delivery.calls.map((call) => call.process_id), ['pty_owner'], 'only the open owner is called back');
  assert.deepEqual(timers.listMcp(), []);
  assert.equal((fixture.database.connection.prepare('select count(*) as count from runtime_timers').get() as { count: number }).count, 0, 'the closed owner\'s watch is not restored');
});

test('an output watch survives restart and fires after reconciliation', async (t) => {
  const fixture = setup(t);
  let timers = fixture.create();
  timers.activate();
  timers.setOutput({ processId: 'child', pattern: 'Done in', ownerProcessId: 'owner', body: 'restored' });
  await settle();
  timers.dispose();
  fixture.output.set('pty_child', 'Done in 1.6 min');
  timers = fixture.create();
  assert.equal(timers.listMcp()[0]?.pattern, 'Done in');
  t.mock.timers.tick(5_000);
  await settle();
  assert.equal(fixture.delivery.calls.length, 0, 'restored watches wait for runtime reconciliation');
  timers.activate();
  await settle();
  assert.equal(fixture.delivery.calls.length, 1);
  assert.match(fixture.delivery.calls[0]!.text, /: matched\]\n- child "child": printed "Done in": Done in 1\.6 min\n.*\nrestored$/);
});

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-timer-recovery-'));
  const database = new DatabaseService(directory);
  database.initialize();
  const now = new Date().toISOString();
  database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)')
    .run('project', 'Timer fixture', directory, now, now);
  for (const id of ['owner', 'child', 'child_2']) {
    database.connection.prepare(`insert into processes (id,project_id,kind,name,status,activity,pty_process_id,created_at,updated_at)
      values (?, 'project', 'agent', ?, 'running', 'working', ?, ?, ?)`).run(id, id, `pty_${id}`, now, now);
  }
  const delivery = { fail: false, calls: [] as Array<{ process_id: string; kind: string; text: string; submit: boolean }> };
  // Output each terminal retains, searched like the sidecar's `all` scope.
  const output = new Map<string, string>();
  const terminal = { request: async (method: string, input: (typeof delivery.calls)[number] & { query?: string }) => {
    if (method === 'terminal.process.search') {
      const lines = (output.get(input.process_id) ?? '').split('\n').filter((line) => line.includes(input.query ?? ''));
      return { scope: 'all', total: lines.length, matches: lines.slice(-1).map((text) => ({ line: 0, text })) };
    }
    if (method !== 'terminal.process.input') return { ok: true };
    delivery.calls.push(input);
    if (delivery.fail) throw new Error('Simulated lost acknowledgement');
  } } as unknown as TerminalService;
  const services: TimerService[] = [];
  t.after(() => {
    for (const timers of services) timers.dispose();
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    database,
    delivery,
    output,
    terminal,
    create() {
      const timers = new TimerService(database, terminal, { persistent: true });
      services.push(timers);
      return timers;
    },
    report(processId: string) {
      database.connection.prepare(`insert into timeline_events (id, event_type, project_id, process_id, actor_type, created_at)
        values (?, 'agent.reported', 'project', ?, 'agent', ?)`).run(`report_${processId}`, processId, new Date().toISOString());
    }
  };
}
