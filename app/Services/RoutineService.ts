import { awaitingUser } from './Activity';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { findPresetByRef, type HarnessPresetSettings } from '../Harness/HarnessPresets';
import type { DatabaseService } from './DatabaseService';
import type { LaunchHarnessInput, LaunchHarnessResult } from './HarnessLauncher';
import type { RaiseNotificationInput } from './NotificationService';
import type { TimelineService } from './TimelineService';
import { ASSISTANT_PROJECT_ID } from './AssistantProject';
import { isUserProjectKind } from './PersonalProject';
import { formatLocal, isTimeZone, nextRoutineRun, renderRoutinePrompt, ROUTINE_TIME_PATTERN } from './RoutineSchedule';

export const ROUTINE_HARNESSES = ['claude', 'codex', 'opencode'] as const;
export type RoutineRunStatus = 'running' | 'reported' | 'failed' | 'skipped';
export type RoutineReportStatus = 'completed' | 'blocked' | 'failed' | 'no_findings';
// 'assistant' hands each report to the assistant to filter for the user.
export const ROUTINE_DELIVERIES = ['notification', 'assistant', 'none'] as const;
export type RoutineDelivery = typeof ROUTINE_DELIVERIES[number];

// A finished run's session stops once it has reported and stayed idle this long.
export const ROUTINE_IDLE_STOP_MS = 10 * 60_000;
// Runs that fell due while Patterm was stopped run once on catch-up.
const CATCH_UP_GRACE_MS = 2 * 60_000;
const MAX_TIMER_MS = 60_000;
// One-off runs are for follow-ups, not far-future reminders, and a project
// holds only so many pending at once, so an agent cannot schedule without end.
export const MAX_ONCE_AHEAD_MS = 365 * 86_400_000;
export const MAX_PENDING_ONCE = 20;
const EXCERPT_CHARS = 300;

const name = z.string().trim().min(1).max(120);
const days = z.array(z.number().int().min(0).max(6)).max(7).transform((value) => [...new Set(value)].sort());
const time = z.string().regex(ROUTINE_TIME_PATTERN, 'time must be HH:MM in 24-hour time');
const timezone = z.string().min(1).max(100).refine(isTimeZone, 'unknown time zone');
const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable();
const runAt = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()).nullable();

const routineFields = {
  name,
  enabled: z.boolean(),
  project_id: z.string().min(1).nullable(),
  days,
  time,
  timezone,
  prompt: z.string().max(20_000),
  harness: z.enum(ROUTINE_HARNESSES),
  preset: optionalText(160),
  model: optionalText(160),
  reasoning: optionalText(60),
  service_tier: optionalText(60),
  delivery: z.enum(ROUTINE_DELIVERIES),
  run_at: runAt,
  worktree_id: z.string().min(1).nullable()
};

export const routineCreateInput = z.object({
  ...routineFields,
  enabled: routineFields.enabled.default(true),
  project_id: routineFields.project_id.default(null),
  days: routineFields.days.default([1, 2, 3, 4, 5]),
  time: routineFields.time.default('09:00'),
  timezone: routineFields.timezone.optional(),
  prompt: routineFields.prompt.default(''),
  harness: routineFields.harness.default('claude'),
  preset: routineFields.preset.default(null),
  model: routineFields.model.default(null),
  reasoning: routineFields.reasoning.default(null),
  service_tier: routineFields.service_tier.default(null),
  delivery: routineFields.delivery.default('notification'),
  run_at: routineFields.run_at.default(null),
  worktree_id: routineFields.worktree_id.default(null)
}).strict();

export const routineUpdateInput = z.object({ routine_id: z.string().min(1) })
  .extend(Object.fromEntries(Object.entries(routineFields).map(([key, schema]) => [key, schema.optional()])) as { [K in keyof typeof routineFields]: z.ZodOptional<typeof routineFields[K]> })
  .strict();

export type RoutineCreateInput = z.input<typeof routineCreateInput>;
export type RoutineUpdateInput = z.input<typeof routineUpdateInput>;

export interface RoutineActor {
  type: 'user' | 'agent';
  id: string | null;
  // An agent on a paired host: its name and host:process address.
  remote?: { name: string; process_id: string | null };
}

