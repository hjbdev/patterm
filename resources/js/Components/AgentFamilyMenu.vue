<template>
  <!-- An agent family's hover menu: its summary, subagents, processes, and timers. -->
  <p v-if="showLabel" class="max-w-80 truncate px-2 pb-1 pt-1.5 text-[13px] font-medium">{{ hostLabel(agentLabel(family.root.session), family.root.session.host) }}</p>
  <div v-if="family.root.session.statusLabel" class="flex px-2 pb-1 pt-1.5">
    <StatusLabelPill :label="family.root.session.statusLabel" />
  </div>
  <AutoSummaryPreview v-if="family.root.session.summary" :summary="family.root.session.summary" />
  <ContextMenu
    v-for="option in family.options.slice(1)"
    :key="option.session.id"
    @update:open="emit('menu', $event)"
  >
    <ContextMenuTrigger as-child>
      <button
        type="button"
        :class="cn(
          'mention-target relative isolate flex h-[26px] w-full items-center gap-1.5 overflow-hidden rounded-tab px-2 text-left text-[13px] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          sessionActive(option.session) && 'bg-primary/10',
          mentionPreview === option.session.id && 'mention-glow'
        )"
        :style="{ paddingLeft: `${8 + agentOptionIndent(option.depth)}px` }"
        @click.stop="emit('selectSession', option.session)"
      >
        <TabWash :activity="activity(option.session)" />
        <RowStatus :activity="activity(option.session)" />
        <span class="min-w-0 flex-1 truncate">{{ agentLabel(option.session) }}</span>
        <StatusLabelPill v-if="option.session.statusLabel" :label="option.session.statusLabel" />
        <HostBadge v-if="option.session.host" :host="option.session.host" />
        <UnreadDot :urgency="unreadUrgency(option.session.processId)" />
      </button>
    </ContextMenuTrigger>
    <ContextMenuContent class="w-52">
      <ContextMenuItem @select="emit('rename', option.session)">
        <Pencil class="h-4 w-4" />
        <span>Rename</span>
      </ContextMenuItem>
      <StatusLabelMenu :session="option.session" />
      <ContextMenuItem :disabled="!option.session.processId" @select="emit('setTimer', option.session)">
        <Clock class="h-4 w-4" />
        <span>Set timer</span>
      </ContextMenuItem>
      <ContextMenuItem :disabled="!option.session.processId" @select="emit('copyId', option.session)">
        <Copy class="h-4 w-4" />
        <span>Copy process ID</span>
      </ContextMenuItem>
      <ContextMenuItem class="text-destructive focus:text-destructive" @select="emit('close', option.session)">
        <X class="h-4 w-4" />
        <span>Close</span>
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
  <template v-if="processes.length">
    <Separator v-if="family.options.length > 1" class="my-1" />
    <button
      v-for="process in processes"
      :key="process.id"
      type="button"
      :class="cn(
        'relative isolate flex h-[26px] w-full items-center gap-1.5 overflow-hidden rounded-tab px-2 text-left text-[13px] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        processActive(process) && 'bg-primary/10'
      )"
      @click.stop="emit('selectProcess', process)"
    >
      <TabWash :activity="processActivity(process)" />
      <RowStatus :activity="processActivity(process)" />
      <span class="min-w-0 flex-1 truncate">
        {{ process.name }}<span v-if="familyOwnerLabel(family, process.parentProcessId)" class="text-muted-foreground"> · {{ familyOwnerLabel(family, process.parentProcessId) }}</span>
      </span>
      <UnreadDot :urgency="unreadUrgency(process.id)" />
    </button>
  </template>
  <template v-if="timers.length">
    <Separator v-if="showLabel || processes.length || family.options.length > 1 || family.root.session.summary" class="my-1" />
    <div
      v-for="timer in timers"
      :key="timer.id"
      class="flex h-[26px] items-center gap-1.5 px-2 text-[13px] text-muted-foreground"
      :title="timer.body"
    >
      <TimerIcon class="h-3.5 w-3.5 shrink-0" />
      <span class="min-w-0 flex-1 truncate">
        {{ timerLabel(timer) }}<template v-if="timer.ownerProcessId !== family.root.session.processId"> · {{ ownerName(timer.ownerProcessId) }}</template>
      </span>
      <span class="shrink-0 text-xs tabular-nums">{{ timerRemaining(timer, now) }}</span>
    </div>
  </template>
</template>

<script setup lang="ts">
import { Clock, Copy, Pencil, Timer as TimerIcon, X } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { agentLabel, agentOptionIndent, familyOwnerLabel, type AgentTabFamily } from '../lib/agentTabs';
import { mentionPreview } from '../lib/integratedComposer';
import { processActivity, type RowActivity } from '../lib/rowActivity';
import { hostLabel } from '../lib/hosts';
import { timerLabel, timerRemaining } from '../lib/timers';
import type { ProcessRecord, SessionRecord, TimerRecord } from '../types';
import { unreadUrgency } from '../Composables/useNotifications';
import AutoSummaryPreview from './AutoSummaryPreview.vue';
import HostBadge from './HostBadge.vue';
import RowStatus from './RowStatus.vue';
import StatusLabelMenu from './StatusLabelMenu.vue';
import StatusLabelPill from './StatusLabelPill.vue';
import TabWash from './TabWash.vue';
import UnreadDot from './UnreadDot.vue';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu';
import { Separator } from './ui/separator';

const props = defineProps<{
  family: AgentTabFamily;
  processes: ProcessRecord[];
  timers: TimerRecord[];
  now: number;
  // Icon-only tabs hide the agent's name, so their menu shows it.
  showLabel: boolean;
  activity: (session: SessionRecord) => RowActivity;
  sessionActive: (session: SessionRecord) => boolean;
  processActive: (process: ProcessRecord) => boolean;
}>();

// `menu` reports a row's context menu opening or closing, so the host keeps
// the menu open meanwhile.
const emit = defineEmits<{
  selectSession: [session: SessionRecord];
  selectProcess: [process: ProcessRecord];
  rename: [session: SessionRecord];
  setTimer: [session: SessionRecord];
  copyId: [session: SessionRecord];
  close: [session: SessionRecord];
  menu: [open: boolean];
}>();

function ownerName(processId: string | null): string {
  const session = props.family.options.find((option) => option.session.processId === processId)?.session;
  if (session) return agentLabel(session);
  return props.processes.find((process) => process.id === processId)?.name ?? '';
}
</script>
