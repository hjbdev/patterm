<template>
  <!-- The collapsed sidebar: one button per tab. Hovering one shows what it's doing. -->
  <div class="flex h-full min-h-0 w-12 flex-col items-center">
    <div class="flex shrink-0 flex-col items-center gap-0.5 py-0.5">
      <BoardButton side="right" />
      <LaunchAgentMenu :project-id="sidebar.projectId.value" />
    </div>
    <div ref="list" class="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden py-1 [scrollbar-width:none]">
      <HarnessLaunchTabs :project-id="sidebar.projectId.value" vertical compact />
      <template v-for="(tab, index) in tabs" :key="tab.key">
        <div v-if="index > 0 && tab.pinned !== tabs[index - 1]!.pinned" class="my-1 w-5 border-t border-white/10" />
        <div
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
                <RowStatus :activity="activityOf(tab)" :count="tab.kind === 'agent' ? sidebar.memberCount(tab.family) : 0" />
                <UnreadDot class="absolute right-1 top-1" :urgency="tabUnread(tab)" />
                <span v-if="tab.kind === 'agent' && sidebar.memberCount(tab.family) && !countInRing(activityOf(tab))" :class="cn('absolute -bottom-0.5 right-0 rounded-sm bg-[#080808] px-0.5 text-[9px] font-medium leading-3 tabular-nums', subagentCountClass(activityOf(tab)))">
                  <WorkingShimmer :active="subagentPulse(activityOf(tab)) === 'working'">{{ sidebar.memberCount(tab.family) }}</WorkingShimmer>
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
import { PanelLeftOpen } from 'lucide-vue-next';
import { agentLabel } from '../../lib/agentTabs';
import { hostLabel } from '../../lib/hosts';
import { cn } from '@/lib/utils';
import { countInRing, describeActivity, processActivity, subagentCountClass, subagentPulse, type RowActivity } from '../../lib/rowActivity';
import WorkingShimmer from '../WorkingShimmer.vue';
import type { StripTab } from '../../lib/tabStrip';
import type { ProcessRecord, SessionRecord } from '../../types';
import { unreadUrgency, type NotificationUrgency } from '../../Composables/useNotifications';
import AgentFamilyMenu from '../AgentFamilyMenu.vue';
import LaunchAgentMenu from '../LaunchAgentMenu.vue';
import HarnessLaunchTabs from '../HarnessLaunchTabs.vue';
import RowStatus from '../RowStatus.vue';
import TabWash from '../TabWash.vue';
import UnreadDot from '../UnreadDot.vue';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import BoardButton from './BoardButton.vue';
import SidebarItemMenu from './SidebarItemMenu.vue';
import SidebarNavLinks from './SidebarNavLinks.vue';
import { closeSession, copyId, openRename, openTimer } from './sidebarActions';
import { useSidebar } from './sidebarContext';
import { useHoverPopover } from '../../Composables/useHoverPopover';
import { useSidebarReorder } from '../../Composables/useSidebarReorder';
import { useSidebarMention } from './sidebarMention';

const emit = defineEmits<{ expand: [] }>();
const sidebar = useSidebar();
const tabs = computed(() => sidebar.tabs.value);

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
  if (session.exitedAt) return;
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

const { setElement, element, draggingKey, dropLine, onPointerDown, consumeClick } = useSidebarReorder(
  () => tabs.value.map((tab) => ({ key: tab.key, group: tab.pinned ? 'pinned' : 'open' })),
  sidebar.moveTab
);
</script>
