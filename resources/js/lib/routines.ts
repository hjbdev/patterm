import { formatLocal, nextRoutineRun } from '../../../app/Services/RoutineSchedule';
import { useWorkbench } from '../Composables/useWorkbench';
import { topicChanged, topicRead } from './serverQuery';

export type RoutineRunStatus = 'running' | 'reported' | 'failed' | 'skipped';
export type RoutineReportStatus = 'completed' | 'blocked' | 'failed' | 'no_findings';
export type RoutineDelivery = 'notification' | 'none';

export interface RoutineRunRecord {
  run_id: string;
  routine_id: string;
  scheduled_for: string;
  started_at: string | null;
  reported_at: string | null;
  finished_at: string | null;
  status: RoutineRunStatus;
  report_status: RoutineReportStatus | null;
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

export interface RoutineRecord {
  routine_id: string;
  name: string;
  enabled: boolean;
  // Null for a workspace routine, which reads across every project.
  project_id: string | null;
  project_name: string | null;
  days: number[];
  time: string;
  timezone: string;
  prompt: string;
  harness: string;
  // A preset, or a model with its own reasoning and speed, as spawn_agent accepts.
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
  // The newest run still waiting on a permission prompt.
  waiting_run: RoutineRunRecord | null;
  created_at: string;
  updated_at: string;
}

export type RoutinePatch = Partial<Pick<RoutineRecord, 'name' | 'enabled' | 'project_id' | 'days' | 'time' | 'timezone' | 'prompt' | 'harness' | 'preset' | 'model' | 'reasoning' | 'service_tier' | 'delivery' | 'run_at' | 'worktree_id'>>;

export interface RoutineModelOption {
  id: string;
  label: string;
  reasoning: string[];
  serviceTiers?: Array<{ id: string; label: string }>;
}

export interface RoutinePresetOption {
  harness: string;
  name: string;
}

export interface RoutineChoiceOption {
  value: string | null;
  label: string;
  group?: string;
}

export const ROUTINE_HARNESSES = ['claude', 'codex', 'opencode'] as const;

// Routine reads are cached until routines change or a run's agent starts or
// stops. Writes here mark routines changed, so the next read is fresh.
function routineRead<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return topicRead('routines', [name, args, useWorkbench().lifecycleRevision.value], () => window.patterm.call(name, args) as Promise<T>);
}

function routineWrite<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return (window.patterm.call(name, args) as Promise<T>).then((result) => {
    topicChanged('routines');
    return result;
  });
}

export function listRoutines(): Promise<RoutineRecord[]> {
  return routineRead<{ routines: RoutineRecord[] }>('routine_list', {}).then((result) => result.routines);
}

export function createRoutine(input: RoutinePatch & { name: string }): Promise<RoutineRecord> {
  return routineWrite<RoutineRecord>('routine_create', input);
}

export function updateRoutine(routineId: string, patch: RoutinePatch): Promise<RoutineRecord> {
  return routineWrite<RoutineRecord>('routine_update', { routine_id: routineId, ...patch });
}

export function deleteRoutine(routineId: string): Promise<unknown> {
  return routineWrite('routine_delete', { routine_id: routineId });
}

export function runRoutineNow(routineId: string): Promise<RoutineRunRecord> {
  return routineWrite<RoutineRunRecord>('routine_run_now', { routine_id: routineId });
}

export function routineRun(runId: string): Promise<RoutineRunRecord> {
  return window.patterm.call('routine_run', { run_id: runId }) as Promise<RoutineRunRecord>;
}

export function routineLog(input: { limit?: number; offset?: number; routine_id?: string } = {}): Promise<RoutineRunRecord[]> {
  return routineRead<{ runs: RoutineRunRecord[] }>('routine_log', input).then((result) => result.runs);
}

// A run sits at the time it reported, or when it started if it has not.
export function runTime(run: RoutineRunRecord): number {
  return Date.parse(run.reported_at ?? run.finished_at ?? run.started_at ?? run.scheduled_for);
}

export function routineRuns(routineId: string, limit = 20): Promise<RoutineRunRecord[]> {
  return routineRead<{ runs: RoutineRunRecord[] }>('routine_runs', { routine_id: routineId, limit }).then((result) => result.runs);
}

export const WEEKDAYS = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
  { day: 0, label: 'Sun' }
] as const;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function describeDays(days: readonly number[]): string {
  const set = new Set(days);
  if (!set.size) return 'No days';
  if (set.size === 7) return 'Every day';
  if (set.size === 5 && [1, 2, 3, 4, 5].every((day) => set.has(day))) return 'Weekdays';
  if (set.size === 2 && set.has(0) && set.has(6)) return 'Weekends';
  if (set.size === 1) return `${DAY_NAMES[[...set][0]!]}s`;
  return WEEKDAYS.filter((entry) => set.has(entry.day)).map((entry) => entry.label).join(', ');
}

export function describeSchedule(routine: Pick<RoutineRecord, 'days' | 'time' | 'timezone' | 'run_at'>): string {
  if (routine.run_at) return `Once on ${onceDate(routine)} at ${routine.time}`;
  return `${describeDays(routine.days)} at ${routine.time}`;
}

// A one-off's YYYY-MM-DD date in the routine's own time zone.
export function onceDate(routine: Pick<RoutineRecord, 'timezone' | 'run_at'>): string {
  return routine.run_at ? formatLocal(Date.parse(routine.run_at), routine.timezone).slice(0, 10) : '';
}

