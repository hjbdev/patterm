<template>
  <div class="h-full overflow-auto bg-background p-6">
    <div class="mx-auto max-w-6xl space-y-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h1 class="text-xl font-semibold tracking-tight">Worktrees</h1>
        <div class="flex gap-1">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground" aria-label="Link worktree" @click="openForm('link')"><Link2 class="h-4 w-4" /></Button>
            </TooltipTrigger>
            <TooltipContent>Link worktree</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground" aria-label="Create worktree" @click="openForm('create')"><Plus class="h-4 w-4" /></Button>
            </TooltipTrigger>
            <TooltipContent>Create worktree</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
      <EmptyState v-if="!project.worktrees.length" title="No linked worktrees" description="Create a worktree or link an existing one to this project." />
      <article v-for="worktree in project.worktrees" :key="worktree.id" class="rounded-xl border border-border/70 bg-card/40 p-4">
        <h2 class="text-sm font-medium">{{ worktree.branch ?? 'Detached HEAD' }}</h2>
        <p class="mt-1 break-all font-mono text-xs text-muted-foreground">{{ worktree.worktreePath }}</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" :disabled="busy" @click="openShell(worktree.id)">Open terminal</Button>
          <Button variant="ghost" size="sm" :disabled="busy" @click="unlink(worktree.id)">Unlink</Button>
        </div>
      </article>
    </div>
    <Dialog v-model:open="formOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ formMode === 'create' ? 'Create worktree' : 'Link worktree' }}</DialogTitle>
          <DialogDescription>{{ remoteHost ? `Paths refer to directories on ${remoteHost}.` : isBrowser ? 'Paths refer to directories on the server.' : 'Worktrees belong to this project.' }}</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submit">
          <div v-if="formMode === 'create'" class="space-y-1.5">
            <label for="worktree-name" class="text-xs font-medium text-muted-foreground">Name</label>
            <Input id="worktree-name" v-model="name" placeholder="feature-name" required />
          </div>
          <div class="space-y-1.5">
            <label for="worktree-path" class="text-xs font-medium text-muted-foreground">{{ remoteHost ? `Path on ${remoteHost}` : isBrowser ? 'Server path' : 'Path' }}{{ formMode === 'create' ? ' (optional)' : '' }}</label>
            <div class="flex gap-2">
              <Input id="worktree-path" v-model="path" class="font-mono" placeholder="/path/to/worktree" :required="formMode === 'link'" />
              <Button v-if="!remoteHost" type="button" variant="outline" @click="browse">Browse…</Button>
            </div>
          </div>
          <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
          <DialogFooter><Button type="submit" :disabled="busy || (formMode === 'create' ? !name.trim() : !path.trim())">{{ formMode === 'create' ? 'Create' : 'Link' }}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Link2, Plus } from 'lucide-vue-next';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import type { ProjectWorkbench } from '../types';
import { useWorkbench } from '../Composables/useWorkbench';
import EmptyState from './EmptyState.vue';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';

const props = defineProps<{ project: ProjectWorkbench }>();
const emit = defineEmits<{ selectTerminal: [processId: string] }>();
const { refresh } = useWorkbench();
const isBrowser = window.patterm.runtime === 'browser';
// A paired host's project has paths on that host, which this machine's
// folder picker cannot browse.
const remoteHost = computed(() => props.project.project.host ?? null);
const busy = ref(false);
const error = ref('');
const formOpen = ref(false);
const formMode = ref<'create' | 'link'>('create');
const name = ref('');
const path = ref('');

function openForm(mode: 'create' | 'link'): void {
  formMode.value = mode;
  name.value = '';
  path.value = '';
  error.value = '';
  formOpen.value = true;
}

async function browse(): Promise<void> {
  await run(async () => { path.value = await window.patterm.pickDirectory(path.value.trim()) ?? path.value; });
}

async function submit(): Promise<void> {
  await run(async () => {
    await window.patterm.call(`worktree_${formMode.value}`, {
      project_id: props.project.project.id,
      ...(formMode.value === 'create' ? { name: name.value.trim() } : {}),
      ...(path.value.trim() ? { worktree_path: path.value.trim() } : {})
    });
    await refresh();
    formOpen.value = false;
  });
}

async function openShell(worktreeId: string): Promise<void> {
  await run(async () => {
    const result = await window.patterm.call('process_create', { project_id: props.project.project.id, worktree_id: worktreeId }) as { pty_process_id?: string };
    await refresh();
    if (result.pty_process_id) emit('selectTerminal', result.pty_process_id);
  });
}

async function unlink(worktreeId: string): Promise<void> {
  await run(async () => {
    await window.patterm.call('worktree_abandon', { worktree_id: worktreeId });
    await refresh();
  });
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try { await action(); }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); }
  finally { busy.value = false; }
}
</script>
