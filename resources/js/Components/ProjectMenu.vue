<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 rounded-tab text-muted-foreground" :aria-label="`Actions for ${project.name}`" title="Project actions">
        <MoreHorizontal class="h-4 w-4" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem @select="openRename"><Pencil class="h-4 w-4" /><span>Rename…</span></DropdownMenuItem>
      <DropdownMenuItem @select="emit('changeLogo')"><ImageIcon class="h-4 w-4" /><span>Change logo…</span></DropdownMenuItem>
      <template v-if="project.kind !== 'personal'">
        <DropdownMenuSeparator />
        <DropdownMenuItem class="text-destructive focus:text-destructive" @select="openRemove"><Trash2 class="h-4 w-4" /><span>Remove…</span></DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>

  <Dialog v-model:open="renameOpen">
    <DialogContent class="sm:max-w-sm">
      <DialogHeader>
        <DialogTitle>Rename project</DialogTitle>
        <DialogDescription>Changes the name Patterm shows. The folder keeps its name.</DialogDescription>
      </DialogHeader>
      <form class="flex flex-col gap-3" @submit.prevent="submitRename">
        <Input v-model="name" aria-label="Project name" maxlength="200" />
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter><Button type="submit" :disabled="busy || !name.trim()">Save</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="removeOpen">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Remove {{ project.name }}?</DialogTitle>
        <DialogDescription>This deletes everything Patterm holds for it and can’t be undone.</DialogDescription>
      </DialogHeader>
      <div class="space-y-2 text-sm text-muted-foreground">
        <p v-if="liveAgents" class="text-foreground">{{ liveAgents === 1 ? '1 agent is' : `${liveAgents} agents are` }} running and will be stopped.</p>
        <p>Its agents and processes, worktree records, todos, scratchpads, links, routines, and conversation history are deleted.</p>
        <p>Files on disk stay: <span class="font-mono text-foreground">{{ project.path }}</span>, its worktree folders, and its branches.</p>
      </div>
      <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
      <DialogFooter class="gap-2">
        <Button type="button" variant="ghost" :disabled="busy" @click="removeOpen = false">Cancel</Button>
        <Button type="button" variant="ghost" class="text-destructive hover:text-destructive" :disabled="busy" @click="submitRemove">Remove project</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Image as ImageIcon, MoreHorizontal, Pencil, Trash2 } from 'lucide-vue-next';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Input } from './ui/input';
import type { ProjectSummary } from '../types';

const props = defineProps<{ project: ProjectSummary; liveAgents?: number }>();
const emit = defineEmits<{ changeLogo: [] }>();

const renameOpen = ref(false);
const removeOpen = ref(false);
const name = ref('');
const busy = ref(false);
const error = ref('');

function openRename(): void {
  name.value = props.project.name;
  error.value = '';
  renameOpen.value = true;
}

function openRemove(): void {
  error.value = '';
  removeOpen.value = true;
}

async function submitRename(): Promise<void> {
  const next = name.value.trim();
  if (busy.value || !next) return;
  await run(() => window.patterm.call('project_rename', { project_id: props.project.id, name: next }), renameOpen);
}

async function submitRemove(): Promise<void> {
  if (busy.value) return;
  await run(() => window.patterm.call('project_remove', { project_id: props.project.id }), removeOpen);
}

async function run(call: () => Promise<unknown>, open: typeof renameOpen): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await call();
    open.value = false;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}
</script>
