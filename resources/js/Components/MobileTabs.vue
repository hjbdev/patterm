<template>
  <ResponsiveMenu v-model:open="open" mobile-only title="Open tabs">
    <template #trigger>
      <button type="button" class="relative isolate flex h-[30px] w-full min-w-0 items-center gap-2 rounded-tab bg-primary/10 px-2 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Switch tab">
        <LoaderCircle v-if="activeLaunch?.state === 'starting'" class="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        <template v-else-if="activeAgent">
          <TabWash :activity="activityFor(activeAgent)" />
          <RowStatus :activity="activityFor(activeAgent)" />
        </template>
        <template v-else-if="activeProcess">
          <TabWash :activity="processActivity(activeProcess)" />
          <RowStatus :activity="processActivity(activeProcess)" />
        </template>
        <span class="min-w-0 flex-1 truncate">{{ activeLaunch ? harnessLaunchLabel(activeLaunch) : activeProcess?.name ?? (activeAgent ? agentLabel(activeAgent) : 'Tabs') }}<HostBadge v-if="activeHost" :host="activeHost" class="ml-1.5" /></span>
        <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    </template>
    <template #header-actions>
      <div class="flex items-center gap-1">
        <!-- Phones have no sidebar, so the canvas is reached from here. -->
        <button
          v-if="canvasHome"
          type="button"
          aria-label="Canvas"
          :aria-pressed="board.open.value"
          :class="cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-tab text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            board.open.value && 'bg-primary/10 text-foreground'
          )"
          @click="openCanvas"
        >
          <Workflow class="h-3.5 w-3.5" />
        </button>
        <LaunchAgentMenu :project-id="projectId" :choose-project="Boolean(projectOf)" nested @started="open = false" />
      </div>
    </template>
    <template #mobile>
      <HarnessLaunchTabs v-for="id in launchProjectIds" :key="id" :project-id="id" vertical @select="open = false" />
      <div v-if="!families.length && !processes.length && !pendingLaunches.length" class="py-6 text-center text-sm text-muted-foreground">No open tabs</div>
      <div v-for="family in families" :key="family.rootId" class="mb-1">
        <button type="button" class="relative isolate flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="isFamilyActive(family) ? 'bg-primary/10' : ''" @click="selectFamily(family)">
          <TabWash :activity="activityFor(family.root.session)" />
          <RowStatus :activity="activityFor(family.root.session)" :count="family.options.length - 1 + ownedProcesses(family).length" :count-label="memberLabel(family.options.length - 1, ownedProcesses(family).length)" />
          <ProjectLogo v-if="projectOf?.(family.rootId)" :project="projectOf(family.rootId)!" :size="16" />
          <span class="min-w-0 flex-1 truncate">{{ agentLabel(family.root.session) }}<HostBadge v-if="family.root.session.host" :host="family.root.session.host" class="ml-1.5" /></span>
          <UnreadDot :urgency="unreadUrgency(family.root.session.processId)" />
          <span v-if="family.options.length - 1 + ownedProcesses(family).length && !countInRing(activityFor(family.root.session))" :class="cn('text-xs tabular-nums', subagentCountClass(activityFor(family.root.session)))">
            <WorkingShimmer :active="subagentPulse(activityFor(family.root.session)) === 'working'">{{ family.options.length - 1 + ownedProcesses(family).length }}</WorkingShimmer>
          </span>
        </button>
        <div v-if="isFamilyActive(family)" class="ml-5 border-l border-border pl-2">
          <button v-for="option in family.options.slice(1)" :key="option.session.id" type="button" class="relative isolate flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="option.session.id === activeAgent?.id ? 'bg-primary/10' : ''" :style="{ paddingLeft: `${12 + agentOptionIndent(option.depth)}px` }" @click="selectSession(family.rootId, option.session)">
            <TabWash :activity="activityFor(option.session)" />
            <RowStatus :activity="activityFor(option.session)" />
            <span class="min-w-0 flex-1 truncate">{{ agentLabel(option.session) }}<HostBadge v-if="option.session.host" :host="option.session.host" class="ml-1.5" /></span>
            <UnreadDot :urgency="unreadUrgency(option.session.processId)" />
          </button>
          <button v-for="process in ownedProcesses(family)" :key="process.id" type="button" class="relative isolate flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="process.ptyProcessId === activeTerminalId ? 'bg-primary/10' : ''" @click="selectProcess(process)">
            <TabWash :activity="processActivity(process)" />
            <RowStatus :activity="processActivity(process)" />
            <span class="min-w-0 flex-1 truncate">{{ process.name }}<span v-if="familyOwnerLabel(family, process.parentProcessId)" class="text-muted-foreground"> · {{ familyOwnerLabel(family, process.parentProcessId) }}</span><HostBadge v-if="process.host" :host="process.host" class="ml-1.5" /></span>
            <UnreadDot :urgency="unreadUrgency(process.id)" />
          </button>
        </div>
      </div>
      <div v-if="processes.length && families.length" class="my-2 border-t border-border" />
      <button v-for="process in processes" :key="process.id" type="button" class="relative isolate flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="process.ptyProcessId === activeTerminalId ? 'bg-primary/10' : ''" @click="selectProcess(process)">
        <TabWash :activity="processActivity(process)" />
        <RowStatus :activity="processActivity(process)" />
        <ProjectLogo v-if="projectOf?.(process.id)" :project="projectOf(process.id)!" :size="16" />
        <span class="min-w-0 flex-1 truncate">{{ process.name }}<HostBadge v-if="process.host" :host="process.host" class="ml-1.5" /></span>
        <UnreadDot :urgency="unreadUrgency(process.id)" />
      </button>
    </template>
    <template #mobile-footer>
      <SidebarPages labelled class="mt-1 justify-around border-t border-white/5 pt-2" @click="open = false" />
    </template>
  </ResponsiveMenu>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useBoardIsHome, useBoardRoute } from '../Composables/useBoard';
