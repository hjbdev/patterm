<template>
  <!-- A project's logo with the state of its live agents as a 2px bar under it:
       a comet sweeping along a faint track while agents work, and solid amber
       while one waits on you. Waiting outranks working; an idle project has no
       bar. `dim` fades only the logo, so the bar stays readable. -->
  <span class="relative inline-flex shrink-0" :style="{ width: `${px}px`, height: `${px}px` }" :title="label || undefined">
    <ProjectLogo :project="project" :size="px" class="transition-opacity duration-200" :class="dim && 'opacity-60 group-hover:opacity-100 group-focus-visible:opacity-100'" />
    <span v-if="state" class="project-status-bar" :data-state="state" aria-hidden="true"><span /></span>
    <span v-if="label" class="sr-only">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import ProjectLogo from './ProjectLogo.vue';
import type { AgentState } from '../lib/projectOverview';
import type { ProjectSummary } from '../types';

const props = defineProps<{
  project: Pick<ProjectSummary, 'id' | 'name' | 'logo' | 'kind'>;
  // One state per live root agent, subagents folded in.
  states: readonly AgentState[];
  size?: number | undefined;
  dim?: boolean | undefined;
}>();

const px = computed(() => props.size ?? 14);

const state = computed<'waiting' | 'working' | null>(() => {
  if (props.states.includes('waiting')) return 'waiting';
  return props.states.includes('working') ? 'working' : null;
});

const label = computed(() => {
  const count = (wanted: AgentState) => props.states.filter((value) => value === wanted).length;
  return [
    count('waiting') && `${count('waiting')} ${count('waiting') === 1 ? 'needs' : 'need'} you`,
    count('working') && `${count('working')} working`,
    count('idle') && `${count('idle')} idle`
  ].filter(Boolean).join(', ');
});
</script>

<style scoped>
.project-status-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -5px;
  height: 2px;
  overflow: hidden;
  border-radius: 9999px;
  pointer-events: none;
}

.project-status-bar > span {
  position: absolute;
  inset: 0;
  border-radius: inherit;
}

.project-status-bar[data-state='waiting'] > span {
  background: hsl(var(--warning));
}

.project-status-bar[data-state='working'] {
  overflow: visible;
  background: rgb(212 212 216 / 0.18);
  clip-path: inset(-3px 0 -3px 0 round 9999px);
}

/* The comet: a tail fading up to a glowing head, sweeping left to right. */
.project-status-bar[data-state='working'] > span {
  right: auto;
  width: 60%;
  background: linear-gradient(90deg, transparent, rgb(212 212 216));
  filter: drop-shadow(0 0 2px rgb(212 212 216));
  animation: loader-project-comet 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes loader-project-comet {
  from { transform: translateX(-100%); }
  to { transform: translateX(170%); }
}

@media (prefers-reduced-motion: reduce) {
  .project-status-bar[data-state='working'] > span {
    width: 100%;
    animation: none;
  }
}
</style>
