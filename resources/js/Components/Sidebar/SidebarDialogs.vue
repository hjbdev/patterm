<template>
  <Dialog v-model:open="sidebarDialogs.renameOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ sidebarDialogs.renameKind === 'agent' ? 'Rename agent' : 'Rename process' }}</DialogTitle>
        <DialogDescription>Set the label shown in the sidebar.</DialogDescription>
      </DialogHeader>
      <form class="flex flex-col gap-3" @submit.prevent="submit">
        <Input v-model="sidebarDialogs.renameName" aria-label="Name" maxlength="500" />
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="submit" :disabled="busy || !sidebarDialogs.renameName.trim()">Save</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
  <SetTimerDialog v-model:open="sidebarDialogs.timerOpen" :target-process-id="sidebarDialogs.timerTargetId" :target-name="sidebarDialogs.timerTargetName" />
</template>

<script setup lang="ts">
import { ref } from 'vue';
import SetTimerDialog from '../SetTimerDialog.vue';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { sidebarDialogs } from './sidebarActions';

const busy = ref(false);
const error = ref('');

async function submit(): Promise<void> {
  const name = sidebarDialogs.renameName.trim();
  if (busy.value || !name) return;
  busy.value = true;
  error.value = '';
  try {
    await window.patterm.call('rename_process', { process_id: sidebarDialogs.renameTargetId, name });
    sidebarDialogs.renameOpen = false;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}
</script>
