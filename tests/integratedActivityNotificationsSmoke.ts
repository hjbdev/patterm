import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloseProcessAction } from '../app/Actions/CloseProcessAction';
import { CloseRequestActions } from '../app/Actions/CloseRequestActions';
import { integratedActivityNotifications } from '../app/Listeners/IntegratedActivityNotifications';
import { DatabaseService } from '../app/Services/DatabaseService';
import { IDLE_COMPACTION_AFTER_MS, IdleCompactionService, type IdleCompactionSource } from '../app/Services/IdleCompactionService';
import type { CompactionSignal, IntegratedActivityChange } from '../app/Services/IntegratedAgentService';
import { NotificationService } from '../app/Services/NotificationService';
import { SettingsService } from '../app/Services/SettingsService';
import type { TerminalService } from '../app/Services/TerminalService';
import { removeTree } from './fixtures/TempTree';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const AFTER = 40;
const SETTLE = AFTER * 3;

// The notification listener wired as App wires it: registered before idle
// compaction's own listener, with real notifications and close requests.
async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-activity-notifications-test-'));
  const database = new DatabaseService(directory);
  let idleCompaction: IdleCompactionService | null = null;
  try {
    database.initialize();
    const db = database.connection;
    const at = new Date(0).toISOString();
    db.prepare('insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)').run('project_a', 'Alpha', directory, at, at);
    db.prepare(`insert into processes (id, project_id, kind, name, status, activity, pty_process_id, created_at, updated_at)
      values ('agent', 'project_a', 'agent', 'agent', 'running', 'idle', 'pty_agent', ?, ?)`).run(at, at);
    db.prepare(`insert into sessions (id, project_id, process_id, harness, session_role, interface_mode, started_at)
      values ('session_agent', 'project_a', 'agent', 'claude', 'orchestrator', 'integrated', ?)`).run(at);
    IDLE_COMPACTION_AFTER_MS.claude = AFTER;

    const listeners: Array<(change: IntegratedActivityChange) => void> = [];
    let signal: ((processId: string, signal: CompactionSignal) => void) | undefined;
    let compactions = 0;
    const source: IdleCompactionSource = {
      onActivityChange(listener) { listeners.push(listener); return () => {}; },
      onCompactionSignal(listener) { signal = listener; return () => {}; },
      onConversationEvent() { return () => {}; },
      async compact(processId) { signal?.(processId, 'compact'); compactions += 1; },
      async model() { return null; },
      async lastActivity() { return null; }
    };
    const activity = (value: string) => {
      const { activity: previous } = db.prepare(`select activity from processes where id = 'agent'`).get() as { activity: string };
      db.prepare(`update processes set activity = ? where id = 'agent'`).run(value);
      for (const listener of listeners) listener({ processId: 'agent', previous, activity: value, snapshot: false });
    };
    const notifications = new NotificationService(database, new SettingsService(database), { append: () => 'event' }, async () => {}, () => undefined);
    const terminal = { request: async () => ({}) } as unknown as TerminalService;
    const closeRequests = new CloseRequestActions(database, { append: () => 'event' }, new CloseProcessAction(database, terminal, undefined, undefined, notifications, () => {}), async () => {}, () => {}, notifications);
    const compaction = new IdleCompactionService(database, source, () => true);
    idleCompaction = compaction;
    const raised: string[] = [];
    listeners.push(integratedActivityNotifications({
      notifications,
      raise: (input) => { raised.push(input.kind); void notifications.raise(input); },
      closeRequests: () => closeRequests,
      isAssistant: () => false,
      wokeFromSnooze: () => false,
      compacting: (processId) => compaction.compacting(processId),
      triage: () => ({ quiet: false, reason: 'disabled' }),
      log: () => {}
    }));
    compaction.start();
    const open = () => notifications.list({ process_id: 'agent' }).items.map((item) => `${item.kind}:${item.title}`).sort();

    // A turn asks the user a question and asks to be closed.
    signal?.('agent', 'turn');
    activity('working');
    await notifications.raise({ processId: 'agent', source: 'mcp', kind: 'attention', title: 'Decision needed', body: 'Pick one.' });
    await closeRequests.request('agent', { summary: 'Shipped.' });
    activity('idle');
    await wait(5);
    const asked = open();
    assert.deepEqual(asked, ['attention:Decision needed', 'attention:Ready to close']);

    // The automatic compaction an hour later leaves both open and is not
    // announced, neither as a finished turn nor as the close request again.
    await wait(SETTLE);
    assert.equal(compactions, 1);
    activity('working');
    assert.equal(closeRequests.pending('agent'), true, 'a compaction does not clear the close request');
    activity('idle');
    await wait(5);
    assert.deepEqual(open(), asked, 'a compaction resolves none of the user\'s notifications');
    assert.equal(notifications.list({ process_id: 'agent' }).items.find((item) => item.title === 'Ready to close')?.occurrences, 1, 'the close request is not announced again');
    assert.equal(raised.includes('turn_finished'), false);
    assert.equal(compaction.compacting('agent'), false);

    // The user's next turn is new work: it resolves them and is announced.
    signal?.('agent', 'turn');
    activity('working');
    assert.equal(closeRequests.pending('agent'), false, 'new work makes the close request stale');
    activity('idle');
    await wait(5);
    assert.deepEqual(open(), ['turn_finished:agent']);

    // A failed automatic compaction does not report an error.
    await wait(SETTLE);
    assert.equal(compactions, 2);
    activity('working');
    activity('error');
    await wait(5);
    assert.equal(raised.includes('failure'), false, 'a failed compaction is not an agent error');
    assert.equal(compaction.compacting('agent'), false);
    activity('idle');
    activity('working');
    activity('error');
    assert.equal(raised.at(-1), 'failure', 'a failed turn still reports its error');
  } finally {
    idleCompaction?.dispose();
    database.dispose();
    removeTree(directory);
  }
  console.log('integrated activity notifications smoke passed');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
