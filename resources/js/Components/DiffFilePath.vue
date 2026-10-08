<template>
  <div class="flex min-w-0 items-center gap-2">
    <DiffFileStatus :file="file" />
    <p class="min-w-0 truncate font-mono text-xs" :title="file.previousPath ? `${file.previousPath} → ${file.path}` : file.path">
      <span v-if="directory" class="text-muted-foreground">{{ directory }}/</span><span class="text-foreground">{{ name }}</span>
    </p>
    <span v-if="file.previousPath" class="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">from {{ file.previousPath }}</span>
    <DiffStat v-if="!file.binary" class="text-[11px]" :additions="file.additions" :deletions="file.deletions" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import DiffFileStatus from './DiffFileStatus.vue';
import DiffStat from './DiffStat.vue';
import { directoryName, fileName, type WorktreeDiffFile } from '../lib/worktreeDiff';

const props = defineProps<{ file: WorktreeDiffFile }>();
const directory = computed(() => directoryName(props.file.path));
const name = computed(() => fileName(props.file.path));
</script>
