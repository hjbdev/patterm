<template>
  <div class="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
    <template v-if="launch">
      <LoaderCircle v-if="launch.state !== 'failed'" class="h-6 w-6 animate-spin text-muted-foreground motion-reduce:animate-none" />
      <AgentIcon v-else :harness="launch.input.harness" class="h-6 w-6" />
      <h1 class="text-lg font-medium">{{ harnessLaunchLabel(launch) }}</h1>
      <HostBadge v-if="launch.input.host" :host="launch.input.host" />
      <p v-if="launch.state !== 'failed'" role="status" class="text-sm text-muted-foreground">Waiting for the agent to start. You can switch tabs or launch another agent.</p>
      <template v-else>
        <p role="alert" class="max-w-lg text-sm text-destructive">{{ launch.error }}</p>
        <p class="max-w-lg text-sm text-muted-foreground">Check the project’s agents before launching again if the connection was interrupted.</p>
        <Button v-if="versionMismatch && !launch.input.host" variant="outline" @click="recover">Restart server…</Button>
        <Button variant="ghost" @click="dismiss">Dismiss</Button>
      </template>
    </template>
    <p v-else class="text-sm text-muted-foreground">This launch view is no longer available. Select an agent or launch a new one.</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { LoaderCircle } from 'lucide-vue-next';
import { harnessLaunches, harnessLaunchLabel } from '../lib/harnessLaunches';
import { toastLaunchError } from '../lib/launchErrors';
import { isOpenCodeVersionMismatch } from '../../../app/Services/OpenCodeServiceErrors';
import { useHarnessLaunch } from '../Composables/useHarnessLaunch';
import AgentIcon from '../Components/AgentIcon.vue';
import HostBadge from '../Components/HostBadge.vue';
import { Button } from '../Components/ui/button';

const route = useRoute(), router = useRouter();
const { launchHarness } = useHarnessLaunch();
const launch = computed(() => harnessLaunches.launches.find((item) => item.id === route.params.launchId && item.input.projectId === route.params.projectId));
const versionMismatch = computed(() => isOpenCodeVersionMismatch(launch.value?.error ?? ''));
function recover(): void {
  const current = launch.value;
  if (!current) return;
  // Keep the existing explicit confirmation for a shared-server restart.
  toastLaunchError(new Error(current.error), 'Could not launch OpenCode', () => { harnessLaunches.dismiss(current.id); launchHarness(current.input); });
}
function dismiss(): void {
  const current = launch.value;
  if (!current) return;
  harnessLaunches.dismiss(current.id);
  void router.replace({ name: 'project', params: { projectId: current.input.projectId } });
}
</script>
