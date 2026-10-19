<template>
  <div ref="strip" :class="cn('flex min-w-max items-center', props.class)">
    <TransitionGroup name="strip-tab" tag="div" class="flex min-w-max items-center gap-1">
      <div
        v-for="(tab, index) in tabs"
        :key="tab.key"
        :ref="(element) => setTabElement(tab.key, element)"
        :class="cn('strip-tab group/tab relative shrink-0 rounded-tab', compact(tab) ? 'w-8' : 'w-56', (startsProject(index) || startsSnoozed(index)) && 'ml-2 before:absolute before:-left-[5px] before:top-1 before:h-[18px] before:w-px before:bg-white/10')"
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
                <template v-else-if="tab.pinned">
                  <RowStatus :activity="activityFor(tab.family.root.session)" :count="familyMenuCount(tab.family)" :count-label="familyMemberLabel(tab.family)" />
                  <UnreadDot class="absolute right-1 top-1" :urgency="unreadUrgency(tab.family.root.session.processId)" />
                </template>
                <template v-else>
                  <span class="flex min-w-0 flex-1 items-center gap-1.5">
                    <RowStatus :activity="activityFor(tab.family.root.session)" :count="familyMenuCount(tab.family)" :count-label="familyMemberLabel(tab.family)" />
                    <ProjectLogo v-if="tabProject(tab)" :project="tabProject(tab)!" :size="14" :title="tabProject(tab)!.name" />
                    <span class="truncate">{{ agentLabel(tab.family.root.session) }}</span>
                    <HostBadge v-if="tab.family.root.session.host" :host="tab.family.root.session.host" />
                    <UnreadDot :urgency="unreadUrgency(tab.family.root.session.processId)" />
                  </span>
                  <!-- The timer and count sit close together, tucked against the close button. -->
                  <span v-if="familyTimers(tab.family).length || familyMenuCount(tab.family) > 0" class="flex shrink-0 items-center gap-1">
                    <span v-if="familyTimers(tab.family).length" class="flex shrink-0 items-center text-muted-foreground" :aria-label="`${familyTimers(tab.family).length} ${familyTimers(tab.family).length === 1 ? 'timer' : 'timers'} set`">
                      <!-- 13px with a 1.25px stroke matches the count's height; lifted half a pixel because its crown sits it low. -->
                      <TimerIcon class="h-[13px] w-[13px] -translate-y-[0.5px]" :stroke-width="2.3" />
                    </span>
                    <span v-if="familyMenuCount(tab.family) > 0 && !countInRing(activityFor(tab.family.root.session))" :class="cn('flex shrink-0', subagentCountClass(activityFor(tab.family.root.session)))" :aria-label="`${familyMenuCount(tab.family)} subagents and processes`">
                      <MemberCount :count="familyMenuCount(tab.family)" :shimmer="subagentPulse(activityFor(tab.family.root.session)) === 'working'" />
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
              <ContextMenuItem @select="setPinned(tab, !tab.pinned)">
                <PinOff v-if="tab.pinned" class="h-4 w-4" />
                <Pin v-else class="h-4 w-4" />
                <span>{{ tab.pinned ? 'Unpin tab' : 'Pin tab' }}</span>
              </ContextMenuItem>
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
          :pinned="tab.pinned"
          :active="tab.process.ptyProcessId === activeTerminalId"
          @select="selectProcess(tab.process)"
          @update:pinned="setPinned(tab, $event)"
        />
        <!-- Pinned and snoozed tabs have no room for a close button; their menus still close them. -->
        <CloseRowButton
          v-if="!compact(tab)"
          :label="tab.kind === 'agent' ? agentLabel(tab.family.root.session) : tab.process.name"
          :class="cn('absolute right-1 top-[3px] opacity-0 transition-opacity group-hover/tab:opacity-100 focus-visible:opacity-100', tabActive(tab) && 'opacity-100')"
          @close="tab.kind === 'agent' ? closeAgent(tab.family.root.session) : confirmClose(tab.process.id, tab.process.name, 'process')"
        />
      </div>
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
import SnoozedProjectHeader from './SnoozedProjectHeader.vue';
import { computed, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue';
import { Clock, Copy, Moon, Pencil, Pin, PinOff, Sun, Timer as TimerIcon, X } from 'lucide-vue-next';
import { canSnooze, openSnooze, unsnooze } from '../Composables/useSnooze';
import { moveAwakeTab, setTabPinned, tabSnoozed } from '../lib/snooze';
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
import { activityLookup, countInRing, describeActivity, memberLabel, subagentCountClass, subagentPulse } from '../lib/rowActivity';
import MemberCount from './MemberCount.vue';
import type { StripTab, TabLayout } from '../lib/tabStrip';
import { timersForProcesses } from '../lib/timers';
import type { ProcessRecord, ProjectSummary, SessionRecord, TimerRecord } from '../types';
import ProjectLogo from './ProjectLogo.vue';
import { animateTabMoves, useTabStripDrag } from '../Composables/useTabStripDrag';
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
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu';
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
// Pinned and snoozed tabs show only their status.
function compact(tab: StripTab): boolean {
  return tab.pinned || tabSnoozed(tab);
}

// A rule sets snoozed tabs apart from the rest.
function startsSnoozed(index: number): boolean {
  const tab = props.tabs[index], previous = props.tabs[index - 1];
  return Boolean(tab && previous && tabSnoozed(tab) && !tabSnoozed(previous));
}

function startsProject(index: number): boolean {
  const tab = props.tabs[index], previous = props.tabs[index - 1];
  return Boolean(props.groupedByProject && tab && previous && !compact(tab) && !compact(previous) && tabProject(tab)?.id !== tabProject(previous)?.id);
}

const emit = defineEmits<{
  select: [session: SessionRecord];
  selectProcess: [process: ProcessRecord];
  'update:selectedByRoot': [selected: SelectedAgentByRoot];
  'update:layout': [layout: TabLayout];
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
  tabs: () => props.tabs.map((tab) => ({ key: tab.key, group: tabSnoozed(tab) ? 'snoozed' : tab.pinned ? 'pinned' : 'tabs' })),
  element: (key) => tabElements.get(key),
  onDragStart: () => hover.close(),
  onDrop: (key, index) => {
    const layout = moveAwakeTab(props.tabs, key, index);
    if (layout) emit('update:layout', layout);
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

// Pinned and snoozed tabs hide their label, so their menu always opens to show it.
function hasPopover(tab: Extract<StripTab, { kind: 'agent' }>): boolean {
  return compact(tab)
    || familyMenuCount(tab.family) > 0
    || Boolean(tab.family.root.session.summary)
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
watch(() => props.tabs.map((tab) => `${tab.key}:${tab.pinned}:${tabSnoozed(tab)}`).join(' '), cancelTabDrag);

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

function setPinned(tab: StripTab, pinned: boolean): void {
  const layout = setTabPinned(props.tabs, tab.key, pinned);
  void animateTabMoves([...tabElements.values()], () => emit('update:layout', layout));
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
