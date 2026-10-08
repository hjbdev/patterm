// Routine schedules are local wall-clock times in an IANA time zone, so 16:30
// stays 16:30 across daylight-saving changes. Days use JavaScript numbering:
// 0 is Sunday. A one-off schedule sets run_at, an ISO instant, and ignores days.
export interface RoutineScheduleSpec {
  days: readonly number[];
  time: string;
  timezone: string;
  run_at?: string | null;
}

export const ROUTINE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// The first run strictly after `after`, or null when no day is selected or a
// one-off time has passed.
export function nextRoutineRun(schedule: RoutineScheduleSpec, after: number): number | null {
  if (schedule.run_at) {
    const at = Date.parse(schedule.run_at);
    return at > after ? at : null;
  }
  if (!schedule.days.length || !ROUTINE_TIME_PATTERN.test(schedule.time)) return null;
  const [hours, minutes] = schedule.time.split(':').map(Number) as [number, number];
  const today = zonedParts(after, schedule.timezone);
  for (let offset = 0; offset <= 7; offset += 1) {
    // Date.UTC normalises day overflow, so this walks calendar days in the zone.
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (!schedule.days.includes(day.getUTCDay())) continue;
    const at = zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hours, minutes, schedule.timezone);
    if (at > after) return at;
  }
  return null;
}

// The instant of a local YYYY-MM-DD date and HH:MM time in `timezone`.
export function zonedInstant(date: string, time: string, timezone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match || !ROUTINE_TIME_PATTERN.test(time)) return null;
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return zonedTimeToUtc(Number(match[1]), Number(match[2]), Number(match[3]), hours, minutes, timezone);
}

export interface RoutinePromptValues {
  scheduledFor: number;
  timezone: string;
  lastRunAt: number | null;
  since: number | null;
}

// Fills {{date}}, {{weekday}}, {{since}}, and {{last_run_at}}. A first run has
// no previous run, so both of those fall back to the start of that day.
export function renderRoutinePrompt(template: string, values: RoutinePromptValues): string {
  const parts = zonedParts(values.scheduledFor, values.timezone);
  const date = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const startOfDay = `${date} 00:00`;
  const replacements: Record<string, string> = {
    date,
    weekday: WEEKDAYS[parts.weekday]!,
    since: values.since === null ? startOfDay : formatLocal(values.since, values.timezone),
    last_run_at: values.lastRunAt === null ? startOfDay : formatLocal(values.lastRunAt, values.timezone)
  };
  return template.replace(/\{\{\s*(date|weekday|since|last_run_at)\s*\}\}/g, (_match, key: string) => replacements[key]!);
}

export function formatLocal(at: number, timezone: string): string {
  const parts = zonedParts(at, timezone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

function zonedParts(at: number, timezone: string): ZonedParts {
  const values: Record<string, string> = {};
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short'
  });
  for (const part of format.formatToParts(at)) values[part.type] = part.value;
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday ?? '')
  };
}

// Converts a wall-clock time in `timezone` to an instant. A repeated time (when
// clocks go back) resolves to its first occurrence. A time skipped when clocks go
// forward resolves later by the size of the gap, in every zone: 02:30 in a
// one-hour gap starting at 02:00 becomes 03:30.
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Offsets a day either side of the approximate instant bracket any transition
  // near it, in zones up to UTC±14; transitions are never that close together.
  const approximate = wall - offsetAt(wall, timezone);
  const before = wall - offsetAt(approximate - 24 * 3_600_000, timezone);
  const after = wall - offsetAt(approximate + 24 * 3_600_000, timezone);
  const matches = [before, after].filter((at) => {
    const parts = zonedParts(at, timezone);
    return parts.hour === hour && parts.minute === minute;
  });
  // In a gap neither offset reproduces the time; the earlier offset lands after the gap.
  return matches.length ? Math.min(...matches) : before;
}

function offsetAt(at: number, timezone: string): number {
  const parts = zonedParts(at, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return asUtc - Math.floor(at / 60_000) * 60_000;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
