<template>
  <section
    ref="root"
    tabindex="-1"
    role="dialog"
    :aria-label="`Review changes in ${name}`"
    class="absolute inset-0 z-40 flex min-h-0 flex-col bg-background outline-none"
    data-component="worktree-diff-deck"
    @keydown="keydown"
  >
    <header class="flex h-11 shrink-0 items-center gap-2 px-3">
      <Button variant="ghost" size="sm" class="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground" :aria-label="`Back to ${returnLabel.toLowerCase()}`" @click="emit('close')">
        <ArrowLeft class="h-3.5 w-3.5" aria-hidden="true" />
        <span class="hidden sm:inline">{{ returnLabel }}</span>
      </Button>
      <span class="text-muted-foreground/60" aria-hidden="true">/</span>
      <GitBranch class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <h2 class="min-w-0 truncate text-sm font-[440]" :title="worktree.worktree_path">{{ name }}</h2>
      <span v-if="scopeLabel" class="hidden shrink-0 text-xs text-muted-foreground md:inline">{{ scopeLabel }}</span>
      <div class="ml-auto flex shrink-0 items-center gap-1.5">
        <DiffViewOptions :viewer="viewer" :compact="compact" />
        <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" aria-label="Refresh changes" title="Refresh changes" @click="viewer.refresh()"><RefreshCw class="h-3.5 w-3.5" /></Button>
      </div>
    </header>
    <div v-if="viewer.files.length" class="shrink-0 border-b border-border/60 px-4 pb-3 pt-1">
      <div class="flex items-baseline justify-between gap-3 text-xs">
        <p class="text-foreground"><span class="tabular-nums">{{ viewedCount }}</span> of <span class="tabular-nums">{{ viewer.files.length }}</span> files viewed</p>
        <p class="flex items-center gap-2 text-muted-foreground">
          <template v-if="remaining.files">
            <span class="hidden sm:inline">left to review</span>
            <DiffStat :additions="remaining.additions" :deletions="remaining.deletions" />
          </template>
          <span v-else class="text-diff-add">All files viewed</span>
          <span v-if="viewer.hiddenFiles" class="hidden md:inline">· {{ viewer.hiddenFiles }} hidden by filters</span>
        </p>
      </div>
      <div class="mt-2 flex h-2 w-full gap-[3px]" role="list" aria-label="Changed files, sized by lines changed">
        <button
          v-for="file in viewer.files"
          :key="file.path"
          type="button"
          role="listitem"
          class="h-full min-w-[3px] rounded-[2px] transition-[opacity,transform] hover:scale-y-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none"
          :class="[file.path === viewer.selectedFile?.path ? 'ring-1 ring-foreground ring-offset-2 ring-offset-background' : '', viewed.isViewed(file) && file.path !== viewer.selectedFile?.path ? 'opacity-25' : '']"
          :style="segmentStyle(file)"
          :title="`${file.path} · +${file.additions} −${file.deletions}${viewed.isViewed(file) ? ' · viewed' : ''}`"
          :aria-label="`${file.path}, ${file.additions} additions, ${file.deletions} deletions${viewed.isViewed(file) ? ', viewed' : ''}`"
          :aria-current="file.path === viewer.selectedFile?.path ? 'true' : undefined"
          @click="viewer.select(file.path)"
        />
      </div>
    </div>
    <div v-if="viewer.selectedFile" class="flex h-11 shrink-0 items-center gap-3 border-b border-border/60 px-3 sm:px-4">
      <label class="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
        <Checkbox :model-value="viewed.isViewed(viewer.selectedFile)" aria-label="Viewed" @update:model-value="viewed.setViewed(viewer.selectedFile, $event === true)" />
        <span class="hidden sm:inline">Viewed</span>
      </label>
      <DiffFilePath :file="viewer.selectedFile" class="min-w-0 flex-1" />
      <div class="flex shrink-0 items-center gap-1">
        <Popover v-model:open="pickerOpen">
          <PopoverTrigger as-child>
            <Button variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs text-muted-foreground" aria-label="Jump to a file"><Search class="h-3.5 w-3.5" aria-hidden="true" /><span class="hidden md:inline">Files</span></Button>
          </PopoverTrigger>
          <PopoverContent align="end" class="w-[min(36rem,calc(100vw-2rem))] p-0">
            <Command>
              <CommandInput placeholder="Jump to a changed file…" aria-label="Jump to a changed file" />
              <CommandList class="max-h-80">
                <CommandEmpty class="px-3 py-2 text-left text-xs text-muted-foreground">No matching files.</CommandEmpty>
                <CommandGroup>
                  <CommandItem v-for="file in viewer.files" :key="file.path" :value="file.path" class="gap-2" @select="choose(file.path)">
                    <DiffFilePath :file="file" class="min-w-0 flex-1" :class="{ 'opacity-50': viewed.isViewed(file) }" />
                    <CheckCheck v-if="viewed.isViewed(file)" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Viewed" />
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" aria-label="Previous file" title="Previous file ([)" :disabled="viewer.selectedIndex <= 0" @click="viewer.step(-1)"><ChevronLeft class="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" aria-label="Next file" title="Next file (])" :disabled="viewer.selectedIndex >= viewer.files.length - 1" @click="viewer.step(1)"><ChevronRight class="h-4 w-4" /></Button>
        <Button size="sm" class="ml-1 h-7 gap-1.5 px-2.5 text-xs" title="Mark viewed and open the next unviewed file (v)" @click="markViewedAndNext">
          <span class="hidden sm:inline">Viewed, next</span><span class="sm:hidden">Next</span><ArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
    <div ref="diffViewport" class="min-h-0 flex-1 overflow-auto overscroll-contain">
      <WorktreeFileDiff v-if="viewer.selectedFile && viewer.summary" :worktree-id="worktree.id" :base-commit="viewer.summary.base.commit" :file="viewer.selectedFile" :scope="viewer.scope" :diff-style="compact ? 'unified' : viewer.diffStyle" />
      <DiffViewerMessage v-else :viewer="viewer" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, ref, toRef, watch } from 'vue';
