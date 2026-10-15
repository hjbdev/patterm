import type { TimerKind, TimerRecord } from '../types';

const KIND_LABELS: Record<TimerKind, string> = {
  delay: 'Timer',
  idle_any: 'When any is idle',
  idle_all: 'When all are idle',
  report_any: 'When any reports',
  report_all: 'When all report',
  output: 'Watching output'
};

export function timersForProcesses(timers: readonly TimerRecord[], processIds: ReadonlySet<string>): TimerRecord[] {
  return timers
    .filter((timer) => timer.ownerProcessId !== null && processIds.has(timer.ownerProcessId))
    .sort((a, b) => (a.firesAtUnixMs ?? Infinity) - (b.firesAtUnixMs ?? Infinity) || a.createdAtUnixMs - b.createdAtUnixMs);
}

export function timerLabel(timer: TimerRecord): string {
  return timer.label ?? KIND_LABELS[timer.kind];
}

// Watch timers only carry a deadline as their rescue timeout, so it reads as an upper bound.
export function timerRemaining(timer: TimerRecord, now: number): string {
  if (timer.status === 'paused') return 'Paused';
  if (timer.firesAtUnixMs === null) return '';
  const remaining = formatDuration(timer.firesAtUnixMs - now);
  return timer.kind === 'delay' ? remaining : `≤ ${remaining}`;
}

// To the minute, for text that shouldn't change every second.
export function timerRemainingToMinute(timer: TimerRecord, now: number): string {
  return timerRemaining(timer, now).replace(/(\d+[hm]) \d+s$/, '$1');
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// Durations in words, such as 1 hour 30 minutes.
export function describeDuration(seconds: number): string {
  const total = Math.max(1, Math.ceil(seconds));
  const parts = [[Math.floor(total / 3600), 'hour'], [Math.floor((total % 3600) / 60), 'minute'], [total % 60, 'second']] as const;
  return parts.filter(([amount]) => amount > 0).map(([amount, unit]) => `${amount} ${unit}${amount === 1 ? '' : 's'}`).join(' ');
}

// Durations such as 30s, 5m, 1.5h, or 250ms. A bare number is seconds.
export function parseDurationSeconds(value: string): number | null {
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }
  const unit = match[2] ?? 's';
  if (unit === 'ms') {
    return amount / 1000;
  }
  if (unit === 'm') {
    return amount * 60;
  }
  if (unit === 'h') {
    return amount * 60 * 60;
  }
  return amount;
}
