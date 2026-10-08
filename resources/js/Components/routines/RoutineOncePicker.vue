<template>
  <div class="flex flex-wrap items-center gap-2">
    <Input :model-value="date" type="date" aria-label="Date" class="h-8 w-[9.5rem] tabular-nums [color-scheme:dark]" @update:model-value="setDate(String($event))" />
    <Input :model-value="time" inputmode="numeric" maxlength="5" placeholder="HH:MM" aria-label="Time (24-hour)" class="h-8 w-[4.5rem] text-center tabular-nums" @update:model-value="setTime(String($event))" />
  </div>
</template>

<script setup lang="ts">
import { Input } from '../ui/input';
import { zonedInstant } from '../../../../app/Services/RoutineSchedule';

// The date and time are in the routine's own zone, like a repeating routine's time.
const props = defineProps<{ date: string; time: string; timezone: string }>();
const emit = defineEmits<{ change: [patch: { run_at: string; time: string }] }>();

// Only a complete date and 24-hour time are saved, so partial typing never schedules a wrong run.
function setDate(value: string): void {
  save(value, props.time);
}

function setTime(value: string): void {
  save(props.date, value);
}

function save(date: string, time: string): void {
  const at = zonedInstant(date, time, props.timezone);
  if (at !== null) emit('change', { run_at: new Date(at).toISOString(), time });
}
</script>
