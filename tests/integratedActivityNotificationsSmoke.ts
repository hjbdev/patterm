import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloseProcessAction } from '../app/Actions/CloseProcessAction';
import { CloseRequestActions } from '../app/Actions/CloseRequestActions';
import { NotificationActions } from '../app/Actions/NotificationActions';
import { integratedActivityNotifications, REPLY_PREVIEW_LIMIT, type IntegratedActivityNotificationContext } from '../app/Listeners/IntegratedActivityNotifications';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { DatabaseService } from '../app/Services/DatabaseService';
import { IDLE_COMPACTION_AFTER_MS, IdleCompactionService, type IdleCompactionSource } from '../app/Services/IdleCompactionService';
import { IntegratedAgentService, type CompactionSignal, type IntegratedActivityChange, type IntegratedProviderService } from '../app/Services/IntegratedAgentService';
import type { IntegratedConversationListener } from '../app/Services/IntegratedConversation';
import { TurnBusyError } from '../app/Services/IntegratedDelivery';
import { NotificationService } from '../app/Services/NotificationService';
import { ParentRequestService, pendingRequestSummary } from '../app/Services/ParentRequestService';
import { PresenceService } from '../app/Services/PresenceService';
import type { PushService } from '../app/Services/PushService';
import { SettingsService } from '../app/Services/SettingsService';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';
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
    const notificationContext: IntegratedActivityNotificationContext = {
      notifications: notices,
      raise: (input) => { pending.push(notices.raise(input)); },
      closeRequests: () => null,
      isAssistant: () => false,
      wokeFromSnooze: () => false,
      compacting: () => automaticCompaction,
      triage: () => ({ quiet: true, reason: 'model', probability: 0.99, waiting: false }),
      botReply: () => null,
      log: () => {}
    };
    const notify = integratedActivityNotifications(notificationContext);
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
    let admission: Promise<unknown> | null = null;
    const provider: IntegratedProviderService = {
      prepare: async () => ({ resumeId: 'test-thread', argv: [] }),
      conversation: async () => ({ status: nativeStatus }),
      prompt: async () => admission ? await admission : {},
      command: async () => ({}),
      interrupt: async () => {},
      replyPermission: async () => {},
      replyQuestion: async () => {},
      subscribe: async (_id, listener) => { stream = listener; return () => { stream = undefined; }; }
    };
    const runtime = new IntegratedAgentService(database, { claude: provider });
    runtime.onActivityChange(notify);
    runtime.onPromptDispatch((processId) => notices.resolve({ process_id: processId, kinds: ['failure'], dedupe_key: 'failure' }));
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
      let acknowledge!: () => void;
      admission = new Promise<void>((resolve) => { acknowledge = resolve; });
      const retry = runtime.prompt('agent', 'Retry while the snapshot catches up');
      await settle();
      nativeStatus = 'working';
      await runtime.conversation('agent');
      stream!({ processId: 'agent', revision: 3, kind: 'status', status: 'working' });
      acknowledge();
      await retry;
      nativeStatus = 'error';
      stream!({ processId: 'agent', revision: 4, kind: 'status', status: 'error' });
      await settle();
      assert.equal(parentMessages.length, beforeRuntime + 3, 'snapshot-before-live-working cannot hide a requested retry');
      admission = new Promise<void>((resolve) => { acknowledge = resolve; });
      const fastFailure = runtime.prompt('agent', 'Fail before acknowledging admission');
      await settle();
      nativeStatus = 'working';
      await runtime.conversation('agent');
      nativeStatus = 'error';
      stream!({ processId: 'agent', revision: 5, kind: 'status', status: 'error' });
      await settle();
      assert.equal(parentMessages.length, beforeRuntime + 4, 'a failure before prompt acknowledgement also reaches the parent');
      acknowledge();
      await fastFailure;
      assert.equal(notices.list({ process_id: 'agent' }).items.filter((item) => item.kind === 'failure').length, 1, 'a late acknowledgement cannot resolve the new failure');
    } finally {
      runtime.dispose();
    }

    db.prepare(`insert into processes (id, project_id, kind, name, status, created_at, updated_at)
      values ('root', 'project_a', 'agent', 'root', 'running', ?, ?)`).run(at, at);
    db.prepare(`insert into sessions (id, project_id, process_id, harness, session_role, interface_mode, mcp_identity, started_at)
      values ('session_root', 'project_a', 'root', 'claude', 'orchestrator', 'integrated', 'root-identity', ?)`).run(at);
    db.prepare(`update processes set parent_process_id = 'root' where id = 'bot-parent'`).run();
    db.prepare(`update sessions set interface_mode = 'integrated', mcp_identity = 'parent-identity' where id = 'session_parent'`).run();
    db.prepare(`update sessions set cwd = ?, harness = 'agy' where id = 'session_agent'`).run(directory);
    fs.writeFileSync(path.join(directory, 'README.md'), 'example');
    settings.updateNotificationSettings({ subagentNotifications: false, sources: { integrated_permission: 'all' } });
    const reviews: Array<{ target: string; offerId: string }> = [];
    const replies: unknown[] = [];
    let nativePermissions = [{ id: 'read-1', tool_kind: 'read', once: true, action: 'Read README', resources: ['README.md'] }];
    let nativeQuestions: Array<{ id: string; questions: Array<{ question: string; options: Array<{ label: string }> }> }> = [];
    let nativeForms: unknown[] = [];
    const delegatedProvider: IntegratedProviderService = {
      ...provider,
      conversation: async () => ({ status: nativePermissions.length ? 'permission' : nativeQuestions.length || nativeForms.length ? 'question' : 'working', permissions: { data: nativePermissions }, questions: nativeQuestions, forms: nativeForms }),
      replyPermission: async (...args) => { replies.push(args); nativePermissions = nativePermissions.filter((permission) => permission.id !== args[1]); },
      replyQuestion: async (...args) => { replies.push(args); nativeQuestions = nativeQuestions.filter((question) => question.id !== args[1]); },
      replyForm: async (...args) => { replies.push(args); nativeForms = []; }
    };
    const agy = new IntegratedAgentService(database, { agy: delegatedProvider, claude: delegatedProvider, opencode: delegatedProvider });
    const permissionNotices: Array<Promise<unknown>> = [];
    const permissions = new ParentRequestService(database, agy,
      async (target, text) => { reviews.push({ target, offerId: /offer_id "([^"]+)"/.exec(text)![1]! }); },
      (processId, kind) => { permissionNotices.push(notices.raise({ processId, source: 'integrated', kind: 'permission', body: 'Review needed', dedupeKey: `escalation:${kind}`, escalatedRequest: true })); },
      (processId, kind) => { notices.resolve({ process_id: processId, dedupe_key: `escalation:${kind}` }); }, () => {});
    agy.onPendingRequests((processId, requests) => permissions.observe(processId, requests));
    agy.onActivityChange(integratedActivityNotifications({ ...notificationContext, routesRequests: (id) => permissions.handles(id) }));
    try {
      agy.observe('agent');
      await settle();
      assert.deepEqual(reviews.map((review) => review.target), ['bot-parent']);
      assert.equal(notices.list({ process_id: 'agent' }).items.some((item) => item.kind === 'permission'), false);
      const read = reviews[0]!.offerId;
      await assert.rejects(permissions.reply('session_root', read, { decision: 'once' }), /no longer pending for you/);
      nativePermissions.push({ id: 'write-2', tool_kind: 'edit', once: true, action: 'Edit README', resources: ['README.md'] });
      stream!({ processId: 'agent', revision: 6, kind: 'pending' });
      await settle();
      assert.deepEqual(reviews.map((review) => review.target), ['bot-parent', 'bot-parent'], 'new requests are routed without repeating pending requests');
      await permissions.reply('session_parent', read, { decision: 'once' });
      assert.deepEqual(replies, [['agent', 'read-1', 'once', undefined]]);
      const edit = reviews[1]!.offerId;
      await assert.rejects(permissions.reply('session_parent', edit, { decision: 'once' }), /only a one-time read/i);
      await permissions.reply('session_parent', edit, { decision: 'escalate' });
      assert.equal(reviews[2]!.target, 'root');
      await assert.rejects(permissions.reply('session_parent', edit, { decision: 'reject' }), /no longer pending for you/);
      await permissions.reply('session_root', reviews[2]!.offerId, { decision: 'escalate' });
      await Promise.all(permissionNotices);
      assert.ok(notices.list({ process_id: 'agent' }).items.some((item) => item.kind === 'permission' && item.audience === 'user'));
      assert.equal(nativePermissions.length, 1, 'escalation leaves the native request pending');
      await agy.replyPermission('agent', 'write-2', 'reject');
      stream!({ processId: 'agent', revision: 7, kind: 'pending' });
      await settle();
      assert.equal(notices.list({ process_id: 'agent' }).items.some((item) => item.kind === 'permission'), false);

      db.prepare(`update sessions set harness = 'claude' where id = 'session_agent'`).run();
      const question = { question: 'Which test suite did you delegate?', options: [{ label: 'Smoke' }, { label: 'Browser' }] };
      nativeQuestions = [{ id: 'question-1', questions: [question] }, { id: 'question-2', questions: [question] }];
      stream!({ processId: 'agent', revision: 8, kind: 'pending' });
      await settle();
      assert.deepEqual(reviews.slice(3).map((review) => review.target), ['bot-parent', 'bot-parent']);
      assert.equal(notices.list({ process_id: 'agent' }).items.some((item) => item.kind === 'permission'), false);
      const answer = reviews[3]!.offerId;
      await assert.rejects(permissions.reply('session_parent', answer, { decision: 'answer', answers: [['Unknown']] }), /invalid answer/i);
      await permissions.reply('session_parent', answer, { decision: 'answer', answers: [['Smoke']] });
      assert.deepEqual(replies.at(-1), ['agent', 'question-1', [['Smoke']]]);
      await permissions.reply('session_parent', reviews[4]!.offerId, { decision: 'escalate' });
      assert.equal(reviews[5]!.target, 'root');
      await permissions.reply('session_root', reviews[5]!.offerId, { decision: 'escalate' });
      await Promise.all(permissionNotices);
      assert.ok(notices.list({ process_id: 'agent' }).items.some((item) => item.kind === 'permission' && item.audience === 'user'));
      assert.equal(nativeQuestions[0]?.id, 'question-2');
      await agy.replyQuestion('agent', 'question-2', [['Browser']]);
      stream!({ processId: 'agent', revision: 9, kind: 'pending' });
      await settle();
      assert.equal(notices.list({ process_id: 'agent' }).items.some((item) => item.kind === 'permission'), false);

      db.prepare(`update sessions set harness = 'opencode' where id = 'session_agent'`).run();
      nativeForms = [{ id: 'form-1', title: 'Questions', fields: [{
        key: 'suite', type: 'string', required: true, custom: true, options: [{ label: 'Smoke', value: 'smoke' }]
      }] }];
      stream!({ processId: 'agent', revision: 10, kind: 'pending' });
      await settle();
      assert.equal(reviews[6]!.target, 'bot-parent');
      await permissions.reply('session_parent', reviews[6]!.offerId, { decision: 'answer', answers: [['Smoke']] });
      assert.deepEqual(replies.at(-1), ['agent', 'form-1', { suite: 'smoke' }, 'accept']);

      db.prepare(`update sessions set harness = 'agy' where id = 'session_agent'`).run();
      fs.writeFileSync(path.join(directory, '.env'), 'placeholder');
      nativePermissions = [{ id: 'sensitive-read', tool_kind: 'read', once: true, action: 'Read file', resources: ['.env'] }];
      stream!({ processId: 'agent', revision: 11, kind: 'pending' });
      await settle();
      const oldOffer = reviews[7]!.offerId;
      await assert.rejects(permissions.reply('session_parent', oldOffer, { decision: 'once' }), /only a one-time read/i);
      db.prepare(`update processes set parent_process_id = 'root' where id = 'agent'`).run();
      stream!({ processId: 'agent', revision: 12, kind: 'pending' });
      await settle();
      await assert.rejects(permissions.reply('session_parent', oldOffer, { decision: 'reject' }), /no longer pending for you/);
      assert.equal(reviews[8]!.target, 'root', 'reparenting offers the unchanged native request to the new parent');
      await permissions.reply('session_root', reviews[8]!.offerId, { decision: 'escalate' });
      await Promise.all(permissionNotices);
      assert.ok(notices.list({ process_id: 'agent' }).items.some((item) => item.kind === 'permission' && item.audience === 'user'));

      // A bot overseeing the agent answers what waits for the user, with a
      // parent's limits and nothing more.
      const summary = pendingRequestSummary({ harness: 'agy', cwd: directory }, await agy.peekConversation('agent'));
      assert.deepEqual(summary.map((item) => [item.request_id, item.can_approve_once]), [['sensitive-read', false]]);
      await assert.rejects(permissions.overseerReply('agent', 'sensitive-read', { decision: 'once' }, 'bot'), /only a one-time read/i);
      await assert.rejects(permissions.overseerReply('agent', 'sensitive-read', { decision: 'answer', answers: [['Yes']] }, 'bot'), /once or reject/);
      await assert.rejects(permissions.overseerReply('agent', 'gone', { decision: 'reject' }, 'bot'), /no longer pending/);
      await assert.rejects(permissions.overseerReply('agent', 'sensitive-read', { decision: 'reject' }, 'agent'), /own requests/);
      // A request still offered to a parent is the parent's to answer.
      nativePermissions.push({ id: 'read-3', tool_kind: 'read', once: true, action: 'Read README', resources: ['README.md'] });
      stream!({ processId: 'agent', revision: 13, kind: 'pending' });
      await settle();
      assert.equal(reviews[9]!.target, 'root');
      await assert.rejects(permissions.overseerReply('agent', 'read-3', { decision: 'once' }, 'bot'), /with the agent's parent/);
      await permissions.overseerReply('agent', 'sensitive-read', { decision: 'reject' }, 'bot');
      assert.deepEqual(replies.at(-1), ['agent', 'sensitive-read', 'reject', undefined]);
      // A top-level agent's requests go straight to the user, and its overseer may answer them.
      db.prepare(`update processes set parent_process_id = null where id = 'agent'`).run();
      stream!({ processId: 'agent', revision: 14, kind: 'pending' });
      await settle();
      await assert.rejects(permissions.reply('session_root', reviews[9]!.offerId, { decision: 'once' }), /no longer pending for you/);
      const reviewCount = reviews.length;
      assert.equal((await permissions.overseerReply('agent', 'read-3', { decision: 'once' }, 'bot')).status, 'resolved');
      assert.deepEqual(replies.at(-1), ['agent', 'read-3', 'once', undefined]);
      assert.equal(reviews.length, reviewCount, 'an overseer reply offers nothing to parents');
      // Skill files in standard user skill directories are also safe one-time reads,
      // while unrelated home files and sensitive files inside skill dirs stay denied.
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-skill-home-'));
      const priorHome = process.env.HOME;
      const priorProfile = process.env.USERPROFILE;
      try {
        process.env.HOME = fakeHome;
        process.env.USERPROFILE = fakeHome;
        const skillDir = path.join(fakeHome, '.config', 'opencode', 'skills', 'review-loop');
        const claudeSkillsRoot = path.join(fakeHome, '.claude', 'skills');
        const codexSkillDir = path.join(fakeHome, '.codex', 'skills', 'example');
        const agySkillDir = path.join(fakeHome, '.gemini', 'config', 'skills', 'example');
        const projectSkillDir = path.join(directory, '.claude', 'skills', 'local');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.mkdirSync(claudeSkillsRoot, { recursive: true });
        fs.mkdirSync(codexSkillDir, { recursive: true });
        fs.mkdirSync(agySkillDir, { recursive: true });
        fs.mkdirSync(projectSkillDir, { recursive: true });
        fs.mkdirSync(path.join(directory, '.codex'), { recursive: true });
        const skillFile = path.join(skillDir, 'SKILL.md');
        const codexSkillFile = path.join(codexSkillDir, 'SKILL.md');
        const agySkillFile = path.join(agySkillDir, 'SKILL.md');
        const projectSkillFile = path.join(projectSkillDir, 'SKILL.md');
        const skillSecret = path.join(skillDir, '.env');
        const otherHome = path.join(fakeHome, 'notes.txt');
        const codexAuth = path.join(directory, '.codex', 'auth.json');
        const oauthCreds = path.join(directory, '.credentials.json');
        fs.writeFileSync(skillFile, '# skill');
        fs.symlinkSync(skillDir, path.join(claudeSkillsRoot, 'review-loop'), 'dir');
        fs.writeFileSync(codexSkillFile, '# codex skill');
        fs.writeFileSync(agySkillFile, '# agy skill');
        fs.writeFileSync(projectSkillFile, '# local skill');
        fs.writeFileSync(skillSecret, 'SECRET=1');
        fs.writeFileSync(otherHome, 'private');
        fs.writeFileSync(codexAuth, '{}');
        fs.writeFileSync(oauthCreds, '{}');
        nativePermissions = [
          { id: 'skill-read', tool_kind: 'read', once: true, action: 'Read skill', resources: ['~/.config/opencode/skills/review-loop/SKILL.md'] },
          { id: 'symlink-skill-read', tool_kind: 'read', once: true, action: 'Read symlinked skill', resources: ['~/.claude/skills/review-loop/SKILL.md'] },
          { id: 'project-skill-read', tool_kind: 'read', once: true, action: 'Read project skill', resources: ['.claude/skills/local/SKILL.md'] },
          { id: 'codex-skill-read', tool_kind: 'read', once: true, action: 'Read codex skill', resources: [codexSkillFile] },
          { id: 'agy-skill-read', tool_kind: 'read', once: true, action: 'Read agy skill', resources: [agySkillFile] }
        ];
        stream!({ processId: 'agent', revision: 145, kind: 'pending' });
        await settle();
        const skillSummary = pendingRequestSummary({ harness: 'agy', cwd: directory }, await agy.peekConversation('agent'));
        assert.deepEqual(skillSummary.map((item) => [item.request_id, item.can_approve_once]), [
          ['skill-read', true],
          ['symlink-skill-read', true],
          ['project-skill-read', true],
          ['codex-skill-read', true],
          ['agy-skill-read', true]
        ]);
        assert.equal((await permissions.overseerReply('agent', 'skill-read', { decision: 'once' }, 'bot')).status, 'resolved');
        assert.equal((await permissions.overseerReply('agent', 'symlink-skill-read', { decision: 'once' }, 'bot')).status, 'resolved');
        assert.equal((await permissions.overseerReply('agent', 'project-skill-read', { decision: 'once' }, 'bot')).status, 'resolved');
        nativePermissions = [
          { id: 'skill-secret', tool_kind: 'read', once: true, action: 'Read secret', resources: [skillSecret] },
          { id: 'home-other', tool_kind: 'read', once: true, action: 'Read home', resources: [otherHome] },
          { id: 'codex-auth', tool_kind: 'read', once: true, action: 'Read codex auth', resources: ['.codex/auth.json'] },
          { id: 'oauth-creds', tool_kind: 'read', once: true, action: 'Read oauth creds', resources: ['.credentials.json'] }
        ];
        stream!({ processId: 'agent', revision: 146, kind: 'pending' });
        await settle();
        const deniedSummary = pendingRequestSummary({ harness: 'agy', cwd: directory }, await agy.peekConversation('agent'));
        assert.deepEqual(deniedSummary.map((item) => [item.request_id, item.can_approve_once]), [
          ['skill-secret', false],
          ['home-other', false],
          ['codex-auth', false],
          ['oauth-creds', false]
        ]);
        await assert.rejects(permissions.overseerReply('agent', 'skill-secret', { decision: 'once' }, 'bot'), /only a one-time read/i);
        await assert.rejects(permissions.overseerReply('agent', 'home-other', { decision: 'once' }, 'bot'), /only a one-time read/i);
        await assert.rejects(permissions.overseerReply('agent', 'codex-auth', { decision: 'once' }, 'bot'), /only a one-time read/i);
        await assert.rejects(permissions.overseerReply('agent', 'oauth-creds', { decision: 'once' }, 'bot'), /only a one-time read/i);
        // A repo-controlled skill symlink pointing outside the workspace is denied,
        // while an ordinary file accessed via a symlinked workspace cwd alias passes.
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-outside-'));
        const aliasCwd = path.join(outsideDir, 'workspace-alias');
        try {
          const outsideFile = path.join(outsideDir, 'outside-note.txt');
          fs.writeFileSync(outsideFile, 'outside');
          fs.mkdirSync(path.join(directory, '.agents'), { recursive: true });
          fs.symlinkSync(outsideDir, path.join(directory, '.agents', 'skills'), 'dir');
          fs.symlinkSync(directory, aliasCwd, 'dir');
          const escaped = pendingRequestSummary({ harness: 'agy', cwd: directory }, {
            permissions: { data: [{ id: 'escape', tool_kind: 'read', once: true, resources: ['.agents/skills/outside-note.txt'] }] }
          });
          assert.equal(escaped[0]!.can_approve_once, false, 'a repo skill symlink cannot widen the read boundary');
          const aliased = pendingRequestSummary({ harness: 'agy', cwd: aliasCwd }, {
            permissions: { data: [{ id: 'alias', tool_kind: 'read', once: true, resources: [path.join(aliasCwd, 'README.md')] }] }
          });
          assert.equal(aliased[0]!.can_approve_once, true, 'ordinary files under a symlinked workspace cwd alias remain allowed');
        } finally {
          removeTree(outsideDir);
        }
        nativePermissions = [];
      } finally {
        if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
        if (priorProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorProfile;
        removeTree(fakeHome);
      }
      db.prepare(`update sessions set harness = 'claude' where id = 'session_agent'`).run();
      nativeQuestions = [{ id: 'question-3', questions: [question] }];
      stream!({ processId: 'agent', revision: 15, kind: 'pending' });
      await settle();
      const asked = pendingRequestSummary({ harness: 'claude', cwd: directory }, await agy.peekConversation('agent'));
      assert.equal(asked[0]!.answerable, true);
      await assert.rejects(permissions.overseerReply('agent', 'question-3', { decision: 'reject' }, 'bot'), /use answer/i);
      await assert.rejects(permissions.overseerReply('agent', 'question-3', { decision: 'answer', answers: [['Unknown']] }, 'bot'), /invalid answer/i);
      await permissions.overseerReply('agent', 'question-3', { decision: 'answer', answers: [['Browser']] }, 'bot');
      assert.deepEqual(replies.at(-1), ['agent', 'question-3', [['Browser']]]);
    } finally {
      agy.dispose();
      permissions.dispose();
    }

    // Non-parent send_input / send_message (including held peer prompts) leave
    // open user attention notices intact; owner prompts clear them.
    const peerNow = new Date().toISOString();
    db.prepare(`insert into processes (id, project_id, kind, name, status, activity, created_at, updated_at) values ('peer_target', 'project_a', 'agent', 'Target', 'running', 'idle', ?, ?)`).run(peerNow, peerNow);
    db.prepare(`insert into sessions (id, project_id, process_id, harness, interface_mode, session_role, mcp_identity, started_at, cwd) values ('session_peer_target', 'project_a', 'peer_target', 'codex', 'integrated', 'orchestrator', 'id_peer_target', ?, ?)`).run(peerNow, directory);
    db.prepare(`insert into processes (id, project_id, kind, name, status, activity, created_at, updated_at) values ('peer_caller', 'project_a', 'agent', 'Caller', 'running', 'working', ?, ?)`).run(peerNow, peerNow);
    db.prepare(`insert into sessions (id, project_id, process_id, harness, interface_mode, session_role, mcp_identity, started_at, cwd) values ('session_peer_caller', 'project_a', 'peer_caller', 'codex', 'integrated', 'orchestrator', 'id_peer_caller', ?, ?)`).run(peerNow, directory);
    const peerTimeline = new TimelineService(database);
    const peerNotices = new NotificationService(database, settings, peerTimeline, async () => {}, () => {});
    const peerNotificationActions = new NotificationActions(peerNotices, settings, new PresenceService(), undefined as unknown as PushService);
    let peerStream: IntegratedConversationListener | undefined;
    let peerStatus = 'idle';
    let rejectBusy = false;
    const peerIntegrated = new IntegratedAgentService(database, {
      codex: {
        ...provider,
        subscribe: async (_processId, listener) => { peerStream = listener; return () => { peerStream = undefined; }; },
        conversation: async () => ({ status: peerStatus, messages: [] }),
        prompt: async () => {
          if (rejectBusy) throw new TurnBusyError('Busy compacting', 'Compact');
          return { turnId: 'turn-peer' };
        }
      }
    });
    peerIntegrated.onActivityChange(integratedActivityNotifications({
      ...notificationContext,
      notifications: peerNotices,
      raise: (input) => { void peerNotices.raise(input); },
      closeRequests: () => null,
      compacting: () => false,
      wokeFromSnooze: () => false
    }));
    try {
      const peerRegistry = createTestMcpRegistry({
        tempDir: directory,
        database,
        timeline: peerTimeline,
        integrated: peerIntegrated,
        notifications: peerNotificationActions,
        workbench: new WorkbenchRepository(database),
        terminal: { request: async () => ({}) } as unknown as TerminalService
      });
      peerIntegrated.observe('peer_target');
      await wait(10);
      const { notification_id: noticeId } = await peerRegistry.callPublic('notify_user', { title: 'User decision needed' }, { identity: 'id_peer_target' }) as { notification_id: string };
      assert.equal(peerNotices.get(noticeId)?.resolved_at, null);
      await peerRegistry.callPublic('send_input', { process_id: 'peer_target', kind: 'text', text: 'Peer note', submit: true }, { identity: 'id_peer_caller' });
      assert.equal(peerNotices.get(noticeId)?.resolved_at, null, 'peer send_input leaves open user attention notice intact');
      peerStatus = 'idle';
      peerStream?.({ processId: 'peer_target', revision: 1, kind: 'status', status: 'idle' });
      await peerRegistry.callPublic('send_message', { target_process_id: 'peer_target', message: 'Peer msg' }, { identity: 'id_peer_caller' });
      assert.equal(peerNotices.get(noticeId)?.resolved_at, null, 'peer send_message leaves open user attention notice intact');
      // Held peer prompt queued during compaction also preserves attention on flush.
      rejectBusy = true;
      await peerRegistry.callPublic('send_input', { process_id: 'peer_target', kind: 'text', text: 'Held peer note', submit: true }, { identity: 'id_peer_caller' });
      rejectBusy = false;
      peerStatus = 'idle';
      peerStream?.({ processId: 'peer_target', revision: 2, kind: 'status', status: 'idle' });
      await wait(25);
      assert.equal(peerNotices.get(noticeId)?.resolved_at, null, 'held peer prompt preserves open attention when flushed');
      // An owner prompt clears the open user attention notice.
      peerStatus = 'idle';
      peerStream?.({ processId: 'peer_target', revision: 3, kind: 'status', status: 'idle' });
      await peerIntegrated.prompt('peer_target', { text: 'Owner reply' });
      assert.notEqual(peerNotices.get(noticeId)?.resolved_at, null, 'owner prompt clears open user attention notice');
    } finally {
      peerIntegrated.dispose();
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
