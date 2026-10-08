<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <slot name="trigger" />
    </DialogTrigger>
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>{{ isBrowser ? 'Register a project using a directory on the server.' : 'Register a local project rooted at a directory on disk.' }}</DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" @submit.prevent="submit">
        <div class="flex flex-col gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ isBrowser ? 'Server path' : 'Path' }}</label>
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
import { ref } from 'vue';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { Input } from './ui/input';
import { useAutofocus } from '../Composables/useAutofocus';

const emit = defineEmits<{ created: [projectId: string] }>();

const isBrowser = window.patterm.runtime === 'browser';
const open = ref(false);
const pathInput = ref<{ $el?: unknown } | null>(null);
const path = ref('');
const name = ref('');
const error = ref('');
const busy = ref(false);

useAutofocus(open, pathInput);

async function browse(): Promise<void> {
  const picked = await window.patterm?.pickDirectory?.(path.value.trim());
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
    const result = (await window.patterm?.call?.('patterm.project.create', {
      path: path.value.trim(),
      name: name.value.trim(),
    })) as { project_id?: string } | null;
    open.value = false;
    path.value = '';
    name.value = '';
    if (result?.project_id) {
      emit('created', result.project_id);
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}

</script>
