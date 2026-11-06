import type { AgentTabFamily } from './agentTabs';
import type { LiveProcessRecord } from './processTabs';

// Tabs are keyed `agent:<root session id>` or `process:<process id>`, matching
// the `data-patterm-tab-id` attribute on their buttons. Folders are keyed
// `folder:<id>`.
export type TabKey = string;

export interface TabFolder { id: string; name: string }

// One scope's arrangement, saved on the server (app/Services/TabLayouts).
// `order` holds tabs and folders as they show; a tab filed in a folder shows
// inside it instead, in the order `order` gives.
export interface TabLayout {
  order: TabKey[];
  folders: TabFolder[];
  filed: Record<TabKey, string>;
}

export type StripTab =
  | { key: TabKey; kind: 'agent'; folder: string | null; family: AgentTabFamily }
  | { key: TabKey; kind: 'process'; folder: string | null; process: LiveProcessRecord };

export type LayoutEntry =
  | { kind: 'tab'; key: TabKey; tab: StripTab }
  | { kind: 'folder'; key: TabKey; folder: TabFolder; tabs: StripTab[] };

export const EMPTY_TAB_LAYOUT: TabLayout = { order: [], folders: [], filed: {} };

const LEGACY_TAB_LAYOUT_STORAGE_PREFIX = 'patterm.tabs.v1.';

export function agentTabKey(rootId: string): TabKey {
  return `agent:${rootId}`;
}

export function processTabKey(processId: string): TabKey {
  return `process:${processId}`;
}

export function folderKey(id: string): TabKey {
  return `folder:${id}`;
}

export function isFolderKey(key: TabKey): boolean {
  return key.startsWith('folder:');
}

