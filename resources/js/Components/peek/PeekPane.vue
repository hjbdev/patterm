<template>
  <!-- One thing beside the agent: a server's page, an image, a worktree's
       changes, or the whole session context. Opening another replaces it; Esc
       or × closes it. -->
  <SessionContextPanel v-if="peek.kind === 'context'" :project-id="projectId" :session-id="sessionId" :summary="summary" :can-summarize="Boolean(canSummarize)" :active-worktree-id="activeWorktreeId" @open-worktree="emit('openWorktree', $event)" @close="emit('close')" />
  <div v-else class="flex min-h-0 flex-1 flex-col">
    <header class="flex h-11 shrink-0 items-center gap-1 pl-4 pr-2">
      <template v-if="peek.kind === 'preview'">
        <h2 class="shrink-0 truncate text-[13px] font-medium">{{ peek.label }}</h2>
        <a :href="peek.url" target="_blank" rel="noopener noreferrer" class="ml-1 min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground transition-colors hover:text-foreground" :title="peek.url">{{ address }}</a>
        <Button variant="ghost" size="icon" :class="ACTION" aria-label="Reload" title="Reload" @click="reloads += 1"><RotateCw class="h-3.5 w-3.5" /></Button>
        <Button as="a" variant="ghost" size="icon" :class="ACTION" :href="peek.url" target="_blank" rel="noopener noreferrer" aria-label="Open in browser" title="Open in browser"><ExternalLink class="h-3.5 w-3.5" /></Button>
      </template>
      <template v-else-if="peek.kind === 'image'">
        <h2 class="min-w-0 truncate text-[13px] font-medium">{{ image?.name ?? 'Image' }}</h2>
        <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{{ peek.index + 1 }} of {{ peek.images.length }}</span>
        <span class="flex-1" />
        <template v-if="peek.images.length > 1">
          <Button variant="ghost" size="icon" :class="ACTION" aria-label="Previous image" @click="step(-1)"><ChevronLeft class="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" :class="ACTION" aria-label="Next image" @click="step(1)"><ChevronRight class="h-4 w-4" /></Button>
        </template>
        <Button v-if="image" as-child variant="ghost" size="icon" :class="ACTION"><RouterLink :to="image.to" aria-label="Show in conversation" title="Show in conversation"><MessageSquare class="h-3.5 w-3.5" /></RouterLink></Button>
      </template>
      <template v-else>
        <h2 class="min-w-0 truncate text-[13px] font-medium">{{ peek.worktree.branch ?? 'Changes' }}</h2>
        <DiffStat v-if="totals" :additions="totals.additions" :deletions="totals.deletions" class="shrink-0" />
        <span class="flex-1" />
        <Button variant="ghost" size="sm" class="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground" @click="emit('openWorktree', peek.worktree)"><FileDiff class="h-3.5 w-3.5" />Open diff review</Button>
      </template>
      <Button variant="ghost" size="icon" :class="ACTION" aria-label="Close peek" @click="emit('close')"><X class="h-4 w-4" /></Button>
    </header>
    <!-- The page fills the pane. One that refuses to be framed, or plain HTTP
         from a secure page, shows blank; Open in browser still works. -->
    <iframe v-if="peek.kind === 'preview'" :key="`${peek.url}:${reloads}`" :src="peek.url" :title="peek.label" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" referrerpolicy="no-referrer" class="min-h-0 w-full flex-1 bg-white" />
    <template v-else-if="peek.kind === 'image'">
      <!-- Swipe or arrow keys step through the images. -->
      <div class="flex min-h-0 flex-1 touch-pan-y items-center justify-center px-3 pb-3" tabindex="-1" @keydown.left.prevent="step(-1)" @keydown.right.prevent="step(1)" @pointerdown="swipeStart" @pointerup="swipeEnd">
        <img v-if="imageUrl" :src="imageUrl" :alt="image?.name ?? 'Image'" class="max-h-full max-w-full rounded-md object-contain" draggable="false">
        <p v-else-if="imageFailed" class="text-sm text-muted-foreground">This image is no longer stored.</p>
      </div>
      <div v-if="peek.images.length > 1" class="flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-3 [scrollbar-width:none]">
        <span v-for="(item, index) in peek.images" :key="item.key" class="w-12 shrink-0 rounded-md" :class="index === peek.index && 'ring-2 ring-foreground/80 ring-offset-1 ring-offset-background'">
          <MediaThumb :image="item" :project-id="projectId" @open="emit('update:peek', { ...peek, index })" />
        </span>
      </div>
    </template>
    <PeekDiff v-else :worktree-id="peek.worktree.id" @review="emit('openWorktree', peek.worktree)" @loaded="totals = $event.totals" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { ChevronLeft, ChevronRight, ExternalLink, FileDiff, MessageSquare, RotateCw, X } from 'lucide-vue-next';
import DiffStat from '../DiffStat.vue';
import SessionContextPanel from '../session-context/SessionContextPanel.vue';
import { Button } from '../ui/button';
import MediaThumb from './MediaThumb.vue';
import PeekDiff from './PeekDiff.vue';
import type { SessionWorktree } from '../../lib/projectContext';
import type { Peek } from '../../lib/peek';
import { previewAddress } from '../../lib/servers';
import { transcriptImageUrl } from '../../lib/transcriptImages';
import type { DiffTotals } from '../../lib/worktreeDiff';
import type { AutoSummaryRecord } from '../../types';

const props = defineProps<{ peek: Peek; projectId: string; sessionId: string; summary?: AutoSummaryRecord | null | undefined; canSummarize?: boolean | undefined; activeWorktreeId?: string | null | undefined }>();
const emit = defineEmits<{ close: []; 'update:peek': [peek: Peek]; openWorktree: [worktree: SessionWorktree] }>();
const ACTION = 'h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground';

const reloads = ref(0);
// The address without its scheme, as a browser's bar shows it.
const address = computed(() => props.peek.kind === 'preview' ? previewAddress(props.peek.url) : '');

const totals = ref<DiffTotals | null>(null);
watch(() => props.peek.kind === 'diff' ? props.peek.worktree.id : null, () => { totals.value = null; });

const image = computed(() => props.peek.kind === 'image' ? props.peek.images[props.peek.index] ?? null : null);
const imageUrl = ref<string | null>(null), imageFailed = ref(false);
watch(() => image.value?.sha256, (sha256) => {
  imageUrl.value = null;
  imageFailed.value = false;
  if (!sha256) return;
  transcriptImageUrl(sha256, props.projectId).then(
    (url) => { if (image.value?.sha256 === sha256) imageUrl.value = url; },
    () => { if (image.value?.sha256 === sha256) imageFailed.value = true; }
  );
}, { immediate: true });

function step(delta: number): void {
  if (props.peek.kind !== 'image' || props.peek.images.length < 2) return;
  const count = props.peek.images.length;
  emit('update:peek', { ...props.peek, index: (props.peek.index + delta + count) % count });
}
let swipeX: number | null = null;
function swipeStart(event: PointerEvent): void {
  swipeX = event.pointerType === 'mouse' ? null : event.clientX;
}
function swipeEnd(event: PointerEvent): void {
  if (swipeX === null) return;
  const dx = event.clientX - swipeX;
  swipeX = null;
  if (Math.abs(dx) > 48) step(dx < 0 ? 1 : -1);
}
</script>
