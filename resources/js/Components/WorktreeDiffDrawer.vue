<template>
  <section
    ref="root"
    tabindex="-1"
    role="dialog"
    :aria-label="`Changes in ${name}`"
    class="absolute inset-0 z-40 flex min-h-0 flex-col bg-background outline-none"
    data-component="worktree-diff-drawer"
    @keydown="keydown"
  >
    <header class="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
      <Button variant="ghost" size="sm" class="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground" :aria-label="`Back to ${returnLabel.toLowerCase()}`" @click="emit('close')">
        <ArrowLeft class="h-3.5 w-3.5" aria-hidden="true" />
        <span class="hidden sm:inline">{{ returnLabel }}</span>
      </Button>
      <span class="text-muted-foreground/60" aria-hidden="true">/</span>
      <GitBranch class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <h2 class="min-w-0 truncate text-sm font-[440]" :title="worktree.worktree_path">{{ name }}</h2>
      <span v-if="scopeLabel" class="hidden shrink-0 text-xs text-muted-foreground md:inline">{{ scopeLabel }}</span>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <span v-if="viewer.summary" class="hidden items-center gap-2 text-xs text-muted-foreground lg:flex">
          {{ viewer.totals.files }} {{ viewer.totals.files === 1 ? 'file' : 'files' }}
          <DiffStat :additions="viewer.totals.additions" :deletions="viewer.totals.deletions" />
        </span>
        <DiffViewOptions :viewer="viewer" :compact="compact" />
        <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" aria-label="Refresh changes" title="Refresh changes" @click="viewer.refresh()"><RefreshCw class="h-3.5 w-3.5" /></Button>
      </div>
    </header>
    <div class="flex min-h-0 flex-1">
      <aside v-if="!compact" class="flex w-72 shrink-0 flex-col border-r border-border/60 xl:w-80" aria-label="Changed files">
        <div class="flex h-9 shrink-0 items-center justify-between px-3 text-xs text-muted-foreground">
          <span>Files</span>
          <span class="tabular-nums">{{ viewer.files.length }}</span>
        </div>
        <div class="min-h-0 flex-1 overflow-auto overscroll-contain">
          <DiffFileTree :tree="viewer.tree" :selected-path="viewer.selectedFile?.path ?? null" @select="viewer.select" />
        </div>
        <p v-if="footnote" class="shrink-0 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">{{ footnote }}</p>
      </aside>
      <div class="flex min-w-0 flex-1 flex-col">
        <div v-if="viewer.selectedFile" class="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 sm:px-4">
          <Button v-if="compact" variant="ghost" size="sm" class="-ml-1 h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground" aria-label="Show changed files" @click="filesOpen = true">
            <ListTree class="h-3.5 w-3.5" aria-hidden="true" />{{ viewer.files.length }}
          </Button>
          <DiffFilePath :file="viewer.selectedFile" class="min-w-0 flex-1" />
          <div class="flex shrink-0 items-center gap-0.5">
            <span class="mr-1 hidden text-xs tabular-nums text-muted-foreground sm:inline">{{ viewer.selectedIndex + 1 }} of {{ viewer.files.length }}</span>
            <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" aria-label="Previous file" title="Previous file ([)" :disabled="viewer.selectedIndex <= 0" @click="viewer.step(-1)"><ChevronLeft class="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" aria-label="Next file" title="Next file (])" :disabled="viewer.selectedIndex >= viewer.files.length - 1" @click="viewer.step(1)"><ChevronRight class="h-4 w-4" /></Button>
          </div>
        </div>
        <div ref="diffViewport" class="min-h-0 flex-1 overflow-auto overscroll-contain">
          <WorktreeFileDiff v-if="viewer.selectedFile && viewer.summary" :worktree-id="worktree.id" :base-commit="viewer.summary.base.commit" :file="viewer.selectedFile" :scope="viewer.scope" :diff-style="compact ? 'unified' : viewer.diffStyle" />
          <DiffViewerMessage v-else :viewer="viewer" />
        </div>
      </div>
    </div>
    <Sheet v-model:open="filesOpen">
      <SheetContent side="left" class="flex w-[85vw] max-w-sm flex-col gap-0 p-0">
        <SheetHeader class="border-b border-border/60 px-4 py-3 text-left">
          <SheetTitle class="text-sm">Changed files</SheetTitle>
          <SheetDescription class="text-xs">{{ viewer.files.length }} {{ viewer.files.length === 1 ? 'file' : 'files' }}{{ footnote ? ` · ${footnote}` : '' }}</SheetDescription>
        </SheetHeader>
        <div class="min-h-0 flex-1 overflow-auto">
          <DiffFileTree :tree="viewer.tree" :selected-path="viewer.selectedFile?.path ?? null" @select="selectFromSheet" />
        </div>
      </SheetContent>
    </Sheet>
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, ref, toRef, watch } from 'vue';
import { useElementSize } from '@vueuse/core';
import { ArrowLeft, ChevronLeft, ChevronRight, GitBranch, ListTree, RefreshCw } from 'lucide-vue-next';
import DiffFilePath from './DiffFilePath.vue';
import DiffFileTree from './DiffFileTree.vue';
import DiffStat from './DiffStat.vue';
import DiffViewerMessage from './DiffViewerMessage.vue';
import DiffViewOptions from './DiffViewOptions.vue';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { useWorktreeDiffViewer } from '../Composables/useWorktreeDiff';
import { diffFileStepKey, worktreeName } from '../lib/worktreeDiff';
import type { SessionWorktree } from '../lib/projectContext';

// Pierre and Shiki load with the first diff rather than with the app.
const WorktreeFileDiff = defineAsyncComponent(() => import('./WorktreeFileDiff.vue'));

const props = defineProps<{ worktree: SessionWorktree; returnLabel: string }>();
const emit = defineEmits<{ close: [] }>();

const root = ref<HTMLElement>();
const diffViewport = ref<HTMLElement>();
const filesOpen = ref(false);
const viewer = useWorktreeDiffViewer(toRef(() => props.worktree.id));
const { width } = useElementSize(root);
const compact = computed(() => width.value > 0 && width.value < 900);
const name = computed(() => worktreeName({ branch: props.worktree.branch, path: props.worktree.worktree_path }));
const scopeLabel = computed(() => {
  if (viewer.scope === 'uncommitted') return 'uncommitted changes';
  return viewer.summary?.base.ref ? `since ${viewer.summary.base.ref}` : '';
});
const footnote = computed(() => [
  viewer.hiddenFiles ? `${viewer.hiddenFiles} hidden by filters` : '',
  viewer.summary?.truncated ? 'some untracked files not listed' : ''
].filter(Boolean).join(' · '));

// Each file opens at its top.
watch(() => viewer.selectedFile?.path, () => diffViewport.value?.scrollTo({ top: 0 }));

function selectFromSheet(path: string): void {
  viewer.select(path);
  filesOpen.value = false;
}

function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !event.defaultPrevented) {
    event.preventDefault();
    emit('close');
    return;
  }
  const step = diffFileStepKey(event);
  if (step === null) return;
  event.preventDefault();
  viewer.step(step);
}

onMounted(() => void nextTick(() => root.value?.focus()));
</script>
