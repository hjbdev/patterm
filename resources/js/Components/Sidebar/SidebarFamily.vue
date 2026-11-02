<template>
  <div>
    <div class="group/row relative">
      <SidebarItemMenu :session="root" :tab="tab">
        <button
          type="button"
          data-sidebar-row
          :data-row-key="tab.key"
          :data-family="tab.family.rootId"
          :data-node="foldable ? tab.family.rootId : undefined"
          :data-expandable="foldable ? 'true' : undefined"
          :data-expanded="foldable ? String(expanded) : undefined"
          :data-patterm-tab-id="tab.key"
          :aria-current="active ? 'page' : undefined"
          :class="cn(
            'relative isolate flex w-full min-w-0 select-none items-start gap-2 rounded-tab px-2 text-left text-[13px] transition-[padding,color,background-color,box-shadow] duration-200 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none',
            twoLines ? 'py-1.5' : 'py-1',
            active ? 'bg-primary/10 text-foreground' : 'text-foreground/85',
            mentionPreview === tab.family.rootId && 'mention-glow'
          )"
          @click="select"
        >
          <TabWash :activity="activity" />
          <!-- One icon column: the harness icon, or the status while it matters. -->
          <span class="flex h-5 w-4 shrink-0 items-center justify-center">
            <RowStatus :activity="activity" :count="memberCount" :count-label="memberLabel" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex min-w-0 items-center gap-1.5 leading-5" :style="{ paddingRight: `${reserve}px` }">
              <ProjectLogo v-if="project" :project="project" :size="14" :title="project.name" />
              <span class="truncate" :class="sidebar.familyActive(tab.family) && 'font-medium'">{{ label }}</span>
              <BotOwnerPill v-if="ownerBot" :bot="ownerBot" />
              <StatusLabelPill v-if="root.statusLabel" :label="root.statusLabel" />
              <HostBadge v-if="root.host" :host="root.host" />
            </span>
            <Transition :css="false" @enter="expandIn" @leave="collapseOut">
              <span v-if="twoLines" class="flex items-center gap-2 text-xs leading-4">
                <span class="min-w-0 flex-1 truncate" :class="waiting ? 'text-foreground/75' : 'text-muted-foreground'">{{ subtitle }}</span>
                <span v-if="timer" class="flex shrink-0 items-center gap-1 tabular-nums text-muted-foreground" :title="timer.title"><TimerIcon class="h-3 w-3" />{{ timer.remaining }}</span>
              </span>
            </Transition>
          </span>
        </button>
      </SidebarItemMenu>
      <!-- Over the first line: the member toggle, then the unread dot, which hover swaps for a close button. -->
      <div class="absolute right-1.5 flex h-5 items-center gap-0.5 transition-[top] duration-200 motion-reduce:transition-none" :class="twoLines ? 'top-1.5' : 'top-1'">
        <!-- Without a second line, the timer joins the first. -->
        <span v-if="timer && !twoLines" class="mr-0.5 flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground" :title="timer.title"><TimerIcon class="h-3 w-3" />{{ timer.remaining }}</span>
        <button
          v-if="foldable"
          type="button"
          tabindex="-1"
          :class="cn('flex h-5 items-center rounded px-1 transition-colors hover:bg-white/10 hover:text-foreground', subagentCountClass(activity))"
          :aria-expanded="expanded"
          :aria-label="`${expanded ? 'Hide' : 'Show'} ${memberLabel}`"
          :title="memberLabel"
          @pointerdown.stop
          @click.stop="emit('toggle')"
        >
          <MemberCount :count="memberCount" :open="expanded" :shimmer="subagentPulse(activity) === 'working'" :bare="countInRing(activity)" />
        </button>
        <span class="relative flex h-5 w-5 items-center justify-center">
          <UnreadDot class="transition-opacity group-hover/row:opacity-0" :urgency="familyUrgency(sidebar, tab.family, expanded)" />
          <CloseRowButton class="pointer-events-none opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 absolute inset-0" :label="label" @close="closeSession(root)" />
        </span>
      </div>
    </div>
    <!-- The tree below the root, at any depth: each agent's subagents, then
         its processes. Members grow and shrink into place. -->
    <Transition :css="false" @enter="expandIn" @leave="collapseOut">
      <div v-if="expanded && foldable" class="sidebar-tree">
        <TransitionGroup :css="false" @enter="expandIn" @leave="collapseOut">
          <SidebarNode v-for="child in tab.family.root.children" :key="child.session.id" :node="child" :root-id="tab.family.rootId" :parent-key="tab.key" :parent-host="root.host" :depth="1" :owned="owned" />
          <SidebarMemberRow v-for="process in rootProcesses" :key="process.id" :process="process" :root-id="tab.family.rootId" :parent-key="tab.key" :parent-host="root.host" />
        </TransitionGroup>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import HostBadge from '../HostBadge.vue';
