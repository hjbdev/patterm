<template>
  <span class="inline-flex shrink-0 items-center gap-1.5 font-mono tabular-nums" :aria-label="`${additions} additions, ${deletions} deletions`">
    <span class="text-diff-add" aria-hidden="true">+{{ formatDiffCount(additions) }}</span>
    <span class="text-diff-remove" aria-hidden="true">−{{ formatDiffCount(deletions) }}</span>
  </span>
</template>

<script setup lang="ts">
import { formatDiffCount } from '../lib/worktreeDiff';

defineProps<{ additions: number; deletions: number }>();
</script>
