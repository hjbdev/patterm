<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-8 shrink-0 items-center gap-0.5 pl-3 pr-1">
      <span class="flex-1 text-xs text-muted-foreground">Agents</span>
      <BoardButton />
      <SidebarViewOptions />
      <LaunchAgentMenu :project-id="sidebar.projectId.value" />
    </div>
    <div ref="list" class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-2 [scrollbar-width:thin]" @keydown="onKeydown">
      <HarnessLaunchTabs :project-id="sidebar.projectId.value" vertical />
      <p v-if="!sidebar.tabs.value.length && !pendingLaunches.length" class="px-2 py-1 text-[13px] text-muted-foreground">No agents running</p>
      <!-- One list, headings included, so a row that changes group keeps its
           element and slides there instead of leaving one group and entering another. -->
      <TransitionGroup tag="div" :css="false" @enter="expandIn" @leave="collapseOut">
        <template v-for="entry in entries" :key="entry.key">
          <div v-if="entry.kind === 'divider'" data-sidebar-slide class="mx-2 my-2 border-t border-white/[0.06]" />
          <div v-else-if="entry.kind === 'heading'" data-sidebar-slide class="flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground" :class="entry.first ? '' : 'mt-3'">
            <span class="flex-1">{{ entry.label }}</span>
            <span class="tabular-nums">{{ entry.count }}</span>
          </div>
          <div
            v-else
            :ref="(element) => setElement(entry.key, element)"
            data-sidebar-block
            data-sidebar-slide
            :data-sidebar-group="entry.group"
            class="relative"
            :class="[draggingKey === entry.key && 'z-10 rounded-tab bg-[hsl(0_0%_12%)] shadow-lg', entry.gap]"
            @pointerdown="onPointerDown($event, entry.key)"
            @click.capture="consumeClick($event, entry.key)"
          >
            <span v-if="dropLine?.key === entry.key" class="pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary/70" :class="dropLine.edge === 'before' ? '-top-px' : '-bottom-px'" aria-hidden="true" />
            <SidebarFamily
              v-if="entry.tab.kind === 'agent'"
              :tab="entry.tab"
              :expanded="expanded(entry.tab) || revealed(entry.tab.family.rootId)"
              :subtitle="subtitle(entry.tab)"
              :waiting="Boolean(familyWaitingOn(sidebar, entry.tab.family))"
              expand-on-select
              @toggle="toggle(entry.tab, $event)"
              @expand="(open) => setFamilyOpen(entry.tab, open)"
            />
            <SidebarMemberRow v-else :process="entry.tab.process" :tab="entry.tab" />
          </div>
        </template>
      </TransitionGroup>
      <template v-if="processTabs.length">
        <button
          type="button"
          class="mt-3 flex h-7 w-full items-center gap-2 rounded-tab px-2 text-left text-xs transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :class="!processesOpen && processTabs.some((tab) => sidebar.processActive(tab.process)) ? 'bg-primary/10 text-foreground' : 'text-muted-foreground'"
          :aria-expanded="processesOpen"
          @click="expansion.state.value.processes = !processesOpen"
        >
          <ChevronRight class="h-3 w-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none" :class="processesOpen && 'rotate-90'" />
          <span class="flex-1">Processes</span>
          <span class="tabular-nums">{{ processTabs.length }}</span>
        </button>
        <Transition :css="false" @enter="expandIn" @leave="collapseOut">
          <TransitionGroup v-if="processesOpen" tag="div" :css="false" @enter="expandIn" @leave="collapseOut">
            <div
              v-for="tab in processTabs"
              :key="tab.key"
              :ref="(element) => setElement(tab.key, element)"
              data-sidebar-block
              data-sidebar-group="processes"
              class="relative"
              :class="draggingKey === tab.key && 'z-10 rounded-tab bg-[hsl(0_0%_12%)] shadow-lg'"
              @pointerdown="onPointerDown($event, tab.key)"
              @click.capture="consumeClick($event, tab.key)"
            >
              <span v-if="dropLine?.key === tab.key" class="pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary/70" :class="dropLine.edge === 'before' ? '-top-px' : '-bottom-px'" aria-hidden="true" />
              <SidebarMemberRow :process="tab.process" :tab="tab" />
            </div>
          </TransitionGroup>
        </Transition>
      </template>
    </div>
    <div class="flex shrink-0 items-center border-t border-white/5 px-1 pt-1">
      <SidebarPages class="flex-1">
        <template #end>
          <span class="flex-1" />
          <SidebarCollapseButton v-if="placement === 'docked'" />
        </template>
      </SidebarPages>
    </div>
    <!-- The agent you point at gets a card beside it. -->
    <SidebarAgentCard :list="list" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, provide, ref, watch } from 'vue';
