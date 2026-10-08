<template>
  <div class="space-y-1.5">
    <Textarea ref="field" :model-value="modelValue" :rows="rows ?? 4" aria-label="Prompt" placeholder="What should the agent do each run?" :class="['resize-y text-[13px] leading-relaxed', fieldClass]" @update:model-value="emit('update:modelValue', $event)" />
    <div class="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      <span class="mr-1">Insert</span>
      <button
        v-for="variable in VARIABLES"
        :key="variable.token"
        type="button"
        class="rounded px-1.5 py-0.5 font-mono hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        :title="variable.description"
        @click="insert(variable.token)"
      >{{ variable.token }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { Textarea } from '../ui/textarea';

const props = defineProps<{ modelValue: string; rows?: number; fieldClass?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const VARIABLES = [
  { token: '{{date}}', description: 'The run date, such as 2026-10-05' },
  { token: '{{weekday}}', description: 'The run weekday, such as Monday' },
  { token: '{{since}}', description: 'When the last successful run reported' },
  { token: '{{last_run_at}}', description: 'When the previous run started' }
];

const field = ref<{ $el: HTMLTextAreaElement } | null>(null);

// Inserts at the cursor, or at the end when the prompt has not been focused.
function insert(token: string): void {
  const element = field.value?.$el;
  const start = element?.selectionStart ?? props.modelValue.length;
  const end = element?.selectionEnd ?? start;
  emit('update:modelValue', `${props.modelValue.slice(0, start)}${token}${props.modelValue.slice(end)}`);
  void nextTick(() => {
    element?.focus();
    element?.setSelectionRange(start + token.length, start + token.length);
  });
}
</script>
