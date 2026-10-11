<template>
  <!-- Every agent in the project across the whole workspace, most urgent
       first, each with its full summary. Choose one to open it. -->
  <section
    ref="root"
    aria-label="Board"
    tabindex="-1"
    class="flex h-full min-h-0 origin-top flex-col outline-none animate-in fade-in zoom-in-[0.985] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:animate-none"
    @keydown="onKeydown"
  >
    <header class="flex h-12 shrink-0 items-center gap-3 pl-6 pr-3">
      <h2 class="shrink-0 text-[13px] font-medium text-foreground">{{ projectName }}</h2>
      <p class="min-w-0 truncate text-xs text-muted-foreground">
        <template v-for="(item, index) in tally" :key="item.id">{{ index ? ' · ' : '' }}<span class="tabular-nums text-foreground">{{ item.count }}</span> {{ item.label }}</template>
      </p>
      <span class="flex-1" />
      <!-- The project's own processes, a click away like its agents. Phones
           have them in the drawer's list. -->
      <nav v-if="processTabs.length" aria-label="Processes" class="hidden min-w-0 items-center gap-0.5 sm:flex">
        <button
          v-for="tab in shownProcesses"
          :key="tab.key"
          type="button"
          :aria-current="sidebar.processActive(tab.process) ? 'page' : undefined"
          class="flex h-7 min-w-0 max-w-44 items-center gap-1.5 rounded-tab px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :title="tab.process.command || tab.process.name"
          @click="openProcess(tab.process)"
        >
          <span class="flex h-4 w-4 shrink-0 items-center justify-center">
            <TabIcon :activity="processActivity(tab.process)" compact muted><TerminalSquare class="h-3.5 w-3.5" /></TabIcon>
          </span>
          <span class="truncate">{{ tab.process.name }}</span>
        </button>
        <span v-if="hiddenProcesses" class="px-1.5 text-xs tabular-nums text-muted-foreground/70">+{{ hiddenProcesses }}</span>
      </nav>
      <!-- Back to the agent or page it was opened from in this project. -->
      <Tooltip v-if="board.closable.value">
        <TooltipTrigger as-child>
          <button
            type="button"
            aria-label="Close board"
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-tab text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            @click="board.close"
          >
            <X class="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" class="bg-popover text-popover-foreground">Close <kbd class="ml-1 rounded border border-border/70 px-1 text-[10px]">Esc</kbd></TooltipContent>
      </Tooltip>
    </header>

    <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-1 [scrollbar-width:thin]">
      <p v-if="!digests.length" class="pt-24 text-center text-[13px] text-muted-foreground">No agents running</p>
      <div
        v-else
        class="grid items-start justify-center"
        :style="{ gridTemplateColumns: `repeat(${plan.columns}, minmax(0, ${MAX_BLOCK}px))`, columnGap: `${LANE_GAP}px`, rowGap: `${LANE_ROW_GAP}px` }"
      >
        <section v-for="lane in plan.lanes" :key="lane.id" :aria-label="lane.label" class="min-w-0" :style="{ gridColumn: `span ${lane.span}` }">
          <h3 class="mb-2 px-4 text-xs leading-5 text-muted-foreground">{{ lane.label }}</h3>
          <!-- Masonry: each column stacks its own blocks, so a short block leaves no hole beside a tall one. -->
          <div class="flex items-start" :style="{ gap: `${BLOCK_GAP}px` }">
            <div v-for="(column, index) in lane.columns" :key="index" class="flex min-w-0 flex-1 flex-col" :style="{ gap: `${BLOCK_GAP}px` }">
              <BoardBlock v-for="digest in column" :key="digest.key" :digest="digest" :now="now" />
            </div>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useElementSize } from '@vueuse/core';
import { TerminalSquare, X } from 'lucide-vue-next';
import { useAgentDigests } from '../../Composables/useAgentDigests';
import { useBoardRoute } from '../../Composables/useBoard';
import { useWorkbench } from '../../Composables/useWorkbench';
import { STATE_ORDER, type DigestState } from '../../lib/agentDigest';
import { processActivity } from '../../lib/rowActivity';
import type { StripTab } from '../../lib/tabStrip';
import type { ProcessRecord } from '../../types';
import TabIcon from '../TabIcon.vue';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useSidebar } from '../Sidebar/sidebarContext';
import BoardBlock from './BoardBlock.vue';

// Blocks stay readable down to the minimum and stop growing at the maximum,
// so a quiet project's few blocks sit centred instead of stretching.
const MIN_BLOCK = 280;
const MAX_BLOCK = 400;
const BLOCK_GAP = 12;
// Lanes sit a little further apart than the blocks within them.
const LANE_GAP = 24;
const LANE_ROW_GAP = 28;
const PADDING_X = 48;

const LANE_LABELS: Record<DigestState, string> = { attention: 'Needs you', working: 'Working', waiting: 'Waiting', done: 'Done', idle: 'Quiet' };

// More than this and the rest are a count; the sidebar lists them all.
const PROCESSES_SHOWN = 4;

type ProcessTab = Extract<StripTab, { kind: 'process' }>;

const { digests, now, show } = useAgentDigests();
// The board shows every agent's todos, links and diffs, so it keeps them fresh.
show(() => true);
const board = useBoardRoute();
const sidebar = useSidebar();
const { projects } = useWorkbench();

const projectName = computed(() => projects.value.find((item) => item.project.id === sidebar.projectId.value)?.project.name ?? '');

