<template>
  <div v-if="viewer.error && !viewer.summary" role="alert" class="mx-auto max-w-md px-6 py-16 text-center text-sm text-destructive">{{ viewer.error }}</div>
  <div v-else-if="viewer.summary && !viewer.summary.files.length" role="status" class="mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-16 text-center">
    <GitCompareArrows class="h-5 w-5 text-muted-foreground" aria-hidden="true" />
    <p class="text-sm">{{ viewer.scope === 'branch' ? `No changes since ${viewer.summary.base.ref ?? 'the last commit'}` : 'No uncommitted changes' }}</p>
    <p class="text-xs text-muted-foreground">{{ viewer.scope === 'branch' ? 'Commits, uncommitted edits, and new files on this branch appear here.' : 'Edits and new files appear here until they are committed.' }}</p>
  </div>
  <div v-else-if="viewer.summary && !viewer.files.length" role="status" class="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
    <p class="text-sm">Filters hide all {{ viewer.hiddenFiles }} changed {{ viewer.hiddenFiles === 1 ? 'file' : 'files' }}</p>
    <Button variant="outline" size="sm" @click="viewer.filters.excludeDocs = false; viewer.filters.excludeTests = false">Show all files</Button>
  </div>
</template>

<script setup lang="ts">
import { GitCompareArrows } from 'lucide-vue-next';
import { Button } from './ui/button';
import type { WorktreeDiffViewerState } from '../Composables/useWorktreeDiff';

defineProps<{ viewer: WorktreeDiffViewerState }>();
</script>
