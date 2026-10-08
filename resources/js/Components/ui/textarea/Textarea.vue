<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const props = defineProps<{
  defaultValue?: string;
  modelValue?: string;
  class?: HTMLAttributes['class'];
  placeholder?: string;
  rows?: number | string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <textarea
    :value="modelValue ?? defaultValue"
    :placeholder="placeholder"
    :rows="rows"
    :class="
      cn(
        'flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        props.class
      )
    "
    @input="onInput"
  />
</template>
