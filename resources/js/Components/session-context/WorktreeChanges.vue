<template>
  <template v-if="state?.totals">
    <span v-if="!state.totals.files" class="shrink-0 text-[11px] text-muted-foreground/80">No changes</span>
    <DiffStat v-else class="text-[11px]" :additions="state.totals.additions" :deletions="state.totals.deletions" />
  </template>
  <span v-else-if="state?.error" class="shrink-0 text-[11px] text-muted-foreground/80" :title="state.error">Unavailable</span>
</template>

<script setup lang="ts">
import DiffStat from '../DiffStat.vue';
import type { WorktreeDiffTotalsState } from '../../Composables/useWorktreeDiff';

defineProps<{ state: WorktreeDiffTotalsState | undefined }>();
</script>
