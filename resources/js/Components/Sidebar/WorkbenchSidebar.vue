<template>
  <div class="hidden min-h-0 shrink-0 sm:flex">
    <!-- The incoming state fades in. Width changes are left instant so the
         workspace (and any terminal in it) resizes once, not every frame. -->
    <Transition enter-active-class="transition-opacity duration-200 ease-out motion-reduce:transition-none" enter-from-class="opacity-0">
    <SidebarRail v-if="railed" class="pb-1.5" @expand="expand" />
    <aside v-else aria-label="Agents" class="relative flex min-h-0 flex-col pb-1.5 pl-1" :style="{ width: `${shownWidth}px` }">
      <!-- Same handle as the session context panel: drag, arrow keys, and double-click to reset. -->
      <div
        role="separator"
        tabindex="0"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        :aria-valuenow="shownWidth"
        :aria-valuemin="SIDEBAR_WIDTH.min"
        :aria-valuemax="SIDEBAR_WIDTH.max"
        class="group/resize absolute inset-y-0 -right-1.5 z-10 flex w-2 cursor-col-resize justify-center outline-none"
        @pointerdown="startResize"
        @pointermove="resize"
        @pointerup="endResize"
        @pointercancel="endResize"
        @dblclick="sidebarLayout.width = SIDEBAR_WIDTH.default"
        @keydown.left.prevent="nudge(-20)"
        @keydown.right.prevent="nudge(20)"
        @keydown.home.prevent="sidebarLayout.width = SIDEBAR_WIDTH.min"
        @keydown.end.prevent="nudge(SIDEBAR_WIDTH.max)"
      >
        <span class="h-full w-px bg-transparent transition-colors group-hover/resize:bg-white/15 group-focus-visible/resize:bg-primary/60" :class="drag && 'bg-white/25'" aria-hidden="true" />
      </div>
      <SidebarList placement="docked" class="min-h-0 flex-1" />
    </aside>
    </Transition>

    <SidebarDrawer :open="sidebarLayout.drawerOpen && railed" :dockable="!narrow" :offset="54" :width="sidebarLayout.width" @close="sidebarLayout.drawerOpen = false" @dock="dock">
      <SidebarList placement="drawer" />
    </SidebarDrawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useWindowSize } from '@vueuse/core';
import { touchScreen } from '../../lib/touch';
import { assistantLayout } from '../../lib/assistantLayout';
import { assistant } from '../../lib/assistant';
import { provideAgentDigests } from '../../Composables/useAgentDigests';
import { useSelectedHarnessLaunch } from '../../Composables/useHarnessLaunch';
import { useBoardKeys } from '../../Composables/useBoard';
import SidebarDrawer from './SidebarDrawer.vue';
import SidebarRail from './SidebarRail.vue';
import { useSidebar } from './sidebarContext';
import { clampSidebarWidth, SIDEBAR_WIDTH, sidebarLayout } from './sidebarLayout';
import SidebarList from './SidebarList.vue';

const sidebar = useSidebar();
const selectedLaunch = useSelectedHarnessLaunch();
// Read once for every list's agent cards and for the board.
provideAgentDigests();
useBoardKeys();
const { width } = useWindowSize();
// A docked assistant takes its column first. The sidebar narrows to keep
// 720 px of workspace, then rails once even its minimum width doesn't fit. A
// tablet keeps its list beside a narrower workspace instead.
const ASSISTANT_DOCK_PX = 422;
const fitWidth = computed(() => width.value - (assistant.enabled && assistantLayout.open && assistantLayout.docked && !assistantLayout.expanded ? ASSISTANT_DOCK_PX : 0) - (touchScreen() ? 480 : 720));
const narrow = computed(() => fitWidth.value < SIDEBAR_WIDTH.min);
// The stored width is the preference; the window may show less of it.
const shownWidth = computed(() => Math.min(sidebarLayout.width, Math.max(SIDEBAR_WIDTH.min, fitWidth.value)));

const drag = ref<{ x: number; width: number } | null>(null);
function startResize(event: PointerEvent): void {
  drag.value = { x: event.clientX, width: shownWidth.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}
// Dragging well past the minimum collapses to the rail, as in editors.
const SNAP_TO_RAIL_PX = 56;
function resize(event: PointerEvent): void {
  if (!drag.value) return;
  const wanted = drag.value.width + event.clientX - drag.value.x;
  if (wanted < SIDEBAR_WIDTH.min - SNAP_TO_RAIL_PX) {
    // Expanding again restores the width the drag started from.
    sidebarLayout.width = drag.value.width;
    drag.value = null;
    sidebarLayout.collapsed = true;
    return;
  }
  sidebarLayout.width = Math.min(clampSidebarWidth(wanted), Math.max(SIDEBAR_WIDTH.min, fitWidth.value));
}
function nudge(delta: number): void {
  sidebarLayout.width = Math.min(clampSidebarWidth(shownWidth.value + delta), Math.max(SIDEBAR_WIDTH.min, fitWidth.value));
}
function endResize(): void {
  drag.value = null;
}
const railed = computed(() => sidebarLayout.collapsed || narrow.value);

// When narrow, expanding shows the sidebar over the workspace instead.
function expand(): void {
  if (narrow.value) sidebarLayout.drawerOpen = !sidebarLayout.drawerOpen;
  else sidebarLayout.collapsed = false;
}
function toggle(): void {
  if (railed.value) expand();
  else sidebarLayout.collapsed = true;
}
function dock(): void {
  sidebarLayout.drawerOpen = false;
  sidebarLayout.collapsed = false;
}

// Choosing something dismisses the overlay.
watch(() => [sidebar.page.value, selectedLaunch.value?.id, ...sidebar.tabs.value.flatMap((tab) => tab.kind === 'agent'
  ? [...tab.family.options.filter((option) => sidebar.sessionActive(option.session)).map((option) => option.session.id), ...sidebar.ownedProcesses(tab.family).filter(sidebar.processActive).map((process) => process.id)]
  : sidebar.processActive(tab.process) ? [tab.key] : [])].join(),
() => { sidebarLayout.drawerOpen = false; });

// Ctrl+Shift, like the terminal's copy chord, so plain Ctrl+B still reaches the PTY.
// Caught before a focused terminal sees it, which would send Ctrl+B as well.
function onKeydown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'b') return;
  event.preventDefault();
  event.stopPropagation();
  toggle();
}
onMounted(() => window.addEventListener('keydown', onKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));
</script>
