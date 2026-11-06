<template>
  <!-- The collapsed sidebar: one button per tab. Hovering one shows what it's doing. -->
  <div class="flex h-full min-h-0 w-12 flex-col items-center">
    <div class="flex shrink-0 flex-col items-center gap-0.5 py-0.5">
      <BoardButton side="right" />
      <LaunchAgentMenu :project-id="sidebar.projectId.value" :choose-project="sidebar.allAgents.value" />
    </div>
    <div ref="list" class="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden py-1 [scrollbar-width:none]">
      <HarnessLaunchTabs v-for="projectId in sidebar.shownProjectIds.value" :key="projectId" :project-id="projectId" vertical compact />
      <template v-for="(item, index) in items" :key="item.key">
        <!-- A rule sets each folder, and an open folder's tabs, apart. -->
        <div v-if="ruleBefore(index)" class="my-1 w-5 border-t border-white/10" />
        <div
          v-if="item.kind === 'folder'"
          :ref="(element) => setElement(item.key, element)"
          class="relative"
          :class="draggingKey === item.key && 'z-10'"
          @pointerdown="onPointerDown($event, item.key)"
          @click.capture="consumeClick($event, item.key)"
        >
          <span v-if="dropLine?.key === item.key" class="pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary/70" :class="dropLine.edge === 'before' ? '-top-[3px]' : '-bottom-[3px]'" aria-hidden="true" />
          <ContextMenu>
            <ContextMenuTrigger as-child>
              <button
                type="button"
                :aria-label="`${item.folder.name}, folder, ${item.tabs.length} ${item.tabs.length === 1 ? 'agent' : 'agents'}`"
                :aria-expanded="item.open"
                :title="item.folder.name"
                class="relative flex h-8 w-8 items-center justify-center rounded-tab text-muted-foreground transition-[color,background-color,box-shadow] hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                :class="[!item.open && item.tabs.some(tabActive) && 'bg-primary/10', dropInto === item.key && 'bg-primary/15 ring-1 ring-inset ring-primary/60', draggingKey === item.key && 'bg-[hsl(0_0%_14%)] shadow-lg']"
                @click="expansion.setOpen(item.key, !item.open)"
              >
                <FolderOpen v-if="item.open" class="h-4 w-4" :stroke-width="1.75" />
                <Folder v-else class="h-4 w-4" :stroke-width="1.75" />
                <UnreadDot v-if="!item.open" class="absolute right-1 top-1" :urgency="folderUnread(item.tabs)" />
                <span v-if="item.tabs.length && !item.open" class="absolute -bottom-0.5 right-0 rounded-sm bg-[#080808] px-0.5 text-[9px] font-medium leading-3 tabular-nums">{{ item.tabs.length }}</span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent class="w-52">
              <ContextMenuItem @select="openRenameFolder(item.folder)"><Pencil class="h-4 w-4" /><span>Rename</span></ContextMenuItem>
              <ContextMenuItem @select="openNewFolder()"><FolderPlus class="h-4 w-4" /><span>New folder…</span></ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem @select="sidebar.deleteFolder(item.folder.id)"><FolderX class="h-4 w-4" /><span>Delete folder</span></ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
        <template v-else>
        <!-- Showing all agents, a project's logo heads each run of its tabs. -->
        <ProjectLogo v-if="projectStarts(index)" :project="sidebar.projectOf(item.tab)!" :size="12" :title="sidebar.projectOf(item.tab)!.name" class="mt-1 opacity-70" />
        <div
          v-for="tab in [item.tab]"
          :key="tab.key"
          :ref="(element) => setElement(tab.key, element)"
          class="relative"
          :class="draggingKey === tab.key && 'z-10'"
          @pointerdown="onPointerDown($event, tab.key)"
          @click.capture="consumeClick($event, tab.key)"
          @mouseenter="hover.open(tab.key)"
          @mouseleave="hover.scheduleClose"
          @focusin="hover.open(tab.key)"
          @focusout="hover.scheduleClose"
        >
          <span v-if="dropLine?.key === tab.key" class="pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary/70" :class="dropLine.edge === 'before' ? '-top-[3px]' : '-bottom-[3px]'" aria-hidden="true" />
          <Popover :open="openKey === tab.key && !draggingKey" @update:open="hover.update(tab.key, $event)">
            <PopoverAnchor as="template" :reference="anchor(tab.key)" />
            <SidebarItemMenu :session="tab.kind === 'agent' ? tab.family.root.session : undefined" :process="tab.kind === 'process' ? tab.process : undefined" :tab="tab">
              <button
                type="button"
                :data-patterm-tab-id="tab.key"
                :aria-label="`${tabLabel(tab)}, ${describeActivity(activityOf(tab))}`"
                class="relative isolate flex h-8 w-8 items-center justify-center gap-0.5 rounded-tab transition-[color,background-color,box-shadow] hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                :class="[tabActive(tab) && 'bg-primary/10', draggingKey === tab.key && 'bg-[hsl(0_0%_14%)] shadow-lg', mention?.tabKey === tab.key && 'mention-glow']"
                @click="select(tab)"
              >
                <TabWash :activity="activityOf(tab)" />
                <RowStatus :activity="activityOf(tab)" :count="tab.kind === 'agent' ? sidebar.memberCount(tab.family) : 0" :count-label="tab.kind === 'agent' ? memberLabel(tab.family.options.length - 1, sidebar.ownedProcesses(tab.family).length) : undefined" />
                <UnreadDot class="absolute right-1 top-1" :urgency="tabUnread(tab)" />
                <span v-if="tab.kind === 'agent' && sidebar.memberCount(tab.family) && !countInRing(activityOf(tab))" :class="cn('absolute -bottom-0.5 right-0 rounded-sm bg-[#080808] px-0.5 text-[9px] font-medium leading-3 tabular-nums', subagentCountClass(activityOf(tab)))">
                  {{ sidebar.memberCount(tab.family) }}
                </span>
                <span v-if="tabActive(tab)" class="absolute -left-2 top-1.5 h-5 w-0.5 rounded-full bg-foreground" aria-hidden="true" />
              </button>
            </SidebarItemMenu>
            <PopoverContent
              side="right"
              align="start"
              class="max-h-80 w-auto min-w-56 overflow-y-auto p-1 shadow-lg"
              @mouseenter="hover.cancelClose"
              @mouseleave="hover.scheduleClose"
              @focusin="hover.cancelClose"
              @focusout="hover.scheduleClose"
              @open-auto-focus.prevent
            >
              <AgentFamilyMenu
                v-if="tab.kind === 'agent'"
                :family="tab.family"
                :processes="sidebar.ownedProcesses(tab.family)"
                :timers="sidebar.familyTimers(tab.family)"
                :now="sidebar.now.value"
                show-label
                :activity="sidebar.activity"
                :session-active="sidebar.sessionActive"
                :process-active="sidebar.processActive"
                @select-session="selectMember(tab.family.rootId, $event)"
                @select-process="selectProcess"
                @rename="openRename({ session: $event })"
                @set-timer="openTimer"
                @copy-id="copyId($event.processId)"
                @close="closeSession"
                @menu="hover.holdForMenu(tab.key, $event)"
              />
              <p v-else class="max-w-80 truncate px-2 py-1 text-[13px] font-medium">{{ tab.process.name }}</p>
            </PopoverContent>
          </Popover>
        </div>
        </template>
      </template>
    </div>
    <div class="flex shrink-0 flex-col items-center gap-1 border-t border-white/5 pb-1 pt-2">
      <SidebarNavLinks />
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" data-sidebar-drawer-toggle aria-label="Expand sidebar" class="mt-1 flex h-8 w-8 items-center justify-center rounded-tab text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" @click="emit('expand')">
            <PanelLeftOpen class="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" class="bg-popover text-popover-foreground">Expand sidebar <kbd class="ml-1 rounded border border-border/70 px-1 text-[10px]">Ctrl ⇧ B</kbd></TooltipContent>
      </Tooltip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Folder, FolderOpen, FolderPlus, FolderX, PanelLeftOpen, Pencil } from 'lucide-vue-next';
