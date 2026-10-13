import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { seededHarnessPresetSettings } from '../app/Harness/HarnessPresets';
import backfillRoutineRunReports from '../database/migrations/2026_10_06_000037_backfill_routine_run_reports';
import { registerRoutineTools, type RoutineCaller } from '../app/MCP/registerRoutineTools';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';
import { DatabaseService } from '../app/Services/DatabaseService';
import { ProjectContextService } from '../app/Services/ProjectContextService';
import type { LaunchHarnessInput } from '../app/Services/HarnessLauncher';
import { notificationUrl, type RaiseNotificationInput } from '../app/Services/NotificationService';
import { nextRoutineRun, renderRoutinePrompt } from '../app/Services/RoutineSchedule';
import { MAX_PENDING_ONCE, ROUTINE_IDLE_STOP_MS, RoutineService, type RoutineRecord } from '../app/Services/RoutineService';
import type { TimelineService } from '../app/Services/TimelineService';

const weekdays = [1, 2, 3, 4, 5];

test('schedules keep local wall-clock time across a daylight-saving change', () => {
  const schedule = { days: weekdays, time: '16:30', timezone: 'Europe/London' };
  // Friday 23 October 2026 is still British Summer Time; Monday 26 October is GMT.
  assert.equal(new Date(nextRoutineRun(schedule, Date.parse('2026-10-23T12:00:00Z'))!).toISOString(), '2026-10-23T15:30:00.000Z');
  assert.equal(new Date(nextRoutineRun(schedule, Date.parse('2026-10-23T15:30:00Z'))!).toISOString(), '2026-10-26T16:30:00.000Z');
  assert.equal(nextRoutineRun({ ...schedule, days: [] }, Date.now()), null);
  // Times inside a spring-forward gap move later by the gap, whatever the zone's offset sign.
  assert.equal(new Date(nextRoutineRun({ days: [0], time: '02:30', timezone: 'America/New_York' }, Date.parse('2026-03-08T00:00:00Z'))!).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(new Date(nextRoutineRun({ days: [0], time: '01:30', timezone: 'Europe/London' }, Date.parse('2026-03-29T00:00:00Z'))!).toISOString(), '2026-03-29T01:30:00.000Z');
  // Zones far east of UTC: Auckland and Chatham move their clocks on Sunday 27 September 2026.
  assert.equal(new Date(nextRoutineRun({ days: [0], time: '02:30', timezone: 'Pacific/Auckland' }, Date.parse('2026-09-26T00:00:00Z'))!).toISOString(), '2026-09-26T14:30:00.000Z');
  assert.equal(new Date(nextRoutineRun({ days: [0], time: '03:00', timezone: 'Pacific/Chatham' }, Date.parse('2026-09-26T00:00:00Z'))!).toISOString(), '2026-09-26T14:15:00.000Z');
  assert.equal(new Date(nextRoutineRun({ days: [0], time: '02:30', timezone: 'Pacific/Auckland' }, Date.parse('2026-04-04T00:00:00Z'))!).toISOString(), '2026-04-04T13:30:00.000Z');
  // A repeated time when clocks go back resolves to its first occurrence.
  assert.equal(new Date(nextRoutineRun({ days: [0], time: '01:30', timezone: 'America/New_York' }, Date.parse('2026-11-01T00:00:00Z'))!).toISOString(), '2026-11-01T05:30:00.000Z');
  // Mondays, Wednesdays, and Fridays in New York.
  const decks = { days: [1, 3, 5], time: '08:30', timezone: 'America/New_York' };
  assert.equal(new Date(nextRoutineRun(decks, Date.parse('2026-10-06T12:00:00Z'))!).toISOString(), '2026-10-07T12:30:00.000Z');
});

test('prompt variables are filled from the run time and previous runs', () => {
  const scheduledFor = Date.parse('2026-10-05T15:30:00Z');
  const filled = renderRoutinePrompt('{{weekday}} {{date}} since {{since}}, last {{ last_run_at }}, keep {{other}}', {
    scheduledFor, timezone: 'Europe/London', lastRunAt: Date.parse('2026-10-02T15:31:00Z'), since: null
  });
  assert.equal(filled, 'Monday 2026-10-05 since 2026-10-05 00:00, last 2026-10-02 16:31, keep {{other}}');
});

test('a due routine starts an agent, completes on report, and stops after going idle', async (t) => {
  const fixture = setup(t, Date.parse('2026-10-05T15:29:00Z'));
  const routine = fixture.routines.create({ name: 'Daily roundup', project_id: 'project', days: weekdays, time: '16:30', timezone: 'Europe/London', prompt: 'Roundup for {{date}}', preset: 'Default' }, { type: 'user', id: null });
  assert.equal(routine.next_run_at, '2026-10-05T15:30:00.000Z');
  fixture.routines.activate();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(fixture.launches.length, 1);
  const launch = fixture.launches[0]!;
  assert.equal(launch.project_id, 'project');
  assert.equal(launch.session_role, 'orchestrator');
  assert.equal(launch.preset, 'Default');
  assert.match(launch.initial_prompt!, /report_to_parent/);
  assert.match(launch.initial_prompt!, /Roundup for 2026-10-05$/);
  assert.equal(fixture.routines.get(routine.routine_id).next_run_at, '2026-10-06T15:30:00.000Z');

  assert.equal(fixture.routines.report('other_process', { status: 'completed', body: 'not a run' }), null, 'other agents keep normal report_to_parent behaviour');
  const reported = fixture.routines.report('process_1', { status: 'completed', body: 'Added the roundup to Daily/2026-10-05.md' });
  assert.ok(reported);
  assert.equal(fixture.notifications.length, 1);
  assert.match(fixture.notifications[0]!.title!, /Daily roundup: done/);
  const [run] = fixture.routines.runs(routine.routine_id);
  assert.equal(run?.status, 'reported');
  assert.equal(run?.excerpt, 'Added the roundup to Daily/2026-10-05.md');
  assert.equal(fixture.routines.getRun(run!.run_id).report, 'Added the roundup to Daily/2026-10-05.md', 'the full report is kept for its notification');
  assert.equal(fixture.notifications[0]!.dedupeKey, `routine-report:${run!.run_id}`);
  assert.deepEqual(fixture.routines.reports().map((entry) => entry.run_id), [run!.run_id], 'the log lists runs across routines');
  assert.deepEqual(fixture.routines.reports({ routineId: routine.routine_id }).map((entry) => entry.run_id), [run!.run_id]);
  assert.deepEqual(fixture.routines.reports({ offset: 1 }), [], 'the log pages by offset');
  assert.deepEqual(fixture.routines.reports({ projectId: 'another_project' }), [], 'project callers only see their own runs');
  assert.equal(notificationUrl({ project_id: null, process_id: 'process_1', session_id: null, dedupe_key: `routine-report:${run!.run_id}` }), `/routines?report=${run!.run_id}`);

  // Idle time restarts when the agent works again, such as on a follow-up.
  fixture.setActivity('process_1', 'idle');
  minutes(t, 9);
  fixture.setActivity('process_1', 'working');
  minutes(t, 2);
  fixture.setActivity('process_1', 'idle');
  minutes(t, 5);
  // Work too brief for a sweep to see still restarts the idle time.
  t.mock.timers.tick(30_000);
  fixture.setActivity('process_1', 'working');
  t.mock.timers.tick(10_000);
  fixture.setActivity('process_1', 'idle');
  t.mock.timers.tick(20_000);
  minutes(t, 8);
  assert.deepEqual(fixture.stopped, []);
  minutes(t, 2);
  assert.deepEqual(fixture.stopped, ['process_1']);
  await settle();
  assert.ok(fixture.routines.runs(routine.routine_id)[0]?.finished_at);
});

test('a failed stop is retried and keeps blocking overlapping runs', async (t) => {
  const fixture = setup(t, Date.parse('2026-10-05T10:00:00Z'));
  const routine = fixture.routines.create({ name: 'Decks', project_id: 'project' }, { type: 'user', id: null });
  await fixture.routines.runNow(routine.routine_id);
  fixture.routines.report('process_1', { status: 'completed', body: 'done' });
  fixture.setActivity('process_1', 'idle');
  fixture.failStops(true);
  fixture.routines.sweep();
  t.mock.timers.tick(ROUTINE_IDLE_STOP_MS);
  fixture.routines.sweep();
  await settle();
  assert.equal(fixture.stopped.length, 1);
  assert.equal(fixture.routines.runs(routine.routine_id)[0]?.finished_at, null);
  assert.equal((await fixture.routines.runNow(routine.routine_id)).status, 'skipped');
  fixture.failStops(false);
  fixture.routines.sweep();
  await settle();
  assert.equal(fixture.stopped.length, 2);
  assert.ok(fixture.routines.runs(routine.routine_id).find((run) => run.process_id === 'process_1')?.finished_at);
});

test('edits outside the schedule keep a due run, and runs keep their project', async (t) => {
  const fixture = setup(t, Date.parse('2026-10-05T07:59:00Z'));
  const routine = fixture.routines.create({ name: 'Audit', project_id: 'project', days: [1], time: '09:00', timezone: 'Europe/London' }, { type: 'user', id: null });
  t.mock.timers.tick(60_000 + 5_000);
  // Due at 09:00 London; the scheduler has not fired it yet when the prompt is edited.
  assert.equal(fixture.routines.update({ routine_id: routine.routine_id, prompt: 'new prompt' }).next_run_at, '2026-10-05T08:00:00.000Z');
  await fixture.routines.runNow(routine.routine_id);
  fixture.addProject('other');
  const moved = fixture.routines.update({ routine_id: routine.routine_id, project_id: 'other' });
  assert.equal(moved.last_run?.project_id, 'project');

  // An agent in the routine's new project can't read runs, or their reports, from the old one.
  const registry = new McpToolRegistry();
  let caller: RoutineCaller | null = { sessionId: 'session_other', projectId: 'other', workspace: false };
  registerRoutineTools(registry, fixture.routines, () => caller);
  const runId = moved.last_run!.run_id;
  assert.equal((await registry.call('routine_get', { routine_id: routine.routine_id }) as RoutineRecord).last_run, null);
  assert.equal((await registry.call('routine_list', {}) as { routines: RoutineRecord[] }).routines[0]!.last_run, null);
  assert.deepEqual((await registry.call('routine_runs', { routine_id: routine.routine_id }) as { runs: unknown[] }).runs, []);
  assert.deepEqual((await registry.call('routine_log', {}) as { runs: unknown[] }).runs, []);
  await assert.rejects(registry.call('routine_run', { run_id: runId }), /outside the current caller scope/);
  caller = null;
  assert.equal((await registry.call('routine_run', { run_id: runId }) as { run_id: string }).run_id, runId, 'the owner still reads every run');
});

test('reports are ordered by when they reported, not when they were scheduled', (t) => {
  const fixture = setup(t, Date.parse('2026-10-05T12:00:00Z'));
  const routine = fixture.routines.create({ name: 'Audit', project_id: 'project', days: [1], time: '09:00', timezone: 'Europe/London' }, { type: 'user', id: null });
  const insert = fixture.database.connection.prepare(`insert into routine_runs (id, routine_id, project_id, scheduled_for, reported_at, status, report_status, created_at)
    values (?, ?, 'project', ?, ?, 'reported', 'completed', ?)`);
  // A catch-up run scheduled days ago that reported just now, and a run scheduled and reported this morning.
  insert.run('run_catch_up', routine.routine_id, '2026-10-02T08:00:00Z', '2026-10-05T11:50:00Z', '2026-10-05T11:40:00Z');
  insert.run('run_morning', routine.routine_id, '2026-10-05T08:00:00Z', '2026-10-05T08:05:00Z', '2026-10-05T08:00:00Z');
  assert.deepEqual(fixture.routines.reports().map((run) => run.run_id), ['run_catch_up', 'run_morning']);
  assert.deepEqual(fixture.routines.reports({ limit: 1, offset: 1 }).map((run) => run.run_id), ['run_morning']);
});

test('runs from before full reports were kept get theirs back from the timeline', (t) => {
  const fixture = setup(t, Date.parse('2026-10-05T12:00:00Z'));
  const routine = fixture.routines.create({ name: 'Audit', project_id: 'project', days: [1], time: '09:00', timezone: 'Europe/London' }, { type: 'user', id: null });
  const db = fixture.database.connection;
  const insert = db.prepare(`insert into routine_runs (id, routine_id, project_id, scheduled_for, reported_at, status, report_status, excerpt, created_at)
    values (?, ?, 'project', '2026-10-05T08:00:00Z', '2026-10-05T08:05:00Z', 'reported', 'completed', 'Short excerpt…', '2026-10-05T08:00:00Z')`);
  insert.run('run_titled', routine.routine_id);
  insert.run('run_plain', routine.routine_id);
  insert.run('run_unknown', routine.routine_id);
  const event = db.prepare(`insert into timeline_events (id, event_type, project_id, actor_type, metadata, created_at) values (?, 'agent.reported', 'project', 'agent', ?, '2026-10-05T08:05:00Z')`);
  const body = 'A'.repeat(4000);
  event.run('event_titled', JSON.stringify({ run_id: 'run_titled', title: 'Roundup', body }));
  event.run('event_plain', JSON.stringify({ run_id: 'run_plain', title: null, body }));
  backfillRoutineRunReports.up({ connection: db, sql: (statement: string) => db.exec(statement) } as unknown as Parameters<typeof backfillRoutineRunReports.up>[0]);
  assert.equal(fixture.routines.getRun('run_titled').report, `Roundup\n\n${body}`);
  assert.equal(fixture.routines.getRun('run_plain').report, body);
  assert.equal(fixture.routines.getRun('run_unknown').report, null, 'a run without a report event keeps its excerpt');
});

test('a run waiting on permission stays visible after a later run is skipped', async (t) => {
  const fixture = setup(t, Date.parse('2026-10-05T10:00:00Z'));
  const routine = fixture.routines.create({ name: 'Decks', project_id: 'project' }, { type: 'user', id: null });
  await fixture.routines.runNow(routine.routine_id);
  fixture.setActivity('process_1', 'permission');
  t.mock.timers.tick(1_000);
  await fixture.routines.runNow(routine.routine_id);
  const record = fixture.routines.get(routine.routine_id);
  assert.equal(record.last_run?.status, 'skipped');
  assert.equal(record.waiting_run?.process_id, 'process_1');
  assert.equal(record.waiting_run?.needs_you, true);
});

test('runs that end without reporting fail, and overlapping runs are skipped', async (t) => {
  const fixture = setup(t, Date.parse('2026-10-05T10:00:00Z'));
  const routine = fixture.routines.create({ name: 'Decks', project_id: 'project', model: 'gpt-6-astra', reasoning: 'high', service_tier: 'priority', harness: 'codex' }, { type: 'agent', id: null });
  await fixture.routines.runNow(routine.routine_id);
  const skipped = await fixture.routines.runNow(routine.routine_id);
  assert.equal(skipped.status, 'skipped');
  assert.equal(fixture.launches.length, 1);
  assert.equal(fixture.launches[0]!.model, 'gpt-6-astra');
  assert.equal(fixture.launches[0]!.service_tier, 'priority');

  fixture.setStatus('process_1', 'exited');
  fixture.routines.sweep();
  const failed = fixture.routines.runs(routine.routine_id).find((run) => run.process_id === 'process_1');
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.excerpt, 'The agent ended before it reported.');
});