import { useProjectHarnessLaunches } from '../../Composables/useHarnessLaunch';
import { ChevronRight } from 'lucide-vue-next';
import type { StripTab } from '../../lib/tabStrip';
import LaunchAgentMenu from '../LaunchAgentMenu.vue';
import HarnessLaunchTabs from '../HarnessLaunchTabs.vue';
import BoardButton from './BoardButton.vue';
import SidebarAgentCard from './SidebarAgentCard.vue';
import SidebarCollapseButton from './SidebarCollapseButton.vue';
import SidebarFamily from './SidebarFamily.vue';
import SidebarMemberRow from './SidebarMemberRow.vue';
import SidebarPages from './SidebarPages.vue';
import SidebarViewOptions from './SidebarViewOptions.vue';
import { useSidebar, type AgentTab } from './sidebarContext';
import { familyStatus, familyWaitingOn, selectedThread, SIDEBAR_STATUSES, type SidebarStatus } from '../../lib/sidebarTree';
import { collapseOut, expandIn, rowTops, slideFrom } from '../../lib/sidebarMotion';
import { sidebarNodesKey } from './sidebarNodes';
import { useSidebarMention } from './sidebarMention';
import { useSidebarExpansion } from '../../Composables/useSidebarExpansion';
import { useSidebarKeys } from '../../Composables/useSidebarKeys';
import { useSidebarReorder } from '../../Composables/useSidebarReorder';
import { useSettledValues } from '../../Composables/useSettledValues';

// The sidebar's list. Closed families are one line, subtitles appear where
// they matter, and which families are open is the user's choice, remembered
// on this device. Selecting an agent opens it; Alt-click a count to open or
// close every family.
withDefaults(defineProps<{ placement?: 'docked' | 'drawer' }>(), { placement: 'docked' });
const sidebar = useSidebar();
const pendingLaunches = useProjectHarnessLaunches(() => sidebar.projectId.value);
const expansion = useSidebarExpansion(() => sidebar.projectId.value);

// Grouped by status, a family moves once its new status has lasted a moment,
// so output blips don't bounce it between groups. Needing you moves at once.
const liveStatuses = computed(() => new Map<string, SidebarStatus>(expansion.state.value.groupByStatus
  ? sidebar.tabs.value.flatMap((tab) => tab.kind === 'agent' && !tab.pinned ? [[tab.key, familyStatus(sidebar, tab.family, sidebar.activity(tab.family.root.session))] as const] : [])
  : []));
const status = useSettledValues(() => liveStatuses.value, {
  minimumMs: 2_000,
  immediate: (next) => next === 'attention',
  delayFor: (next) => next === 'working' ? 1_500 : 2_500
});

// Pinned rows first, in the order you gave them. The rest are agents, grouped
// by status if you ask; your order holds within each group.
interface Group { id: string; label: string | null; tabs: StripTab[] }
const groups = computed<Group[]>(() => {
  const tabs = sidebar.tabs.value;
  const open = tabs.filter((tab) => !tab.pinned && tab.kind === 'agent');
  const rest = expansion.state.value.groupByStatus
    ? SIDEBAR_STATUSES.map(({ id, label }) => ({ id, label, tabs: open.filter((tab) => (status(tab.key) ?? 'idle') === id) }))
    : [{ id: 'open', label: null, tabs: open }];
  return [{ id: 'pinned', label: null, tabs: tabs.filter((tab) => tab.pinned) }, ...rest].filter((group) => group.tabs.length);
});
type Entry =
  | { kind: 'divider'; key: string }
  | { kind: 'heading'; key: string; label: string; count: number; first: boolean }
  | { kind: 'tab'; key: string; tab: StripTab; group: string; gap: string | false };