import { useHarnessLaunchesFor, useSelectedHarnessLaunch } from '../Composables/useHarnessLaunch';
import ProjectLogo from './ProjectLogo.vue';
import { harnessLaunchLabel } from '../lib/harnessLaunches';
import { ChevronDown, LoaderCircle, Workflow } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { agentLabel, agentOptionIndent, familyOwnerLabel, type AgentTabFamily } from '../lib/agentTabs';
import { ownedProcessesForSessions, type LiveProcessRecord } from '../lib/processTabs';
import { activityLookup, countInRing, memberLabel, processActivity, subagentCountClass, subagentPulse } from '../lib/rowActivity';
import WorkingShimmer from './WorkingShimmer.vue';
import type { ProcessRecord, ProjectSummary, SessionRecord } from '../types';
import LaunchAgentMenu from './LaunchAgentMenu.vue';
import HarnessLaunchTabs from './HarnessLaunchTabs.vue';
import HostBadge from './HostBadge.vue';
import ResponsiveMenu from './ResponsiveMenu.vue';
import RowStatus from './RowStatus.vue';
import SidebarPages from './Sidebar/SidebarPages.vue';
import TabWash from './TabWash.vue';
import UnreadDot from './UnreadDot.vue';
import { unreadUrgency } from '../Composables/useNotifications';

const props = defineProps<{
  projectId: string;
  families: AgentTabFamily[];
  // Every family, listed or not, so a hidden one you're in still names the menu.
  allFamilies?: AgentTabFamily[] | undefined;
  processes: LiveProcessRecord[];
  allProcesses: ProcessRecord[];
  activeTerminalId: string | null;
  activeSessionId: string | null;
  // While showing all agents: each row's project, and the projects shown.
  projectOf?: ((id: string) => ProjectSummary | null) | undefined;
  shownProjectIds?: readonly string[] | undefined;
}>();

const emit = defineEmits<{
  select: [rootId: string, session: SessionRecord];
  selectProcess: [process: ProcessRecord];
}>();

const open = ref(false);
const board = useBoardRoute();
const canvasHome = useBoardIsHome();

function openCanvas(): void {
  open.value = false;
  board.show();
}
const activeLaunch = useSelectedHarnessLaunch();
const launchProjectIds = computed(() => props.shownProjectIds ?? [props.projectId]);
const pendingLaunches = useHarnessLaunchesFor(() => launchProjectIds.value);
const activeAgent = computed(() => (props.allFamilies ?? props.families).flatMap((family) => family.options).find((option) =>
  option.session.id === props.activeSessionId || Boolean(props.activeTerminalId && option.session.ptyProcessId === props.activeTerminalId)
)?.session ?? null);
const activeProcess = computed(() => props.allProcesses.find((process) => process.ptyProcessId && process.ptyProcessId === props.activeTerminalId) ?? null);
// Paired-host records name their host beside them, as tabs and sidebar rows do.
const activeHost = computed(() => activeLaunch.value ? activeLaunch.value.input.host : activeProcess.value?.host ?? activeAgent.value?.host);

// Each agent's activity with its subagents'.
const activityFor = computed(() => activityLookup(props.allFamilies ?? props.families));

function ownedProcesses(family: AgentTabFamily): LiveProcessRecord[] {
  return ownedProcessesForSessions(family.options.map((option) => option.session), props.allProcesses);
}

function isFamilyActive(family: AgentTabFamily): boolean {
  return family.options.some((option) => option.session.id === activeAgent.value?.id)
    || ownedProcesses(family).some((process) => process.ptyProcessId === props.activeTerminalId);
}

function selectFamily(family: AgentTabFamily): void {
  emit('select', family.rootId, family.root.session);
  if (family.options.length === 1 && !ownedProcesses(family).length) open.value = false;
}

function selectSession(rootId: string, session: SessionRecord): void {
  emit('select', rootId, session);
  open.value = false;
}

function selectProcess(process: ProcessRecord): void {
  emit('selectProcess', process);
  open.value = false;
}

</script>