// Live tabs in layout order, each with the folder it's filed in. Tabs the
// layout does not know yet keep their natural order (agents, then processes)
// at the end, outside any folder.
export function buildStripTabs(
  families: readonly AgentTabFamily[],
  processes: readonly LiveProcessRecord[],
  layout: TabLayout = EMPTY_TAB_LAYOUT
): StripTab[] {
  const folders = new Set(layout.folders.map((folder) => folder.id));
  const folderOf = (key: TabKey) => {
    const id = layout.filed[key];
    return id && folders.has(id) ? id : null;
  };
  const live: StripTab[] = [
    ...families.map((family) => {
      const key = agentTabKey(family.rootId);
      return { key, kind: 'agent' as const, folder: folderOf(key), family };
    }),
    ...processes.map((process) => {
      const key = processTabKey(process.id);
      return { key, kind: 'process' as const, folder: folderOf(key), process };
    })
  ];
  const byKey = new Map(live.map((tab) => [tab.key, tab]));
  return reconcileTabOrder(layout.order, live.map((tab) => tab.key))
    .map((key) => byKey.get(key))
    .filter((tab): tab is StripTab => Boolean(tab));
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

// The tabs as rows and folders, each folder holding its tabs. In `manual`
// order, folders sit where you put them among the tabs; otherwise, while
// tabs are grouped or sorted, folders follow them, in your order.
export function layoutEntries(tabs: readonly StripTab[], layout: TabLayout, manual: boolean): LayoutEntry[] {
  const members = new Map<string, StripTab[]>(layout.folders.map((folder) => [folder.id, []]));
  const loose: StripTab[] = [];
  for (const tab of tabs) (tab.folder && members.get(tab.folder) || loose).push(tab);
  const index = new Map(layout.order.map((key, at) => [key, at]));
  const folders = layout.folders
    .map((folder) => ({ kind: 'folder' as const, key: folderKey(folder.id), folder, tabs: members.get(folder.id)! }))
    .sort((a, b) => (index.get(a.key) ?? Infinity) - (index.get(b.key) ?? Infinity));
  const rows = loose.map((tab) => ({ kind: 'tab' as const, key: tab.key, tab }));
  if (!manual) return [...rows, ...folders];
  const end = layout.order.length;
  const at = (entry: LayoutEntry, fallback: number) => index.get(entry.key) ?? fallback;
  return [...rows.map((entry, i) => ({ entry, at: at(entry, end + i) })), ...folders.map((entry) => ({ entry, at: at(entry, Infinity) }))]
    .sort((a, b) => a.at - b.at)
    .map(({ entry }) => entry);
}

// Every tab in the entries, as they show: each folder's after its place.
export function entryTabs(entries: readonly LayoutEntry[]): StripTab[] {
  return entries.flatMap((entry) => entry.kind === 'tab' ? [entry.tab] : entry.tabs);
}

// A saved layout with every live tab it doesn't know yet added at the end,
// where the strip shows them, so edits can place tabs beside them.
export function withLiveTabs(layout: TabLayout, liveKeys: readonly TabKey[]): TabLayout {
  const known = new Set(layout.order);
  return { ...layout, order: [...layout.order, ...liveKeys.filter((key) => !known.has(key))] };
}

// Forgets closed tabs, keeping folders and any tab `keep` names.
export function forgetClosedTabs(layout: TabLayout, keep: (key: TabKey) => boolean): TabLayout {
  return {
    order: layout.order.filter((key) => isFolderKey(key) || keep(key)),
    folders: layout.folders,
    filed: Object.fromEntries(Object.entries(layout.filed).filter(([key]) => keep(key)))
  };
}

// Moves a tab or folder to sit before `before`, or after `after`. A tab moves
// into `folder`, or out of any with null; with neither neighbour it goes to
// the end of the folder, or of the list. Folders only sit among the tabs.
export function placeInLayout(layout: TabLayout, key: TabKey, place: { folder: string | null; before?: TabKey | null; after?: TabKey | null }): TabLayout {
  const folder = !isFolderKey(key) && place.folder && layout.folders.some((candidate) => candidate.id === place.folder) ? place.folder : null;
  const filed = { ...layout.filed };
  if (folder) filed[key] = folder;
  else delete filed[key];
  const order = layout.order.filter((candidate) => candidate !== key);
  let at = place.before ? order.indexOf(place.before) : -1;
  if (at < 0 && place.after) at = order.indexOf(place.after) + 1 || -1;
  if (at < 0 && folder) {
    const last = order.reduce((found, candidate, index) => filed[candidate] === folder || candidate === folderKey(folder) ? index : found, -1);
    at = last + 1;
  }
  order.splice(at < 0 ? order.length : at, 0, key);
  return { ...layout, order, filed };
}

// A new folder where the first of `keys` was, holding them.
export function createFolderInLayout(layout: TabLayout, folder: TabFolder, keys: readonly TabKey[]): TabLayout {
  const first = keys.length ? layout.order.findIndex((key) => keys.includes(key)) : -1;
  const order = [...layout.order];
  order.splice(first < 0 ? order.length : first, 0, folderKey(folder.id));
  const filed = { ...layout.filed };
  for (const key of keys) filed[key] = folder.id;
  return { order, folders: [...layout.folders, folder], filed };
}

export function renameFolderInLayout(layout: TabLayout, id: string, name: string): TabLayout {
  return { ...layout, folders: layout.folders.map((folder) => folder.id === id ? { ...folder, name } : folder) };
}

// Its tabs stay where the folder was, in its order.
export function deleteFolderFromLayout(layout: TabLayout, id: string): TabLayout {
  const key = folderKey(id);
  const members = layout.order.filter((candidate) => layout.filed[candidate] === id);
  const order = layout.order.filter((candidate) => layout.filed[candidate] !== id);
  order.splice(Math.max(order.indexOf(key), 0), 1, ...members);
  return {
    order: order.filter((candidate) => candidate !== key),
    folders: layout.folders.filter((folder) => folder.id !== id),
    filed: Object.fromEntries(Object.entries(layout.filed).filter(([, folder]) => folder !== id))
  };
}

// Before layouts were saved on the server, each device kept its own, with
// pinned tabs. The first read of a scope that has none saved yet carries the
// device's over, its pins in a folder at the top.
export function readLegacyTabLayout(scope: string, storage?: Pick<Storage, 'getItem'>): TabLayout | null {
  try {
    const value: unknown = JSON.parse((storage ?? localStorage).getItem(`${LEGACY_TAB_LAYOUT_STORAGE_PREFIX}${scope}`) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const { order, pinned } = value as Record<string, unknown>;
    const keys = stringArray(order);
    const pins = stringArray(pinned).filter((key) => keys.includes(key));
    if (!keys.length) return null;
    if (!pins.length) return { order: keys, folders: [], filed: {} };
    const folder = { id: 'pinned', name: 'Pinned' };
    return {
      order: [folderKey(folder.id), ...pins, ...keys.filter((key) => !pins.includes(key))],
      folders: [folder],
      filed: Object.fromEntries(pins.map((key) => [key, folder.id]))
    };
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
