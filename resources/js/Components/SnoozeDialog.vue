<template>
  <Dialog :open="snoozeDialog.open" @update:open="(value) => { if (!value && !snoozeDialog.busy) snoozeDialog.open = false; }">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle class="break-words">Snooze {{ snoozeDialog.name }}</DialogTitle>
        <DialogDescription>It moves aside until its next message.</DialogDescription>
      </DialogHeader>
      <form class="flex flex-col gap-3" @submit.prevent="snoozeConfirmed">
        <Textarea
          v-model="snoozeDialog.reminder"
          aria-label="Reminder"
          class="min-h-20 resize-none text-sm"
          maxlength="1000"
          placeholder="Reminder for when it wakes (optional)"
          @keydown.enter.exact.prevent="snoozeConfirmed"
        />
        <DialogFooter>
          <Button type="submit" :disabled="snoozeDialog.busy">Snooze</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { snoozeConfirmed, snoozeDialog } from '../Composables/useSnooze';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Textarea } from './ui/textarea';
</script>
