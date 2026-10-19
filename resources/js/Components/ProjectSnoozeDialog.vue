<template>
  <Dialog :open="projectSnoozeDialog.open" @update:open="(value) => { if (!value && !projectSnoozeDialog.busy) projectSnoozeDialog.open = false; }">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle class="break-words">Snooze {{ projectSnoozeDialog.name }}</DialogTitle>
        <DialogDescription>Its notifications wait until then, and All agents tucks it away.</DialogDescription>
      </DialogHeader>
      <div class="-mx-2 flex flex-col">
        <button
          v-for="choice in choices"
          :key="choice.label"
          type="button"
          class="flex h-9 items-center justify-between gap-3 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          :disabled="projectSnoozeDialog.busy"
          @click="snoozeProjectUntil(choice.until)"
        >
          <span>{{ choice.label }}</span>
          <span class="text-xs text-muted-foreground">{{ describeWake(choice.until, now) }}</span>
        </button>
      </div>
      <form class="flex items-center gap-2" @submit.prevent="snoozeCustom">
        <Input v-model="custom" type="datetime-local" aria-label="Snooze until" class="flex-1" :min="minimum" />
        <Button type="submit" variant="secondary" :disabled="projectSnoozeDialog.busy || !customDate">Snooze</Button>
      </form>
      <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { notificationSettingsInput } from '../../../app/Services/NotificationSettings';
import { projectSnoozeDialog, snoozeProjectUntil } from '../Composables/useProjectSnooze';
import { describeWake, nextWorkdayStart } from '../lib/projectSnooze';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';

const now = ref(new Date());
const workdayStart = ref('09:00');
const custom = ref('');
const error = ref('');

// Each opening reads the clock and the workday start afresh.
watch(() => projectSnoozeDialog.open, async (open) => {
  if (!open) return;
  now.value = new Date();
  custom.value = '';
  error.value = '';
  try {
    workdayStart.value = notificationSettingsInput.parse(await window.patterm.notificationSettings()).workdayStart;
  } catch {
    // The default start stands.
  }
});

const choices = computed(() => [
  { label: 'Until the next workday starts', until: nextWorkdayStart(now.value, workdayStart.value) },
  { label: 'For 1 hour', until: new Date(now.value.getTime() + 3_600_000) },
  { label: 'For 4 hours', until: new Date(now.value.getTime() + 4 * 3_600_000) }
]);

const pad = (value: number) => String(value).padStart(2, '0');
const minimum = computed(() => {
  const date = now.value;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
});
// A datetime-local value is local time, which Date parses as such.
const customDate = computed(() => {
  const date = custom.value ? new Date(custom.value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
});

function snoozeCustom(): void {
  const date = customDate.value;
  if (!date) return;
  if (date.getTime() <= Date.now()) {
    error.value = 'Choose a time in the future.';
    return;
  }
  void snoozeProjectUntil(date);
}
</script>
