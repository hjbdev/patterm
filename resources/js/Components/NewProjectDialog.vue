<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <slot name="trigger" />
    </DialogTrigger>
    <DialogContent class="sm:max-w-md" @close-auto-focus="onCloseAutoFocus">
      <DialogHeader>
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>{{ selectedHost ? `Register a project using a directory on ${selectedHost}.` : isBrowser ? 'Register a project using a directory on the server.' : 'Register a local project rooted at a directory on disk.' }}</DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" @submit.prevent="submit">
        <div v-if="hostOptions.length > 1" class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-muted-foreground" for="new-project-host">Host</label>
          <SettingsChoice id="new-project-host" v-model="selectedHost" :options="hostOptions" aria-label="Host" class="h-9 w-full text-xs" />
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ selectedHost ? `Path on ${selectedHost}` : isBrowser ? 'Server path' : 'Path' }}</label>
          <div class="flex gap-2">
            <Input ref="pathInput" v-model="path" placeholder="/path/to/repo" class="font-mono" />
            <Button type="button" variant="outline" class="shrink-0" @click="browse">Browse…</Button>
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">Name <span class="font-normal">(optional)</span></label>
          <Input v-model="name" placeholder="Defaults to the directory name" />
        </div>

        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>

        <DialogFooter>
          <Button type="submit" :disabled="busy || path.trim().length === 0">{{ busy ? 'Creating…' : 'Create project' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { Input } from './ui/input';
import SettingsChoice from './settings/SettingsChoice.vue';
import { useAutofocus } from '../Composables/useAutofocus';
import { focusArrivalInput } from '../lib/arrivalFocus';
import { pickServerDirectory } from '../lib/directoryPicker';
import { readHosts, type PeerHost } from '../lib/hosts';

const emit = defineEmits<{ created: [projectId: string] }>();

const isBrowser = window.patterm.runtime === 'browser';
const open = ref(false);
const pathInput = ref<{ $el?: unknown } | null>(null);
const peers = ref<PeerHost[]>([]);
const selectedHost = ref<string | null>(null);
const path = ref('');
const name = ref('');
const error = ref('');
const busy = ref(false);
// The new project opens on its new conversation page, which keeps focus.
let created = false;

const connectedPeers = computed(() => peers.value.filter((peer) => peer.link.state === 'connected'));
const hostOptions = computed(() => [
  { value: null as string | null, label: 'This host' },
  ...connectedPeers.value.map((peer) => ({ value: peer.name as string | null, label: peer.name }))
]);

watch(open, async (isOpen) => {
  if (!isOpen) return;
  try {
    const overview = await readHosts();
    peers.value = overview.peers;
    if (selectedHost.value && !connectedPeers.value.some((peer) => peer.name === selectedHost.value)) selectedHost.value = null;
  } catch {
    peers.value = [];
    selectedHost.value = null;
  }
});

watch(selectedHost, () => {
  path.value = '';
  error.value = '';
});

useAutofocus(open, pathInput);

function onCloseAutoFocus(event: Event): void {
  if (created && focusArrivalInput()) event.preventDefault();
  created = false;
}

async function browse(): Promise<void> {
  const picked = selectedHost.value
    ? await pickServerDirectory(path.value.trim(), selectedHost.value)
    : await window.patterm?.pickDirectory?.(path.value.trim());
  if (picked) {
    path.value = picked;
  }
}

async function submit(): Promise<void> {
  if (busy.value || path.value.trim().length === 0) {
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const result = (await window.patterm?.call?.('project_create', {
      path: path.value.trim(),
      name: name.value.trim(),
    }, selectedHost.value ?? undefined)) as { project_id?: string } | null;
    open.value = false;
    path.value = '';
    name.value = '';
    if (result?.project_id) {
      created = true;
      emit('created', result.project_id);
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}

</script>
