import type { AgentTabFamily } from './agentTabs';
import type { LiveProcessRecord } from './processTabs';

// Tabs are keyed `agent:<root session id>` or `process:<process id>`, matching
// the `data-patterm-tab-id` attribute on their buttons.
export type TabKey = string;

// Per-project tab arrangement, left to right. Pinned tabs always lead the strip.
export interface TabLayout {
  order: TabKey[];
  pinned: TabKey[];
}

export type StripTab =
  | { key: TabKey; kind: 'agent'; pinned: boolean; family: AgentTabFamily }
  | { key: TabKey; kind: 'process'; pinned: boolean; process: LiveProcessRecord };

export const EMPTY_TAB_LAYOUT: TabLayout = { order: [], pinned: [] };

const TAB_LAYOUT_STORAGE_PREFIX = 'patterm.tabs.v1.';

export function agentTabKey(rootId: string): TabKey {
  return `agent:${rootId}`;
}

export function processTabKey(processId: string): TabKey {
  return `process:${processId}`;
}

// Live tabs in layout order with pinned tabs first. Tabs the layout does not
// know yet keep their natural order (agents, then processes) at the end.
export function buildStripTabs(
  families: readonly AgentTabFamily[],
  processes: readonly LiveProcessRecord[],
  layout: TabLayout = EMPTY_TAB_LAYOUT
): StripTab[] {
  const pinned = new Set(layout.pinned);
  const live: StripTab[] = [
    ...families.map((family) => {
      const key = agentTabKey(family.rootId);
      return { key, kind: 'agent' as const, pinned: pinned.has(key), family };
    }),
    ...processes.map((process) => {
      const key = processTabKey(process.id);
      return { key, kind: 'process' as const, pinned: pinned.has(key), process };
    })
  ];
  const byKey = new Map(live.map((tab) => [tab.key, tab]));
  const ordered = reconcileTabOrder(layout.order, live.map((tab) => tab.key))
    .map((key) => byKey.get(key))
    .filter((tab): tab is StripTab => Boolean(tab));
  return [...ordered.filter((tab) => tab.pinned), ...ordered.filter((tab) => !tab.pinned)];
}

export function reconcileTabOrder(order: readonly TabKey[], liveKeys: readonly TabKey[]): TabKey[] {
  const live = new Set(liveKeys);
  const next = new Set<TabKey>();
  for (const key of order) {
    if (live.has(key)) next.add(key);
  }
  for (const key of liveKeys) next.add(key);
  return [...next];
}

// A saved layout with every live tab it doesn't know yet added at the end,
// where the strip shows them. Keys it has for tabs not live now stay.
export function withLiveTabs(layout: TabLayout, liveKeys: readonly TabKey[]): TabLayout {
  const known = new Set(layout.order);
  return { order: [...layout.order, ...liveKeys.filter((key) => !known.has(key))], pinned: layout.pinned };
}

// The layout of the visible strip. Saving it forgets closed tabs.
export function stripTabLayout(tabs: readonly StripTab[]): TabLayout {
  return {
    order: tabs.map((tab) => tab.key),
    pinned: tabs.filter((tab) => tab.pinned).map((tab) => tab.key)
  };
}

// Moves a tab to `index` in the strip without it, kept within its pinned or
// unpinned group.
export function moveStripTab(tabs: readonly StripTab[], key: TabKey, index: number): TabLayout {
  const tab = tabs.find((candidate) => candidate.key === key);
  if (!tab) return stripTabLayout(tabs);
  const rest = tabs.filter((candidate) => candidate.key !== key);
  const pinnedCount = rest.filter((candidate) => candidate.pinned).length;
  const [min, max] = tab.pinned ? [0, pinnedCount] : [pinnedCount, rest.length];
  rest.splice(clamp(index, min, max), 0, tab);
  return stripTabLayout(rest);
}

// Pinning moves a tab to the end of the pinned group; unpinning moves it to
// the start of the unpinned group, as browsers do.
export function setStripTabPinned(tabs: readonly StripTab[], key: TabKey, pinned: boolean): TabLayout {
  const tab = tabs.find((candidate) => candidate.key === key);
  if (!tab || tab.pinned === pinned) return stripTabLayout(tabs);
  const rest = tabs.filter((candidate) => candidate.key !== key);
  rest.splice(rest.filter((candidate) => candidate.pinned).length, 0, { ...tab, pinned });
  return stripTabLayout(rest);
}

// Tab layouts are per-client preferences, like other renderer layout state.
export function readStoredTabLayout(projectId: string, storage?: Pick<Storage, 'getItem'>): TabLayout {
  try {
    const value: unknown = JSON.parse((storage ?? localStorage).getItem(`${TAB_LAYOUT_STORAGE_PREFIX}${projectId}`) ?? 'null');
    if (!value || typeof value !== 'object') return EMPTY_TAB_LAYOUT;
    const { order, pinned } = value as Partial<Record<keyof TabLayout, unknown>>;
    return { order: stringArray(order), pinned: stringArray(pinned) };
  } catch {
    return EMPTY_TAB_LAYOUT;
  }
}

export function writeStoredTabLayout(projectId: string, layout: TabLayout, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? localStorage).setItem(`${TAB_LAYOUT_STORAGE_PREFIX}${projectId}`, JSON.stringify(layout));
  } catch {
    // The layout still applies until the page reloads.
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
