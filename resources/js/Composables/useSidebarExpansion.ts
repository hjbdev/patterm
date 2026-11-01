import { computed, effectScope, ref, watch, type Ref } from 'vue';

// Which agent families are open is the user's choice, remembered per project
// on this device. Families and the processes section start closed.
export interface SidebarExpansion {
  overrides: Record<string, boolean>;
  processes: boolean;
  // Agents whose subagents and servers stay out of the list.
  hiddenMembers: string[];
}

// How the list shows its agents, one set for every project on this device.
export interface SidebarView {
  groupByStatus: boolean;
  // Newest activity first within each group, instead of the order you give it.
  sortByActivity: boolean;
  // Only while showing all agents. Off, the list keeps the order you give it.
  groupByProject: boolean;
  // Subagents and servers listed under their agent. Off, the list is flatter,
  // and each agent's header still lists them.
  members: boolean;
}

const VIEW_DEFAULTS: SidebarView = { groupByStatus: false, sortByActivity: false, groupByProject: true, members: true };
const KEY_PREFIX = 'patterm.sidebar.expansion.';
const VIEW_KEY = 'patterm.sidebar.view';

function parse(key: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pickView(value: Record<string, unknown> | null): SidebarView {
  const view = { ...VIEW_DEFAULTS };
  for (const key of Object.keys(VIEW_DEFAULTS) as (keyof SidebarView)[]) {
    if (typeof value?.[key] === 'boolean') view[key] = value[key];
  }
  return view;
}

function read(projectId: string): SidebarExpansion {
  const value = parse(KEY_PREFIX + projectId);
  const overrides = value?.overrides && typeof value.overrides === 'object' ? value.overrides as Record<string, boolean> : {};
  return {
    overrides: { ...overrides },
    processes: value?.processes === true,
    hiddenMembers: Array.isArray(value?.hiddenMembers) ? value.hiddenMembers as string[] : []
  };
}

// One state per project, shared by everything showing it, so the view options
// (in the list's heading or a phone's Library) and a row's menu change the list.
const states = new Map<string, Ref<SidebarExpansion>>();
const scope = effectScope(true);
let view: Ref<SidebarView> | null = null;

function stateFor(projectId: string): Ref<SidebarExpansion> {
  let state = states.get(projectId);
  if (!state) {
    const created = ref<SidebarExpansion>(read(projectId));
    scope.run(() => watch(created, (value) => localStorage.setItem(KEY_PREFIX + projectId, JSON.stringify(value)), { deep: true }));
    states.set(projectId, created);
    state = created;
  }
  return state;
}

// Before the options were shared, each project kept its own; the first
// project read carries its choices over.
function viewState(projectId: string): Ref<SidebarView> {
  if (!view) {
    const created = ref<SidebarView>(pickView(parse(VIEW_KEY) ?? parse(KEY_PREFIX + projectId)));
    scope.run(() => watch(created, (value) => localStorage.setItem(VIEW_KEY, JSON.stringify(value)), { deep: true }));
    view = created;
  }
  return view;
}

export function useSidebarExpansion(projectId: () => string) {
  const state = computed(() => stateFor(projectId()).value);
  const options = computed(() => viewState(projectId()).value);

  function isOpen(rootId: string): boolean {
    return state.value.overrides[rootId] ?? false;
  }
  // Nested agents start open, so opening a family shows its whole tree.
  function isNodeOpen(sessionId: string): boolean {
    return state.value.overrides[sessionId] ?? true;
  }
  function setOpen(sessionId: string, open: boolean): void {
    state.value.overrides = { ...state.value.overrides, [sessionId]: open };
  }
  // Whether the list shows this agent's subagents and servers under it.
  function membersShown(rootId: string): boolean {
    return options.value.members && !state.value.hiddenMembers.includes(rootId);
  }
  function setMembersHidden(rootId: string, hidden: boolean): void {
    const rest = state.value.hiddenMembers.filter((id) => id !== rootId);
    state.value.hiddenMembers = hidden ? [...rest, rootId] : rest;
  }
  return { state, view: options, isOpen, isNodeOpen, setOpen, membersShown, setMembersHidden };
}