import { agentLabel } from '../../lib/agentTabs';
import { hostLabel } from '../../lib/hosts';
import { cn } from '@/lib/utils';
import { countInRing, describeActivity, memberLabel, processActivity, subagentCountClass, type RowActivity } from '../../lib/rowActivity';
import { folderKey, layoutEntries, type StripTab, type TabFolder } from '../../lib/tabStrip';
import { groupEntriesByProject } from '../../lib/allAgents';
import { tabSnoozed } from '../../lib/snooze';
import { useSidebarExpansion } from '../../Composables/useSidebarExpansion';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu';
import { dropSidebarRow } from './sidebarDrop';
import type { ProcessRecord, SessionRecord } from '../../types';
import { unreadUrgency, type NotificationUrgency } from '../../Composables/useNotifications';
import AgentFamilyMenu from '../AgentFamilyMenu.vue';
import LaunchAgentMenu from '../LaunchAgentMenu.vue';
import HarnessLaunchTabs from '../HarnessLaunchTabs.vue';
import RowStatus from '../RowStatus.vue';
import TabWash from '../TabWash.vue';
import UnreadDot from '../UnreadDot.vue';
import ProjectLogo from '../ProjectLogo.vue';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import BoardButton from './BoardButton.vue';
import SidebarItemMenu from './SidebarItemMenu.vue';
import SidebarNavLinks from './SidebarNavLinks.vue';
import { closeSession, copyId, openNewFolder, openRename, openRenameFolder, openTimer } from './sidebarActions';
import { useSidebar } from './sidebarContext';
import { useHoverPopover } from '../../Composables/useHoverPopover';
import { useSidebarReorder } from '../../Composables/useSidebarReorder';
import { useSidebarMention } from './sidebarMention';

