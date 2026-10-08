<template>
  <p v-if="!runs.length" class="text-xs text-muted-foreground">No runs yet.</p>
  <ul v-else class="-mx-2">
    <li v-for="run in runs" :key="run.run_id" class="group flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-white/[0.03]">
      <span class="w-28 shrink-0 text-xs tabular-nums text-muted-foreground">{{ formatRunWhen(Date.parse(run.scheduled_for), now) }}</span>
      <span class="min-w-0 flex-1 text-[13px]">
        <span :class="runNeedsAttention(run) ? 'text-foreground' : 'text-muted-foreground'">{{ runStatusLabel(run) }}</span>
        <span v-if="routineName" class="text-muted-foreground"> · {{ routineName(run.routine_id) }}</span>
        <span v-if="run.excerpt" class="mt-0.5 block truncate text-xs text-muted-foreground/80" :title="run.excerpt">{{ run.excerpt }}</span>
      </span>
      <button
        v-if="run.status !== 'skipped'"
        type="button"
        class="shrink-0 text-xs text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        @click="emit('open', run)"
      >Open</button>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { formatRunWhen, runNeedsAttention, runStatusLabel, type RoutineRunRecord } from '../../lib/routines';

defineProps<{ runs: RoutineRunRecord[]; now: number; routineName?: (routineId: string) => string }>();
const emit = defineEmits<{ open: [run: RoutineRunRecord] }>();
</script>
