<template>
  <div ref="strip" data-no-drag :class="cn('flex min-w-max items-center', props.class)">
    <TransitionGroup name="strip-tab" tag="div" class="flex min-w-max items-center gap-1">
      <template v-for="(item, index) in items" :key="item.key">
      <!-- A folder's chip, and while it's open, its tabs after it, underlined together. -->
      <div
        v-if="item.kind === 'folder'"
        :key="item.key"
        :ref="(element) => setTabElement(item.key, element)"
        :class="cn('strip-tab group/tab relative shrink-0 rounded-tab', startsGroup(index) && SEPARATOR, item.open && item.tabs.length && FOLDER_LINE)"
        :data-dragging="draggingKey === item.key ? 'true' : undefined"
        @pointerdown="onTabPointerDown($event, item.key)"
        @click.capture="consumeTabClick($event, item.key)"
      >
        <ContextMenu>
          <ContextMenuTrigger as-child>
            <button
              type="button"
              :aria-expanded="item.open"
              :aria-label="`${item.folder.name}, folder, ${item.tabs.length} ${item.tabs.length === 1 ? 'tab' : 'tabs'}`"
              :class="cn(
                'relative flex h-[26px] touch-none select-none items-center gap-1.5 rounded-tab px-2 text-[13px] text-foreground/85 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                !item.open && item.tabs.some(tabActive) && 'bg-primary/10 text-foreground'
              )"
              @click="expansion.setOpen(item.key, !item.open)"
            >
              <FolderOpen v-if="item.open" class="h-[15px] w-[15px] shrink-0 text-muted-foreground" :stroke-width="1.75" aria-hidden="true" />
              <Folder v-else class="h-[15px] w-[15px] shrink-0 text-muted-foreground" :stroke-width="1.75" aria-hidden="true" />
              <span class="max-w-40 truncate">{{ item.folder.name }}</span>
              <FolderDots v-if="!item.open && item.tabs.length" :tabs="item.tabs" />
              <span v-else-if="item.tabs.length" class="flex text-muted-foreground"><MemberCount :count="item.tabs.length" open /></span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent class="w-52">
            <ContextMenuItem @select="openRenameFolder(item.folder)">
              <Pencil class="h-4 w-4" />
              <span>Rename</span>
            </ContextMenuItem>
            <ContextMenuItem @select="openNewFolder()">
              <FolderPlus class="h-4 w-4" />
              <span>New folder…</span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem @select="sidebar.deleteFolder(item.folder.id)">
              <FolderX class="h-4 w-4" />
              <span>Delete folder</span>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
      <template v-else>
      <div
        v-for="tab in [item.tab]"
        :key="tab.key"
        :ref="(element) => setTabElement(tab.key, element)"
        :class="cn('strip-tab group/tab relative shrink-0 rounded-tab', compact(tab) ? 'w-8' : 'w-56', startsGroup(index) && SEPARATOR, item.member && FOLDER_LINE)"
        :data-dragging="draggingKey === tab.key ? 'true' : undefined"
        @pointerdown="onTabPointerDown($event, tab.key); if (tab.kind === 'agent') prefetchTab(tab.family.root.session)"
        @click.capture="consumeTabClick($event, tab.key)"
        @mouseenter="hoverTab(tab)"
        @mouseleave="hover.scheduleClose"
        @focusin="hoverTab(tab)"
        @focusout="hover.scheduleClose"
      >
        <Popover v-if="tab.kind === 'agent'" :open="openRootId === tab.family.rootId && hasPopover(tab)" @update:open="hover.update(tab.family.rootId, $event)">
          <PopoverAnchor as="template" :reference="popoverReference(tab.key)" />
          <ContextMenu>
            <ContextMenuTrigger as-child>
              <button
                type="button"
                :data-patterm-tab-id="tab.key"
                :aria-label="compact(tab) ? `${hostLabel(agentLabel(tab.family.root.session), tab.family.root.session.host)}, ${tabSnoozed(tab) ? 'Snoozed' : describeActivity(activityFor(tab.family.root.session))}` : undefined"
                :class="cn(
                  'mention-target relative isolate flex h-[26px] w-full touch-none select-none items-center gap-2 overflow-hidden rounded-tab bg-transparent text-[13px] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  compact(tab) ? 'justify-center' : 'justify-between pl-2 pr-6',
                  isFamilyActive(tab.family) && 'bg-primary/10',
                  mentionPreview === tab.family.rootId && 'mention-glow'
                )"
                @click="selectSession(tab.family.rootId, tab.family.root.session)"
              >
                <TabWash v-if="!tabSnoozed(tab)" :activity="activityFor(tab.family.root.session)" />
                <!-- Snoozed tabs sit at the end of the strip, quiet until the agent's next message. -->
                <template v-if="tabSnoozed(tab)">
                  <Moon class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <UnreadDot class="absolute right-1 top-1" :urgency="unreadUrgency(tab.family.root.session.processId)" />
                </template>
                <template v-else>
                  <span class="flex min-w-0 flex-1 items-center gap-1.5">
                    <RowStatus :activity="activityFor(tab.family.root.session)" :count="familyMenuCount(tab.family)" :count-label="familyMemberLabel(tab.family)" />
                    <ProjectLogo v-if="tabProject(tab)" :project="tabProject(tab)!" :size="14" :title="tabProject(tab)!.name" />
                    <span class="truncate">{{ agentLabel(tab.family.root.session) }}</span>
                    <!-- The tab's menu names the label in full, so the dot's tooltip waits while it's open. -->
                    <StatusLabelPill v-if="tab.family.root.session.statusLabel" :label="tab.family.root.session.statusLabel" dot :no-tooltip="openRootId === tab.family.rootId" />
                    <BotOwnerPill v-if="ownerBotOf(tab.family.root.session)" :bot="ownerBotOf(tab.family.root.session)!" />
                    <HostBadge v-if="tab.family.root.session.host" :host="tab.family.root.session.host" />
                    <UnreadDot :urgency="unreadUrgency(tab.family.root.session.processId)" />
                  </span>
                  <!-- The timer and count sit close together, tucked against the close button. -->
                  <span v-if="tab.family.root.session.goalStatus || familyTimers(tab.family).length || familyMenuCount(tab.family) > 0" class="flex shrink-0 items-center gap-1">
                    <!-- An open native goal: the agent keeps working until it is met. -->
                    <span v-if="tab.family.root.session.goalStatus" class="flex shrink-0 items-center" :class="tab.family.root.session.goalStatus === 'active' ? 'text-muted-foreground' : 'text-warning/80'" :aria-label="goalStatusLabel(tab.family.root.session.goalStatus as IntegratedGoalStatus)" data-component="tab-goal">
                      <Target class="h-[13px] w-[13px]" :stroke-width="2.3" aria-hidden="true" />
                    </span>
                    <span v-if="familyTimers(tab.family).length" class="flex shrink-0 items-center text-muted-foreground" :aria-label="`${familyTimers(tab.family).length} ${familyTimers(tab.family).length === 1 ? 'timer' : 'timers'} set`">
                      <!-- 13px with a 1.25px stroke matches the count's height; lifted half a pixel because its crown sits it low. -->
                      <TimerIcon class="h-[13px] w-[13px] -translate-y-[0.5px]" :stroke-width="2.3" />
                    </span>
                    <span v-if="familyMenuCount(tab.family) > 0 && !countInRing(activityFor(tab.family.root.session))" :class="cn('flex shrink-0', subagentCountClass(activityFor(tab.family.root.session)))" :aria-label="`${familyMenuCount(tab.family)} subagents and processes`">
                      <MemberCount :count="familyMenuCount(tab.family)" />
                    </span>
                  </span>
                </template>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent class="w-52">
              <ContextMenuItem @select="openRenameAgent(tab.family.root.session)">
                <Pencil class="h-4 w-4" />
                <span>Rename</span>
              </ContextMenuItem>
              <StatusLabelMenu :session="tab.family.root.session" />
              <FolderMenu :tab="tab" />
              <ContextMenuItem v-if="tabSnoozed(tab)" @select="unsnooze(tab.family.root.session.processId!)">
                <Sun class="h-4 w-4" />
                <span>Wake</span>
              </ContextMenuItem>
              <ContextMenuItem v-else :disabled="!canSnooze(tab.family.root.session)" @select="openSnooze(tab.family.root.session)">
                <Moon class="h-4 w-4" />
                <span>Snooze…</span>
              </ContextMenuItem>
              <ContextMenuItem :disabled="!tab.family.root.session.processId" @select="openSetTimer(tab.family.root.session)">
                <Clock class="h-4 w-4" />
                <span>Set timer</span>
              </ContextMenuItem>
              <ContextMenuItem :disabled="!tab.family.root.session.processId" @select="copyProcessId(tab.family.root.session)">
                <Copy class="h-4 w-4" />
                <span>Copy process ID</span>
              </ContextMenuItem>
              <ContextMenuItem class="text-destructive focus:text-destructive" @select="closeAgent(tab.family.root.session)">
                <X class="h-4 w-4" />
                <span>Close</span>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>

          <PopoverContent
            align="start"
            class="max-h-80 w-auto min-w-56 overflow-y-auto p-1 shadow-lg"
            @mouseenter="hover.cancelClose"
            @mouseleave="hover.scheduleClose"
            @focusin="hover.cancelClose"
            @focusout="hover.scheduleClose"
            @open-auto-focus.prevent
          >
            <AgentFamilyMenu
              :family="tab.family"
              :processes="ownedProcesses(tab.family)"
              :timers="familyTimers(tab.family)"
              :now="now"
              :show-label="compact(tab)"
              :activity="activityFor"
              :session-active="(session) => matchesAgentTabSelection(session, activeTerminalId ?? null, activeSessionId ?? null)"
              :process-active="(process) => process.ptyProcessId === activeTerminalId"
              @select-session="selectSession(tab.family.rootId, $event)"
              @select-process="selectProcess"
              @rename="openRenameAgent"
              @set-timer="openSetTimer"
              @copy-id="copyProcessId"
              @close="closeAgent"
              @menu="hover.holdForMenu(tab.family.rootId, $event)"
            />
          </PopoverContent>
        </Popover>
        <ProcessTab
          v-else
          :process="tab.process"
          :project="tabProject(tab)"
          :tab="tab"
          :active="tab.process.ptyProcessId === activeTerminalId"
          @select="selectProcess(tab.process)"
        />
        <!-- Snoozed tabs have no room for a close button; their menus still close them. -->
        <CloseRowButton
          v-if="!compact(tab)"
          :label="tab.kind === 'agent' ? agentLabel(tab.family.root.session) : tab.process.name"
          :class="cn('absolute right-1 top-[3px] opacity-0 transition-opacity group-hover/tab:opacity-100 focus-visible:opacity-100', tabActive(tab) && 'opacity-100')"
          @close="tab.kind === 'agent' ? closeAgent(tab.family.root.session) : confirmClose(tab.process.id, tab.process.name, 'process')"
        />
      </div>
      </template>
      </template>
    </TransitionGroup>
    <div v-if="snoozedProjects?.length" class="ml-2 flex items-center gap-1 before:mr-1 before:h-[18px] before:w-px before:bg-white/10">
      <SnoozedProjectHeader v-for="project in snoozedProjects" :key="project.id" :project="project" chip />
    </div>

    <Dialog v-model:open="renameOpen">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename agent</DialogTitle>
          <DialogDescription>Set the label shown in agent tabs.</DialogDescription>
        </DialogHeader>
        <form class="flex flex-col gap-3" @submit.prevent="submitRename">
          <Input v-model="renameName" placeholder="Agent name" />
          <p v-if="renameError" class="text-sm text-destructive">{{ renameError }}</p>
          <DialogFooter>
            <Button type="submit" :disabled="renameBusy || renameName.trim().length === 0">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <SetTimerDialog v-model:open="timerOpen" :target-process-id="timerTargetProcessId" :target-name="timerTargetName" />
  </div>
