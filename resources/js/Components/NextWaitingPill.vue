<template>
  <!-- After you answer one agent on a phone, the next one waiting on you is a
       tap away, until nothing is left. -->
  <div v-if="waiting" class="mx-auto w-full max-w-[50rem] shrink-0 px-2 pb-2">
    <button
      type="button"
      class="flex h-[38px] w-full items-center gap-2.5 rounded-[11px] bg-white/[0.08] pl-3 pr-2.5 text-left text-sm transition-colors hover:bg-white/[0.12] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      :aria-label="`Next waiting: ${label}. ${familyWaitingOn(sidebar, waiting.family) ?? ''}`"
      @click="open"
    >
      <RowStatus :activity="sidebar.activity(waiting.session)" />
      <span class="shrink-0 text-muted-foreground">Next waiting</span>
      <span class="min-w-0 flex-1 truncate">{{ label }}</span>
      <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ChevronRight } from 'lucide-vue-next';
import RowStatus from './RowStatus.vue';
import { useSidebar, type AgentTab } from './Sidebar/sidebarContext';
import { agentLabel } from '../lib/agentTabs';
import { familyWaitingOn, nextWaiting } from '../lib/sidebarTree';

const props = defineProps<{ processId: string }>();
const sidebar = useSidebar();

// Past this agent's own family, the next one asking.
const ownRootId = computed(() => sidebar.tabs.value.find((candidate): candidate is AgentTab => candidate.kind === 'agent'
  && candidate.family.options.some((option) => option.session.processId === props.processId))?.family.rootId ?? null);
const waiting = computed(() => nextWaiting(sidebar.tabs.value, ownRootId.value));
const label = computed(() => waiting.value ? agentLabel(waiting.value.family.root.session) : '');

function open(): void {
  if (waiting.value) sidebar.selectSession(waiting.value.family.rootId, waiting.value.session);
}
</script>
