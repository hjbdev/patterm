<template>
  <ResponsiveMenu v-model:open="open" mobile-only title="Open tabs">
    <template #trigger>
      <button type="button" class="relative isolate flex h-[30px] w-full min-w-0 items-center gap-2 rounded-tab bg-primary/10 px-2 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Switch tab">
        <template v-if="activeAgent">
          <TabWash :activity="activityFor(activeAgent)" />
          <TabIcon :activity="activityFor(activeAgent)"><AgentIcon :harness="activeAgent.harness" class="h-3.5 w-3.5" /></TabIcon>
        </template>
        <template v-else-if="activeProcess">
          <TabWash :activity="processActivity(activeProcess)" />
          <TabIcon :activity="processActivity(activeProcess)"><TerminalSquare class="h-3.5 w-3.5" /></TabIcon>
        </template>
        <span class="min-w-0 flex-1 truncate">{{ activeProcess?.name ?? (activeAgent ? agentLabel(activeAgent) : 'Tabs') }}</span>
        <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    </template>
    <template #header-actions>
      <LaunchAgentMenu :project-id="projectId" nested @launched="onLaunched" />
    </template>
    <template #mobile>
      <div v-if="!families.length && !processes.length" class="py-6 text-center text-sm text-muted-foreground">No open tabs</div>
      <div v-for="family in families" :key="family.rootId" class="mb-1">
        <button type="button" class="relative isolate flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="isFamilyActive(family) ? 'bg-primary/10' : ''" @click="selectFamily(family)">
          <TabWash :activity="activityFor(family.root.session)" />
          <TabIcon :activity="activityFor(family.root.session)"><AgentIcon :harness="family.root.session.harness" class="h-4 w-4" /></TabIcon>
          <span class="min-w-0 flex-1 truncate">{{ agentLabel(family.root.session) }}</span>
          <UnreadDot :urgency="unreadUrgency(family.root.session.processId)" />
          <span v-if="family.options.length - 1 + ownedProcesses(family).length" :class="cn('text-xs tabular-nums', subagentCountClass(activityFor(family.root.session)))">{{ family.options.length - 1 + ownedProcesses(family).length }}</span>
        </button>
        <div v-if="isFamilyActive(family)" class="ml-5 border-l border-border pl-2">
          <button v-for="option in family.options.slice(1)" :key="option.session.id" type="button" class="relative isolate flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="option.session.id === activeAgent?.id ? 'bg-primary/10' : ''" :style="{ paddingLeft: `${12 + agentOptionIndent(option.depth)}px` }" @click="selectSession(family.rootId, option.session)">
            <TabWash :activity="activityFor(option.session)" />
            <TabIcon :activity="activityFor(option.session)"><AgentIcon :harness="option.session.harness" class="h-4 w-4" /></TabIcon>
            <span class="min-w-0 flex-1 truncate">{{ agentLabel(option.session) }}</span>
            <UnreadDot :urgency="unreadUrgency(option.session.processId)" />
          </button>
          <button v-for="process in ownedProcesses(family)" :key="process.id" type="button" class="relative isolate flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="process.ptyProcessId === activeTerminalId ? 'bg-primary/10' : ''" @click="selectProcess(process)">
            <TabWash :activity="processActivity(process)" />
            <TabIcon :activity="processActivity(process)"><TerminalSquare class="h-4 w-4" /></TabIcon>
            <span class="min-w-0 flex-1 truncate">{{ process.name }}<span v-if="familyOwnerLabel(family, process.parentProcessId)" class="text-muted-foreground"> · {{ familyOwnerLabel(family, process.parentProcessId) }}</span></span>
            <UnreadDot :urgency="unreadUrgency(process.id)" />
          </button>
        </div>
      </div>
      <div v-if="processes.length && families.length" class="my-2 border-t border-border" />
      <button v-for="process in processes" :key="process.id" type="button" class="relative isolate flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="process.ptyProcessId === activeTerminalId ? 'bg-primary/10' : ''" @click="selectProcess(process)">
        <TabWash :activity="processActivity(process)" />
        <TabIcon :activity="processActivity(process)"><TerminalSquare class="h-4 w-4" /></TabIcon>
        <span class="min-w-0 flex-1 truncate">{{ process.name }}</span>
        <UnreadDot :urgency="unreadUrgency(process.id)" />
      </button>
    </template>
  </ResponsiveMenu>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronDown, TerminalSquare } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { agentLabel, agentOptionIndent, familyOwnerLabel, type AgentTabFamily } from '../lib/agentTabs';
import { ownedProcessesForSessions, type LiveProcessRecord } from '../lib/processTabs';
import { activityLookup, processActivity, subagentCountClass } from '../lib/rowActivity';
import type { ProcessRecord, SessionRecord } from '../types';
import AgentIcon from './AgentIcon.vue';
import LaunchAgentMenu from './LaunchAgentMenu.vue';
import ResponsiveMenu from './ResponsiveMenu.vue';
import TabIcon from './TabIcon.vue';
import TabWash from './TabWash.vue';
import UnreadDot from './UnreadDot.vue';
import { unreadUrgency } from '../Composables/useNotifications';

const props = defineProps<{
  projectId: string;
  families: AgentTabFamily[];
  processes: LiveProcessRecord[];
  allProcesses: ProcessRecord[];
  activeTerminalId: string | null;
  activeSessionId: string | null;
}>();

const emit = defineEmits<{
  select: [rootId: string, session: SessionRecord];
  selectProcess: [process: ProcessRecord];
  launched: [sessionId: string, terminalId: string | null];
}>();

const open = ref(false);
const activeAgent = computed(() => props.families.flatMap((family) => family.options).find((option) =>
  option.session.id === props.activeSessionId || Boolean(props.activeTerminalId && option.session.ptyProcessId === props.activeTerminalId)
)?.session ?? null);
const activeProcess = computed(() => props.allProcesses.find((process) => process.ptyProcessId && process.ptyProcessId === props.activeTerminalId) ?? null);

// Each agent's activity with its subagents'.
const activityFor = computed(() => activityLookup(props.families));

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

function onLaunched(sessionId: string, terminalId: string | null): void {
  open.value = false;
  emit('launched', sessionId, terminalId);
}
</script>