test('workspace routines run in the internal project with cross-project reach', async (t) => {
  const fixture = setup(t, Date.parse('2026-10-05T10:00:00Z'));
  const routine = fixture.routines.create({ name: 'Roundup', project_id: null }, { type: 'user', id: null });
  await fixture.routines.runNow(routine.routine_id);
  const launch = fixture.launches[0]!;
  assert.equal(launch.project_id, 'project_assistant');
  assert.equal(launch.session_role, 'routine');
  assert.equal(launch.interface_mode, 'integrated');
  assert.ok(launch.cwd && fs.existsSync(launch.cwd));
});

test('workspace routine runs reach project todos and scratchpads by project_id', (t) => {
  const fixture = setup(t, Date.now());
  const db = fixture.database.connection;
  const at = new Date().toISOString();
  db.prepare(`insert into projects (id,name,path,kind,created_at,updated_at) values ('project_assistant','Assistant','/tmp','assistant',?,?)`).run(at, at);
  db.prepare(`insert into processes (id,project_id,kind,name,status,created_at,updated_at) values ('run_process','project_assistant','agent','Roundup','running',?,?)`).run(at, at);
  db.prepare(`insert into sessions (id,project_id,process_id,harness,session_role,started_at,mcp_identity) values ('run_session','project_assistant','run_process','claude','routine',?,'routine_identity')`).run(at);
  const context = new ProjectContextService(fixture.database, { append: () => 'event' } as unknown as TimelineService);
  assert.deepEqual(context.actor('routine_identity', 'project'), { projectId: 'project', actorId: 'run_session', sessionId: null });
  assert.throws(() => context.actor('routine_identity'), /workspace routine must pass a workspace project_id/);
});

