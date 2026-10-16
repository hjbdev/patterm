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
  // Only while showing all agents. Off, the list keeps the order you give it.
  groupByProject: boolean;
}

const DEFAULTS: SidebarExpansion = { overrides: {}, followActive: false, subtitles: true, processes: false, groupByStatus: false, groupByProject: true };
const KEY_PREFIX = 'patterm.sidebar.expansion.';

function read(projectId: string): SidebarExpansion {
  try {
    const value = JSON.parse(localStorage.getItem(KEY_PREFIX + projectId) ?? 'null') as Partial<SidebarExpansion> | null;
    return { ...DEFAULTS, ...value, overrides: { ...value?.overrides } };
  } catch {
    return { ...DEFAULTS, overrides: {} };
  }
}

// One state per project, shared by everything showing it, so the view options
// in the mobile drawer's header change the list below them.
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
  return { state, isOpen, isNodeOpen, setOpen };
}
