<template>
  <main v-if="stopped" class="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground">
    <div class="max-w-md space-y-3">
      <h1 class="text-xl font-semibold">Patterm has stopped</h1>
      <p class="text-sm text-muted-foreground">All managed agents, commands, and timers have stopped. Saved conversations remain available to resume.</p>
      <p class="text-sm text-muted-foreground">Start Patterm on the server, then refresh this page to reconnect.</p>
    </div>
  </main>
  <WorkbenchLayout v-else />
  <DirectoryPickerDialog v-if="isBrowser" />
  <QuitDialog v-else />
  <!-- Toasts sit above the assistant button in the same corner, or beside the docked assistant, when it is on. -->
  <Toaster position="bottom-right" rich-colors :offset="assistant.enabled && assistantLayout.open && assistantLayout.docked && !assistantLayout.expanded ? { bottom: 16, right: 'calc(var(--assistant-dock-width) + 1.375rem)' } : { bottom: assistant.enabled ? 80 : 16, right: 16 }" :mobile-offset="{ bottom: assistant.enabled ? 80 : 16 }" />
</template>

<script setup lang="ts">
import WorkbenchLayout from './Layouts/WorkbenchLayout.vue';
import { Toaster } from './Components/ui/sonner';
import DirectoryPickerDialog from './Components/DirectoryPickerDialog.vue';
import QuitDialog from './Components/QuitDialog.vue';
import { assistantLayout } from './lib/assistantLayout';
import { assistant } from './lib/assistant';
import { onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { startNotifications } from './Composables/useNotifications';
const stopped = ref(false);
const isBrowser = window.patterm.runtime === 'browser';
startNotifications(useRouter());
const onQuit = () => { stopped.value = true; };
window.addEventListener('patterm:quit', onQuit);
onBeforeUnmount(() => window.removeEventListener('patterm:quit', onQuit));
</script>