test('routines reject conflicting launch settings and unknown presets', (t) => {
  const fixture = setup(t, Date.now());
  const actor = { type: 'user' as const, id: null };
  assert.throws(() => fixture.routines.create({ name: 'x', project_id: 'project', preset: 'Default', model: 'opus' }, actor), /preset or a model/);
  assert.throws(() => fixture.routines.create({ name: 'x', project_id: 'project', preset: 'Missing' }, actor), /unknown claude preset/);
  assert.throws(() => fixture.routines.create({ name: 'x', project_id: 'project', model: 'opus', service_tier: 'priority' }, actor), /Only Codex/);
  assert.throws(() => fixture.routines.create({ name: 'x', project_id: 'project', time: '25:00' }, actor), /HH:MM/);
  assert.throws(() => fixture.routines.create({ name: 'x', project_id: 'nope' }, actor), /unknown project/);
  const routine = fixture.routines.create({ name: 'x', project_id: 'project', harness: 'codex', model: 'gpt-6-astra', service_tier: 'priority' }, actor);
  const switched = fixture.routines.update({ routine_id: routine.routine_id, harness: 'claude' });
  assert.equal(switched.model, null, 'a new harness drops the old model');
  assert.equal(switched.service_tier, null);
  const paused = fixture.routines.update({ routine_id: routine.routine_id, enabled: false });
  assert.equal(paused.next_run_at, null);
});

