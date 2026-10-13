import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import { NotificationService, clean, displayName, type NotificationChange, type NotificationRecord } from '../app/Services/NotificationService';
import { NotificationDelivery } from '../app/Services/NotificationDelivery';
import { PresenceService } from '../app/Services/PresenceService';
import { PushService, assertPushEndpoint, pushSubject } from '../app/Services/PushService';
import { NotificationActions } from '../app/Actions/NotificationActions';
import { CloseProcessAction } from '../app/Actions/CloseProcessAction';
import type { TerminalService } from '../app/Services/TerminalService';
import { removeTree } from './fixtures/TempTree';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-notification-test-'));
  const database = new DatabaseService(directory);
  try {
    database.initialize();
    const db = database.connection;
    const at = new Date(0).toISOString();
    db.prepare('insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)').run('project_a', 'Alpha', directory, at, at);
    const addProcess = (id: string, kind: string, parent: string | null = null, name = id) => db.prepare(`insert into processes
      (id, project_id, parent_process_id, kind, name, status, activity, pty_process_id, created_at, updated_at)
      values (?, 'project_a', ?, ?, ?, 'running', 'idle', ?, ?, ?)`).run(id, parent, kind, name, `pty_${id}`, at, at);
    addProcess('root', 'agent');
    addProcess('child', 'agent', 'root');
    addProcess('shell', 'command', null, 'npm test');
    db.prepare(`insert into sessions (id, project_id, process_id, harness, session_role, started_at, last_title)
      values ('session_root', 'project_a', 'root', 'claude', 'orchestrator', ?, '✳ Claude Code')`).run(at);

    const settings = new SettingsService(database);
    const changes: NotificationChange[] = [];
    const messages: Array<{ processId: string; text: string }> = [];
    let now = Date.parse('2026-09-30T12:00:00Z');
    const service = new NotificationService(database, settings, { append: () => 'event' },
      async (processId, text) => { messages.push({ processId, text }); }, (change) => changes.push(change), () => now);

    // Root agent requests reach the user with every delivery.
    const request = await service.raise({ processId: 'root', source: 'mcp', kind: 'attention', title: 'Approve the migration?', body: 'It drops a column.', dedupeKey: null });
    assert.equal(request.status, 'raised');
    const record = (request as { notification: NotificationRecord }).notification;
    assert.equal(record.delivery, 'all');
    assert.equal(record.audience, 'user');
    assert.equal(record.session_id, 'session_root');
    assert.equal(record.url, '/projects/project_a/agents/session_root');
    assert.equal(changes.at(-1)?.type, 'raised');

    // A quiet routine turn is recorded in the app at low urgency, so it never
    // toasts or pushes.
    const routine = await service.raise({ processId: 'root', source: 'integrated', kind: 'turn_finished', body: 'Finished its turn', dedupeKey: 'test:quiet', quiet: true });
    const routineRecord = (routine as { notification: NotificationRecord }).notification;
    assert.equal(routineRecord.delivery, 'in_app');
    assert.equal(routineRecord.urgency, 'low');
    assert.equal(routineRecord.audience, 'user');
    service.resolve({ ids: [routineRecord.id] });

    // Routine reports are Markdown; toasts, the tray, and push show it as plain text.
    const report = await service.raise({ processId: 'root', source: 'runtime', kind: 'message', title: 'Sweep: Done', body: '## Summary\nFixed **2** bugs in `app/Foo.ts`:\n\n- See [the PR](https://example.com)\n- Done', dedupeKey: 'test:markdown' });
    assert.equal((report as { notification: NotificationRecord }).notification.body, 'Summary\nFixed 2 bugs in app/Foo.ts:\n• See the PR\n• Done');
    service.resolve({ ids: [(report as { notification: NotificationRecord }).notification.id] });

    // Child requests go to the parent instead of the user, Markdown intact.
    const routed = await service.raise({ processId: 'pty_child', source: 'mcp', kind: 'attention', title: 'Which branch?', body: 'Use **main**?', dedupeKey: null });
    assert.deepEqual(routed, { status: 'routed_to_parent', parent_process_id: 'root' });
    assert.equal(messages.at(-1)?.processId, 'root');
    assert.match(messages.at(-1)!.text, /Attention requested by child/);
    assert.match(messages.at(-1)!.text, /Use \*\*main\*\*\?/);
    assert.equal(service.list({ process_id: 'child' }).total, 0);

    // Child terminal prompts mark the tab, tell the parent once, and never toast or push.
    const prompt = await service.raise({ processId: 'child', source: 'terminal', kind: 'attention', body: 'Claude needs your permission to use Bash' });
    const childRecord = (prompt as { notification: NotificationRecord }).notification;
    assert.equal(childRecord.audience, 'parent');
    assert.equal(childRecord.delivery, 'in_app');
    assert.equal(messages.length, 2);
    const repeat = await service.raise({ processId: 'child', source: 'terminal', kind: 'attention', body: 'Claude needs your permission to use Bash' });
    assert.equal(repeat.status, 'updated');
    assert.equal((repeat as { notification: NotificationRecord }).notification.occurrences, 2);
    assert.equal(messages.length, 2, 'repeats do not message the parent again');
    // Input ends the episode, whether it names the Patterm or PTY process id,
    // so the next identical prompt raises and tells the parent again.
    assert.equal(service.resolveHandled('pty_child'), 1);
    const nextEpisode = await service.raise({ processId: 'child', source: 'terminal', kind: 'attention', body: 'Claude needs your permission to use Bash' });
    assert.equal(nextEpisode.status, 'raised');
    assert.equal(messages.length, 3);

    // A child whose parent has exited asks the user directly and says so.
    addProcess('gone', 'agent');
    addProcess('orphan', 'agent', 'gone', 'Reviewer');
    db.prepare(`update processes set status = 'exited' where id = 'gone'`).run();
    const orphaned = await service.raise({ processId: 'orphan', source: 'mcp', kind: 'attention', title: 'Need a decision', body: 'Keep the column?', dedupeKey: null });
    const orphanRecord = (orphaned as { notification: NotificationRecord }).notification;
    assert.equal(orphanRecord.audience, 'user');
    assert.equal(orphanRecord.body, 'From Reviewer, a child agent whose parent is no longer running.\nKeep the column?');

    // Bells collapse into one record and default to in-app only for agents.
    const bell = await service.raise({ processId: 'root', source: 'terminal', kind: 'bell' });
    assert.equal((bell as { notification: NotificationRecord }).notification.delivery, 'in_app');
    assert.equal((await service.raise({ processId: 'root', source: 'terminal', kind: 'bell' })).status, 'updated');
    // Plain process bells are off; their OSC notifications become messages.
    assert.equal((await service.raise({ processId: 'shell', source: 'terminal', kind: 'bell' })).status, 'suppressed');
    const build = await service.raise({ processId: 'shell', source: 'terminal', kind: 'attention', body: 'Build finished' });
    const buildRecord = (build as { notification: NotificationRecord }).notification;
    assert.equal(buildRecord.kind, 'message');
    assert.equal(buildRecord.title, 'npm test');
    assert.equal(buildRecord.url, '/projects/project_a/processes/shell');
    // Process failures default to in-app only; agent failures reach the user.
    const shellFailure = await service.raise({ processId: 'shell', source: 'runtime', kind: 'failure', body: 'Exited with code 1' });
    assert.equal((shellFailure as { notification: NotificationRecord }).notification.delivery, 'in_app');

    // Settings change the delivery level, and minimum urgency gates push.
    settings.updateNotificationSettings({ sources: { agent_requests: 'off' } });
    assert.equal((await service.raise({ processId: 'root', source: 'mcp', kind: 'attention', title: 'Muted', dedupeKey: null })).status, 'suppressed');
    settings.updateNotificationSettings({ minimumUrgency: 'high' });
    const turn = await service.raise({ processId: 'root', source: 'integrated', kind: 'turn_finished', body: 'Finished its turn', dedupeKey: 'integrated:turn_finished' });
    assert.equal((turn as { notification: NotificationRecord }).notification.delivery, 'in_app');
    settings.updateNotificationSettings({});

    // A report replaces the turn-ended notice, and a turn that reported is not
    // announced as merely finished.
    assert.equal(service.turnActivity('root', 'idle', 'working'), false);
    assert.equal(service.turnActivity('root', 'working', 'idle'), false, 'a turn without a report is announced');
    assert.equal(service.turnActivity('root', 'idle', 'working'), false);
    database.connection.prepare(`insert into timeline_events (id, event_type, project_id, process_id, actor_type, metadata, created_at) values ('report-root', 'agent.reported', 'project_a', 'root', 'agent', '{}', ?)`).run(new Date(now + 1000).toISOString());
    assert.equal(service.turnActivity('root', 'working', 'idle'), true, 'a turn that reported is not announced');
    service.turnActivity('root', 'idle', 'working');
    service.turnActivity('root', 'working', 'error');
    database.connection.prepare(`update timeline_events set created_at = ? where id = 'report-root'`).run(new Date(now - 60_000).toISOString());
    service.turnActivity('root', 'error', 'working');
    assert.equal(service.turnActivity('root', 'working', 'idle'), false, 'an error ends the turn, so an earlier report does not cover the next one');
    // A turn already running at startup emits no activity change; it counts
    // from the process's last activity change.
    database.connection.prepare(`update processes set activity = 'working', updated_at = ? where id = 'root'`).run(new Date(now - 5_000).toISOString());
    database.connection.prepare(`update timeline_events set created_at = ? where id = 'report-root'`).run(new Date(now - 1_000).toISOString());
    service.resumeTurns();
    assert.equal(service.turnActivity('root', 'working', 'idle'), true, 'a report during a turn running at startup is counted');
    // A reconnect snapshot can report idle before the agent's own events
    // resume; it neither ends the turn nor starts a new one.
    service.turnActivity('root', 'idle', 'working');
    database.connection.prepare(`update timeline_events set created_at = ? where id = 'report-root'`).run(new Date(now + 2_000).toISOString());
    assert.equal(service.turnActivity('root', 'working', 'idle', true), false);
    service.turnActivity('root', 'idle', 'working', true);
    assert.equal(service.turnActivity('root', 'working', 'idle'), true, 'the turn and its report survive a reconnect snapshot');
    assert.equal((database.connection.prepare(`select turn_started_at from processes where id = 'root'`).get() as { turn_started_at: string | null }).turn_started_at, null);
    // Work the agent resumes after a reconnect reported idle is a new turn:
    // at worst a finished turn is announced again, never wrongly silenced.
    service.turnActivity('root', 'idle', 'working');
    service.turnActivity('root', 'working', 'idle', true);
    const clockBeforeReconnects = now;
    now += 5_000;
    service.turnActivity('root', 'idle', 'working');
    assert.equal(service.turnActivity('root', 'working', 'idle'), false, 'resumed work after a reconnect is a new turn');
    now = clockBeforeReconnects;
    assert.equal(service.reported('root'), 1);
    assert.equal(service.get((turn as { notification: NotificationRecord }).notification.id)?.resolved_at !== null, true);

    // Requests are rate-limited per process.
    const statuses: string[] = [];
    for (let index = 0; index < 6; index++) {
      statuses.push((await service.raise({ processId: 'root', source: 'mcp', kind: 'attention', title: `Request ${index}`, dedupeKey: null })).status);
    }
    assert.deepEqual(statuses, ['raised', 'raised', 'raised', 'raised', 'rate_limited', 'rate_limited']);

    // History pages by cursor, newest activity first, and names each origin.
    const everything = service.list({ include_resolved: true, limit: 200 });
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = service.list({ include_resolved: true, limit: 3, ...(cursor ? { cursor } : {}) });
      paged.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor ?? undefined;
      now += 1_000;
      if (cursor) await service.raise({ processId: 'shell', source: 'terminal', kind: 'attention', body: `Arrived while paging ${paged.length}` });
    } while (cursor);
    assert.deepEqual(paged, everything.items.map((item) => item.id), 'records raised mid-scroll do not shift later pages');
    assert.equal(new Set(paged).size, paged.length);
    const rootRecord = everything.items.find((item) => item.process_id === 'root')!;
    assert.equal(rootRecord.process_name, 'Claude Code');
    assert.equal(rootRecord.project_name, 'Alpha');
    assert.equal(service.list({ include_resolved: true, cursor: 'garbage' }).items.length > 0, true, 'a bad cursor reads the first page');

    // Unread counts, reads, and resolution.
    const rootUnread = service.unread().find((row) => row.process_id === 'root');
    assert.equal(rootUnread?.urgency, 'normal');
    assert.ok(service.markRead({ session_id: 'session_root' }) > 0);
    assert.equal(service.unread().find((row) => row.process_id === 'root'), undefined);
    assert.ok(service.resolveHandled('shell') > 0);
    assert.equal(service.list({ process_id: 'shell' }).items.map((row) => row.kind).join(), 'failure', 'user input keeps failures');
    assert.equal(service.markRead({}), 0, 'an empty read selects nothing');

    // Resolved and read records expire after 30 days.
    now += 31 * 24 * 60 * 60 * 1000;
    assert.ok(service.prune() > 0);

    // Text cleaning.
    assert.equal(displayName('✳ Claude Code'), 'Claude Code');
    assert.equal(clean('a\u0007b\u001b[31m  c', 100), 'a b [31m c');
    assert.equal(clean('x'.repeat(200), 10).length, 10);

    // Push endpoints are limited to browser push services.
    assertPushEndpoint('https://fcm.googleapis.com/fcm/send/abc');
    assertPushEndpoint('https://web.push.apple.com/QGx');
    assertPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc');
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evilfcm.googleapis.com.example/x', 'https://fcm.googleapis.com:8443/x', 'https://user@fcm.googleapis.com/x']) {
      assert.throws(() => assertPushEndpoint(endpoint), /Unsupported push service/, endpoint);
    }
    assert.equal(pushSubject('https://box.example.ts.net'), 'https://box.example.ts.net');
    assert.equal(pushSubject('http://localhost:8787'), 'mailto:patterm@localhost');

    // Push delivery prunes gone subscriptions and keeps VAPID keys private.
    const sent: string[] = [];
    const push = new PushService(database, directory, 'mailto:patterm@localhost', async (subscription) => {
      sent.push(subscription.endpoint);
      if (subscription.endpoint.endsWith('/gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      if (subscription.endpoint.endsWith('/flaky')) throw Object.assign(new Error('busy'), { statusCode: 503 });
    });
    const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
    push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/ok', keys, label: 'Android · Chrome' });
    push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/gone', keys });
    push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/flaky', keys });
    assert.throws(() => push.subscribe({ endpoint: 'https://example.com/push', keys }), /Unsupported push service/);
    assert.match(push.publicKey(), /^[A-Za-z0-9_-]{80,}$/);
    // Windows files have no owner-only mode bits.
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, 'push-vapid.json')).mode & 0o777, 0o600);
    await push.deliver(record);
    assert.equal(sent.length, 3);
    const remaining = push.list();
    assert.deepEqual(remaining.map((row) => row.endpoint.split('/').pop()).sort(), ['flaky', 'ok']);
    assert.ok(remaining.find((row) => row.endpoint.endsWith('/ok'))?.last_success_at);
    assert.equal(remaining.find((row) => row.endpoint.endsWith('/flaky'))?.failure_count, 1);
    assert.equal(push.unsubscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/flaky' }).removed, true);
    assert.equal(new PushService(database, directory, 'mailto:x@y').publicKey(), push.publicKey(), 'keys persist across restarts');

    // Presence: the user is present while any client is visible and focused.
    let clock = 0;
    const presence = new PresenceService(() => clock);
    assert.equal(presence.present(), false);
    presence.update('a', { visible: true, focused: false, route: '/projects' });
    assert.equal(presence.present(), false);
    presence.update('b', { visible: true, focused: true, route: '/projects/project_a/agents/session_root' });
    assert.equal(presence.present(), true);
    assert.equal(presence.viewing('/projects/project_a/agents/session_root'), true);
    clock += 91_000;
    assert.equal(presence.present(), false, 'stale reports count as away');
    presence.update('b', { visible: true, focused: true, route: '/' });
    presence.remove('b');
    assert.equal(presence.present(), false);

    // Delivery waits, then sends only while away and still unread.
    const delivered: string[] = [];
    let away = true;
    const records = new Map<string, NotificationRecord>();
    const delivery = new NotificationDelivery({ present: () => !away }, {
      current: (id) => records.get(id) ?? null,
      push: async (notification) => { delivered.push(`push:${notification.id}`); },
      desktop: (notification) => { delivered.push(`desktop:${notification.id}`); },
      log: () => {}
    });
    const high = { ...record, id: 'high', urgency: 'high' as const, read_at: null, resolved_at: null };
    records.set('high', high);
    delivery.handle({ type: 'raised', notification: high });
    delivery.handle({ type: 'raised', notification: { ...high, id: 'inapp', delivery: 'in_app' } });
    await sleep(20);
    assert.deepEqual(delivered, ['desktop:high', 'push:high']);
    away = false;
    delivery.handle({ type: 'raised', notification: high });
    await sleep(20);
    assert.equal(delivered.length, 2, 'nothing is sent while the user is present');
    delivery.dispose();

    // Actions validate agent input.
    const actions = new NotificationActions(service, settings, presence, push);
    await assert.rejects(async () => actions.notifyUser('root', { title: '' }));
    await assert.rejects(async () => actions.notifyUser('root', { title: 'x', extra: true }));
    assert.equal(actions.readSettings().sources.integrated_turn_finished, 'all');
    assert.equal((await actions.test()).status, 'raised');

    // Closing a process resolves its records through the service, so clients
    // dismiss their toasts.
    await service.raise({ processId: 'root', source: 'mcp', kind: 'attention', title: 'Still open', dedupeKey: null });
    const terminal = { request: async () => ({ ok: true, status: 'stopped' }) } as unknown as TerminalService;
    const before = changes.length;
    await new CloseProcessAction(database, terminal, undefined, undefined, service).execute('root');
    assert.equal(service.list({ process_id: 'root' }).total, 0);
    assert.ok(changes.slice(before).some((change) => change.type === 'resolved'));
  } finally {
    database.dispose();
    removeTree(directory);
  }
  console.log('notification smoke passed');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
