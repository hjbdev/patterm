import { ref, watch } from 'vue';

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

export function useSidebarExpansion(projectId: () => string) {
  let project = projectId();
  const state = ref<SidebarExpansion>(read(project));
  watch(projectId, (id) => {
    project = id;
    state.value = read(id);
  });
  watch(state, (value) => localStorage.setItem(KEY_PREFIX + project, JSON.stringify(value)), { deep: true });

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