test('a one-off runs once in its zone, and only while its time is ahead', () => {
  const once = { days: [], time: '09:00', timezone: 'Europe/London', run_at: '2026-10-07T08:00:00.000Z' };
  assert.equal(nextRoutineRun(once, Date.parse('2026-10-06T12:00:00Z')), Date.parse('2026-10-07T08:00:00Z'));
  assert.equal(nextRoutineRun(once, Date.parse('2026-10-07T08:00:00Z')), null);
});

test('an agent hands work to a one-off that runs once in its worktree and then turns off', async (t) => {
  const fixture = setup(t, Date.parse('2026-10-05T10:00:00Z'));
  const scheduler = fixture.addAgent('session_scheduler', 'process_scheduler');
  const worktree = fixture.addWorktree('worktree_1', 'project');
  const registry = new McpToolRegistry();
  let caller: RoutineCaller | null = { sessionId: scheduler, projectId: 'project', workspace: false };
  registerRoutineTools(registry, fixture.routines, () => caller);

  const routine = await registry.call('routine_schedule_once', { name: 'Check deploy', prompt: 'See whether the deploy finished', in_minutes: 90, worktree_id: worktree }) as RoutineRecord;
  assert.equal(routine.project_id, 'project', 'a project agent schedules into its own project');
  assert.equal(routine.run_at, '2026-10-05T11:30:00.000Z');
  assert.equal(routine.next_run_at, routine.run_at);
  assert.equal(routine.time, '12:30', 'the time shows in the routine\'s zone');
  assert.equal(routine.enabled, true);
  assert.equal(routine.created_by.type, 'agent');

  fixture.routines.activate();
  minutes(t, 91);
  await settle();
  assert.equal(fixture.launches.length, 1);
  const launch = fixture.launches[0]!;
  assert.equal(launch.worktree_id, worktree);
  assert.match(launch.initial_prompt!, /one-off/);
  assert.match(launch.initial_prompt!, /get_conversation_output \(process_id process_scheduler\)/);
  const done = fixture.routines.get(routine.routine_id);
  assert.equal(done.enabled, false, 'a one-off turns itself off once it has run');
  assert.equal(done.next_run_at, null);
  fixture.routines.report('process_1', { status: 'completed', body: 'Deploy is live' });
  assert.equal(fixture.notifications.length, 1, 'the report goes to the user');
  minutes(t, 60 * 24 * 8);
  await settle();
  assert.equal(fixture.launches.length, 1, 'it never runs again');
  await assert.rejects(registry.call('routine_update', { routine_id: routine.routine_id, enabled: true }), /in the future/);

  // Agents cannot place one-offs elsewhere, in the past, or without end.
  await assert.rejects(registry.call('routine_schedule_once', { name: 'x', prompt: 'x', in_minutes: 5, project_id: 'other' }), /their own project/);
  await assert.rejects(registry.call('routine_schedule_once', { name: 'x', prompt: 'x', run_at: '2026-01-01T00:00:00Z' }), /in the future/);
  await assert.rejects(registry.call('routine_schedule_once', { name: 'x', prompt: 'x' }), /run_at or in_minutes/);
  await assert.rejects(registry.call('routine_schedule_once', { name: 'x', prompt: 'x', in_minutes: 5, worktree_id: 'missing' }), /unknown worktree/);
  for (let index = 0; index < MAX_PENDING_ONCE; index += 1) {
    await registry.call('routine_schedule_once', { name: `Follow-up ${index}`, prompt: 'x', in_minutes: 60 });
  }
  await assert.rejects(registry.call('routine_schedule_once', { name: 'One more', prompt: 'x', in_minutes: 60 }), /already has 20/);
  caller = null;
  fixture.addProject('other');
  const elsewhere = fixture.routines.create({ name: 'Elsewhere', project_id: 'other', run_at: '2026-10-20T09:00:00Z', days: [] }, { type: 'user', id: null });
  assert.throws(() => fixture.routines.update({ routine_id: elsewhere.routine_id, project_id: 'project' }), /already has 20/, 'moving a one-off counts toward the new project');
  const repeating = fixture.routines.update({ routine_id: routine.routine_id, run_at: null, days: [1] });
  assert.equal(repeating.run_at, null, 'a one-off can become a weekly routine');
});

