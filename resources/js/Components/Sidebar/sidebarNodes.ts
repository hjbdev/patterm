import { inject, reactive, type InjectionKey } from 'vue';

// Which nested agents are open, provided by the sidebar list. Nested agents
// start open, so opening a family shows its whole tree until you fold part of it.
export interface SidebarNodes {
  isOpen: (sessionId: string) => boolean;
  setOpen: (sessionId: string, open: boolean) => void;
  // Selecting an agent with children also opens them.
  expandOnSelect: boolean;
  // Whether a member row (by session or process ID) is outside the selected thread.
  dimmed?: (id: string) => boolean;
}

export const sidebarNodesKey: InjectionKey<SidebarNodes> = Symbol('sidebarNodes');

const fallbackOpen = reactive<Record<string, boolean>>({});
const fallbackNodes: SidebarNodes = {
  isOpen: (sessionId) => fallbackOpen[sessionId] ?? true,
  setOpen: (sessionId, open) => { fallbackOpen[sessionId] = open; },
  expandOnSelect: false
};

export function useSidebarNodes(): SidebarNodes {
  return inject(sidebarNodesKey, fallbackNodes);
}
