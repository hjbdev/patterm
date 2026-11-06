<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- Bots come first: each is one persistent conversation. -->
    <BotList :phone="placement === 'phone'" :project-id="sidebar.projectId.value" :all="sidebar.allAgents.value" class="shrink-0 px-1 pt-1" />
    <!-- On a phone the list is the home screen, which gives these their own places. -->
    <div v-if="placement !== 'phone'" class="flex h-8 shrink-0 items-center gap-0.5 pl-1.5 pr-1">
      <span class="flex-1"><SidebarViewOptions :label="sidebar.allAgents.value ? 'All agents' : 'Agents'" /></span>
      <LaunchAgentMenu :project-id="sidebar.projectId.value" :choose-project="sidebar.allAgents.value" />
    </div>
    <div ref="list" class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pb-2 [scrollbar-width:thin]" @keydown="onKeydown">
      <HarnessLaunchTabs v-for="projectId in sidebar.shownProjectIds.value" :key="projectId" :project-id="projectId" vertical />
      <p v-if="!sidebar.tabs.value.length && !pendingLaunches.length" class="px-2 py-1 text-[13px] text-muted-foreground">No agents running</p>
      <!-- One list, headings included, so a row that changes group keeps its
           element and slides there instead of leaving one group and entering another. -->
      <TransitionGroup tag="div" :css="false" @enter="expandIn" @leave="collapseOut">
        <template v-for="entry in entries" :key="entry.key">
          <div v-if="entry.kind === 'divider'" data-sidebar-slide class="mx-2 my-2 border-t border-white/[0.06]" />
          <!-- Grouped by project, a hairline rule names each project. -->
          <!-- Its + starts an agent in that project. -->
          <div v-else-if="entry.kind === 'rule'" data-sidebar-slide class="flex h-6 items-center gap-1.5 pl-2 pr-0.5 text-[11px] text-muted-foreground" :class="entry.first ? '' : 'mt-2'">
            <ProjectLogo :project="entry.project" :size="12" />
            <span class="max-w-[60%] truncate">{{ entry.label }}</span>
            <HostBadge v-if="entry.project.host" :host="entry.project.host" />
            <span class="h-px flex-1 bg-white/[0.06]" />
            <LaunchAgentMenu :project-id="entry.project.id" trigger-class="h-5 w-5 [&_svg]:h-3.5 [&_svg]:w-3.5" />
          </div>
          <div v-else-if="entry.kind === 'heading'" data-sidebar-slide class="flex h-7 items-center gap-2 px-2 text-xs text-muted-foreground" :class="entry.first ? '' : 'mt-3'">
            <span class="flex-1">{{ entry.label }}</span>
            <span class="tabular-nums">{{ entry.count }}</span>
          </div>
          <div
            v-else-if="entry.kind === 'folder'"
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
            <SidebarFolderRow :folder="entry.folder" :tabs="entry.tabs" :open="entry.open" :drop-target="dropInto === entry.key" @toggle="setExpanded(entry.key, !entry.open)" />
          </div>
          <div
            v-else
            :ref="(element) => setElement(entry.key, element)"
            data-sidebar-block
            data-sidebar-slide
            :data-sidebar-group="entry.group"
            :data-last="entry.last ? '' : undefined"
            class="relative"
            :class="[draggingKey === entry.key && 'z-10 rounded-tab bg-[hsl(0_0%_12%)] shadow-lg', entry.member ? 'sidebar-folder-member' : entry.gap, entry.member && dropInto === entry.group && 'rounded-tab bg-primary/10']"
            @pointerdown="onPointerDown($event, entry.key)"
            @click.capture="consumeClick($event, entry.key)"
          >
            <span v-if="dropLine?.key === entry.key" class="pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary/70" :class="dropLine.edge === 'before' ? '-top-px' : '-bottom-px'" aria-hidden="true" />
            <SidebarFamily
              v-if="entry.tab.kind === 'agent'"
              :tab="entry.tab"
              :expanded="expansion.membersShown(entry.tab.family.rootId) && (expanded(entry.tab) || revealed(entry.tab.family.rootId))"
              :members-shown="expansion.membersShown(entry.tab.family.rootId)"
              :subtitle="subtitle(entry.tab)"
              :waiting="Boolean(familyWaitingOn(sidebar, entry.tab.family))"
              :project="rowProject(entry.tab)"
              expand-on-select
              @toggle="setExpanded(entry.tab.family.rootId, !expanded(entry.tab))"
              @expand="(open) => setFamilyOpen(entry.tab, open)"
            />
            <SidebarMemberRow v-else :process="entry.tab.process" :tab="entry.tab" :project="rowProject(entry.tab)" />
          </div>
        </template>
      </TransitionGroup>
      <!-- Snoozed projects fold to their names until they wake. -->
      <div v-if="snoozedProjects.length" class="mt-3 space-y-0.5">
        <SnoozedProjectHeader v-for="project in snoozedProjects" :key="project.id" :project="project" />
      </div>
      <template v-if="processTabs.length">
        <button
          type="button"
          class="mt-2 flex h-6 w-full items-center gap-1.5 rounded-tab px-2 text-left text-[11px] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :class="!processesOpen && processTabs.some((tab) => sidebar.processActive(tab.process)) ? 'bg-primary/10 text-foreground' : 'text-muted-foreground'"
          :aria-expanded="processesOpen"
          @click="expansion.state.value.processes = !processesOpen"
        >
          <!-- Ruled like a project's heading in All agents. -->
          <ChevronRight class="h-3 w-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none" :class="processesOpen && 'rotate-90'" />
          <span>Processes</span>
          <span class="h-px flex-1 bg-white/[0.06]" />
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
              <SidebarMemberRow :process="tab.process" :tab="tab" :project="sidebar.allAgents.value ? sidebar.projectOf(tab) : null" />
            </div>
          </TransitionGroup>
        </Transition>
      </template>
    </div>
    <slot v-if="placement === 'phone'" name="footer" />
    <!-- The project's pages and the canvas wait in the Library menu. -->
    <div v-else class="flex shrink-0 items-center gap-0.5 px-1 pt-1.5">
      <LibraryMenu v-if="!sidebar.allAgents.value" />
      <span class="flex-1" />
      <SidebarCollapseButton v-if="placement === 'docked'" />
    </div>
    <!-- The agent you point at gets a card beside it. -->
    <SidebarAgentCard v-if="placement !== 'phone'" :list="list" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, provide, ref, watch } from 'vue';
