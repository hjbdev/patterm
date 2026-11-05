// Native goals: an objective the agent keeps working toward across turns
// until a check says it is met. Codex, OpenCode, and Claude Code each run
// their own loop; providers project their state into this shape as the
// snapshot's `goal`, and the renderer reads it through the same module.

export type IntegratedGoalStatus = 'active' | 'paused' | 'blocked' | 'limited' | 'complete' | 'failed';
export type IntegratedGoalAction = 'set' | 'pause' | 'resume' | 'clear';

export interface IntegratedGoal {
  objective: string;
  status: IntegratedGoalStatus;
  // Continuation rounds so far, and the harness's limit where it has one.
  rounds?: number;
  maxRounds?: number;
  // The latest check's verdict or why the goal stopped.
  reason?: string;
  tokensUsed?: number;
  tokenBudget?: number;
  timeUsedSeconds?: number;
  updatedAt?: string;
}

// What a harness lets the user do with a goal besides set and clear it.
export interface IntegratedGoalSupport {
  canPause: boolean;
  canResume: boolean;
  canEdit: boolean;
  canBudget: boolean;
}

// A transcript row recording a goal change, such as a check that found the
// goal not yet met.
export interface IntegratedGoalMarker {
  id: string;
  at: string;
  text: string;
  level: 'info' | 'warning' | 'error';
}

const STATUSES = new Set<IntegratedGoalStatus>(['active', 'paused', 'blocked', 'limited', 'complete', 'failed']);
const MARKER_LIMIT = 30;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function normaliseGoal(value: unknown): IntegratedGoal | null {
  const row = record(value);
  if (typeof row.objective !== 'string' || !row.objective.trim()) return null;
  const status = STATUSES.has(row.status as IntegratedGoalStatus) ? row.status as IntegratedGoalStatus : 'active';
  const goal: IntegratedGoal = { objective: row.objective, status };
  for (const key of ['rounds', 'maxRounds', 'tokensUsed', 'tokenBudget', 'timeUsedSeconds'] as const) {
    const number = count(row[key]);
    if (number !== undefined) goal[key] = number;
  }
  if (typeof row.reason === 'string' && row.reason.trim()) goal.reason = row.reason.trim();
  if (typeof row.updatedAt === 'string') goal.updatedAt = row.updatedAt;
  return goal;
}

export function normaliseGoalSupport(value: unknown): IntegratedGoalSupport | null {
  const row = record(value);
  if (!Object.keys(row).length) return null;
  return { canPause: row.canPause === true, canResume: row.canResume === true, canEdit: row.canEdit === true, canBudget: row.canBudget === true };
}

// A goal stays visible while there is something to do with it. A met goal
// shows its success briefly, then the transcript marker keeps the record.
export function goalIsOpen(goal: IntegratedGoal | null): boolean {
  return Boolean(goal && goal.status !== 'complete');
}

export function goalStatusLabel(status: IntegratedGoalStatus): string {
  return { active: 'Working toward goal', paused: 'Goal paused', blocked: 'Goal blocked', limited: 'Goal stopped at a limit', complete: 'Goal met', failed: 'Goal failed' }[status];
}

// The row a change from `previous` to `next` adds to the transcript, or null
// when nothing a reader would notice changed.
export function goalTransition(previous: IntegratedGoal | null, next: IntegratedGoal | null): Omit<IntegratedGoalMarker, 'id' | 'at'> | null {
  const because = next?.reason ? `: ${next.reason}` : '';
  if (!next) return previous ? { text: 'Goal cleared', level: 'info' } : null;
  if (!previous || previous.objective !== next.objective) return { text: `Goal set: ${next.objective}`, level: 'info' };
  if (previous.status === next.status) {
    // A new verdict while the goal stays active is a check that found it unmet.
    return next.status === 'active' && next.reason && next.reason !== previous.reason ? { text: `Not yet${because}`, level: 'info' } : null;
  }
  if (next.status === 'complete') return { text: `Goal met${because}`, level: 'info' };
  if (next.status === 'failed') return { text: `Goal failed${because}`, level: 'error' };
  if (next.status === 'paused') return { text: `Goal paused${because}`, level: 'info' };
  if (next.status === 'blocked') return { text: `Goal blocked${because}`, level: 'info' };
  if (next.status === 'limited') return { text: `Goal stopped at a limit${because}`, level: 'info' };
  return { text: 'Goal resumed', level: 'info' };
}

