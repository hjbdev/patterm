<template>
  <Dialog :open="request !== null" @update:open="(open) => { if (!open) finishDirectoryPicker(null); }">
    <!-- Its portal mounts with the app, so a dialog on a page opened later comes after it in the DOM. A higher layer keeps the picker on top. -->
    <DialogContent class="z-[60] sm:max-w-lg" overlay-class="z-[60]">
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
