import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import { NotificationService, type RaiseNotificationInput } from '../app/Services/NotificationService';
import { notificationSettingsInput } from '../app/Services/NotificationSettings';
import { ProjectSnoozeActions } from '../app/Actions/ProjectSnoozeActions';
import { NotificationDelivery } from '../app/Services/NotificationDelivery';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { allAgentsHiding } from '../resources/js/lib/allAgents';
import { nextWorkdayStart, snoozedProjectsLast } from '../resources/js/lib/projectSnooze';
import type { ProjectWorkbench } from '../resources/js/types';
import { removeTree } from './fixtures/TempTree';

// The pure helpers the renderer uses.
function helpers(): void {
  const at = (text: string) => new Date(text);
  assert.equal(nextWorkdayStart(at('2026-10-19T07:00:00'), '09:00').getTime(), at('2026-10-19T09:00:00').getTime(), 'before work starts, today');
  assert.equal(nextWorkdayStart(at('2026-10-19T17:30:00'), '09:00').getTime(), at('2026-10-20T09:00:00').getTime(), 'after it starts, tomorrow');
  assert.equal(nextWorkdayStart(at('2026-10-19T09:00:00'), '09:00').getTime(), at('2026-10-20T09:00:00').getTime(), 'at the start, tomorrow');
  assert.equal(notificationSettingsInput.parse({}).workdayStart, '09:00');
  // A start inside today's daylight-saving gap keeps tomorrow's own time.
  const zone = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
  try {
    assert.equal(nextWorkdayStart(new Date('2026-03-29T12:00:00'), '02:30').toISOString(), new Date('2026-03-30T02:30:00').toISOString());
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
  assert.throws(() => notificationSettingsInput.parse({ workdayStart: '25:00' }));

  const project = (id: string, snoozedUntil: string | null) => ({ project: { id, name: id, path: `/${id}`, snoozedUntil }, projectSessions: [], processes: [], timers: [] }) as unknown as ProjectWorkbench;
  const projects = [project('a', 'later'), project('b', null), project('c', null)];
  assert.deepEqual(snoozedProjectsLast(projects, (item) => item.project).map((item) => item.project.id), ['b', 'c', 'a']);
  // Snoozed projects join the ones you switched off, once.
  assert.deepEqual(allAgentsHiding({ active: true, hidden: ['c'] }, projects).hidden, ['c', 'a']);
  assert.deepEqual(allAgentsHiding({ active: true, hidden: ['a'] }, projects).hidden, ['a']);
}

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-project-snooze-test-'));
  const database = new DatabaseService(directory);
  try {
    database.initialize();
    const db = database.connection;
    const at = new Date(0).toISOString();
    db.prepare('insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)').run('project_a', 'Day job', directory, at, at);
    db.prepare(`insert into processes (id, project_id, kind, name, status, activity, pty_process_id, created_at, updated_at)
      values ('agent', 'project_a', 'agent', 'agent', 'running', 'idle', 'pty_agent', ?, ?)`).run(at, at);

    let now = Date.parse('2026-10-19T12:00:00Z');
    const notifications = new NotificationService(database, new SettingsService(database), { append: () => 'event' }, async () => {}, () => undefined, () => now);
    const raised: RaiseNotificationInput[] = [];
    let changes = 0;
    const snoozes = new ProjectSnoozeActions(database, { append: () => 'event' }, notifications,
      (input) => { raised.push(input); void notifications.raise(input); }, () => { changes += 1; }, () => now);
    const project = () => new WorkbenchRepository(database).snapshot().projects[0]!.project;

    // Awake, a failure reaches every device.
    const awake = await notifications.raise({ processId: 'agent', source: 'runtime', kind: 'failure', body: 'Exited with code 1' });
    assert.equal(awake.status, 'raised');
    assert.ok(awake.status === 'raised' && !awake.notification.held && awake.notification.delivery === 'all');

    // A time in the past is refused.
    assert.throws(() => snoozes.snooze({ project_id: 'project_a', until: '2026-10-19T11:00:00Z' }), /future/);
    snoozes.snooze({ project_id: 'project_a', until: '2026-10-20T09:00:00+01:00' });
    assert.equal(project().snoozedUntil, '2026-10-20T08:00:00.000Z');
    assert.ok(changes > 0);

    // Snoozed, everything is held in the app, permission requests included.
    const permission = await notifications.raise({ processId: 'agent', source: 'integrated', kind: 'permission', body: 'Run rm?' });
    const turn = await notifications.raise({ processId: 'agent', source: 'integrated', kind: 'turn_finished', body: 'Finished its turn' });
    for (const result of [permission, turn]) {
      assert.ok(result.status === 'raised');
      assert.equal(result.notification.held, true);
      assert.equal(result.notification.delivery, 'in_app');
    }
    // System notices, like the summary, are never held.
    const system = await notifications.raise({ projectId: 'project_a', source: 'system', kind: 'message', body: 'Update ready', dedupeKey: 'x' });
    assert.ok(system.status === 'raised' && !system.notification.held);

    // The deadline passes while Patterm is stopped; starting wakes it with
    // one summary of what was held.
    now = Date.parse('2026-10-20T08:05:00Z');
    snoozes.activate();
    snoozes.dispose();
    assert.equal(project().snoozedUntil, null);
    assert.equal(raised.length, 1);
    assert.equal(raised[0]!.title, 'Day job');
    assert.equal(raised[0]!.body, '2 notifications while snoozed');
    assert.equal(raised[0]!.source, 'system');
    assert.equal((db.prepare(`select count(*) as count from notifications where held = 1`).get() as { count: number }).count, 0);
    // Held ones stay unread for the list.
    assert.ok(notifications.unread().some((row) => row.project_id === 'project_a' && row.count >= 2));

    // A repeat of a notice from before the snooze is held and counted too,
    // in this snooze and the next.
    const before = await notifications.raise({ processId: 'agent', source: 'terminal', kind: 'attention', title: 'Build', body: 'done' });
    assert.ok(before.status === 'raised' && !before.notification.held);
    for (const cycle of [1, 2]) {
      snoozes.snooze({ project_id: 'project_a', until: new Date(now + 3_600_000).toISOString() });
      const repeat = await notifications.raise({ processId: 'agent', source: 'terminal', kind: 'attention', title: 'Build', body: 'done' });
      assert.ok(repeat.status === 'updated' && repeat.notification.held && repeat.notification.delivery === 'in_app', `cycle ${cycle}`);
      assert.deepEqual(snoozes.wake({ project_id: 'project_a' }), { woke: true, held: 1 });
    }
    raised.length = 1;

    // A delivery queued before the snooze doesn't go out once a repeat has
    // made the notice held.
    let delivered = 0;
    const delivery = new NotificationDelivery({ present: () => false }, {
      current: (id) => notifications.get(id), desktop: () => { delivered += 1; }, push: async () => { delivered += 1; }, log: () => {}
    });
    const urgent = await notifications.raise({ processId: 'agent', source: 'runtime', kind: 'failure', urgency: 'high', body: 'Crashed', dedupeKey: 'crash' });
    assert.ok(urgent.status === 'raised' && urgent.notification.delivery === 'all');
    delivery.handle({ type: 'raised', notification: urgent.notification });
    snoozes.snooze({ project_id: 'project_a', until: new Date(now + 3_600_000).toISOString() });
    await notifications.raise({ processId: 'agent', source: 'runtime', kind: 'failure', urgency: 'high', body: 'Crashed', dedupeKey: 'crash' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    delivery.dispose();
    assert.equal(delivered, 0);
    snoozes.wake({ project_id: 'project_a' });
    raised.length = 1;

    // Waking by hand with nothing held sends no summary.
    snoozes.snooze({ project_id: 'project_a', until: '2026-10-21T08:00:00Z' });
    assert.deepEqual(snoozes.wake({ project_id: 'project_a' }), { woke: true, held: 0 });
    assert.equal(raised.length, 1);
    assert.deepEqual(snoozes.wake({ project_id: 'project_a' }), { woke: false, held: 0 });
  } finally {
    database.dispose();
    removeTree(directory);
  }
}

helpers();
main().then(() => console.log('project snooze smoke passed')).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
