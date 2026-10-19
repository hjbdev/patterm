<template>
  <section class="flex items-start gap-3 rounded-xl border border-border bg-background px-4 py-3 text-sm shadow-sm" :aria-label="snooze.snoozedAt ? 'Snoozed' : 'Snooze reminder'">
    <Moon class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p class="text-xs text-muted-foreground">{{ snooze.snoozedAt ? 'Snoozed until its next message' : 'Reminder from when you snoozed it' }}</p>
      <p v-if="snooze.reminder" class="mt-0.5 max-h-40 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words text-foreground">{{ snooze.reminder }}</p>
    </div>
    <Button size="sm" class="h-7 shrink-0 px-2.5" variant="ghost" @click="snooze.snoozedAt ? unsnooze(processId) : dismissReminder(processId)">
      {{ snooze.snoozedAt ? 'Wake' : 'Dismiss' }}
    </Button>
  </section>
</template>

<script setup lang="ts">
import { Moon } from 'lucide-vue-next';
import { dismissReminder, unsnooze } from '../Composables/useSnooze';
import type { SnoozeRecord } from '../types';
import { Button } from './ui/button';

defineProps<{ processId: string; snooze: SnoozeRecord }>();
</script>
