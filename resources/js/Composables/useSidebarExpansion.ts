import { computed, effectScope, ref, watch, type Ref } from 'vue';

// Which agent families are open is the user's choice, remembered per project
// on this device. Families follow `all` until opened or closed one by one;
// `followActive` also opens the family you're in unless you've closed it.
export interface SidebarExpansion {
  all: boolean;
  overrides: Record<string, boolean>;
  followActive: boolean;
  summaries: boolean;
  processes: boolean;
  groupByStatus: boolean;
}

const DEFAULTS: SidebarExpansion = { all: false, overrides: {}, followActive: false, summaries: false, processes: false, groupByStatus: false };
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
    return state.value.overrides[rootId] ?? (state.value.all || (state.value.followActive && holdsSelection));
  }
  // Nested agents start open, so opening a family shows its whole tree.
  function isNodeOpen(sessionId: string): boolean {
    return state.value.overrides[sessionId] ?? true;
  }
  function setOpen(sessionId: string, open: boolean): void {
    state.value.overrides = { ...state.value.overrides, [sessionId]: open };
  }
  function setAll(open: boolean): void {
    state.value.all = open;
    state.value.overrides = {};
  }
  return { state, isOpen, isNodeOpen, setOpen, setAll };
}
