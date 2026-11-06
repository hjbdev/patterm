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
  <Dialog v-model:open="sidebarDialogs.folderOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>{{ sidebarDialogs.folderId ? 'Rename folder' : 'New folder' }}</DialogTitle>
        <DialogDescription>Folders keep agents together in the sidebar and the top bar.</DialogDescription>
      </DialogHeader>
      <form class="flex flex-col gap-3" @submit.prevent="submitFolder">
        <Input v-model="sidebarDialogs.folderName" aria-label="Folder name" placeholder="Folder name" maxlength="60" />
        <DialogFooter>
          <Button type="submit" :disabled="!sidebarDialogs.folderName.trim()">{{ sidebarDialogs.folderId ? 'Save' : 'Create' }}</Button>
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
import { useSidebar } from './sidebarContext';
import { useSidebarExpansion } from '../../Composables/useSidebarExpansion';
import { folderKey } from '../../lib/tabStrip';

const sidebar = useSidebar();
const expansion = useSidebarExpansion(() => sidebar.expansionScope.value);

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

// A new folder opens, so you see what went into it.
function submitFolder(): void {
  const name = sidebarDialogs.folderName.trim();
  if (!name) return;
  if (sidebarDialogs.folderId) sidebar.renameFolder(sidebarDialogs.folderId, name);
  else expansion.setOpen(folderKey(sidebar.createFolder(name, sidebarDialogs.folderKeys).id), true);
  sidebarDialogs.folderOpen = false;
}
</script>