import { useElementSize } from '@vueuse/core';
import { ArrowLeft, ArrowRight, CheckCheck, ChevronLeft, ChevronRight, GitBranch, RefreshCw, Search } from 'lucide-vue-next';
import DiffFilePath from './DiffFilePath.vue';
import DiffStat from './DiffStat.vue';
import DiffViewerMessage from './DiffViewerMessage.vue';
import DiffViewOptions from './DiffViewOptions.vue';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { useViewedDiffFiles, useWorktreeDiffViewer } from '../Composables/useWorktreeDiff';
import { acceptsDiffShortcut, diffFileStepKey, diffTotals, worktreeName, type WorktreeDiffFile } from '../lib/worktreeDiff';
import type { SessionWorktree } from '../lib/projectContext';

// Pierre and Shiki load with the first diff rather than with the app.
const WorktreeFileDiff = defineAsyncComponent(() => import('./WorktreeFileDiff.vue'));

const props = defineProps<{ worktree: SessionWorktree; returnLabel: string }>();
const emit = defineEmits<{ close: [] }>();

const root = ref<HTMLElement>();
const diffViewport = ref<HTMLElement>();
const pickerOpen = ref(false);
const worktreeId = toRef(() => props.worktree.id);
const viewer = useWorktreeDiffViewer(worktreeId);
const viewed = useViewedDiffFiles(worktreeId);
const { width } = useElementSize(root);
const compact = computed(() => width.value > 0 && width.value < 900);
const name = computed(() => worktreeName({ branch: props.worktree.branch, path: props.worktree.worktree_path }));
const scopeLabel = computed(() => {
  if (viewer.scope === 'uncommitted') return 'uncommitted changes';
  return viewer.summary?.base.ref ? `since ${viewer.summary.base.ref}` : '';
});
const viewedCount = computed(() => viewer.files.filter((file) => viewed.isViewed(file)).length);
const remaining = computed(() => diffTotals(viewer.files.filter((file) => !viewed.isViewed(file))));

// Square roots keep one large file from squeezing every other segment flat.
function segmentStyle(file: WorktreeDiffFile): Record<string, string> {
  const changes = file.additions + file.deletions;
  const share = changes ? Math.round((file.additions / changes) * 100) : 50;
  const colour = file.binary || !changes
    ? 'hsl(var(--muted-foreground))'
    : `linear-gradient(to right, hsl(var(--diff-add)) ${share}%, hsl(var(--diff-remove)) ${share}%)`;
  return { flexGrow: String(Math.max(1, Math.sqrt(changes))), flexBasis: '0', background: colour };
}

function choose(path: string): void {
  viewer.select(path);
  pickerOpen.value = false;
}

function markViewedAndNext(): void {
  const current = viewer.selectedFile;
  if (!current) return;
  viewed.setViewed(current, true);
  const files = viewer.files;
  const start = files.indexOf(current);
  const next = [...files.slice(start + 1), ...files.slice(0, start)].find((file) => !viewed.isViewed(file));
  if (next) viewer.select(next.path);
}

watch(() => viewer.selectedFile?.path, () => diffViewport.value?.scrollTo({ top: 0 }));

function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !event.defaultPrevented) {
    event.preventDefault();
    emit('close');
    return;
  }
  if (event.key === 'v' && acceptsDiffShortcut(event)) {
    event.preventDefault();
    markViewedAndNext();
    return;
  }
  const step = diffFileStepKey(event);
  if (step === null) return;
  event.preventDefault();
  viewer.step(step);
}

onMounted(() => void nextTick(() => root.value?.focus()));
</script>
