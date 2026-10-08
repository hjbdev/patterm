<template>
  <div class="flex flex-wrap items-center gap-2">
    <div class="flex gap-0.5 rounded-md border border-input bg-white/[0.02] p-0.5" role="group" aria-label="Days">
      <button
        v-for="entry in WEEKDAYS"
        :key="entry.day"
        type="button"
        class="h-7 w-8 rounded-[5px] text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-white/[0.1] aria-pressed:text-foreground"
        :aria-pressed="days.includes(entry.day)"
        :aria-label="entry.label"
        :title="entry.label"
        @click="toggle(entry.day)"
      >{{ entry.label.slice(0, 2) }}</button>
    </div>
    <Input :model-value="time" inputmode="numeric" maxlength="5" placeholder="HH:MM" aria-label="Time (24-hour)" class="h-8 w-[4.5rem] text-center tabular-nums" @update:model-value="setTime(String($event))" />
  </div>
</template>

<script setup lang="ts">
import { Input } from '../ui/input';
import { WEEKDAYS } from '../../lib/routines';

const props = defineProps<{ days: number[]; time: string }>();
const emit = defineEmits<{ 'update:days': [days: number[]]; 'update:time': [time: string] }>();

// Only complete 24-hour times are saved, so partial typing never schedules a wrong run.
function setTime(value: string): void {
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) emit('update:time', value);
}

function toggle(day: number): void {
  emit('update:days', props.days.includes(day) ? props.days.filter((value) => value !== day) : [...props.days, day]);
}
</script>