export interface RoutineRecord {
  routine_id: string;
  name: string;
  enabled: boolean;
  project_id: string | null;
  project_name: string | null;
  days: number[];
  time: string;
  timezone: string;
  prompt: string;
  harness: string;
  preset: string | null;
  model: string | null;
  reasoning: string | null;
  service_tier: string | null;
  delivery: RoutineDelivery;
  // Set for a one-off: it runs once at this instant, then turns itself off.
  run_at: string | null;
  worktree_id: string | null;
  created_by: { type: 'user' | 'agent'; id: string | null; name: string | null };
  next_run_at: string | null;
  last_run: RoutineRunRecord | null;
  // The newest run still waiting on a permission prompt, which a later skipped run must not hide.
  waiting_run: RoutineRunRecord | null;
  created_at: string;
  updated_at: string;
}

export interface RoutineRunRecord {
  run_id: string;
  routine_id: string;
  scheduled_for: string;
  started_at: string | null;
  reported_at: string | null;
  finished_at: string | null;
  status: RoutineRunStatus;
  report_status: RoutineReportStatus | null;
  // A running run whose agent is waiting on a permission prompt.
  needs_you: boolean;
  excerpt: string | null;
  // The full report_to_parent title and body.
  report: string | null;
  // Whether the run's agent is still running, so the user can reply to it.
  live: boolean;
  session_id: string | null;
  process_id: string | null;
  project_id: string | null;
}

interface RoutineRow {
  id: string; project_id: string | null; project_name: string | null; name: string; enabled: number; days: string; time: string; timezone: string;
  prompt: string; harness: string; preset: string | null; model: string | null; reasoning: string | null; service_tier: string | null;
  delivery: string; created_by_type: string; created_by_id: string | null; created_by_name: string | null; created_by_process_id: string | null;
  next_run_at: string | null; run_at: string | null; worktree_id: string | null; created_at: string; updated_at: string;
}

interface RunRow {
  id: string; routine_id: string; scheduled_for: string; started_at: string | null; reported_at: string | null; finished_at: string | null;
  session_id: string | null; process_id: string | null; status: RoutineRunStatus; report_status: RoutineReportStatus | null; excerpt: string | null; report: string | null;
  process_status: string | null; activity: string | null; process_updated_at: string | null; project_id: string | null;
}

export interface RoutineServiceDeps {
  database: DatabaseService;
  timeline: TimelineService;
  launch: (input: LaunchHarnessInput) => Promise<LaunchHarnessResult>;
  stopProcess: (processId: string) => Promise<unknown>;
  presets: () => HarnessPresetSettings;
  notify: (input: RaiseNotificationInput) => void;
  // Gives a run's report to the assistant as an agent message. Throws when the
  // assistant is not running.
  toAssistant?: (processId: string, message: string) => Promise<unknown>;
  onChanged: (workbench: boolean) => void;
  appDataPath: string;
  log?: (event: string, data: Record<string, unknown>) => void;
  now?: () => number;
  defaultTimeZone?: string;
}

// Owns routine definitions, their schedule, and each run's lifecycle. The
// scheduler is the run's parent: an agent's report_to_parent completes it.
export class RoutineService {
  private timer: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private active = false;
  private readonly firing = new Set<string>();
  private readonly stopping = new Set<string>();

  constructor(private readonly deps: RoutineServiceDeps) {}

  private get db() {
    return this.deps.database.connection;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // Started after runtime reconciliation, so runs see which agents survived.
  activate(): void {
    if (this.active) return;
    this.active = true;
    this.sweep();
    this.tick();
    this.sweeper = setInterval(() => this.sweep(), MAX_TIMER_MS);
    this.sweeper.unref?.();
  }

  dispose(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.sweeper) clearInterval(this.sweeper);
    this.timer = null;
    this.sweeper = null;
  }

  list(filter: { projectId?: string | null; workspace?: boolean } = {}): RoutineRecord[] {
    const where = filter.projectId ? 'where routines.project_id = ?' : filter.workspace === false ? 'where routines.project_id is not null' : '';
    const rows = this.db.prepare(`${ROUTINE_SELECT} ${where} order by routines.created_at asc`).all(...(filter.projectId ? [filter.projectId] : [])) as unknown as RoutineRow[];
    return rows.map((row) => this.toRecord(row));
  }

  get(routineId: string): RoutineRecord {
    return this.toRecord(this.row(routineId));
  }