test('a one-off missed while Patterm was stopped runs once on catch-up', async (t) => {
  const fixture = setup(t, Date.parse('2026-10-05T08:00:00Z'));
  const routine = fixture.routines.create({ name: 'Later', project_id: 'project', run_at: '2026-10-05T10:30:00+01:00', days: [] }, { type: 'user', id: null });
  assert.equal(routine.time, '10:30');
  t.mock.timers.tick(3 * 3_600_000);
  fixture.routines.activate();
  await settle();
  assert.equal(fixture.launches.length, 1);
  assert.match(fixture.routines.runs(routine.routine_id)[0]!.excerpt!, /Catch-up/);
  assert.equal(fixture.routines.get(routine.routine_id).enabled, false);
});

test('a removed project\'s routines wait, hidden, until it is added again', async (t) => {
  const fixture = setup(t, Date.parse('2026-10-05T15:29:00Z'));
  const routine = fixture.routines.create({ name: 'Daily roundup', project_id: 'project', days: weekdays, time: '16:30', timezone: 'Europe/London' }, { type: 'user', id: null });
  fixture.database.connection.prepare('update projects set removed_at = ? where id = ?').run(new Date().toISOString(), 'project');
  fixture.routines.activate();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(fixture.launches.length, 0, 'a removed project runs nothing');
  assert.deepEqual(fixture.routines.list().map((record) => record.routine_id), [], 'nor lists its routines');
  assert.throws(() => fixture.routines.create({ name: 'Another', project_id: 'project' }, { type: 'user', id: null }), /unknown project/);

  fixture.database.connection.prepare('update projects set removed_at = null where id = ?').run('project');
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(fixture.launches.length, 1, 'restored, the missed run catches up once');
  assert.deepEqual(fixture.routines.list().map((record) => record.routine_id), [routine.routine_id]);
});