</template>

<script setup lang="ts">
import HostBadge from './HostBadge.vue';
import BotOwnerPill from './BotOwnerPill.vue';
import StatusLabelMenu from './StatusLabelMenu.vue';
import StatusLabelPill from './StatusLabelPill.vue';
import { ownerBotOf } from '../Composables/useBots';
import SnoozedProjectHeader from './SnoozedProjectHeader.vue';
import { computed, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue';
import { Clock, Copy, Folder, FolderOpen, FolderPlus, FolderX, Moon, Pencil, Sun, Target, Timer as TimerIcon, X } from 'lucide-vue-next';
import { goalStatusLabel, type IntegratedGoalStatus } from '../lib/integratedConversation';
import { canSnooze, openSnooze, unsnooze } from '../Composables/useSnooze';
import { tabSnoozed } from '../lib/snooze';
import { confirmClose } from '../Composables/useCloseConfirm';
import { cn } from '@/lib/utils';
import {
  agentLabel,
  matchesAgentTabSelection,
  selectAgentInFamilies,
  type AgentTabFamily,
  type SelectedAgentByRoot
} from '../lib/agentTabs';
import { mentionPreview } from '../lib/integratedComposer';
import { ownedProcessesForSessions } from '../lib/processTabs';
import { activityLookup, countInRing, describeActivity, memberLabel, subagentCountClass } from '../lib/rowActivity';
import MemberCount from './MemberCount.vue';
import { folderKey, isFolderKey, layoutEntries, type StripTab, type TabFolder } from '../lib/tabStrip';
import { useSidebar } from './Sidebar/sidebarContext';
import { openNewFolder, openRenameFolder } from './Sidebar/sidebarActions';
import { useSidebarExpansion } from '../Composables/useSidebarExpansion';
import FolderDots from './FolderDots.vue';
import FolderMenu from './FolderMenu.vue';
import { timersForProcesses } from '../lib/timers';
import type { ProcessRecord, ProjectSummary, SessionRecord, TimerRecord } from '../types';
import ProjectLogo from './ProjectLogo.vue';
import { useTabStripDrag } from '../Composables/useTabStripDrag';
import { useHoverPopover } from '../Composables/useHoverPopover';
import CloseRowButton from './CloseRowButton.vue';
import AgentFamilyMenu from './AgentFamilyMenu.vue';
import ProcessTab from './ProcessTab.vue';
import SetTimerDialog from './SetTimerDialog.vue';
import RowStatus from './RowStatus.vue';
import TabWash from './TabWash.vue';
import UnreadDot from './UnreadDot.vue';
import { unreadUrgency } from '../Composables/useNotifications';
import { hostLabel } from '../lib/hosts';
import { Button } from './ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover';
import { prefetchTab } from '../lib/prefetch';

const props = withDefaults(
  defineProps<{
    tabs: StripTab[];
    sessions: SessionRecord[];
    processes?: ProcessRecord[] | undefined;
    timers?: TimerRecord[] | undefined;
    activeTerminalId?: string | null | undefined;
    activeSessionId?: string | null | undefined;
    selectedByRoot?: SelectedAgentByRoot | undefined;
    // While showing all agents: each tab's project, and whether tabs sit in
    // project groups, which a divider separates.
    projectOf?: ((id: string) => ProjectSummary | null) | undefined;
    groupedByProject?: boolean | undefined;
    // While showing all agents: snoozed projects, folded to their names.
    snoozedProjects?: ProjectSummary[] | undefined;
    class?: string | undefined;
  }>(),
  {
    activeTerminalId: null,
    activeSessionId: null,
    processes: () => [],
    timers: () => [],
    selectedByRoot: () => ({}),
    class: ''
  }
);

function tabProject(tab: StripTab): ProjectSummary | null {
  return props.projectOf?.(tab.kind === 'agent' ? tab.family.rootId : tab.process.id) ?? null;
}
// Snoozed tabs show only their status.
function compact(tab: StripTab): boolean {
  return tabSnoozed(tab);
}

// The strip's tabs and folders, each open folder's tabs after its chip. In
// your order, folders sit where you put them; grouped by project, they follow
// the projects' tabs. Snoozed tabs wait at the end, out of their folders.
const sidebar = useSidebar();
const expansion = useSidebarExpansion(() => sidebar.expansionScope.value);
type StripItem =
  | { kind: 'tab'; key: string; tab: StripTab; member: string | null }
  | { kind: 'folder'; key: string; folder: TabFolder; tabs: StripTab[]; open: boolean };
const items = computed<StripItem[]>(() => [
  ...layoutEntries(props.tabs.filter((tab) => !tabSnoozed(tab)), sidebar.layout.value, !props.groupedByProject).flatMap((entry): StripItem[] => {
    if (entry.kind === 'tab') return [{ kind: 'tab', key: entry.key, tab: entry.tab, member: null }];
    const open = expansion.isOpen(entry.key);
    return [
      { kind: 'folder', key: entry.key, folder: entry.folder, tabs: entry.tabs, open },
      ...(open ? entry.tabs.map((tab) => ({ kind: 'tab' as const, key: tab.key, tab, member: entry.folder.id })) : [])
    ];
  }),
  ...props.tabs.filter(tabSnoozed).map((tab) => ({ kind: 'tab' as const, key: tab.key, tab, member: null }))
]);

const SEPARATOR = 'ml-2 before:absolute before:-left-[5px] before:top-1 before:h-[18px] before:w-px before:bg-white/10';
const FOLDER_LINE = 'after:pointer-events-none after:absolute after:inset-x-1 after:-bottom-[3px] after:h-0.5 after:rounded-full after:bg-white/15';

// A rule sets snoozed tabs apart from the rest, and grouped by project, each
// project's tabs and the folders after them.
function startsGroup(index: number): boolean {
  const item = items.value[index], previous = items.value[index - 1];
  if (!item || !previous) return false;
  const loose = (candidate: StripItem): candidate is Extract<StripItem, { kind: 'tab' }> => candidate.kind === 'tab' && !candidate.member && !tabSnoozed(candidate.tab);
  if (item.kind === 'tab' && tabSnoozed(item.tab)) return previous.kind !== 'tab' || !tabSnoozed(previous.tab);
  if (!props.groupedByProject || !loose(previous)) return false;
  if (item.kind === 'folder') return true;
  return loose(item) && tabProject(item.tab)?.id !== tabProject(previous.tab)?.id;
}

const emit = defineEmits<{
  select: [session: SessionRecord];
  selectProcess: [process: ProcessRecord];
  'update:selectedByRoot': [selected: SelectedAgentByRoot];
}>();

const renameOpen = ref(false);
const renameSession = ref<SessionRecord | null>(null);
const renameName = ref('');
const renameError = ref('');
const renameBusy = ref(false);
const timerOpen = ref(false);
const timerTargetProcessId = ref<string | null>(null);
const timerTargetName = ref<string | null>(null);
const tabElements = new Map<string, HTMLElement>();

const {
  draggingKey,
  onPointerDown: onTabPointerDown,
  consumeClick: consumeTabClick,
  cancel: cancelTabDrag
} = useTabStripDrag({
  // An open folder's tabs move with its chip, and among themselves.
  tabs: () => items.value.map((item) => item.kind === 'folder'
    ? { key: item.key, group: 'tabs', attached: item.open ? item.tabs.map((tab) => tab.key) : [] }
    : { key: item.key, group: tabSnoozed(item.tab) ? 'snoozed' : item.member ? folderKey(item.member) : 'tabs' }),
  element: (key) => tabElements.get(key),
  onDragStart: () => hover.close(),
  // Snoozed tabs keep their places.
  onDrop: (key, beforeKey, afterKey) => {
    if (isFolderKey(key)) return sidebar.moveFolder(key.slice('folder:'.length), beforeKey, afterKey);
    const item = items.value.find((candidate) => candidate.key === key);
    if (item?.kind === 'tab' && !tabSnoozed(item.tab)) sidebar.placeTab(key, item.member, beforeKey, afterKey);
  }
});
const hover = useHoverPopover(() => Boolean(draggingKey.value));

const families = computed(() => props.tabs.flatMap((tab) => tab.kind === 'agent' ? [tab.family] : []));
const ownedProcessesByRoot = computed(() => new Map(
  families.value.map((family) => [
    family.rootId,
    ownedProcessesForSessions(family.options.map((option) => option.session), props.processes)
  ])
));

function ownedProcesses(family: AgentTabFamily): ProcessRecord[] {
  return ownedProcessesByRoot.value.get(family.rootId) ?? [];
}

// Each agent's activity with its subagents', for its tab or menu row.
const activityFor = computed(() => activityLookup(families.value));

// An agent highlighted in a composer's @ menu glows. Its tab scrolls into
// view, and the strip scrolls back when the highlight ends. A subagent's row
// is in its family's menu, which stays open while the row is highlighted.
// Narrow layouts hide the strip, so nothing opens or scrolls there.
const strip = ref<HTMLElement>();
const mentionRootId = ref<string | null>(null);
const openRootId = computed(() => mentionRootId.value ?? hover.hoverKey.value);
let scrollBeforeMention: number | null = null;
watch([mentionPreview, families], ([sessionId]) => {
  const family = sessionId ? families.value.find((candidate) => candidate.options.some((option) => option.session.id === sessionId)) : undefined;
  const tab = family && props.tabs.find((candidate) => candidate.kind === 'agent' && candidate.family.rootId === family.rootId);
  const element = tab ? tabElements.get(tab.key) : undefined;
  const scroller = strip.value?.parentElement;
  if (!family || !element?.getClientRects().length) {
    mentionRootId.value = null;
    if (scroller && scrollBeforeMention !== null) scroller.scrollLeft = scrollBeforeMention;
    scrollBeforeMention = null;
    return;
  }
  mentionRootId.value = family.rootId === sessionId ? null : family.rootId;
  scrollBeforeMention ??= scroller?.scrollLeft ?? null;
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});

const timersByRoot = computed(() => new Map(
  families.value.map((family) => {
    const processIds = new Set<string>(ownedProcesses(family).map((process) => process.id));
    for (const option of family.options) if (option.session.processId) processIds.add(option.session.processId);
    return [family.rootId, timersForProcesses(props.timers, processIds)];
  })
));

function familyTimers(family: AgentTabFamily): TimerRecord[] {
  return timersByRoot.value.get(family.rootId) ?? [];
}

// Ticks only while a tab menu is open so timer countdowns stay current.
const now = ref(Date.now());
let clockInterval: ReturnType<typeof setInterval> | null = null;
watch(openRootId, (rootId) => {
  if (clockInterval) clearInterval(clockInterval);
  clockInterval = null;
  if (!rootId) return;
  now.value = Date.now();
  clockInterval = setInterval(() => { now.value = Date.now(); }, 1_000);
});

function familyMenuCount(family: AgentTabFamily): number {
  return family.options.length - 1 + ownedProcesses(family).length;
}

function familyMemberLabel(family: AgentTabFamily): string {
  return memberLabel(family.options.length - 1, ownedProcesses(family).length);
}

// Snoozed tabs hide their label, so their menu always opens to show it.
function hasPopover(tab: Extract<StripTab, { kind: 'agent' }>): boolean {
  return compact(tab)
    || familyMenuCount(tab.family) > 0
    || Boolean(tab.family.root.session.summary)
    || Boolean(tab.family.root.session.statusLabel)
    || familyTimers(tab.family).length > 0;
}

function tabActive(tab: StripTab): boolean {
  return tab.kind === 'agent' ? isFamilyActive(tab.family) : tab.process.ptyProcessId === props.activeTerminalId;
}

function isFamilyActive(family: AgentTabFamily): boolean {
  return family.options.some((option) => matchesAgentTabSelection(option.session, props.activeTerminalId, props.activeSessionId))
    || ownedProcesses(family).some((process) => Boolean(props.activeTerminalId && process.ptyProcessId === props.activeTerminalId));
}

onBeforeUnmount(() => {
  if (clockInterval) clearInterval(clockInterval);
});

watch(
  () => [props.activeTerminalId, props.activeSessionId] as const,
  ([terminalId, sessionId]) => {
    const session = props.sessions.find((candidate) => matchesAgentTabSelection(candidate, terminalId, sessionId));
    if (session) {
      updateSelectedForSession(session, false);
    }
  },
  { immediate: true }
);

// A tab opening, closing, or changing group mid-drag invalidates the slots.
watch(() => items.value.map((item) => item.kind === 'folder' ? `${item.key}:${item.open}` : `${item.key}:${item.member}:${tabSnoozed(item.tab)}`).join(' '), cancelTabDrag);

function setTabElement(key: string, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLElement) {
    tabElements.set(key, element);
    return;
  }
  tabElements.delete(key);
}