import { useHarnessLaunchesFor } from '../../Composables/useHarnessLaunch';
import { ChevronRight } from 'lucide-vue-next';
import { isFolderKey, layoutEntries, type LayoutEntry, type StripTab, type TabFolder } from '../../lib/tabStrip';
import LaunchAgentMenu from '../LaunchAgentMenu.vue';
import BotList from '../BotList.vue';
import HarnessLaunchTabs from '../HarnessLaunchTabs.vue';
import LibraryMenu from './LibraryMenu.vue';
import SidebarAgentCard from './SidebarAgentCard.vue';
import SidebarCollapseButton from './SidebarCollapseButton.vue';
import SidebarFamily from './SidebarFamily.vue';
import SidebarFolderRow from './SidebarFolderRow.vue';
import SidebarMemberRow from './SidebarMemberRow.vue';
import SidebarViewOptions from './SidebarViewOptions.vue';
import { useSidebar, type AgentTab } from './sidebarContext';
import { familyStatus, familyWaitingOn, selectedThread, sortByActivity, sortEntriesByActivity, SIDEBAR_STATUSES, type SidebarStatus } from '../../lib/sidebarTree';
import { collapseOut, expandIn, rowTops, slideFrom } from '../../lib/sidebarMotion';
import { sidebarNodesKey } from './sidebarNodes';
import { useSidebarMention } from './sidebarMention';
import { useSidebarExpansion } from '../../Composables/useSidebarExpansion';
import { useSidebarKeys } from '../../Composables/useSidebarKeys';
import { useSidebarReorder } from '../../Composables/useSidebarReorder';
import { dropSidebarRow, moveSidebarRow } from './sidebarDrop';
import { useSettledValues } from '../../Composables/useSettledValues';
import { allAgents as allAgentsState, emptyFolderOwner, groupEntriesByProject, projectShown } from '../../lib/allAgents';
import { tabSnoozed } from '../../lib/snooze';
import { projectSnoozed } from '../../lib/projectSnooze';
import SnoozedProjectHeader from '../SnoozedProjectHeader.vue';
import HostBadge from '../HostBadge.vue';
import ProjectLogo from '../ProjectLogo.vue';
import type { ProjectSummary } from '../../types';

// The sidebar's list. Subtitles show on every row or none, and which families
// are open is the user's choice, remembered on this device. Selecting an agent
// opens it.
withDefaults(defineProps<{ placement?: 'docked' | 'drawer' | 'phone' }>(), { placement: 'docked' });
const sidebar = useSidebar();
const pendingLaunches = useHarnessLaunchesFor(() => sidebar.shownProjectIds.value);
const expansion = useSidebarExpansion(() => sidebar.expansionScope.value);

