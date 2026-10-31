import { computed, effectScope, ref, watch, type Ref } from 'vue';

// Which agent families are open is the user's choice, remembered per project
// on this device. Families start closed; `followActive` also opens the family
// you're in unless you've closed it. `subtitles` shows every row's status line.
export interface SidebarExpansion {
  overrides: Record<string, boolean>;
  followActive: boolean;
  subtitles: boolean;
  processes: boolean;
  groupByStatus: boolean;
  // Newest activity first within each group, instead of the order you give it.
  sortByActivity: boolean;
  // Only while showing all agents. Off, the list keeps the order you give it.
  groupByProject: boolean;
  // Subagents and servers listed under their agent. Off, the list is flatter,
  // and each agent's header still lists them. `hiddenMembers` turns them off
  // for single agents.
  members: boolean;
  hiddenMembers: string[];
}

const DEFAULTS: SidebarExpansion = { overrides: {}, followActive: false, subtitles: true, processes: false, groupByStatus: false, sortByActivity: false, groupByProject: true, members: true, hiddenMembers: [] };
const KEY_PREFIX = 'patterm.sidebar.expansion.';

function read(projectId: string): SidebarExpansion {
  try {
    const value = JSON.parse(localStorage.getItem(KEY_PREFIX + projectId) ?? 'null') as Partial<SidebarExpansion> | null;
    return { ...DEFAULTS, ...value, overrides: { ...value?.overrides }, hiddenMembers: Array.isArray(value?.hiddenMembers) ? value.hiddenMembers : [] };
  } catch {
    return { ...DEFAULTS, overrides: {}, hiddenMembers: [] };
  }
}

// One state per project, shared by everything showing it, so the view options
// (in the list's heading or a phone's Library) and a row's menu change the list.
const states = new Map<string, Ref<SidebarExpansion>>();
const scope = effectScope(true);

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

export function useSidebarExpansion(projectId: () => string) {
  const state = computed(() => stateFor(projectId()).value);

  function isOpen(rootId: string, holdsSelection: boolean): boolean {
    return state.value.overrides[rootId] ?? (state.value.followActive && holdsSelection);
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
    return state.value.members && !state.value.hiddenMembers.includes(rootId);
  }
  function setMembersHidden(rootId: string, hidden: boolean): void {
    const rest = state.value.hiddenMembers.filter((id) => id !== rootId);
    state.value.hiddenMembers = hidden ? [...rest, rootId] : rest;
  }
  return { state, isOpen, isNodeOpen, setOpen, membersShown, setMembersHidden };
}