const emit = defineEmits<{ expand: [] }>();
const sidebar = useSidebar();
const tabs = computed(() => sidebar.tabs.value);
const expansion = useSidebarExpansion(() => sidebar.expansionScope.value);

// The tabs as the top bar has them, with folders: each open folder's tabs
// after it. Snoozed tabs wait at the end, out of their folders.
type RailItem =
  | { kind: 'tab'; key: string; tab: StripTab; member: string | null }
  | { kind: 'folder'; key: string; folder: TabFolder; tabs: StripTab[]; open: boolean };
const items = computed<RailItem[]>(() => {
  const entries = layoutEntries(tabs.value.filter((tab) => !tabSnoozed(tab)), sidebar.layout.value);
  const grouped = sidebar.allAgents.value && expansion.view.value.groupByProject
    ? groupEntriesByProject(entries, sidebar.projects.value, sidebar.projectOf).flatMap((group) => group.items)
    : entries;
  return [
    ...grouped.flatMap((entry): RailItem[] => {
      if (entry.kind === 'tab') return [{ kind: 'tab', key: entry.key, tab: entry.tab, member: null }];
      const open = expansion.isOpen(entry.key);
      return [
        { kind: 'folder', key: entry.key, folder: entry.folder, tabs: entry.tabs, open },
        ...(open ? entry.tabs.map((tab) => ({ kind: 'tab' as const, key: tab.key, tab, member: entry.folder.id })) : [])
      ];
    }),
    ...tabs.value.filter(tabSnoozed).map((tab) => ({ kind: 'tab' as const, key: tab.key, tab, member: null }))
  ];
});
const inFolder = (item: RailItem | undefined) => Boolean(item && (item.kind === 'folder' || item.member));
function ruleBefore(index: number): boolean {
  const item = items.value[index], previous = items.value[index - 1];
  return Boolean(item && previous && (item.kind === 'folder' || (inFolder(previous) && !inFolder(item))));
}