// Grouped by status, a family moves once its new status has lasted a moment,
// so output blips don't bounce it between groups. Needing you moves at once.
const liveStatuses = computed(() => new Map<string, SidebarStatus>(expansion.view.value.groupByStatus
  ? sidebar.tabs.value.flatMap((tab) => tab.kind === 'agent' && !tabSnoozed(tab) ? [[tab.key, familyStatus(sidebar, tab.family, sidebar.activity(tab.family.root.session))] as const] : [])
  : []));
const status = useSettledValues(() => liveStatuses.value, {
  minimumMs: 2_000,
  immediate: (next) => next === 'attention',
  delayFor: (next) => next === 'working' ? 1_500 : 2_500
});

// In All agents, snoozed projects you haven't switched off.
const snoozedProjects = computed(() => sidebar.allAgents.value
  ? sidebar.projects.value.filter((project) => projectSnoozed(project) && projectShown(allAgentsState, project.id))
  : []);

// All agents groups by project unless you'd rather sort them yourself.
const byProject = computed(() => sidebar.allAgents.value && expansion.view.value.groupByProject);
const sorted = computed(() => expansion.view.value.sortByActivity);

// Agents and folders, grouped by project or status if you ask; your order, or
// recent activity, holds within each group. A folder sits among the agents,
// grouped by its first tab's project, or its most urgent tab's status, and
// sorted by its newest tab's activity. Folders hold their agents and any
// processes filed with them. Snoozed agents wait at the end until their next
// message, out of their folders until then.
type FolderItem = Extract<LayoutEntry, { kind: 'folder' }>;
type Item = StripTab | FolderItem;
interface Group { id: string; label: string | null; items: Item[]; sortable: boolean; project?: ProjectSummary }
const STATUS_RANK: Record<SidebarStatus, number> = { attention: 2, working: 1, idle: 0 };
function entryStatus(entry: LayoutEntry): SidebarStatus {
  const of = (tab: StripTab) => status(tab.key) ?? 'idle';
  if (entry.kind === 'tab') return of(entry.tab);
  return entry.tabs.map(of).reduce<SidebarStatus>((worst, next) => STATUS_RANK[next] > STATUS_RANK[worst] ? next : worst, 'idle');
}
const groups = computed<Group[]>(() => {
  const listed = sidebar.tabs.value.filter((tab) => !tabSnoozed(tab) && (tab.kind === 'agent' || tab.folder));
  const placed = layoutEntries(listed, sidebar.layout.value);
  const open = sorted.value ? sortEntriesByActivity(placed) : placed;
  const item = (entry: LayoutEntry): Item => entry.kind === 'tab' ? entry.tab : entry;
  const rest: Group[] = byProject.value
    ? groupEntriesByProject(open, sidebar.projects.value, sidebar.projectOf, emptyFolderOwner(sidebar.layout.value, sidebar.tabs.value, sidebar.projects.value, sidebar.projectOf)).map(({ project, items }) => ({ id: `project:${project.id}`, label: project.name, project, items: items.map(item), sortable: !sorted.value }))
    : expansion.view.value.groupByStatus
    ? SIDEBAR_STATUSES.map(({ id, label }) => ({ id, label, items: open.filter((entry) => entryStatus(entry) === id).map(item), sortable: !sorted.value }))
    : [{ id: 'open', label: null, items: open.map(item), sortable: !sorted.value }];
  const snoozed = { id: 'snoozed', label: 'Snoozed', items: sidebar.tabs.value.filter(tabSnoozed), sortable: false };
  return [...rest, snoozed].filter((group) => group.items.length);
});

type Entry =
  | { kind: 'divider'; key: string }
  | { kind: 'heading'; key: string; label: string; count: number; first: boolean }
  | { kind: 'rule'; key: string; label: string; first: boolean; project: ProjectSummary }
  | { kind: 'folder'; key: string; folder: TabFolder; tabs: StripTab[]; open: boolean; group: string; gap: string | false }
  | { kind: 'tab'; key: string; tab: StripTab; group: string; gap: string | false; member: boolean; last: boolean };
