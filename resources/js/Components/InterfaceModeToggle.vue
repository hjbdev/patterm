<template>
  <DropdownMenuRadioGroup v-if="menu" :model-value="modelValue" class="grid grid-cols-2 gap-0.5 rounded-tab bg-muted/40 p-0.5" @update:model-value="select">
    <DropdownMenuRadioItem v-for="mode in modes" :key="mode.value" :value="mode.value" :class="cn(segmentClass, 'h-7 justify-center px-2 py-0 text-xs focus:bg-primary/10 focus:text-foreground data-[state=unchecked]:focus:bg-muted/60 [&>span:first-child]:hidden')" @select.prevent>
      <component :is="mode.icon" class="h-3.5 w-3.5" />
      {{ mode.label }}
    </DropdownMenuRadioItem>
  </DropdownMenuRadioGroup>
  <div v-else role="radiogroup" aria-label="Agent interface" class="inline-flex gap-0.5 rounded-tab bg-muted/40 p-0.5">
    <button v-for="mode in modes" :key="mode.value" type="button" role="radio" :aria-checked="modelValue === mode.value" :data-state="modelValue === mode.value ? 'checked' : 'unchecked'" :class="cn(segmentClass, 'min-h-9 px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring')" @click="select(mode.value)">
      <component :is="mode.icon" class="h-4 w-4" />
      {{ mode.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { MessagesSquare, TerminalSquare } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from './ui/dropdown-menu';
import type { AgentInterface } from '../types';

defineProps<{ modelValue: AgentInterface; menu?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: AgentInterface] }>();

const modes = [
  { value: 'tui', label: 'TUI', icon: TerminalSquare },
  { value: 'integrated', label: 'Integrated', icon: MessagesSquare }
] as const;

// Matches the selected agent tab so the toggle reads as part of the top bar.
const segmentClass = 'flex items-center gap-1.5 rounded-[5px] text-muted-foreground transition-colors hover:text-foreground data-[state=checked]:bg-primary/10 data-[state=checked]:text-foreground';

function select(value: unknown): void {
  if (value === 'tui' || value === 'integrated') emit('update:modelValue', value);
}
</script>
