<template>
  <div class="flex min-h-0 flex-1 items-center justify-center bg-background px-6">
    <div class="flex max-w-lg flex-col items-center gap-5 text-center">
      <div>
        <h1 class="text-3xl font-semibold tracking-tight">Get Started</h1>
        <p class="mt-2 text-sm text-muted-foreground">{{ chooseProject ? 'Start an installed agent CLI in one of your projects.' : `Start an installed agent CLI for ${projectName}.` }}</p>
      </div>

      <!-- Showing all agents, the launch menu asks which project first. -->
      <LaunchAgentMenu v-if="chooseProject" :project-id="projectId" choose-project label="Start an agent" />
      <div v-else-if="launchableHarnesses.length" class="flex flex-wrap items-center justify-center gap-2">
        <Button
          v-for="harness in launchableHarnesses"
          :key="harness.id"
          variant="outline"
          size="sm"
          class="gap-2"
          @click="launchHarness(harness.harness)"
        >
          <AgentIcon :harness="harness.harness" class="h-4 w-4" />
          {{ harnessLabel(harness.harness) }}
        </Button>
      </div>
      <p v-else class="text-sm text-muted-foreground">No installed agent CLIs were found on PATH.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useHarnessLaunch } from '../Composables/useHarnessLaunch';
import { harnessLabel, launchableHarnesses as filterLaunchableHarnesses } from '../lib/harnesses';
import type { HarnessInstallationRecord } from '../types';
import AgentIcon from './AgentIcon.vue';
import LaunchAgentMenu from './LaunchAgentMenu.vue';
import { Button } from './ui/button';

const props = withDefaults(
  defineProps<{
    projectId: string;
    projectName: string;
    remote?: boolean;
    harnesses: HarnessInstallationRecord[];
    chooseProject?: boolean;
  }>(),
  {}
);

const { launchHarness: startHarness } = useHarnessLaunch();
const launchableHarnesses = computed(() => filterLaunchableHarnesses(props.harnesses));

function launchHarness(harness: string): void {
  startHarness({ harness, projectId: props.projectId, targetProjectId: props.projectId, ...(props.remote ? { host: props.projectId.split(':')[0]! } : {}) });
}
</script>
