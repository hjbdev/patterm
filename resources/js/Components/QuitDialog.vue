<template>
  <Dialog :open="open" @update:open="(value) => { if (!value) cancel(); }">
    <DialogContent class="sm:max-w-md" @interact-outside="(event) => event.preventDefault()">
      <DialogHeader>
        <DialogTitle>Quit Patterm and stop all processes?</DialogTitle>
        <DialogDescription>{{ detail }}</DialogDescription>
      </DialogHeader>
      <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
      <DialogFooter>
        <Button ref="cancelButton" variant="secondary" :disabled="busy" @click="cancel">Cancel</Button>
        <Button variant="destructive" :disabled="busy" @click="confirm">{{ busy ? 'Stopping…' : 'Quit and stop all' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

// Desktop only. Closing the window asks here instead of in a native dialog.
// Confirming runs the same command as the palette's Quit Patterm, which shuts
// the application down and closes the window.
const open = ref(false);
const busy = ref(false);
const detail = ref('');
const error = ref('');
const cancelButton = ref<{ $el: HTMLElement } | null>(null);

const unsubscribe = window.patterm.onQuitRequest?.((request) => {
  window.patterm.quitRequestShown?.(request.id);
  if (busy.value) return;
  detail.value = request.detail;
  error.value = '';
  open.value = true;
  // Cancel is the default, as in the palette's two-step confirmation.
  void nextTick(() => cancelButton.value?.$el.focus());
});
onBeforeUnmount(() => unsubscribe?.());

function cancel(): void {
  if (!busy.value) open.value = false;
}

async function confirm(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await window.patterm.commandsRun({
      id: 'renderer:quit',
      context: { active_project_id: null, active_terminal_id: null, active_tab: null },
      input: { confirmed: true }
    });
    window.close();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    busy.value = false;
  }
}
</script>
