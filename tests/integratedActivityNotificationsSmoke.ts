import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloseProcessAction } from '../app/Actions/CloseProcessAction';
import { CloseRequestActions } from '../app/Actions/CloseRequestActions';
import { integratedActivityNotifications, REPLY_PREVIEW_LIMIT } from '../app/Listeners/IntegratedActivityNotifications';
import { DatabaseService } from '../app/Services/DatabaseService';
import { IDLE_COMPACTION_AFTER_MS, IdleCompactionService, type IdleCompactionSource } from '../app/Services/IdleCompactionService';
import { IntegratedAgentService, type CompactionSignal, type IntegratedActivityChange, type IntegratedProviderService } from '../app/Services/IntegratedAgentService';
import type { IntegratedConversationListener } from '../app/Services/IntegratedConversation';
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
    let botReply: string | null = null;
    listeners.push(integratedActivityNotifications({
      notifications,
      raise: (input) => { raised.push(input.kind); void notifications.raise(input); },
      closeRequests: () => closeRequests,
      isAssistant: () => false,
      wokeFromSnooze: () => false,
      compacting: (processId) => compaction.compacting(processId),
      triage: () => ({ quiet: false, reason: 'disabled' }),
      botReply: () => botReply,
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
    const finished = () => notifications.list({ process_id: 'agent' }).items.find((item) => item.kind === 'turn_finished');
    assert.equal(finished()?.body, 'Finished its turn', 'without a reply the turn is announced as before');

    // A bot's turn shows its reply as plain text, previewed when long.
    botReply = '  **Inbox** is clear: [2 replies](https://example.com) sent.  ';
    activity('working');
    activity('idle');
    await wait(5);
    assert.equal(finished()?.body, 'Inbox is clear: 2 replies sent.');
    botReply = 'word '.repeat(200);
    activity('working');
    activity('idle');
    await wait(5);
    const preview = finished()?.body ?? '';
    assert.equal(preview.length, REPLY_PREVIEW_LIMIT);
    assert.ok(preview.endsWith('…'));
    botReply = '   ';
    activity('working');
    activity('idle');
    await wait(5);
    assert.equal(finished()?.body, 'Finished its turn', 'a blank reply falls back');
    botReply = '![](https://example.com/image.png)';
    activity('working');
    activity('idle');
    await wait(5);
    assert.equal(finished()?.body, 'Finished its turn', 'a reply with no plain text falls back');
    assert.deepEqual(open(), ['turn_finished:agent'], 'previews keep one turn notification');
    botReply = null;

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

    // Reproduce the bot's failed retry through the real activity listener,
    // not two unrelated calls to raise(). User notification settings are off.
    compaction.dispose();
    db.prepare(`insert into processes (id, project_id, kind, name, status, created_at, updated_at)
      values ('bot-parent', 'project_a', 'agent', 'bot', 'running', ?, ?)`).run(at, at);
    db.prepare(`insert into sessions (id, project_id, process_id, harness, session_role, bot_id, started_at)
      values ('session_parent', 'project_a', 'bot-parent', 'claude', 'bot', 'test-bot', ?)`).run(at);
    db.prepare(`update processes set parent_process_id = 'bot-parent' where id = 'agent'`).run();
    const settings = new SettingsService(database);
    settings.updateNotificationSettings({ sources: { agent_failures: 'off', integrated_turn_finished: 'off', integrated_permission: 'off' } });
    const parentMessages: string[] = [];
    const notices = new NotificationService(database, settings, { append: () => 'event' },
      async (target, text) => { assert.equal(target, 'bot-parent'); parentMessages.push(text); }, () => {});
    let automaticCompaction = false;
    const pending: Array<Promise<unknown>> = [];
    const notify = integratedActivityNotifications({
      notifications: notices,
      raise: (input) => { pending.push(notices.raise(input)); },
      closeRequests: () => null,
      isAssistant: () => false,
      wokeFromSnooze: () => false,
      compacting: () => automaticCompaction,
      triage: () => ({ quiet: true, reason: 'model', probability: 0.99, waiting: false }),
      botReply: () => null,
      log: () => {}
    });
    const event = async (previous: string, next: string, snapshot = false) => {
      notify({ processId: 'agent', previous, activity: next, snapshot });
      await Promise.all(pending.splice(0));
    };
    notices.resolve({ process_id: 'agent' });
    await event('idle', 'working');
    await event('working', 'error');
    assert.equal(parentMessages.length, 1);
    for (let i = 0; i < 20; i += 1) await event('error', 'error', true);
    assert.equal(parentMessages.length, 1, 'reconnect error snapshots do not spam the parent');
    await event('error', 'working', true);
    await event('working', 'error', true);
    assert.equal(parentMessages.length, 1, 'reconnect work does not create a failure episode');
    automaticCompaction = true;
    await event('error', 'working');
    await event('working', 'idle');
    automaticCompaction = false;
    await event('idle', 'error', true);
    assert.equal(parentMessages.length, 1, 'automatic compaction does not reset the failure');
    await event('error', 'working');
    await event('working', 'error');
    assert.equal(parentMessages.length, 2, 'an identical failure after a real retry reaches the bot');
    assert.equal(parentMessages[0], parentMessages[1]);
    await event('error', 'thinking');
    await event('thinking', 'error');
    assert.equal(parentMessages.length, 3, 'a retry can begin with thinking');
    await event('error', 'working');
    await event('working', 'idle');
    assert.equal(parentMessages.length, 4, 'a successful retry reaches the bot even when triage quiets it');
    assert.match(parentMessages.at(-1)!, /Notification from agent/);
    const failures = notices.list({ process_id: 'agent', include_resolved: true }).items.filter((item) => item.kind === 'failure');
    assert.equal(failures.filter((item) => !item.resolved_at).length, 0, 'resumed work closes stale failures');
    assert.ok(failures.length >= 3, 'retry failures remain in history');

    // Exercise the upstream service too: provider stream -> persisted
    // activity -> notification listener -> parent, with a real prompt retry.
    let stream: IntegratedConversationListener | undefined;
    let nativeStatus = 'idle';
    const provider: IntegratedProviderService = {
      prepare: async () => ({ resumeId: 'test-thread', argv: [] }),
      conversation: async () => ({ status: nativeStatus }),
      prompt: async () => ({}),
      command: async () => ({}),
      interrupt: async () => {},
      replyPermission: async () => {},
      replyQuestion: async () => {},
      subscribe: async (_id, listener) => { stream = listener; return () => { stream = undefined; }; }
    };
    const runtime = new IntegratedAgentService(database, { claude: provider });
    runtime.onActivityChange(notify);
    const settle = async () => {
      for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.all(pending.splice(0));
    };
    const beforeRuntime = parentMessages.length;
    try {
      runtime.observe('agent');
      await settle();
      assert.ok(stream, 'the runtime subscribes to the native provider');
      await runtime.prompt('agent', 'Try the job');
      nativeStatus = 'error';
      stream!({ processId: 'agent', revision: 1, kind: 'status', status: 'error' });
      await settle();
      assert.equal(parentMessages.length, beforeRuntime + 1);
      await runtime.conversation('agent');
      await settle();
      assert.equal(parentMessages.length, beforeRuntime + 1, 'an error snapshot is silent');
      await runtime.prompt('agent', 'Retry the same job');
      stream!({ processId: 'agent', revision: 2, kind: 'status', status: 'error' });
      await settle();
      assert.equal(parentMessages.length, beforeRuntime + 2, 'a real prompt retry delivers the second identical failure');
    } finally {
      runtime.dispose();
    }
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
