<template>
  <!-- Where a new conversation starts: the project, and on it a worktree. -->
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button type="button" variant="ghost" size="sm" :class="PICKER" :aria-label="`Project: ${target?.project.name ?? 'Choose a project'}`">
        <ProjectLogo v-if="target" :project="target.project" :size="13" />
        <span class="truncate">{{ target?.project.name ?? 'Choose a project' }}</span>
        <HostBadge v-if="target?.host" :host="target.host" />
        <ChevronsUpDown class="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="center" class="max-h-72 w-64 overflow-y-auto" @close-auto-focus="emit('closeAutoFocus', $event)">
      <DropdownMenuItem v-for="option in targets" :key="option.targetProjectId" class="gap-2 text-[13px]" @select="emit('update:targetProjectId', option.targetProjectId)">
        <ProjectLogo :project="option.project" :size="14" />
        <span class="min-w-0 flex-1 truncate">{{ option.project.name }}</span>
        <HostBadge v-if="option.host" :host="option.host" />
        <Check class="h-3.5 w-3.5 shrink-0" :class="option.targetProjectId === targetProjectId ? '' : 'invisible'" />
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
  <template v-if="worktrees.length">
    <span aria-hidden="true" class="text-xs opacity-50">·</span>
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button type="button" variant="ghost" size="sm" :class="PICKER" :aria-label="`Run in ${worktreeLabel}`">
          <GitBranch class="h-3 w-3 shrink-0" aria-hidden="true" />
          <span class="truncate">{{ worktreeLabel }}</span>
          <ChevronsUpDown class="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" class="max-h-72 w-64 overflow-y-auto" @close-auto-focus="emit('closeAutoFocus', $event)">
        <DropdownMenuItem class="gap-2 text-[13px]" @select="emit('update:worktreeId', null)">
          <span class="min-w-0 flex-1 truncate">Project checkout</span>
          <Check class="h-3.5 w-3.5 shrink-0" :class="worktreeId === null ? '' : 'invisible'" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem v-for="worktree in worktrees" :key="worktree.id" class="gap-2 text-[13px]" @select="emit('update:worktreeId', worktree.id)">
          <span class="min-w-0 flex-1 truncate">{{ worktreeName(worktree) }}</span>
          <Check class="h-3.5 w-3.5 shrink-0" :class="worktreeId === worktree.id ? '' : 'invisible'" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Check, ChevronsUpDown, GitBranch } from 'lucide-vue-next';
import HostBadge from './HostBadge.vue';
import ProjectLogo from './ProjectLogo.vue';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import type { launchTargets } from '../lib/allAgents';
import type { WorktreeRecord } from '../types';

type LaunchTarget = ReturnType<typeof launchTargets>[number];

const props = defineProps<{ targets: readonly LaunchTarget[]; targetProjectId: string; worktrees: readonly WorktreeRecord[]; worktreeId: string | null }>();
const emit = defineEmits<{ 'update:targetProjectId': [id: string]; 'update:worktreeId': [id: string | null]; closeAutoFocus: [event: Event] }>();

const PICKER = 'h-8 max-w-56 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground';

const target = computed(() => props.targets.find((option) => option.targetProjectId === props.targetProjectId) ?? null);
const worktreeLabel = computed(() => {
  const worktree = props.worktrees.find((candidate) => candidate.id === props.worktreeId);
  return worktree ? worktreeName(worktree) : 'Project checkout';
});
function worktreeName(worktree: WorktreeRecord): string {
  return worktree.branch ?? worktree.worktreePath.slice(worktree.worktreePath.lastIndexOf('/') + 1);
}
</script>