// Open, a folder lists its agents under it. Folded, it still shows any that
// need you or hold the selection, so parking an agent can't hide a question.
function folderMembers(item: FolderItem, open: boolean): StripTab[] {
  if (open) return sorted.value ? sortByActivity(item.tabs) : item.tabs;
  return item.tabs.filter((tab) => tab.kind === 'agent'
    ? Boolean(sidebar.familyAttention(tab.family)) || sidebar.familyActive(tab.family)
    : sidebar.processActive(tab.process));
}
const entries = computed<Entry[]>(() => groups.value.flatMap((group, groupIndex): Entry[] => [
  ...(group.project ? [{ kind: 'rule' as const, key: `heading:${group.id}`, label: group.project.name, first: groupIndex === 0, project: group.project }]
    : group.label ? [{ kind: 'heading' as const, key: `heading:${group.id}`, label: group.label, count: group.items.length, first: groupIndex === 0 }]
      : groupIndex > 0 ? [{ kind: 'divider' as const, key: `divider:${group.id}` }] : []),
  ...group.items.flatMap((item, index): Entry[] => {
    const gap = index > 0 && 'mt-0.5';
    if (item.kind === 'folder') {
      const open = expansion.isOpen(item.key);
      const members = folderMembers(item, open);
      return [
        { kind: 'folder', key: item.key, folder: item.folder, tabs: item.tabs, open, group: group.id, gap },
        ...members.map((tab, at) => ({ kind: 'tab' as const, key: tab.key, tab, group: item.key, gap: false as const, member: true, last: at === members.length - 1 }))
      ];
    }
    return [{ kind: 'tab', key: item.key, tab: item, group: group.id, gap, member: false, last: false }];
  })
]));
// Sorted freely, each row shows its project's logo; grouped, the rule does,
// except over rows in folders.
const rowProject = (tab: StripTab) => sidebar.allAgents.value && (!byProject.value || tab.folder) ? sidebar.projectOf(tab) : null;

// When rows change group (a status settling, or filing), or recent activity
// reorders them, measure them before the list redraws and slide them from
// there. Drag and Alt+arrow moves slide themselves from where the row was let
// go, so their order is left out here. The sort mode is part of the key, so
// switching it slides rows even when both orders happen to give the same key.
const list = ref<HTMLElement | null>(null);
watch(() => `${sorted.value}|${entries.value.flatMap((entry) => {
  if (entry.kind !== 'tab' && entry.kind !== 'folder') return [];
  return [`${entry.key}:${entry.group}`];
}).sort().join()}|${entries.value.filter((entry) => entry.kind === 'tab' && !groupSortable(entry.group)).map((entry) => entry.key).join()}`, () => {
  if (!list.value) return;
  const before = rowTops(list.value.querySelectorAll<HTMLElement>('[data-sidebar-slide]'));
  void nextTick(() => slideFrom(before));
}, { flush: 'pre' });
const processTabs = computed(() => sidebar.tabs.value.filter((tab): tab is Extract<StripTab, { kind: 'process' }> => !tab.folder && tab.kind === 'process'));
const processesOpen = computed(() => expansion.state.value.processes);

// Rows in a folder keep your order unless the list is sorted by activity.
function groupSortable(group: string): boolean {
  if (isFolderKey(group)) return !sorted.value;
  if (group === 'processes') return true;
  return groups.value.find((candidate) => candidate.id === group)?.sortable ?? false;
}

function expanded(tab: AgentTab): boolean {
  return expansion.isOpen(tab.family.rootId);
}
// Families and folders: a folder's key is its row's.
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

// What a family waits on shows under it, then a snooze reminder.
function subtitle(tab: AgentTab): string | null {
  return familyWaitingOn(sidebar, tab.family) ?? tab.family.root.session.snooze?.reminder ?? null;
}

// The first row of an open folder, which a drop just under its row goes before.
function firstIn(key: string): string | null {
  const folder = entries.value.find((entry) => entry.kind === 'folder' && entry.key === key);
  return folder?.kind === 'folder' && folder.open ? folder.tabs[0]?.key ?? null : null;
}
const groupOf = (key: string) => entries.value.find((entry) => (entry.kind === 'tab' || entry.kind === 'folder') && entry.key === key)?.group;
const { onKeydown } = useSidebarKeys({ toggle: setExpanded, move: (key, beforeKey, afterKey) => moveSidebarRow(sidebar, key, beforeKey, afterKey, groupOf(key) as string | undefined) });
const { setElement, draggingKey, dropLine, dropInto, onPointerDown, consumeClick } = useSidebarReorder(
  () => [
    ...entries.value.flatMap((entry) => entry.kind === 'tab' || entry.kind === 'folder'
      ? entry.group === 'snoozed' ? [] : [{ key: entry.key, group: entry.group, folder: entry.kind === 'folder', sortable: groupSortable(entry.group) }]
      : []),
    ...(processesOpen.value ? processTabs.value.map((tab) => ({ key: tab.key, group: 'processes', sortable: true })) : [])
  ],
  (key, drop) => dropSidebarRow(sidebar, key, drop, firstIn)
);
</script>
