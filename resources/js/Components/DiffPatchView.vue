<template>
  <p v-if="isEmpty" class="rounded-md border border-border/60 bg-background/60 p-3 text-sm text-muted-foreground">
    No tracked patch to render.
  </p>
  <div v-else-if="isDeferred" class="space-y-2 rounded-md border border-border/60 bg-background/60 p-3 text-sm text-muted-foreground">
    <p>{{ deferredSummary }}</p>
    <button type="button" class="rounded-md border border-border/70 px-2 py-1 text-xs text-foreground hover:bg-muted/50" @click="renderDeferredPatch">
      Render diff
    </button>
  </div>
  <div v-else class="space-y-2">
    <p v-if="isRendering" class="rounded-md border border-border/60 bg-background/60 p-3 text-sm text-muted-foreground">
      Rendering diff...
    </p>
    <div v-show="!isRendering" ref="container" class="overflow-hidden rounded-md border border-border/60 bg-background/60" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { FileDiff, parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import '../lib/diffLanguages';

const props = defineProps<{ patch: string; cacheKey: string }>();
const container = ref<HTMLElement | null>(null);
const isEmpty = ref(false);
const isDeferred = ref(false);
const isRendering = ref(false);
const renderRequested = ref(false);
const instances: FileDiff[] = [];
let renderToken = 0;

const LARGE_PATCH_BYTES = 1_000_000;
const LARGE_PATCH_FILES = 100;
const LARGE_PATCH_LINES = 10_000;
const deferredSummary = computed(() => {
  const estimate = estimatePatch(props.patch);
  return `Large diff: ${estimate.files} files, ${estimate.lines} lines, ${formatBytes(estimate.bytes)}. Render on demand to keep the UI responsive.`;
});

onMounted(renderPatch);
watch(() => [props.patch, props.cacheKey], () => {
  renderRequested.value = false;
  void renderPatch();
});

onBeforeUnmount(() => {
  renderToken += 1;
  cleanup();
});

async function renderPatch(): Promise<void> {
  const token = ++renderToken;
  await nextTick();
  const root = container.value;
  if (!root) return;

  cleanup();
  root.replaceChildren();
  isRendering.value = false;

  const estimate = estimatePatch(props.patch);
  isEmpty.value = props.patch.trim().length === 0;
  if (isEmpty.value) {
    isDeferred.value = false;
    return;
  }
  if (!renderRequested.value && shouldDefer(estimate)) {
    isDeferred.value = true;
    return;
  }

  isDeferred.value = false;
  isRendering.value = true;
  await yieldToBrowser();
  if (token !== renderToken) return;
  const patches = parsePatchFiles(props.patch, props.cacheKey);
  const files = patches.flatMap((patch) => patch.files);
  isEmpty.value = files.length === 0;
  if (isEmpty.value) {
    isRendering.value = false;
    return;
  }

  for (const [index, file] of files.entries()) {
    if (token !== renderToken) return;
    renderFile(root, file);
    if (index % 2 === 1) await yieldToBrowser();
  }
  if (token === renderToken) isRendering.value = false;
}

function renderDeferredPatch(): void {
  renderRequested.value = true;
  void renderPatch();
}

function renderFile(root: HTMLElement, fileDiff: FileDiffMetadata): void {
  const host = document.createElement('div');
  host.className = 'border-b border-border/50 last:border-b-0';
  root.appendChild(host);

  const instance = new FileDiff({
    themeType: 'dark',
    diffStyle: 'split',
    overflow: 'scroll',
    stickyHeader: true,
    hunkSeparators: 'line-info-basic'
  });
  // The library creates and manages its own `diffs-container` custom element
  // (which adopts the base stylesheet) when given a wrapper. Passing a plain
  // div as fileContainer bypasses that stylesheet and breaks the split layout.
  instance.render({ fileDiff, containerWrapper: host });
  instances.push(instance);
}

function cleanup(): void {
  while (instances.length > 0) {
    instances.pop()?.cleanUp();
  }
}

interface PatchEstimate {
  bytes: number;
  files: number;
  lines: number;
}

function estimatePatch(patch: string): PatchEstimate {
  const lines = patch ? patch.split('\n').length : 0;
  const files = (patch.match(/^diff --git /gm) ?? []).length;
  return { bytes: patch.length, files, lines };
}

function shouldDefer(estimate: PatchEstimate): boolean {
  return estimate.bytes > LARGE_PATCH_BYTES || estimate.files > LARGE_PATCH_FILES || estimate.lines > LARGE_PATCH_LINES;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KiB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MiB`;
}
</script>
