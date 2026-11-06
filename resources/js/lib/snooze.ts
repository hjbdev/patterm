import type { StripTab } from './tabStrip';
import type { SessionRecord } from '../types';

// An agent snoozed until its next message. One that has exited has no next
// message, so it shows as it is.
export function isSnoozed(session: SessionRecord): boolean {
  return Boolean(session.snooze?.snoozedAt && !session.exitedAt);
}

export function tabSnoozed(tab: StripTab): boolean {
  return tab.kind === 'agent' && isSnoozed(tab.family.root.session);
}

// Snoozed tabs move to the end of the strip, keeping their order.
export function snoozedLast<T extends StripTab>(tabs: readonly T[]): T[] {
  return [...tabs.filter((tab) => !tabSnoozed(tab)), ...tabs.filter(tabSnoozed)];
}
