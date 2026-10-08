<template>
  <div :class="inset ? 'pl-6' : ''">
    <!-- Switches stay beside their label. Wider controls move below it in narrow columns. -->
    <div :class="toggle ? 'flex items-center justify-between gap-4' : 'flex flex-col gap-2.5 [@container(min-width:26rem)]:flex-row [@container(min-width:26rem)]:items-center [@container(min-width:26rem)]:justify-between [@container(min-width:26rem)]:gap-6'">
      <div class="min-w-0" :class="disabled ? 'opacity-50' : ''">
        <label :for="htmlFor" class="block text-[13px]">{{ label }}</label>
        <p v-if="description || $slots.description" class="mt-0.5 text-xs leading-relaxed text-muted-foreground"><slot name="description">{{ description }}</slot></p>
      </div>
      <div class="flex shrink-0 items-center gap-3"><slot /></div>
    </div>
    <div v-if="$slots.below" class="mt-3"><slot name="below" /></div>
    <p v-if="error" role="alert" class="mt-2 text-xs text-destructive">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { settingSaveStatus } from '../../Composables/useSettingsAutosave';

// `toggle` marks a switch row. `inset` indents a setting that depends on the
// one above it.
const props = defineProps<{ label: string; description?: string; htmlFor?: string; saveKey?: string; toggle?: boolean; inset?: boolean; disabled?: boolean }>();

const error = computed(() => {
  const saved = props.saveKey ? settingSaveStatus(props.saveKey) : null;
  return saved?.state === 'error' ? saved.error : '';
});
</script>
