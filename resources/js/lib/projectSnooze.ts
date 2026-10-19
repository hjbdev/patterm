import type { ProjectSummary } from '../types';

export function projectSnoozed(project: Pick<ProjectSummary, 'snoozedUntil'> | null | undefined): boolean {
  return Boolean(project?.snoozedUntil);
}

// The next start of the workday after `now`: today if it hasn't come yet,
// otherwise tomorrow. `start` is HH:MM local time.
export function nextWorkdayStart(now: Date, start: string): Date {
  const [hours, minutes] = start.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

// "09:00 tomorrow", "17:30 today", or a weekday and time further out.
export function describeWake(until: Date, now: Date): string {
  const time = until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(until) - day(now)) / 86_400_000);
  if (days === 0) return `${time} today`;
  if (days === 1) return `${time} tomorrow`;
  return `${until.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

// Snoozed projects last, keeping their order otherwise.
export function snoozedProjectsLast<T>(items: readonly T[], projectOf: (item: T) => Pick<ProjectSummary, 'snoozedUntil'>): T[] {
  return [...items.filter((item) => !projectSnoozed(projectOf(item))), ...items.filter((item) => projectSnoozed(projectOf(item)))];
}
