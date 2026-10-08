<template>
  <!-- A word in a sentence that opens a menu of its options. -->
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        :aria-label="label"
        class="inline-flex items-center gap-0.5 rounded px-1 text-foreground underline decoration-white/20 underline-offset-4 hover:decoration-white/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >{{ current?.label ?? 'choose' }}<ChevronDown class="h-3 w-3 opacity-60" /></button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="max-h-80 overflow-y-auto">
      <DropdownMenuRadioGroup :model-value="keyOf(modelValue)" @update:model-value="choose">
        <template v-for="(group, index) in groups" :key="group.name">
          <DropdownMenuSeparator v-if="index > 0" />
          <DropdownMenuLabel v-if="group.name" class="text-[11px] font-normal text-muted-foreground">{{ group.name }}</DropdownMenuLabel>
          <DropdownMenuRadioItem v-for="option in group.options" :key="keyOf(option.value)" :value="keyOf(option.value)">{{ option.label }}</DropdownMenuRadioItem>
        </template>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDown } from 'lucide-vue-next';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import type { RoutineChoiceOption } from '../../lib/routines';

const props = defineProps<{ modelValue: string | null; options: RoutineChoiceOption[]; label: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>();

const current = computed(() => props.options.find((option) => option.value === props.modelValue) ?? null);

const groups = computed(() => {
  const result: Array<{ name: string; options: RoutineChoiceOption[] }> = [];
  for (const option of props.options) {
    const name = option.group ?? '';
    const group = result.find((entry) => entry.name === name);
    if (group) group.options.push(option);
    else result.push({ name, options: [option] });
  }
  return result;
});

// Menu values must be non-empty strings, and some choices are null.
function keyOf(value: string | null): string {
  return JSON.stringify(value);
}

function choose(key: unknown): void {
  if (typeof key === 'string') emit('update:modelValue', JSON.parse(key) as string | null);
}
</script>