function popoverReference(key: string): HTMLElement {
  return tabElements.get(key) ?? document.body;
}

function selectSession(rootId: string, session: SessionRecord): void {
  if (session.exitedAt) return;
  emit('update:selectedByRoot', { ...props.selectedByRoot, [rootId]: session.id });
  emit('select', session);
  hover.close();
}

function selectProcess(process: ProcessRecord): void {
  if (!process.ptyProcessId || process.status !== 'running') return;
  emit('selectProcess', process);
  hover.close();
}

function hoverTab(tab: StripTab): void {
  if (tab.kind !== 'agent') return;
  hover.open(tab.family.rootId);
  prefetchTab(tab.family.root.session);
}

function updateSelectedForSession(session: SessionRecord, emitSelect: boolean): void {
  for (const family of families.value) {
    if (!family.options.some((option) => option.session.id === session.id)) {
      continue;
    }
    const nextSelected = selectAgentInFamilies(props.sessions, props.selectedByRoot, session.id);
    if (nextSelected[family.rootId] !== props.selectedByRoot[family.rootId]) {
      emit('update:selectedByRoot', nextSelected);
    }
    if (emitSelect) {
      emit('select', session);
    }
    return;
  }
}

function openRenameAgent(session: SessionRecord): void {
  renameSession.value = session;
  renameName.value = agentLabel(session);
  renameError.value = '';
  renameOpen.value = true;
}