import BotOwnerPill from '../BotOwnerPill.vue';
import StatusLabelPill from '../StatusLabelPill.vue';
import { ownerBotOf } from '../../Composables/useBots';
import ProjectLogo from '../ProjectLogo.vue';
import type { ProjectSummary } from '../../types';
import { computed } from 'vue';
import { Timer as TimerIcon } from 'lucide-vue-next';
import MemberCount from '../MemberCount.vue';
import { cn } from '@/lib/utils';
import { agentLabel, familyOwnerLabel } from '../../lib/agentTabs';
import { countInRing, subagentCountClass, subagentPulse } from '../../lib/rowActivity';
import RowStatus from '../RowStatus.vue';
import TabWash from '../TabWash.vue';
import UnreadDot from '../UnreadDot.vue';
import CloseRowButton from '../CloseRowButton.vue';
import { closeSession } from './sidebarActions';
import SidebarItemMenu from './SidebarItemMenu.vue';
import SidebarMemberRow from './SidebarMemberRow.vue';
import SidebarNode from './SidebarNode.vue';
import { useSidebar, type AgentTab } from './sidebarContext';
import { familyTimerSummary, familyUrgency } from '../../lib/sidebarTree';
import { collapseOut, expandIn } from '../../lib/sidebarMotion';
import { mentionPreview } from '../../lib/integratedComposer';
import { processesByOwner } from '../../lib/sidebarTree';

// An agent family: the root agent's row, with its subagents and processes
// below when expanded.
const props = withDefaults(defineProps<{
  tab: AgentTab;
  expanded: boolean;
  subtitle?: string | null | undefined;
  waiting?: boolean | undefined;
  // Shown while listing all agents, where rows from several projects mix.
  project?: ProjectSummary | null;
  // Off, the row keeps its member count but its subagents and processes
  // don't list below it; the agent's header lists them instead.
  membersShown?: boolean;
}>(), { subtitle: null, waiting: false, project: null, membersShown: true });
// `expand` asks to open or close the family after the agent was clicked:
// clicking opens it, and clicking it again while it's selected closes it.
const emit = defineEmits<{ toggle: []; expand: [open: boolean] }>();

const sidebar = useSidebar();
const root = computed(() => props.tab.family.root.session);
const activity = computed(() => sidebar.activity(root.value));
const label = computed(() => agentLabel(root.value));
const ownerBot = computed(() => ownerBotOf(root.value));
// A closed family holding the selection is highlighted, so you can see where you are.
const active = computed(() => sidebar.sessionActive(root.value) || (!props.expanded && sidebar.familyActive(props.tab.family)));
const memberCount = computed(() => sidebar.memberCount(props.tab.family));
const foldable = computed(() => props.membersShown && memberCount.value > 0);
const owned = computed(() => processesByOwner(sidebar.ownedProcesses(props.tab.family)));
const rootProcesses = computed(() => owned.value.get(root.value.processId ?? '') ?? []);
const memberLabel = computed(() => {
  const agents = props.tab.family.options.length - 1;
  const processes = sidebar.ownedProcesses(props.tab.family).length;
  return [agents && `${agents} ${agents === 1 ? 'subagent' : 'subagents'}`, processes && `${processes} ${processes === 1 ? 'process' : 'processes'}`].filter(Boolean).join(', ');
});

const timer = computed(() => familyTimerSummary(sidebar.familyTimers(props.tab.family), sidebar.now.value, ownerName));
function ownerName(processId: string | null): string | null {
  return familyOwnerLabel(props.tab.family, processId)
    ?? sidebar.ownedProcesses(props.tab.family).find((process) => process.id === processId)?.name
    ?? null;
}
const twoLines = computed(() => Boolean(props.subtitle));
// The first line keeps clear of the controls laid over it.
const reserve = computed(() => 22 + (foldable.value ? 34 : 0) + (timer.value && !twoLines.value ? 20 + 7 * timer.value.remaining.length : 0));

function select(): void {
  const wasSelected = sidebar.sessionActive(root.value);
  sidebar.selectSession(props.tab.family.rootId, root.value);
  if (!foldable.value) return;
  if (!props.expanded) emit('expand', true);
  else if (wasSelected) emit('expand', false);
}
</script>