function setup(t: TestContext, now: number) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-routines-'));
  const database = new DatabaseService(directory);
  database.initialize();
  const at = new Date().toISOString();
  database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)').run('project', 'Routine fixture', directory, at, at);
  const launches: LaunchHarnessInput[] = [];
  const notifications: RaiseNotificationInput[] = [];
  const stopped: string[] = [];
  let failStops = false;
  const routines = new RoutineService({
    database,
    timeline: { append: () => 'event' } as unknown as TimelineService,
    launch: async (input) => {
      launches.push(input);
      const id = `process_${launches.length}`;
      database.connection.prepare(`insert into processes (id,project_id,kind,name,status,activity,created_at,updated_at) values (?, ?, 'agent', ?, 'running', 'working', ?, ?)`)
        .run(id, input.project_id, input.name ?? 'agent', at, at);
      return { session_id: `session_${launches.length}`, process_id: id, pty_process_id: null, interface_mode: 'tui', harness: input.harness ?? 'claude', name: input.name ?? '' };
    },
    stopProcess: async (processId) => {
      stopped.push(processId);
      if (failStops) throw new Error('stop failed');
    },
    presets: seededHarnessPresetSettings,
    notify: (input) => { notifications.push(input); },
    onChanged: () => undefined,
    appDataPath: directory,
    defaultTimeZone: 'Europe/London'
  });
  t.after(() => {
    routines.dispose();
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    routines, launches, notifications, stopped, database,
    // Like the runtime, activity changes stamp updated_at.
    setActivity: (id: string, activity: string) => database.connection.prepare('update processes set activity = ?, updated_at = ? where id = ? and activity != ?').run(activity, new Date().toISOString(), id, activity),
    setStatus: (id: string, status: string) => database.connection.prepare('update processes set status = ? where id = ?').run(status, id),
    failStops: (value: boolean) => { failStops = value; },
    addProject: (id: string) => database.connection.prepare('insert into projects (id,name,path,created_at,updated_at) values (?,?,?,?,?)').run(id, id, directory, at, at),
    addAgent: (sessionId: string, processId: string) => {
      database.connection.prepare(`insert into processes (id,project_id,kind,name,status,created_at,updated_at) values (?, 'project', 'agent', 'Scheduler', 'running', ?, ?)`).run(processId, at, at);
      database.connection.prepare(`insert into sessions (id,project_id,process_id,harness,session_role,started_at,mcp_identity) values (?, 'project', ?, 'claude', 'orchestrator', ?, ?)`).run(sessionId, processId, at, `${sessionId}_identity`);
      return sessionId;
    },
    addWorktree: (id: string, projectId: string) => {
      database.connection.prepare(`insert into worktrees (id,project_id,repo_path,worktree_path,branch,created_by,created_at) values (?, ?, ?, ?, ?, 'user', ?)`).run(id, projectId, directory, directory, `patterm/${id}`, at);
      return id;
    }
  };
}

// Mocked ticks run every timer with the final clock time, so step a minute at a time.
function minutes(t: TestContext, count: number) {
  for (let index = 0; index < count; index += 1) t.mock.timers.tick(60_000);
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
