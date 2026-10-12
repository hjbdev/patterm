<template>
  <div class="max-w-80 p-2 text-left">
    <p class="whitespace-pre-wrap break-words text-xs text-foreground" :title="`Generated ${new Date(summary.generatedAt).toLocaleString()}`">{{ summary.text }}</p>
    <p v-if="summary.coverage && summary.coverage !== 'complete'" class="mt-1 text-[10px] text-muted-foreground">{{ summary.coverage === 'stale' ? 'History changed; recap may be out of date' : summary.coverage === 'catching_up' ? 'Catching up with history' : 'Partial history coverage' }}</p>
  </div>
</template>
<script setup lang="ts">
import type { AutoSummaryRecord } from '../types';
defineProps<{ summary: AutoSummaryRecord }>();
</script>
