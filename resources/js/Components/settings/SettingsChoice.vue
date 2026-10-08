<template>
  <!-- Short option sets show side by side; longer ones use a menu. -->
  <RadioGroupRoot
    v-if="segmented"
    :model-value="keyOf(modelValue)"
    :disabled="disabled === true"
    :aria-label="ariaLabel"
    orientation="horizontal"
    loop
    class="flex h-8 w-full max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-input bg-white/[0.02] p-0.5 [@container(min-width:26rem)]:inline-flex [@container(min-width:26rem)]:w-auto [@container(min-width:26rem)]:shrink-0"
    @update:model-value="choose"
  >
    <RadioGroupItem
      v-for="option in options"
      :key="keyOf(option.value)"
      :value="keyOf(option.value)"
      :title="option.short ? option.label : undefined"
      class="h-full flex-1 whitespace-nowrap rounded-[5px] px-2.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=checked]:bg-white/[0.1] data-[state=checked]:text-foreground [@container(min-width:26rem)]:flex-none"
    >
      {{ option.short ?? option.label }}
    </RadioGroupItem>
  </RadioGroupRoot>
  <Select v-else :model-value="keyOf(modelValue)" :disabled="disabled === true" @update:model-value="choose">
    <SelectTrigger :id="id" :aria-label="ariaLabel" :class="cn('w-full [@container(min-width:26rem)]:w-56', props.class)">
      <SelectValue :placeholder="placeholder ?? ''" />
    </SelectTrigger>
    <SelectContent>
      <SelectItem v-for="option in options" :key="keyOf(option.value)" :value="keyOf(option.value)">{{ option.label }}</SelectItem>
    </SelectContent>
  </Select>
</template>

<script setup lang="ts" generic="T extends string | number | null">
import type { HTMLAttributes } from 'vue';
import { RadioGroupItem, RadioGroupRoot } from 'reka-ui';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

export interface SettingsChoiceOption<V> { value: V; label: string; short?: string }

// `segmented` shows the options side by side; keep it for short sets.
const props = defineProps<{
  modelValue: T;
  options: Array<SettingsChoiceOption<T>>;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  segmented?: boolean;
  class?: HTMLAttributes['class'];
}>();
const emit = defineEmits<{ 'update:modelValue': [value: T] }>();

// Menu items need non-empty string values, and some settings use null or numbers.
function keyOf(value: T | null | undefined): string {
  return JSON.stringify(value ?? null);
}

function choose(key: unknown): void {
  if (typeof key !== 'string') return;
  const value = JSON.parse(key) as T;
  if (keyOf(value) !== keyOf(props.modelValue)) emit('update:modelValue', value);
}
</script>
