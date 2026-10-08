<template>
  <Transition enter-from-class="opacity-0" leave-to-class="opacity-0" enter-active-class="transition-opacity duration-150" leave-active-class="transition-opacity duration-500">
    <span v-if="status.state !== 'idle'" role="status" aria-live="polite" class="inline-flex shrink-0 items-center gap-1 text-[11px] font-normal" :class="status.state === 'error' ? 'text-destructive' : 'text-muted-foreground'" :title="status.error || undefined">
      <LoaderCircle v-if="status.state === 'saving'" class="h-3 w-3 animate-spin" aria-hidden="true" />
      <CircleAlert v-else-if="status.state === 'error'" class="h-3 w-3" aria-hidden="true" />
      <Check v-else class="h-3 w-3 text-success" aria-hidden="true" />
      <span>{{ status.state === 'saving' ? 'Saving' : status.state === 'error' ? 'Not saved' : 'Saved' }}</span>
    </span>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Check, CircleAlert, LoaderCircle } from 'lucide-vue-next';
import { sectionSaveStatus } from '../../Composables/useSettingsAutosave';

// Shows saves of settings whose key starts with `scope`.
const props = defineProps<{ scope: string }>();
const status = computed(() => sectionSaveStatus(props.scope));
</script>
