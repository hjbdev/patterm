import { computed, onBeforeUnmount, onMounted, watch, type ComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSidebar } from '../Components/Sidebar/sidebarContext';

// In sidebar mode, a project's page is the board of its agents, once it has
// any. Otherwise the project's page opens its first tab, or offers to launch
// an agent.
export function useBoardIsHome(): ComputedRef<boolean> {
  const sidebar = useSidebar();
  return computed(() => sidebar.shown.value && sidebar.tabs.value.some((tab) => tab.kind === 'agent'));
}

// A second close before the first step back lands, from the shortcut and then
// Esc, say, would step back twice.
let leaving = false;

// The board is a page, so Back and Forward reach it like any other. Opening it
// adds a step to the history; closing it steps back to where it was opened,
// when that was in this project.
export function useBoardRoute() {
  const route = useRoute();
  const router = useRouter();
  const sidebar = useSidebar();
  const home = useBoardIsHome();
  const open = computed(() => route.name === 'project' && home.value);
  watch(open, () => { leaving = false; });

  // Arriving from another project, or from a link, there's nothing in this
  // project to go back to.
  function openedHere(): boolean {
    const back = router.options.history.state.back;
    return typeof back === 'string' && back.startsWith(`/projects/${sidebar.projectId.value}/`);
  }
  const closable = computed(() => {
    void route.fullPath;
    return open.value && openedHere();
  });

  function show(): void {
    if (!open.value && sidebar.projectId.value) void router.push({ name: 'project', params: { projectId: sidebar.projectId.value } });
  }

  function close(): void {
    if (!open.value || leaving || !openedHere()) return;
    leaving = true;
    router.back();
  }

  function toggle(): void {
    if (open.value) close();
    else show();
  }

  return { open, closable, show, close, toggle };
}

// Ctrl+Shift+Space, beside navigation mode's Ctrl+Space, opens the board or
// goes back from it, and Esc from the sidebar goes back from it too. Caught
// before a focused terminal sees the shortcut, which would send Ctrl+Space.
export function useBoardKeys(): void {
  const board = useBoardRoute();

  function onShortcut(event: KeyboardEvent): void {
    if (event.code !== 'Space' || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) board.toggle();
  }

  // The board handles Esc itself; menus and dialogs close themselves first,
  // and Esc while typing, as in the assistant, stays with the text.
  function onEscape(event: KeyboardEvent): void {
    if (!board.open.value || event.key !== 'Escape' || event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest('[role="menu"], [role="dialog"], [role="listbox"], input, textarea, select, [contenteditable]')) return;
    board.close();
  }

  onMounted(() => {
    window.addEventListener('keydown', onShortcut, true);
    window.addEventListener('keydown', onEscape);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onShortcut, true);
    window.removeEventListener('keydown', onEscape);
  });
}
