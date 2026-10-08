<template>
  <Tooltip v-if="session || process">
    <TooltipTrigger as-child>
      <MentionChip
        as="button"
        type="button"
        data-component="process-mention"
        :label="name"
        :host="(session ?? process)?.host"
        :harness="session?.harness"
        :agent="Boolean(session)"
        :live="live"
        :aria-disabled="!openable || undefined"
        :class="cn(
          'transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          openable ? (live ? 'hover:bg-purple-400/25' : 'hover:bg-foreground/10') : 'cursor-default'
        )"
        @click="open"
      />
    </TooltipTrigger>
    <TooltipContent class="max-w-80 bg-popover text-popover-foreground">
      <p class="font-medium">{{ label }}</p>
      <p class="text-muted-foreground">{{ status }} · <span class="font-mono">{{ processId }}</span></p>
      <p v-if="summary" class="mt-1.5 whitespace-pre-wrap break-words">{{ summary }}</p>
    </TooltipContent>
  </Tooltip>
  <template v-else>{{ processId }}</template>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { cn } from '@/lib/utils';
import { useWorkbench } from '../Composables/useWorkbench';
import { findProcess, sessionForProcess } from '../lib/agentMentions';
import { agentLabel } from '../lib/agentTabs';
import { hostLabel } from '../lib/hosts';
import { processStatusIcon, sessionStatusIcon } from '../lib/statusIcons';
import MentionChip from './MentionChip.vue';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

// A process ID in a message, shown as the agent or process it names. IDs that
// match nothing in the project stay plain text.
const props = defineProps<{ processId: string }>();

const route = useRoute();
const router = useRouter();
const { projects, archivedSessions, archivedProcesses, loadArchived } = useWorkbench();
const routeProjectId = computed(() => typeof route.params.projectId === 'string' ? route.params.projectId : null);
const project = computed(() => projects.value.find((item) => item.project.id === routeProjectId.value) ?? null);
const owner = computed(() => findProcess(projects.value, props.processId, routeProjectId.value));
// Ended processes outside the snapshot are only looked up in the route's project.
const session = computed(() => owner.value ? owner.value.session : sessionForProcess(archivedSessions.value.values(), props.processId));
const process = computed(() => owner.value ? owner.value.process : archivedProcesses.value.get(props.processId) ?? null);
const projectId = computed(() => owner.value?.projectId ?? routeProjectId.value);
const name = computed(() => session.value ? agentLabel(session.value) : process.value?.name ?? props.processId);
const label = computed(() => session.value ? hostLabel(agentLabel(session.value), session.value.host) : process.value ? hostLabel(process.value.name, process.value.host) : props.processId);
const status = computed(() => session.value ? sessionStatusIcon(session.value).label : process.value ? processStatusIcon(process.value).label : '');
const summary = computed(() => (session.value ?? process.value)?.summary?.text ?? '');
const live = computed(() => session.value ? !session.value.exitedAt : process.value?.status === 'running');
// Ended Integrated agents keep a read-only transcript; ended terminals have
// nothing to show.
const openable = computed(() => session.value
  ? !session.value.exitedAt || session.value.interfaceMode === 'integrated'
  : Boolean(process.value?.ptyProcessId && process.value.status === 'running'));

// Processes that ended before the snapshot's window are read on demand.
watch([project, () => props.processId], ([current, processId]) => {
  if (current && !session.value && !process.value) void loadArchived(current.project.id, { processId });
}, { immediate: true });

function open(): void {
  const id = projectId.value;
  if (!id || !openable.value) return;
  if (session.value) void router.push({ name: 'agent', params: { projectId: id, sessionId: session.value.id } });
  else if (process.value) void router.push({ name: 'process', params: { projectId: id, processId: process.value.id } });
}
</script>