const processTabs = computed(() => sidebar.tabs.value.filter((tab): tab is ProcessTab => tab.kind === 'process'));
const shownProcesses = computed(() => processTabs.value.slice(0, PROCESSES_SHOWN));
const hiddenProcesses = computed(() => Math.max(0, processTabs.value.length - PROCESSES_SHOWN));

function openProcess(process: ProcessRecord): void {
  sidebar.selectProcess(process);
}

const groups = computed(() => STATE_ORDER
  .map((state) => ({ id: state, label: LANE_LABELS[state], digests: digests.value.filter((digest) => digest.state === state) }))
  .filter((group) => group.digests.length));

const tally = computed(() => groups.value.map((group) => ({
  id: group.id,
  count: group.digests.length,
  label: group.id === 'attention' ? (group.digests.length === 1 ? 'needs you' : 'need you') : group.label.toLowerCase()
})));

// Measured from the start, so the board opens already laid out.
const root = ref<HTMLElement | null>(null);
const scroller = ref<HTMLElement | null>(null);
const { width } = useElementSize(scroller, { width: (document.getElementById('workbench-main')?.clientWidth ?? 0) - PADDING_X, height: 0 });
const columns = computed(() => Math.max(1, Math.floor((width.value + LANE_GAP) / (MIN_BLOCK + LANE_GAP))));

// Lanes go side by side when they fit, the tallest taking the spare columns,
// so the whole project shows at once. When they don't, or when that would
// make one lane much taller, each lane takes the width it needs and they wrap.
const plan = computed(() => {
  const counts = groups.value.map((group) => group.digests.length);
  const wrapped = counts.map((count) => Math.min(count, columns.value));
  const sideBySide = counts.length <= columns.value ? spreadColumns(counts, columns.value) : null;
  const useSideBySide = sideBySide !== null && Math.max(...counts.map((count, index) => Math.ceil(count / sideBySide[index]!))) <= wrappedRows(counts, wrapped, columns.value);
  const spans = useSideBySide ? sideBySide : wrapped;
  return {
    columns: useSideBySide ? spans.reduce((sum, span) => sum + span, 0) : columns.value,
    // Blocks deal out across a lane's columns in order, so they read left to right, then down.
    lanes: groups.value.map((group, index) => ({
      ...group,
      span: spans[index]!,
      columns: Array.from({ length: spans[index]! }, (_, column) => group.digests.filter((_, position) => position % spans[index]! === column))
    }))
  };
});

// One column a lane, then spare columns to whichever lane is tallest, as long
// as that makes it shorter.
function spreadColumns(counts: readonly number[], available: number): number[] {
  const spans = counts.map(() => 1);
  if (!spans.length) return spans;
  let spare = available - counts.length;
  for (;;) {
    const rows = counts.map((count, index) => Math.ceil(count / spans[index]!));
    const tallest = rows.indexOf(Math.max(...rows));
    const height = rows[tallest]!;
    if (height <= 1) break;
    const needed = Math.ceil(counts[tallest]! / (height - 1)) - spans[tallest]!;
    if (needed > spare) break;
    spans[tallest]! += needed;
    spare -= needed;
  }
  return spans;
}

// Block rows when lanes wrap: each row of lanes is as tall as its tallest.
function wrappedRows(counts: readonly number[], spans: readonly number[], available: number): number {
  let total = 0;
  let used = 0;
  let rowHeight = 0;
  counts.forEach((count, index) => {
    const span = spans[index]!;
    if (used + span > available) {
      total += rowHeight;
      used = 0;
      rowHeight = 0;
    }
    used += span;
    rowHeight = Math.max(rowHeight, Math.ceil(count / span));
  });
  return total + rowHeight;
}

// Arrow keys move between blocks by where they sit on screen.
const ARROWS: Record<string, { axis: 'x' | 'y'; sign: 1 | -1 }> = {
  ArrowLeft: { axis: 'x', sign: -1 },
  ArrowRight: { axis: 'x', sign: 1 },
  ArrowUp: { axis: 'y', sign: -1 },
  ArrowDown: { axis: 'y', sign: 1 }
};

function blocks(): HTMLElement[] {
  return [...(root.value?.querySelectorAll<HTMLElement>('[data-board-block]') ?? [])];
}

function focusBlock(block: HTMLElement | undefined): void {
  if (!block) return;
  block.focus({ preventScroll: true });
  block.scrollIntoView({ block: 'nearest' });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    board.close();
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const all = blocks();
    focusBlock(event.key === 'Home' ? all[0] : all[all.length - 1]);
    return;
  }
  const arrow = ARROWS[event.key];
  if (!arrow || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  const all = blocks();
  const current = (document.activeElement as HTMLElement | null)?.closest('[data-board-cell]')?.querySelector<HTMLElement>('[data-board-block]');
  if (!current) {
    focusBlock(all[0]);
    return;
  }
  const from = current.getBoundingClientRect();
  let best: HTMLElement | undefined;
  let bestScore = Infinity;
  for (const block of all) {
    if (block === current) continue;
    const rect = block.getBoundingClientRect();
    // Along the arrow, from edge to edge; across it, from centre to centre.
    const along = arrow.axis === 'x' ? (rect.left - from.left) * arrow.sign : (rect.top - from.top) * arrow.sign;
    const across = arrow.axis === 'x' ? (rect.top + rect.height / 2) - (from.top + from.height / 2) : (rect.left + rect.width / 2) - (from.left + from.width / 2);
    if (along < 1) continue;
    const score = along + Math.abs(across) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = block;
    }
  }
  focusBlock(best);
}

// Start on the most urgent agent, so Enter goes straight to what needs you;
// Esc goes back to where you were.
onMounted(() => (blocks()[0] ?? root.value)?.focus({ preventScroll: true }));
</script>
