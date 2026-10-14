<template>
  <div v-if="launches.length" class="flex gap-1" :class="vertical ? 'flex-col' : 'shrink-0'">
    <Button v-for="launch in launches" :key="launch.id" variant="ghost" :size="compact ? 'icon' : 'sm'"
      :data-patterm-tab-id="launch.id"
      :aria-label="`${harnessLaunchLabel(launch)}${launch.input.host ? ` · ${launch.input.host}` : ''}`"
      :title="harnessLaunchLabel(launch)"
      class="relative h-7 shrink-0 gap-2 rounded-tab text-[13px]"
      :class="cn(compact ? 'w-8' : vertical ? 'w-full justify-start' : 'w-56 justify-start', selected(launch) && 'bg-primary/10', launch.state === 'failed' && 'text-destructive')"
      @click="select(launch)">
      <LoaderCircle v-if="launch.state === 'starting'" class="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
      <AlertCircle v-else-if="launch.state === 'failed'" class="h-3.5 w-3.5 shrink-0" />
      <AgentIcon v-else :harness="launch.input.harness" class="h-3.5 w-3.5 shrink-0" />
      <template v-if="!compact"><span class="truncate">{{ harnessLaunchLabel(launch) }}</span><HostBadge v-if="launch.input.host" :host="launch.input.host" /></template>
    </Button>
  </div>
</template>

<script setup lang="ts">
import { cn } from '../lib/utils';
import { useRoute, useRouter } from 'vue-router';
import { AlertCircle, LoaderCircle } from 'lucide-vue-next';
import { harnessLaunchLabel, type HarnessLaunch } from '../lib/harnessLaunches';
import { useProjectHarnessLaunches } from '../Composables/useHarnessLaunch';
import AgentIcon from './AgentIcon.vue';
import HostBadge from './HostBadge.vue';
import { Button } from './ui/button';

const props = defineProps<{ projectId: string; vertical?: boolean; compact?: boolean }>();
const emit = defineEmits<{ select: [] }>();
const route = useRoute(), router = useRouter();
const launches = useProjectHarnessLaunches(() => props.projectId);
function selected(launch: HarnessLaunch): boolean { return route.name === 'launch' && route.params.launchId === launch.id; }
function select(launch: HarnessLaunch): void {
  void router.push(launch.state === 'ready'
    ? { name: 'agent', params: { projectId: props.projectId, sessionId: launch.sessionId! } }
    : { name: 'launch', params: { projectId: props.projectId, launchId: launch.id } });
  emit('select');
}
</script>