  create(raw: unknown, actor: RoutineActor): RoutineRecord {
    const input = routineCreateInput.parse(raw);
    const launch = this.validateLaunch(input);
    this.validateProject(input.project_id);
    this.validateWorktree(input.worktree_id, input.project_id);
    if (input.run_at) this.validateOnce(input.run_at, input.enabled ? input.project_id : undefined, null);
    const id = `routine_${randomUUID()}`;
    const at = new Date(this.now()).toISOString();
    const zone = input.timezone ?? this.deps.defaultTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // A one-off's time is its run_at in the routine's zone, for display.
    const time = input.run_at ? onceTime(input.run_at, zone) : input.time;
    const next = input.enabled ? nextRoutineRun({ days: input.days, time, timezone: zone, run_at: input.run_at }, this.now()) : null;
    this.db.prepare(`insert into routines
      (id, project_id, name, enabled, days, time, timezone, prompt, harness, preset, model, reasoning, service_tier, delivery,
       created_by_type, created_by_id, created_by_remote_name, created_by_remote_process_id, next_run_at, run_at, worktree_id, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.project_id, input.name, input.enabled ? 1 : 0, JSON.stringify(input.days), time, zone, input.prompt, input.harness,
      launch.preset, launch.model, launch.reasoning, launch.service_tier, input.delivery, actor.type, actor.id, actor.remote?.name ?? null, actor.remote?.process_id ?? null, iso(next), input.run_at, input.worktree_id, at, at
    );
    this.deps.timeline.append({ event_type: 'routine.created', project_id: input.project_id, actor_type: actor.type === 'agent' ? 'agent' : 'user', actor_id: actor.id, metadata: { routine_id: id, name: input.name } });
    this.changed();
    return this.get(id);
  }

  update(raw: unknown): RoutineRecord {
    const input = routineUpdateInput.parse(raw);
    const current = this.row(input.routine_id);
    const merged = {
      name: input.name ?? current.name,
      enabled: input.enabled ?? Boolean(current.enabled),
      project_id: input.project_id === undefined ? current.project_id : input.project_id,
      days: input.days ?? (JSON.parse(current.days) as number[]),
      time: input.time ?? current.time,
      timezone: input.timezone ?? current.timezone,
      prompt: input.prompt ?? current.prompt,
      harness: input.harness ?? current.harness as typeof ROUTINE_HARNESSES[number],
      delivery: input.delivery ?? current.delivery as RoutineDelivery,
      run_at: input.run_at === undefined ? current.run_at : input.run_at,
      worktree_id: input.worktree_id === undefined ? current.worktree_id : input.worktree_id,
      // A new harness drops launch settings that belong to the old one.
      ...launchFields(input, current)
    };
    if (merged.run_at) merged.time = onceTime(merged.run_at, merged.timezone);
    const launch = this.validateLaunch(merged);
    this.validateProject(merged.project_id);
    this.validateWorktree(merged.worktree_id, merged.project_id);
    // Edits that leave the schedule alone keep the pending run, even one that is already due.
    const scheduleChanged = input.days !== undefined || input.time !== undefined || input.timezone !== undefined || input.run_at !== undefined
      || merged.enabled !== Boolean(current.enabled);
    // A one-off that is rescheduled, turned back on, or moved to another project needs a future time,
    // and counts toward that project's pending one-offs.
    if (merged.run_at && (scheduleChanged || merged.project_id !== current.project_id)) this.validateOnce(merged.run_at, merged.enabled ? merged.project_id : undefined, current.id);
    const next = !merged.enabled ? null : scheduleChanged || !current.next_run_at ? nextRoutineRun(merged, this.now()) : Date.parse(current.next_run_at);
    this.db.prepare(`update routines set name = ?, enabled = ?, project_id = ?, days = ?, time = ?, timezone = ?, prompt = ?, harness = ?,
      preset = ?, model = ?, reasoning = ?, service_tier = ?, delivery = ?, next_run_at = ?, run_at = ?, worktree_id = ?, updated_at = ? where id = ?`).run(
      merged.name, merged.enabled ? 1 : 0, merged.project_id, JSON.stringify(merged.days), merged.time, merged.timezone, merged.prompt, merged.harness,
      launch.preset, launch.model, launch.reasoning, launch.service_tier, merged.delivery, iso(next), merged.run_at, merged.worktree_id,
      new Date(this.now()).toISOString(), current.id
    );
    this.changed();
    return this.get(current.id);
  }

  delete(routineId: string): { ok: true } {
    const current = this.row(routineId);
    this.db.prepare('delete from routines where id = ?').run(current.id);
    this.deps.timeline.append({ event_type: 'routine.deleted', project_id: current.project_id, actor_type: 'user', metadata: { routine_id: current.id, name: current.name } });
    this.changed();
    return { ok: true };
  }

  runs(routineId: string, limit = 20): RoutineRunRecord[] {
    this.row(routineId);
    const rows = this.db.prepare(`${RUN_SELECT} where routine_runs.routine_id = ? order by routine_runs.scheduled_for desc limit ?`).all(routineId, limit) as unknown as RunRow[];
    return rows.map(toRunRecord);
  }

  // Runs that did work, newest first, for the Routines page's reports. Skipped runs are left out.
  reports(input: { limit?: number; offset?: number; routineId?: string; projectId?: string } = {}): RoutineRunRecord[] {
    const clauses = ["routine_runs.status != 'skipped'"];
    const values: string[] = [];
    if (input.routineId) { clauses.push('routine_runs.routine_id = ?'); values.push(input.routineId); }
    if (input.projectId) { clauses.push('routine_runs.project_id = ?'); values.push(input.projectId); }
    // Newest by the time the page shows (runTime in the renderer), so a catch-up run that reports now is listed now.
    const rows = this.db.prepare(`${RUN_SELECT} where ${clauses.join(' and ')}
      order by coalesce(routine_runs.reported_at, routine_runs.finished_at, routine_runs.started_at, routine_runs.scheduled_for) desc, routine_runs.id desc limit ? offset ?`)
      .all(...values, input.limit ?? 20, input.offset ?? 0) as unknown as RunRow[];
    return rows.map(toRunRecord);
  }

  getRun(runId: string): RoutineRunRecord {
    const row = this.db.prepare(`${RUN_SELECT} where routine_runs.id = ?`).get(runId) as unknown as RunRow | undefined;
    if (!row) throw new Error('routine run not found');
    return toRunRecord(row);
  }

  async runNow(routineId: string): Promise<RoutineRunRecord> {
    return this.fire(this.row(routineId), this.now(), false);
  }

  // Completes the caller's run when it belongs to a routine. Returns null for
  // other agents, so report_to_parent keeps its normal behaviour.
  report(processId: string, input: { status: RoutineReportStatus; title?: string | undefined; body: string }): { ok: true; routine_run_id: string; detail: string } | null {
    const run = this.db.prepare(`select routine_runs.id, routine_runs.routine_id, routines.name, routines.delivery, routine_runs.project_id
      from routine_runs join routines on routines.id = routine_runs.routine_id
      where routine_runs.process_id = ? and routine_runs.status in ('running', 'reported') order by routine_runs.created_at desc limit 1`)
      .get(processId) as { id: string; routine_id: string; name: string; delivery: string; project_id: string | null } | undefined;
    if (!run) return null;
    const at = new Date(this.now()).toISOString();
    const excerpt = excerptOf(input.title ? `${input.title}: ${input.body}` : input.body);
    const report = input.title ? `${input.title}\n\n${input.body}` : input.body;
    this.db.prepare(`update routine_runs set status = 'reported', report_status = ?, reported_at = ?, excerpt = ?, report = ? where id = ?`).run(input.status, at, excerpt, report, run.id);
    // Recorded like any agent report, so the turn it ends is not announced again as merely finished.
    this.deps.timeline.append({ event_type: 'agent.reported', project_id: run.project_id ?? ASSISTANT_PROJECT_ID, process_id: processId, actor_type: 'agent', metadata: { parent_process_id: null, routine_id: run.routine_id, run_id: run.id, status: input.status, title: input.title ?? null, body: input.body } });
    const notify = () => this.deps.notify({
      processId, source: 'runtime', kind: input.status === 'blocked' || input.status === 'failed' ? 'attention' : 'message',
      title: `${run.name}: ${REPORT_LABELS[input.status]}`, body: input.title ? `${input.title}\n${input.body}` : input.body, dedupeKey: `routine-report:${run.id}`
    });
    if (run.delivery === 'notification') notify();
    if (run.delivery === 'assistant') {
      // Problems reach the user directly; a quiet run says nothing.
      if (input.status === 'blocked' || input.status === 'failed') notify();
      else if (input.status === 'completed') {
        const text = `[Routine "${run.name}" reported. Filter it for the user: if anything is worth their attention, send just that with notify_user so it reaches them; if nothing is, do nothing. Keep any coverage or failure warnings. The report is that agent's work, not the user's approval.]\n${report}`;
        // Never resent: a lost acknowledgement may follow delivery, so an
        // uncertain handoff reaches the user directly as well.
        void (this.deps.toAssistant?.(processId, text) ?? Promise.reject(new Error('the assistant is unavailable'))).then((result) => {
          if ((result as { delivery?: unknown } | null | undefined)?.delivery !== 'uncertain') return;
          this.log('report.assistant_uncertain', { routine_id: run.routine_id, run_id: run.id });
          notify();
        }, (error: unknown) => {
          this.log('report.assistant_failed', { routine_id: run.routine_id, run_id: run.id, message: message(error) });
          notify();
        });
      }
    }
    this.changed();
    return { ok: true, routine_run_id: run.id, detail: 'Reported to the routine. Patterm stops this session once it has been idle for 10 minutes; the user can still reply to you before then.' };
  }

  private tick(): void {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.now();
    const due = this.db.prepare(`${ROUTINE_SELECT} where routines.enabled = 1 and routines.next_run_at is not null and routines.next_run_at <= ?`).all(new Date(now).toISOString()) as unknown as RoutineRow[];
    for (const row of due) {
      const scheduledFor = Date.parse(row.next_run_at!);
      void this.fire(row, scheduledFor, now - scheduledFor > CATCH_UP_GRACE_MS).catch((error: unknown) => this.log('fire.failed', { routine_id: row.id, message: message(error) }));
    }
    const soonest = this.db.prepare(`select min(next_run_at) as at from routines where enabled = 1 and next_run_at is not null`).get() as { at: string | null };
    const delay = soonest.at ? Math.min(MAX_TIMER_MS, Math.max(1_000, Date.parse(soonest.at) - this.now())) : MAX_TIMER_MS;
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  private async fire(row: RoutineRow, scheduledFor: number, catchUp: boolean): Promise<RoutineRunRecord> {
    if (this.firing.has(row.id)) throw new Error('This routine is already starting a run');
    this.firing.add(row.id);
    try {
      const schedule = { days: JSON.parse(row.days) as number[], time: row.time, timezone: row.timezone, run_at: row.run_at };
      // Advance first, so a failed launch is not retried every tick. A one-off
      // turns itself off once its time has come.
      if (row.enabled && row.next_run_at && Date.parse(row.next_run_at) <= this.now()) {
        this.db.prepare('update routines set next_run_at = ?, enabled = ? where id = ?')
          .run(iso(nextRoutineRun(schedule, Math.max(this.now(), scheduledFor))), row.run_at ? 0 : 1, row.id);
      }
      const runId = `routine_run_${randomUUID()}`;
      const at = new Date(this.now()).toISOString();
      // Each run keeps the project it started in, even if the routine moves later.
      const insert = (status: RoutineRunStatus, excerpt: string | null) => this.db.prepare(`insert into routine_runs
        (id, routine_id, project_id, scheduled_for, status, excerpt, created_at, started_at, finished_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(runId, row.id, row.project_id, new Date(scheduledFor).toISOString(), status, excerpt, at, status === 'running' ? at : null, status === 'running' ? null : at);
      const busy = this.db.prepare(`select 1 from routine_runs join processes on processes.id = routine_runs.process_id
        where routine_runs.routine_id = ? and routine_runs.finished_at is null and processes.status = 'running' limit 1`).get(row.id);
      if (busy) {
        insert('skipped', 'The previous run was still going.');
        this.changed();
        return this.getRun(runId);
      }
      insert('running', catchUp ? `Catch-up for ${formatLocal(scheduledFor, row.timezone)}, when Patterm was not running.` : null);
      this.changed();
      try {
        const launched = await this.deps.launch(this.launchInput(row, scheduledFor, runId));
        this.db.prepare('update routine_runs set process_id = ?, session_id = ? where id = ?').run(launched.process_id, launched.session_id, runId);
        this.deps.timeline.append({ event_type: 'routine.started', project_id: row.project_id, process_id: launched.process_id, session_id: launched.session_id, actor_type: 'system', metadata: { routine_id: row.id, run_id: runId } });
      } catch (error) {
        this.db.prepare(`update routine_runs set status = 'failed', excerpt = ?, finished_at = ? where id = ?`).run(excerptOf(`Could not start: ${message(error)}`), new Date(this.now()).toISOString(), runId);
        this.deps.notify({ projectId: row.project_id, source: 'runtime', kind: 'failure', title: `${row.name} could not start`, body: message(error), dedupeKey: null });
      }
      this.changed(true);
      return this.getRun(runId);
    } finally {
      this.firing.delete(row.id);
    }
  }

  private launchInput(row: RoutineRow, scheduledFor: number, runId: string): LaunchHarnessInput {
    const workspace = row.project_id === null;
    const previous = this.db.prepare(`select started_at, reported_at from routine_runs where routine_id = ? and started_at is not null and id != ?
      order by started_at desc limit 1`).get(row.id, runId) as { started_at: string; reported_at: string | null } | undefined;
    const lastSuccess = this.db.prepare(`select reported_at from routine_runs where routine_id = ? and status = 'reported' and report_status in ('completed', 'no_findings')
      order by reported_at desc limit 1`).get(row.id) as { reported_at: string } | undefined;
    const prompt = renderRoutinePrompt(row.prompt, {
      scheduledFor, timezone: row.timezone,
      lastRunAt: previous ? Date.parse(previous.started_at) : null,
      since: lastSuccess ? Date.parse(lastSuccess.reported_at) : null
    });
    const cwd = workspace ? this.workspaceDirectory() : undefined;
    return {
      harness: row.harness as typeof ROUTINE_HARNESSES[number],
      preset: row.preset,
      model: row.model,
      reasoning: row.reasoning,
      service_tier: row.service_tier,
      project_id: row.project_id ?? ASSISTANT_PROJECT_ID,
      ...(cwd ? { cwd } : {}),
      worktree_id: row.worktree_id,
      actor_id: null,
      session_role: workspace ? 'routine' : 'orchestrator',
      // Workspace runs have no project tab, so they open as Integrated conversations on the Routines page.
      ...(workspace ? { interface_mode: 'integrated' as const } : {}),
      name: row.name,
      initial_prompt: runInstructions(row, scheduledFor, prompt)
    };
  }

  // Workspace runs live in the assistant's internal project, created here if
  // the assistant has never started.
  private workspaceDirectory(): string {
    const cwd = path.join(this.deps.appDataPath, 'routines');
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const at = new Date(this.now()).toISOString();
    this.db.prepare(`insert into projects (id, name, path, kind, created_at, updated_at) values (?, 'Assistant', ?, 'assistant', ?, ?)
      on conflict(id) do nothing`).run(ASSISTANT_PROJECT_ID, path.join(this.deps.appDataPath, 'assistant'), at, at);
    return cwd;
  }

  // Ends runs whose agent has gone, and stops agents that reported and then
  // stayed idle for ROUTINE_IDLE_STOP_MS. A run counts as finished only once
  // its agent has stopped, so a failed stop is retried and still blocks overlap.
  sweep(): void {
    const rows = this.db.prepare(`${RUN_SELECT} where routine_runs.finished_at is null and routine_runs.status in ('running', 'reported')`).all() as unknown as RunRow[];
    const at = new Date(this.now()).toISOString();
    let changed = false;
    for (const row of rows) {
      if (!row.process_id) continue;
      if (row.process_status !== 'running') {
        if (row.status === 'running') {
          this.db.prepare(`update routine_runs set status = 'failed', excerpt = coalesce(excerpt, ?), finished_at = ? where id = ?`).run('The agent ended before it reported.', at, row.id);
          // Routines the assistant filters have no other sign that a run went missing.
          const routine = this.db.prepare('select name, delivery, project_id from routines where id = ?').get(row.routine_id) as { name: string; delivery: string; project_id: string | null } | undefined;
          if (routine?.delivery === 'assistant') this.deps.notify({ projectId: routine.project_id, source: 'runtime', kind: 'failure', title: `${routine.name} ended before it reported`, body: 'The run stopped without a report, so its work may be incomplete.', dedupeKey: `routine-report:${row.id}` });
        } else {
          this.db.prepare('update routine_runs set finished_at = ? where id = ?').run(at, row.id);
        }
        changed = true;
        continue;
      }
      if (row.status !== 'reported' || row.activity !== 'idle' || this.stopping.has(row.id)) continue;
      // Activity changes stamp processes.updated_at, so idle time restarts whenever
      // the agent works again, such as on a follow-up from the user. Unrelated
      // updates only lengthen the wait.
      const idleSince = Math.max(Date.parse(row.reported_at!), Date.parse(row.process_updated_at ?? row.reported_at!));
      if (this.now() - idleSince < ROUTINE_IDLE_STOP_MS) continue;
      const runId = row.id;
      this.stopping.add(runId);
      void this.deps.stopProcess(row.process_id).then(() => {
        this.db.prepare('update routine_runs set finished_at = ? where id = ? and finished_at is null').run(new Date(this.now()).toISOString(), runId);
        this.changed(true);
      }, (error: unknown) => this.log('stop.failed', { run_id: runId, message: message(error) })).finally(() => this.stopping.delete(runId));
    }
    if (changed) this.changed(true);
  }

  private row(routineId: string): RoutineRow {
    const row = this.db.prepare(`${ROUTINE_SELECT} where routines.id = ?`).get(routineId) as unknown as RoutineRow | undefined;
    if (!row) throw new Error(`unknown routine: ${routineId}`);
    return row;
  }

  private toRecord(row: RoutineRow): RoutineRecord {
    const last = this.db.prepare(`${RUN_SELECT} where routine_runs.routine_id = ? order by routine_runs.scheduled_for desc limit 1`).get(row.id) as unknown as RunRow | undefined;
    const waiting = this.db.prepare(`${RUN_SELECT} where routine_runs.routine_id = ? and routine_runs.status = 'running' and processes.status = 'running' and processes.activity in ('permission', 'question')
      order by routine_runs.scheduled_for desc limit 1`).get(row.id) as unknown as RunRow | undefined;
    return {
      routine_id: row.id,
      name: row.name,
      enabled: Boolean(row.enabled),
      project_id: row.project_id,
      project_name: row.project_name,
      days: JSON.parse(row.days) as number[],
      time: row.time,
      timezone: row.timezone,
      prompt: row.prompt,
      harness: row.harness,
      preset: row.preset,
      model: row.model,
      reasoning: row.reasoning,
      service_tier: row.service_tier,
      delivery: row.delivery as RoutineDelivery,
      run_at: row.run_at,
      worktree_id: row.worktree_id,
      created_by: { type: row.created_by_type as 'user' | 'agent', id: row.created_by_id, name: row.created_by_name },
      next_run_at: row.next_run_at,
      last_run: last ? toRunRecord(last) : null,
      waiting_run: waiting ? toRunRecord(waiting) : null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  // A preset and a direct model are alternatives, as spawn_agent accepts.
  private validateLaunch(input: { harness: string; preset: string | null; model: string | null; reasoning: string | null; service_tier: string | null }) {
    if (input.preset && input.model) throw new Error('Choose a preset or a model, not both');
    if (input.preset && !findPresetByRef(this.deps.presets(), input.preset, input.harness as typeof ROUTINE_HARNESSES[number])) {
      throw new Error(`unknown ${input.harness} preset: ${input.preset}`);
    }
    if (!input.model && (input.reasoning || input.service_tier)) throw new Error('Effort and speed need a model');
    if (input.service_tier && input.harness !== 'codex') throw new Error('Only Codex routines choose a speed');
    return { preset: input.preset, model: input.model, reasoning: input.model ? input.reasoning : null, service_tier: input.model ? input.service_tier : null };
  }

  // A routine's worktree belongs to its project; workspace routines have none.
  private validateWorktree(worktreeId: string | null, projectId: string | null): void {
    if (worktreeId === null) return;
    const row = this.db.prepare('select project_id from worktrees where id = ?').get(worktreeId) as { project_id: string } | undefined;
    if (!row || row.project_id !== projectId) throw new Error(`unknown worktree in this project: ${worktreeId}`);
  }

  // A pending one-off must be in the future, within a year, and within the
  // project's limit. A paused one (projectId undefined) skips the limit.
  private validateOnce(runAt: string, projectId: string | null | undefined, routineId: string | null): void {
    const at = Date.parse(runAt);
    if (at <= this.now()) throw new Error('run_at must be in the future');
    if (at - this.now() > MAX_ONCE_AHEAD_MS) throw new Error('run_at must be within a year');
    if (projectId === undefined) return;
    const pending = this.db.prepare(`select count(*) as count from routines where run_at is not null and enabled = 1 and next_run_at is not null
      and project_id is ? and id is not ?`).get(projectId, routineId) as { count: number };
    if (pending.count >= MAX_PENDING_ONCE) throw new Error(`This project already has ${MAX_PENDING_ONCE} one-off runs waiting; wait for some to run or delete them`);
  }

  private validateProject(projectId: string | null): void {
    if (projectId === null) return;
    const row = this.db.prepare('select kind from projects where id = ?').get(projectId) as { kind: string } | undefined;
    if (!isUserProjectKind(row?.kind)) throw new Error(`unknown project: ${projectId}`);
  }

  private changed(workbench = false): void {
    this.deps.onChanged(workbench);
  }

  private log(event: string, data: Record<string, unknown>): void {
    this.deps.log?.(event, data);
  }
}

const ROUTINE_SELECT = `select routines.*, projects.name as project_name,
    case when routines.created_by_type = 'agent' then coalesce(routines.created_by_remote_name, (select coalesce(sessions.title, sessions.harness) from sessions where sessions.id = routines.created_by_id)) end as created_by_name,
    case when routines.created_by_type = 'agent' then coalesce(routines.created_by_remote_process_id, (select sessions.process_id from sessions where sessions.id = routines.created_by_id)) end as created_by_process_id
  from routines left join projects on projects.id = routines.project_id`;

const RUN_SELECT = `select routine_runs.*, processes.status as process_status, processes.activity, processes.updated_at as process_updated_at
  from routine_runs left join processes on processes.id = routine_runs.process_id`;

const REPORT_LABELS: Record<RoutineReportStatus, string> = { completed: 'done', blocked: 'blocked', failed: 'failed', no_findings: 'nothing to report' };

function launchFields(input: z.infer<typeof routineUpdateInput>, current: RoutineRow) {
  const harnessChanged = input.harness !== undefined && input.harness !== current.harness;
  const pick = <K extends 'preset' | 'model' | 'reasoning' | 'service_tier'>(key: K) => input[key] !== undefined ? input[key]! : harnessChanged ? null : current[key];
  return { preset: pick('preset'), model: pick('model'), reasoning: pick('reasoning'), service_tier: pick('service_tier') };
}

function onceTime(runAt: string, timezone: string): string {
  return formatLocal(Date.parse(runAt), timezone).slice(11);
}

function runInstructions(row: RoutineRow, scheduledFor: number, prompt: string): string {
  const lines = [
    `[Patterm ${row.run_at ? 'scheduled run' : 'routine'} "${row.name}", run for ${formatLocal(scheduledFor, row.timezone)} ${row.timezone}]`,
    `A ${row.run_at ? 'one-off' : 'scheduled'} Patterm ${row.run_at ? 'run' : 'routine'} started you. Do the task below without waiting for the user. When you finish, call report_to_parent once with a short summary of what you did and where any output is, such as file paths or URLs; use status blocked or failed if you could not finish. Patterm stops this session after it reports and goes idle.`
  ];
  // Another agent handed this work over; its conversation is there if the prompt leaves something out.
  if (row.created_by_type === 'agent' && row.created_by_process_id) {
    lines.push(`${row.created_by_name ?? 'Another agent'} scheduled this. If the task below leaves out context you need, read that agent's conversation with get_conversation_output (process_id ${row.created_by_process_id}).`);
  }
  if (row.project_id === null) lines.push('You have no project of your own: get_project_status without project_id lists every project, and project tools need project_id.');
  return `${lines.join('\n')}\n\n${prompt.trim() || 'No task was given. Report that the routine has no prompt.'}`;
}

function toRunRecord(row: RunRow): RoutineRunRecord {
  return {
    run_id: row.id,
    routine_id: row.routine_id,
    scheduled_for: row.scheduled_for,
    started_at: row.started_at,
    reported_at: row.reported_at,
    finished_at: row.finished_at,
    status: row.status,
    report_status: row.report_status,
    needs_you: row.status === 'running' && row.process_status === 'running' && awaitingUser(row.activity),
    excerpt: row.excerpt,
    report: row.report,
    live: row.process_status === 'running',
    session_id: row.session_id,
    process_id: row.process_id,
    project_id: row.project_id
  };
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