const entries = computed<Entry[]>(() => groups.value.flatMap((group, groupIndex): Entry[] => [
  ...(group.label ? [{ kind: 'heading' as const, key: `heading:${group.id}`, label: group.label, count: group.tabs.length, first: groupIndex === 0 }]
    : groupIndex > 0 ? [{ kind: 'divider' as const, key: `divider:${group.id}` }] : []),
  ...group.tabs.map((tab, index) => ({ kind: 'tab' as const, key: tab.key, tab, group: group.id, gap: index > 0 && 'mt-0.5' }))
]));

// When rows change group (a status settling, or pinning), measure them before
// the list redraws and slide them from there. Reordering within a group
// animates itself.
const list = ref<HTMLElement | null>(null);
watch(() => groups.value.flatMap((group) => group.tabs.map((tab) => `${tab.key}:${group.id}`)).sort().join(), () => {
  if (!list.value) return;
  const before = rowTops(list.value.querySelectorAll<HTMLElement>('[data-sidebar-slide]'));
  void nextTick(() => slideFrom(before));
}, { flush: 'pre' });
const processTabs = computed(() => sidebar.tabs.value.filter((tab): tab is Extract<StripTab, { kind: 'process' }> => !tab.pinned && tab.kind === 'process'));
const processesOpen = computed(() => expansion.state.value.processes);

function expanded(tab: AgentTab): boolean {
  return expansion.isOpen(tab.family.rootId, sidebar.familyActive(tab.family));
}
function setExpanded(rootId: string, open: boolean): void {
  expansion.setOpen(rootId, open);
}
function setFamilyOpen(tab: StripTab, open: boolean): void {
  if (tab.kind === 'agent') setExpanded(tab.family.rootId, open);
}
// Nested agents fold the same way, and selecting one opens its children.
// Members off the path to the selected agent dim their text.
const thread = computed(() => selectedThread(sidebar, sidebar.tabs.value));
provide(sidebarNodesKey, {
  isOpen: (sessionId: string) => revealed(sessionId) || expansion.isNodeOpen(sessionId),
  setOpen: expansion.setOpen,
  expandOnSelect: true,
  dimmed: (id: string) => Boolean(thread.value && !thread.value.has(id))
});

// An agent highlighted in a composer's @ menu glows, and the agents above it
// open while it's highlighted so its row shows.
const mention = useSidebarMention(
  () => sidebar.tabs.value,
  () => list.value,
  ({ sessionId }) => list.value?.querySelector<HTMLElement>(`[data-family="${CSS.escape(sessionId)}"], [data-row-key="${CSS.escape(`session:${sessionId}`)}"]`)
);
function revealed(sessionId: string): boolean {
  return Boolean(mention.value?.ancestors.has(sessionId));
}

function toggle(tab: AgentTab, event: MouseEvent): void {
  if (event.altKey) expansion.setAll(!expanded(tab));
  else setExpanded(tab.family.rootId, !expanded(tab));
}

// What a family waits on always shows; its status line shows when it's open,
// or everywhere if the user asks for every summary. Recaps from before status
// lines existed show their first line instead.
function subtitle(tab: AgentTab): string | null {
  const waitingOn = familyWaitingOn(sidebar, tab.family);
  if (waitingOn) return waitingOn;
  const summary = tab.family.root.session.summary;
  if (!summary || !(expansion.state.value.summaries || expanded(tab))) return null;
  const coverage: Record<string, string> = { stale: 'Summary history changed', catching_up: 'Summary catching up',
    partial: 'Partial conversation recap', paused: 'Summary catch-up paused' };
  return coverage[summary.coverage ?? ''] ?? summary.status ?? summary.text;
}

const { onKeydown } = useSidebarKeys({ toggle: setExpanded, move: sidebar.moveTab });
const { setElement, draggingKey, dropLine, onPointerDown, consumeClick } = useSidebarReorder(
  () => [
    ...groups.value.flatMap((group) => group.tabs.map((tab) => ({ key: tab.key, group: group.id }))),
    ...processTabs.value.map((tab) => ({ key: tab.key, group: 'processes' }))
  ],
  sidebar.moveTab
);
</script>