async function submitRename(): Promise<void> {
  const session = renameSession.value;
  const name = renameName.value.trim();
  if (!session || renameBusy.value || !name) return;
  renameBusy.value = true;
  renameError.value = '';
  try {
    await window.patterm?.call?.('rename_process', {
      process_id: agentLifecycleId(session),
      name
    });
    renameOpen.value = false;
    renameSession.value = null;
  } catch (caught) {
    renameError.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    renameBusy.value = false;
  }
}

function openSetTimer(session: SessionRecord): void {
  timerTargetProcessId.value = agentLifecycleId(session);
  timerTargetName.value = agentLabel(session);
  timerOpen.value = true;
}

function copyProcessId(session: SessionRecord): void {
  const processId = session.processId;
  if (!processId) return;
  void navigator.clipboard.writeText(processId).catch((error: unknown) => {
    console.warn('Failed to copy process ID', error);
  });
}

function closeAgent(session: SessionRecord): void {
  confirmClose(agentLifecycleId(session), agentLabel(session), 'agent');
}

function agentLifecycleId(session: SessionRecord): string {
  return session.processId ?? session.id;
}
</script>

<style scoped>
/* No transform transition here: drags and reorders animate transforms themselves. */
.strip-tab {
  transition:
    width 180ms cubic-bezier(0.2, 0, 0, 1),
    opacity 180ms ease;
}

.strip-tab[data-dragging='true'] {
  z-index: 20;
  background-color: hsl(0 0% 12%);
  box-shadow: 0 6px 16px -4px rgb(0 0 0 / 0.75);
}

.strip-tab-enter-from,
.strip-tab-leave-to {
  opacity: 0;
  transform: translateY(-0.125rem) scale(0.98);
  width: 0;
}

.strip-tab-enter-active,
.strip-tab-leave-active {
  overflow: hidden;
  transition:
    width 180ms cubic-bezier(0.2, 0, 0, 1),
    opacity 180ms ease,
    transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

/* Fades the mention glow in and out alongside the background. */
.mention-target {
  transition-property: color, background-color, box-shadow;
}

@media (prefers-reduced-motion: reduce) {
  .mention-target,
  .strip-tab,
  .strip-tab-enter-active,
  .strip-tab-leave-active {
    transition: none;
  }
}
</style>
