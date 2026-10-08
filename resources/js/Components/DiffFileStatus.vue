<template>
  <span
    class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] font-semibold leading-none"
    :class="tone"
    :title="label"
    role="img"
    :aria-label="label"
  >{{ letter }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { diffStatus, type WorktreeDiffFile } from '../lib/worktreeDiff';

const props = defineProps<{ file: WorktreeDiffFile }>();

const letter = computed(() => diffStatus(props.file.status).letter);
const label = computed(() => {
  const status = diffStatus(props.file.status).label;
  if (props.file.untracked) return `${status}, untracked`;
  return props.file.previousPath ? `${status} from ${props.file.previousPath}` : status;
});
const tone = computed(() => {
  switch (props.file.status) {
    case 'added': return 'bg-diff-add/10 text-diff-add';
    case 'deleted': return 'bg-diff-remove/10 text-diff-remove';
    case 'renamed': case 'copied': return 'bg-sky-400/10 text-sky-400';
    default: return 'bg-warning/10 text-warning';
  }
});
</script>
