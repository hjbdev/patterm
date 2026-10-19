import { moveStripTab, setStripTabPinned, type StripTab, type TabLayout } from './tabStrip';
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

// Moves an awake tab to `index` among the awake tabs, which lead the strip.
// Snoozed tabs, pinned or not, keep their places after them; they don't move.
export function moveAwakeTab(tabs: readonly StripTab[], key: string, index: number): TabLayout | null {
  const awake = tabs.filter((tab) => !tabSnoozed(tab));
  if (!awake.some((tab) => tab.key === key)) return null;
  return withSnoozedLast(moveStripTab(awake, key, index), tabs.filter(tabSnoozed));
}

// Pins or unpins a tab as the strip does, counting only awake tabs, since
// snoozed ones sit at the end whether pinned or not.
export function setTabPinned(tabs: readonly StripTab[], key: string, pinned: boolean): TabLayout {
  const asleep = tabs.filter(tabSnoozed).map((tab) => tab.key === key ? { ...tab, pinned } : tab);
  return withSnoozedLast(setStripTabPinned(tabs.filter((tab) => !tabSnoozed(tab)), key, pinned), asleep);
}

function withSnoozedLast(layout: TabLayout, asleep: readonly StripTab[]): TabLayout {
  return {
    order: [...layout.order, ...asleep.map((tab) => tab.key)],
    pinned: [...layout.pinned, ...asleep.filter((tab) => tab.pinned).map((tab) => tab.key)]
  };
}
