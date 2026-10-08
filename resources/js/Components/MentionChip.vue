<template>
  <component
    :is="as"
    :class="cn(
      'mx-px inline-flex max-w-full items-baseline gap-1 rounded-md px-1.5 align-baseline font-medium leading-5',
      launch ? 'bg-orange-400/15 text-orange-200' : live ? 'bg-purple-400/15 text-purple-200' : 'bg-foreground/[0.06] text-muted-foreground',
      props.class
    )"
  >
    <AgentIcon v-if="agent" :harness="harness" class="h-3.5 w-3.5 self-center" />
    <TerminalSquare v-else class="h-3.5 w-3.5 shrink-0 self-center" aria-hidden="true" />
    <span class="truncate">{{ label }}</span>
    <HostBadge v-if="host" :host="host" class="self-center text-current opacity-60" />
  </component>
</template>

<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { TerminalSquare } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import AgentIcon from './AgentIcon.vue';
import HostBadge from './HostBadge.vue';

// A mentioned agent or process, in the composer and in sent messages. It sits
// on the text baseline and fits the line, so it never spreads the lines apart.
// Purple while it runs, grey once it has ended. A preset or harness to launch
// a new agent with is orange.
const props = withDefaults(defineProps<{
  label: string;
  // The paired host the agent or process runs on.
  host?: string | undefined;
  harness?: string | null | undefined;
  // An agent, as opposed to a process such as a shell.
  agent?: boolean | undefined;
  live?: boolean | undefined;
  launch?: boolean | undefined;
  as?: string | undefined;
  class?: HTMLAttributes['class'];
}>(), { harness: null, agent: true, live: true, launch: false, as: 'span', class: '' });
</script>
