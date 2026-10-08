<template>
  <Dialog :open="request !== null" @update:open="(open) => { if (!open) finishDirectoryPicker(null); }">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Choose a folder</DialogTitle>
        <DialogDescription>Folders on the server. Type to filter, Tab to complete.</DialogDescription>
      </DialogHeader>
      <DirectoryBrowser v-if="request" :key="requestKey" :initial="request.initial" @select="finishDirectoryPicker" @cancel="finishDirectoryPicker(null)" />
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import DirectoryBrowser from './DirectoryBrowser.vue';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { directoryPickerRequest as request, finishDirectoryPicker } from '../lib/directoryPicker';

// Each request starts a fresh browser at its own initial path.
const requestKey = ref(0);
watch(request, () => { requestKey.value += 1; });
</script>
