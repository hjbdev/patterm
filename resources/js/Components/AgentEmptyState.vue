<template>
  <div class="flex min-h-0 flex-1 items-center justify-center bg-background px-6">
    <div class="flex max-w-lg flex-col items-center gap-5 text-center">
      <div>
        <h1 class="text-3xl font-semibold tracking-tight">Get Started</h1>
        <p class="mt-2 text-sm text-muted-foreground">Start an installed agent CLI for {{ projectName }}.</p>
      </div>

      <div v-if="launchableHarnesses.length" class="flex flex-wrap items-center justify-center gap-2">
        <Button
          v-for="harness in launchableHarnesses"
          :key="harness.id"
          variant="outline"
          size="sm"
          class="gap-2"
          :disabled="launching"
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
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
import { harnessLabel, launchableHarnesses as filterLaunchableHarnesses } from '../lib/harnesses';
import type { HarnessInstallationRecord } from '../types';
import AgentIcon from './AgentIcon.vue';
import { Button } from './ui/button';

const props = withDefaults(
  defineProps<{
    projectId: string;
    projectName: string;
    harnesses: HarnessInstallationRecord[];
  }>(),
  {}
);

const emit = defineEmits<{ launched: [sessionId: string, terminalId: string | null] }>();

const launching = ref(false);
const launchableHarnesses = computed(() => filterLaunchableHarnesses(props.harnesses));

async function launchHarness(harness: string): Promise<void> {
  if (launching.value) return;
  launching.value = true;
  try {
    const result = (await window.patterm?.call?.('patterm.harness.launch', {
      harness,
      project_id: props.projectId,
    })) as { session_id?: unknown; pty_process_id?: unknown } | null | undefined;
    if (typeof result?.session_id === 'string') {
      emit('launched', result.session_id, typeof result.pty_process_id === 'string' ? result.pty_process_id : null);
    }
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : `Failed to launch ${harnessLabel(harness)}`);
  } finally {
    launching.value = false;
  }
}
</script>