// The rail has no rows for subagents, so a highlighted subagent's family glows.
const list = ref<HTMLElement>();
const mention = useSidebarMention(
  () => tabs.value,
  () => list.value,
  ({ tabKey }) => list.value?.querySelector<HTMLElement>(`[data-patterm-tab-id="${CSS.escape(tabKey)}"]`)
);

// The hovered tab's popover, or the family of a highlighted subagent, which
// has no icon of its own here. Narrow layouts hide the rail, so nothing opens there.
const hover = useHoverPopover(() => Boolean(draggingKey.value));
const openKey = computed(() => {
  const current = mention.value;
  const tab = current && tabs.value.find((candidate) => candidate.key === current.tabKey);
  if (tab?.kind === 'agent' && tab.family.rootId !== current!.sessionId && element(tab.key)?.getClientRects().length) return tab.key;
  return hover.hoverKey.value;
});

function projectStarts(index: number): boolean {
  const item = items.value[index];
  if (!sidebar.allAgents.value || item?.kind !== 'tab' || item.member) return false;
  const previous = items.value[index - 1];
  return Boolean(sidebar.projectOf(item.tab)) && (previous?.kind !== 'tab' || Boolean(previous.member) || sidebar.projectOf(previous.tab)?.id !== sidebar.projectOf(item.tab)?.id);
}
// A folded folder's most urgent unread.
function folderUnread(tabs: readonly StripTab[]): NotificationUrgency | null {
  const urgencies = tabs.map(tabUnread);
  return urgencies.includes('high') ? 'high' : urgencies.find(Boolean) ?? null;
}
function tabLabel(tab: StripTab): string {
  return tab.kind === 'agent' ? hostLabel(agentLabel(tab.family.root.session), tab.family.root.session.host) : hostLabel(tab.process.name, tab.process.host);
}
function activityOf(tab: StripTab): RowActivity {
  return tab.kind === 'agent' ? sidebar.activity(tab.family.root.session) : processActivity(tab.process);
}
function tabActive(tab: StripTab): boolean {
  return tab.kind === 'agent' ? sidebar.familyActive(tab.family) : sidebar.processActive(tab.process);
}
function tabUnread(tab: StripTab): NotificationUrgency | null {
  if (tab.kind === 'process') return unreadUrgency(tab.process.id);
  const ids = [...tab.family.options.map((option) => option.session.processId), ...sidebar.ownedProcesses(tab.family).map((process) => process.id)];
  const urgencies = ids.map((id) => unreadUrgency(id));
  return urgencies.includes('high') ? 'high' : urgencies.find(Boolean) ?? null;
}
function anchor(key: string): HTMLElement {
  return element(key) ?? document.body;
}
function selectMember(rootId: string, session: SessionRecord): void {
  sidebar.selectSession(rootId, session);
  hover.close();
}
function selectProcess(process: ProcessRecord): void {
  sidebar.selectProcess(process);
  hover.close();
}
function select(tab: StripTab): void {
  if (tab.kind === 'agent') sidebar.selectSession(tab.family.rootId, tab.family.root.session);
  else sidebar.selectProcess(tab.process);
}

// Snoozed tabs keep their places.
const { setElement, element, draggingKey, dropLine, dropInto, onPointerDown, consumeClick } = useSidebarReorder(
  () => items.value.flatMap((item) => item.kind === 'tab' && tabSnoozed(item.tab) ? [] : [{
    key: item.key,
    group: item.kind === 'tab' && item.member ? folderKey(item.member) : 'open',
    folder: item.kind === 'folder',
    sortable: true
  }]),
  (key, drop) => dropSidebarRow(sidebar, key, drop, (folder) => {
    const item = items.value.find((candidate) => candidate.key === folder);
    return item?.kind === 'folder' && item.open ? item.tabs[0]?.key ?? null : null;
  })
);
</script>