// The goal state a provider last observed for each native session, and the
// markers its changes produced. Markers are Patterm's: they live as long as
// the provider's connection, and the goal itself stays native.
export class GoalLog {
  private readonly goals = new Map<string, IntegratedGoal | null>();
  private readonly markers = new Map<string, IntegratedGoalMarker[]>();
  private sequence = 0;
  // Each observation's sequence, so a slow read can tell a newer one came in.
  private readonly revisions = new Map<string, number>();

  known(key: string): boolean {
    return this.goals.has(key);
  }

  goal(key: string): IntegratedGoal | null {
    return this.goals.get(key) ?? null;
  }

  revision(key: string): number {
    return this.revisions.get(key) ?? 0;
  }

  // `quiet` records state read on demand, such as after a reconnect, which
  // is not a change anyone saw happen.
  observe(key: string, goal: IntegratedGoal | null, at = new Date().toISOString(), quiet = false): boolean {
    const known = this.goals.has(key);
    const previous = this.goals.get(key) ?? null;
    this.goals.set(key, goal);
    this.revisions.set(key, ++this.sequence);
    if (this.goals.size > 500) {
      const oldest = this.goals.keys().next().value!;
      this.goals.delete(oldest);
      this.revisions.delete(oldest);
    }
    const change = quiet || !known && !goal ? null : goalTransition(previous, goal);
    if (!change) return known && JSON.stringify(previous) !== JSON.stringify(goal);
    const list = [...(this.markers.get(key) ?? []), { id: `patterm_goal_${++this.sequence}`, at, ...change }].slice(-MARKER_LIMIT);
    this.markers.set(key, list);
    if (this.markers.size > 500) this.markers.delete(this.markers.keys().next().value!);
    return true;
  }

  list(key: string): IntegratedGoalMarker[] {
    return this.markers.get(key) ?? [];
  }

  forget(key: string): void {
    this.goals.delete(key);
    this.markers.delete(key);
    this.revisions.delete(key);
  }
}

function rowTime(row: Record<string, unknown>): number {
  const native = record(row.time);
  for (const value of [row.createdAt, row.created_at, native.created]) {
    const time = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : Number.NaN;
    if (Number.isFinite(time)) return time;
  }
  return Number.NaN;
}

// Places goal markers among a snapshot's chronological rows by time. Rows
// without a time keep their place; a marker newer than every row goes last.
export function withGoalMarkers<T>(rows: T[], markers: IntegratedGoalMarker[]): Array<T | Record<string, unknown>> {
  if (!markers.length) return rows;
  const result: Array<T | Record<string, unknown>> = [];
  const pending = [...markers].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  for (const row of rows) {
    const time = rowTime(record(row));
    while (pending.length && Number.isFinite(time) && Date.parse(pending[0]!.at) < time) result.push(markerRow(pending.shift()!));
    result.push(row);
  }
  return [...result, ...pending.map(markerRow)];
}

function markerRow(marker: IntegratedGoalMarker): Record<string, unknown> {
  return { id: marker.id, role: 'assistant', kind: 'notice', level: marker.level, title: 'goal', text: marker.text, createdAt: marker.at, completedAt: marker.at };
}

// Applies goal markers to a provider snapshot whose messages are an array or
// a `{ data }` page.
export function snapshotWithGoal(snapshot: Record<string, unknown>, goal: IntegratedGoal | null, markers: IntegratedGoalMarker[]): Record<string, unknown> {
  const messages = snapshot.messages;
  const page = record(messages);
  const placed = Array.isArray(messages) ? withGoalMarkers(messages, markers)
    : Array.isArray(page.data) ? { ...page, data: withGoalMarkers(page.data, markers) } : messages;
  return { ...snapshot, goal, messages: placed };
}

// Parses what follows `/goal`. Every harness takes the same words, so
// pause, resume, and clear never become an objective.
export function goalCommand(text: string): { action: IntegratedGoalAction; objective?: string } {
  const value = text.trim();
  const word = value.toLowerCase();
  if (word === 'clear' || word === 'pause' || word === 'resume') return { action: word };
  return { action: 'set', objective: value };
}
