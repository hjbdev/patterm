<template>
  <!-- A folded folder's members, one dot each: amber while one needs you, red
       on an error, bright and pulsing while it works, a faint ring at rest. -->
  <span class="flex items-center gap-[3px]" :aria-label="label">
    <span
      v-for="dot in dots.slice(0, MAX_DOTS)"
      :key="dot.key"
      class="h-[5px] w-[5px] shrink-0 rounded-full"
      :class="DOT_CLASSES[dot.state]"
      aria-hidden="true"
    />
    <span v-if="dots.length > MAX_DOTS" class="text-[10px] font-medium leading-[10px] tabular-nums text-muted-foreground" aria-hidden="true">+{{ dots.length - MAX_DOTS }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { processActivity } from '../lib/rowActivity';
import { familyAttention, familyStatus } from '../lib/sidebarTree';
import type { StripTab } from '../lib/tabStrip';
import { useSidebar } from './Sidebar/sidebarContext';

type DotState = 'attention' | 'error' | 'working' | 'idle';
const MAX_DOTS = 6;
const DOT_CLASSES: Record<DotState, string> = {
  attention: 'bg-warning',
  error: 'bg-destructive',
  working: 'animate-pulse bg-foreground/80 motion-reduce:animate-none',
  idle: 'border border-muted-foreground/50'
};

const props = defineProps<{ tabs: readonly StripTab[] }>();
const sidebar = useSidebar();

const dots = computed(() => props.tabs.map((tab) => ({ key: tab.key, state: dotState(tab) })));
const label = computed(() => {
  const count = (state: DotState) => dots.value.filter((dot) => dot.state === state).length;
  const parts = [
    [count('attention') + count('error'), 'need you'],
    [count('working'), 'working']
  ].filter(([n]) => n).map(([n, what]) => `${n} ${what}`);
  return [`${props.tabs.length} ${props.tabs.length === 1 ? 'agent' : 'agents'}`, ...parts].join(', ');
});

function dotState(tab: StripTab): DotState {
  if (tab.kind === 'process') return processActivity(tab.process).self === 'working' ? 'working' : 'idle';
  const status = familyStatus(sidebar, tab.family, sidebar.activity(tab.family.root.session));
  if (status === 'attention') return familyAttention(sidebar, tab.family) === 'error' ? 'error' : 'attention';
  return status;
}
</script>
