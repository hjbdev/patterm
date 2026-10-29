<template>
  <!-- A worktree's changes against its base, file by file. Any file, or the
       header's button, opens the full diff review. -->
  <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
    <p v-if="error" class="px-2 py-1 text-sm text-destructive">{{ error }}</p>
    <p v-else-if="summary && !summary.files.length" class="px-2 py-1 text-sm text-muted-foreground">No changes against {{ summary.base.ref ?? 'the base' }}.</p>
    <button v-for="file in summary?.files ?? []" :key="file.path" type="button" class="flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-sm:min-h-11" @click="emit('review')">
      <DiffFilePath :file="file" class="min-w-0 flex-1" />
    </button>
    <p v-if="summary?.truncated" class="px-2 py-1 text-xs text-muted-foreground">More files changed than are listed here.</p>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import DiffFilePath from '../DiffFilePath.vue';
import type { WorktreeDiffSummary } from '../../lib/worktreeDiff';

const props = defineProps<{ worktreeId: string }>();
const emit = defineEmits<{ review: []; loaded: [summary: WorktreeDiffSummary] }>();
const summary = ref<WorktreeDiffSummary | null>(null), error = ref('');
watch(() => props.worktreeId, async (id) => {
  summary.value = null;
  error.value = '';
  try {
    const result = await window.patterm.call('diff_current', { worktree_id: id, scope: 'branch' }) as WorktreeDiffSummary;
    if (id !== props.worktreeId) return;
    summary.value = result;
    emit('loaded', result);
  } catch (cause) {
    if (id === props.worktreeId) error.value = cause instanceof Error ? cause.message : String(cause);
  }
}, { immediate: true });
</script>