// A one-off whose time has passed. A paused one still ahead is not done.
export function onceDone(routine: RoutineRecord, now: number): boolean {
  return Boolean(routine.run_at) && !routine.next_run_at && Date.parse(routine.run_at!) <= now;
}

// Upcoming runs in the routine's own time zone.
export function nextRuns(routine: Pick<RoutineRecord, 'days' | 'time' | 'timezone' | 'run_at'>, from: number, count: number): number[] {
  const runs: number[] = [];
  let cursor = from;
  while (runs.length < count) {
    const next = nextRoutineRun(routine, cursor);
    if (next === null) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}

export function formatRunDay(at: number, now: number): string {
  const day = new Date(at);
  const diff = Math.round((startOfDay(day) - startOfDay(new Date(now))) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return DAY_NAMES[day.getDay()]!;
  return day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function formatRunTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export function formatRunWhen(at: number, now: number): string {
  return `${formatRunDay(at, now)} ${formatRunTime(at)}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function nextRunLabel(routine: RoutineRecord, now: number): string {
  if (onceDone(routine, now) && routine.last_run) return `Ran ${formatRunWhen(runTime(routine.last_run), now)}`;
  if (!routine.enabled) return 'Paused';
  if (routine.run_at) return routine.next_run_at ? `Runs ${formatRunWhen(Date.parse(routine.next_run_at), now)}` : 'Pick a time in the future';
  if (!routine.days.length) return 'Pick at least one day';
  return routine.next_run_at ? `Next run ${formatRunWhen(Date.parse(routine.next_run_at), now)}` : 'Not scheduled';
}

export function runStatusLabel(run: RoutineRunRecord): string {
  if (run.needs_you) return 'Needs you';
  if (run.status === 'running') return 'Running';
  if (run.status === 'skipped') return 'Skipped';
  if (run.status === 'failed') return 'Failed';
  return { completed: 'Done', blocked: 'Blocked', failed: 'Failed', no_findings: 'Nothing to report' }[run.report_status ?? 'completed'];
}

// Runs that want the user: waiting on a prompt, blocked, or failed.
export function runNeedsAttention(run: RoutineRunRecord): boolean {
  return run.needs_you || run.status === 'failed' || run.report_status === 'blocked' || run.report_status === 'failed';
}

export function launchChoiceKey(routine: RoutineRecord): string {
  return routine.model ? `model:${routine.model}` : `preset:${routine.preset ?? ''}`;
}

export function launchChoiceOptions(harness: string, presets: readonly RoutinePresetOption[], models: Record<string, RoutineModelOption[]>): RoutineChoiceOption[] {
  return [
    { value: 'preset:', label: 'default preset', group: 'Presets' },
    ...presets.filter((preset) => preset.harness === harness).map((preset) => ({ value: `preset:${preset.name}`, label: preset.name, group: 'Presets' })),
    ...(models[harness] ?? []).map((model) => ({ value: `model:${model.id}`, label: model.label, group: 'Models' }))
  ];
}

// Picking a preset clears the model settings; picking a model keeps a
// reasoning level and speed it still supports.
export function launchChoicePatch(routine: RoutineRecord, key: string, models: Record<string, RoutineModelOption[]>): RoutinePatch {
  if (key.startsWith('preset:')) return { preset: key.slice(7) || null, model: null, reasoning: null, service_tier: null };
  const id = key.slice(6);
  const model = modelFor(routine.harness, id, models);
  return {
    preset: null,
    model: id,
    reasoning: routine.reasoning && model?.reasoning.includes(routine.reasoning) ? routine.reasoning : null,
    service_tier: routine.service_tier && model?.serviceTiers?.some((tier) => tier.id === routine.service_tier) ? routine.service_tier : null
  };
}

// A new harness starts from its default preset, since presets and models belong to one harness.
export function harnessPatch(harness: string): RoutinePatch {
  return { harness, preset: null, model: null, reasoning: null, service_tier: null };
}

export function modelFor(harness: string, id: string | null, models: Record<string, RoutineModelOption[]>): RoutineModelOption | null {
  return id ? (models[harness] ?? []).find((model) => model.id === id) ?? null : null;
}

export function reasoningOptions(model: RoutineModelOption | null): RoutineChoiceOption[] {
  return [{ value: null, label: 'default' }, ...(model?.reasoning ?? []).map((level) => ({ value: level, label: level }))];
}

export function speedOptions(model: RoutineModelOption | null): RoutineChoiceOption[] {
  if (!model?.serviceTiers?.length) return [];
  return [{ value: null, label: 'default speed' }, { value: 'default', label: 'Standard' }, ...model.serviceTiers.map((tier) => ({ value: tier.id, label: tier.label }))];
}

export function describeLaunch(routine: RoutineRecord, models: Record<string, RoutineModelOption[]>): string {
  if (!routine.model) return routine.preset ?? 'default preset';
  const model = modelFor(routine.harness, routine.model, models);
  const tier = model?.serviceTiers?.find((entry) => entry.id === routine.service_tier)?.label ?? (routine.service_tier === 'default' ? 'Standard' : null);
  return `${[model?.label ?? routine.model, routine.reasoning].filter(Boolean).join(' ')}${tier ? `, ${tier}` : ''}`;
}

export const DELIVERY_OPTIONS: RoutineChoiceOption[] = [
  { value: 'notification', label: 'notify me' },
  { value: 'none', label: 'do nothing' }
];

export function projectOptions(projects: ReadonlyArray<{ id: string; name: string }>): RoutineChoiceOption[] {
  return [{ value: null, label: 'all projects' }, ...projects.map((project) => ({ value: project.id, label: project.name }))];
}
