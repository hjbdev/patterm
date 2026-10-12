<template>
  <div class="relative min-w-0" data-component="worktree-file-diff">
    <LoadingBar :active="loading" label="Loading file diff" />
    <p v-if="error" role="alert" class="px-4 py-6 text-sm text-destructive">{{ error }}</p>
    <p v-else-if="notice" role="status" class="px-4 py-10 text-center text-sm text-muted-foreground">{{ notice }}</p>
    <div v-show="!error && !notice" ref="host" class="worktree-file-diff min-w-0" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { FileDiff } from '@pierre/diffs';
import '../lib/diffLanguages';
import LoadingBar from './LoadingBar.vue';
import { loadDiffFile } from '../Composables/useWorktreeDiff';
import { DIFF_LINE_DIFF_TYPE, DIFF_THEME, diffFileContents, diffHighlighterPool } from '../lib/diffHighlighter';
import type { DiffScope, DiffStyle, WorktreeDiffFile, WorktreeDiffFileContents } from '../lib/worktreeDiff';

const props = defineProps<{ worktreeId: string; baseCommit: string; file: WorktreeDiffFile; scope: DiffScope; diffStyle: DiffStyle }>();

const host = ref<HTMLElement>();
const contents = shallowRef<WorktreeDiffFileContents | null>(null);
const loading = ref(false);
const error = ref('');
const notice = computed(() => {
  if (contents.value?.binary) return 'Binary file. Nothing to show here.';
  if (contents.value?.tooLarge) return 'This file is too large to show here.';
  return '';
});
let instance: FileDiff | null = null;
let generation = 0;

// The previous file stays on screen until the next one is ready; prefetched
// files resolve at once.
async function load(): Promise<void> {
  const current = ++generation;
  loading.value = true;
  try {
    const result = await loadDiffFile(props.worktreeId, props.scope, props.baseCommit, props.file);
    if (current !== generation) return;
    contents.value = result;
    error.value = '';
    render();
  } catch (cause) {
    if (current !== generation) return;
    contents.value = null;
    error.value = cause instanceof Error ? cause.message : String(cause);
    cleanup();
  } finally {
    if (current === generation) loading.value = false;
  }
}

// Full contents on both sides let Pierre expand the unchanged lines between hunks.
function render(): void {
  cleanup();
  const data = contents.value;
  const root = host.value;
  if (!data || !root || data.binary || data.tooLarge) return;
  instance = new FileDiff({
    theme: DIFF_THEME,
    themeType: 'dark',
    diffStyle: props.diffStyle,
    overflow: 'scroll',
    disableFileHeader: true,
    hunkSeparators: 'line-info',
    lineDiffType: DIFF_LINE_DIFF_TYPE,
    diffIndicators: 'bars',
    expansionLineCount: 20,
    preferredHighlighter: 'shiki-wasm'
  }, diffHighlighterPool());
  instance.render({ ...diffFileContents(props.worktreeId, props.baseCommit, props.file, data), containerWrapper: root });
}

function cleanup(): void {
  instance?.cleanUp();
  instance = null;
  host.value?.replaceChildren();
}

// Polls replace the file object; reload only when the file or its content changes.
watch(() => `${props.worktreeId}\0${props.file.path}\0${props.scope}\0${props.baseCommit}\0${props.file.version}`, () => void load(), { immediate: true });
watch(() => props.diffStyle, render);

onBeforeUnmount(() => {
  generation++;
  cleanup();
});
</script>

<style scoped>
/* Pierre draws inside its own shadow root; custom properties still inherit.
   Context lines share the workspace surface, so a short file has no seam. */
.worktree-file-diff :deep(diffs-container) {
  --diffs-bg: hsl(var(--background));
  --diffs-bg-context-override: hsl(var(--background));
  --diffs-font-family: ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, monospace;
  --diffs-header-font-family: var(--patterm-ui-font-family);
  --diffs-font-size: 12.5px;
  --diffs-line-height: 20px;
}
</style>
