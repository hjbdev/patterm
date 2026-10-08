<template>
  <div class="max-w-80 p-2 text-left">
    <p class="whitespace-pre-wrap break-words text-xs text-foreground" :title="`Generated ${new Date(summary.generatedAt).toLocaleString()}`">{{ summary.text }}</p>
  </div>
</template>
<script setup lang="ts">
import type { AutoSummaryRecord } from '../types';
defineProps<{ summary: AutoSummaryRecord }>();
</script>
