<template>
  <Dialog :open="closeConfirm.open" @update:open="(value) => { if (!value && !closeConfirm.busy) closeConfirm.open = false; }">
    <DialogContent class="sm:max-w-sm" @open-auto-focus="focusCancel">
      <DialogHeader>
        <DialogTitle class="break-words">Close {{ closeConfirm.name }}?</DialogTitle>
        <DialogDescription>
          {{ closeConfirm.kind === 'agent' ? 'This stops the agent and any subagents and processes it started.' : 'This stops the process.' }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button ref="cancelButton" variant="secondary" :disabled="closeConfirm.busy" @click="closeConfirm.open = false">Cancel</Button>
        <Button variant="destructive" :disabled="closeConfirm.busy" @click="closeConfirmed">{{ closeConfirm.kind === 'agent' ? 'Close agent' : 'Close process' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { closeConfirm, closeConfirmed } from '../Composables/useCloseConfirm';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

const cancelButton = ref<{ $el: HTMLElement } | null>(null);

// Cancel is the default, so a stray Enter keeps the agent running.
function focusCancel(event: Event): void {
  event.preventDefault();
  cancelButton.value?.$el.focus();
}
</script>
