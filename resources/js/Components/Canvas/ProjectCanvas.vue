<template>
  <!-- Every agent in the project, or in All agents, as flowcharts of who
       works for whom. Drag the background to pan, a card to move it; scroll
       to pan and pinch or Ctrl+scroll to zoom. Choose a card to open it. -->
  <section
    ref="root"
    aria-label="Canvas"
    tabindex="-1"
    class="flex h-full min-h-0 flex-col outline-none animate-in fade-in duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:animate-none"
    @keydown="onKeydown"
  >
    <header class="flex h-12 shrink-0 items-center gap-3 pl-6 pr-3">
      <h2 class="shrink-0 text-[13px] font-medium text-foreground">{{ projectName }}</h2>
      <p class="min-w-0 truncate text-xs text-muted-foreground">
        <template v-for="(item, index) in tally" :key="item.id">{{ index ? ' · ' : '' }}<span :class="cn('tabular-nums', item.id === 'attention' ? 'text-warning' : 'text-foreground')">{{ item.count }}</span> {{ item.label }}</template>
      </p>
      <span class="flex-1" />
      <!-- The project's own processes, a click away like its agents. -->
      <nav v-if="processTabs.length" aria-label="Processes" class="hidden min-w-0 items-center gap-0.5 sm:flex">
        <button
          v-for="tab in shownProcesses"
          :key="tab.key"
          type="button"
          :aria-current="sidebar.processActive(tab.process) ? 'page' : undefined"
          class="flex h-7 min-w-0 max-w-44 items-center gap-1.5 rounded-tab px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :title="tab.process.command || tab.process.name"
          @click="sidebar.selectProcess(tab.process)"
        >
          <span class="flex h-4 w-4 shrink-0 items-center justify-center">
            <RowStatus :activity="processActivity(tab.process)" />
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
            aria-label="Close canvas"
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-tab text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            @click="board.close"
          >
            <X class="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" class="bg-popover text-popover-foreground">Close <kbd class="ml-1 rounded border border-border/70 px-1 text-[10px]">Esc</kbd></TooltipContent>
      </Tooltip>
    </header>

    <div
      ref="viewportEl"
      :class="cn('canvas-surface relative min-h-0 flex-1 touch-none select-none overflow-hidden', panning ? 'cursor-grabbing' : 'cursor-grab')"
      :style="{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${GRID * view.zoom}px ${GRID * view.zoom}px` }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @lostpointercapture.self="onPointerUp"
      @wheel.prevent="onWheel"
    >
      <p v-if="!nodes.length" class="pt-24 text-center text-[13px] text-muted-foreground">No agents running</p>
      <div v-else class="absolute left-0 top-0 origin-top-left" :style="{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }">
        <svg class="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden="true">
          <g fill="none" stroke-width="1.5" :stroke="EDGE_COLOUR">
            <path v-for="edge in drawnEdges" :key="edge.id" :d="edge.path" />
          </g>
          <!-- Work flows down the edge to a subagent while it works. -->
          <g fill="none" stroke-width="1.5" stroke="hsl(var(--primary) / 0.55)" stroke-linecap="round" class="canvas-flow">
            <path v-for="edge in flowingEdges" :key="edge.id" :d="edge.path" stroke-dasharray="2 10" />
          </g>
          <circle v-for="anchor in anchors" :key="anchor.id" :cx="anchor.x" :cy="anchor.y" r="3.5" fill="hsl(var(--background))" :stroke="EDGE_COLOUR" stroke-width="1.5" />
        </svg>
        <CanvasCard
          v-for="node in nodes"
          :key="node.id"
          :node="node"
          :position="positions.get(node.id)!"
          :now="now"
          :dragging="drag?.id === node.id && drag.moved"
          @focus="reveal"
        />
      </div>

      <!-- Zoom and layout, out of the way in the corner. -->
      <div class="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-lg border border-white/[0.06] bg-[hsl(0_0%_10.5%)] p-0.5 text-muted-foreground" @pointerdown.stop>
        <button type="button" aria-label="Zoom out" :class="TOOL" @click="zoomBy(1 / ZOOM_STEP)"><Minus class="h-3.5 w-3.5" /></button>
        <button type="button" aria-label="Actual size" title="Actual size" :class="cn(TOOL, 'w-11 text-[11px] tabular-nums')" @click="zoomTo(1)">{{ Math.round(view.zoom * 100) }}%</button>
        <button type="button" aria-label="Zoom in" :class="TOOL" @click="zoomBy(ZOOM_STEP)"><Plus class="h-3.5 w-3.5" /></button>
        <button type="button" aria-label="Fit to screen" title="Fit to screen" :class="TOOL" @click="fit"><Maximize2 class="h-3.5 w-3.5" /></button>
        <button v-if="moved" type="button" aria-label="Tidy up" title="Put every card back in place" :class="TOOL" @click="tidy"><Undo2 class="h-3.5 w-3.5" /></button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useElementSize } from '@vueuse/core';
import { Maximize2, Minus, Plus, Undo2, X } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { useAgentDigests } from '../../Composables/useAgentDigests';
import { useBoardRoute } from '../../Composables/useBoard';
import { useWorkbench } from '../../Composables/useWorkbench';
import {
  CARD_HEIGHT, CARD_WIDTH, canvasBounds, edgeAnchor, edgePath, fitViewport, layoutCanvasToFit,
  readCanvasPositions, writeCanvasPositions, zoomAbout, type CanvasTree, type Point, type Viewport
} from '../../lib/agentCanvas';
import type { AgentNode } from '../../lib/agentTree';
import { processActivity } from '../../lib/rowActivity';
import { processesByOwner } from '../../lib/sidebarTree';
import type { StripTab } from '../../lib/tabStrip';
import RowStatus from '../RowStatus.vue';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useSidebar } from '../Sidebar/sidebarContext';
import CanvasCard, { type CanvasNode } from './CanvasCard.vue';

const GRID = 24;
const ZOOM_STEP = 1.2;
// A press that moves less than this is a click.
const DRAG_THRESHOLD = 4;
const EDGE_COLOUR = 'hsl(var(--muted-foreground) / 0.35)';
const TOOL = 'flex h-7 min-w-7 items-center justify-center rounded-md transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
// More than this and the rest are a count; the sidebar lists them all.
const PROCESSES_SHOWN = 4;

type ProcessTab = Extract<StripTab, { kind: 'process' }>;

const { digests, now, show } = useAgentDigests();
// Cards show each agent's links and branch, so they stay fresh while it's open.
show(() => true);
const board = useBoardRoute();
const sidebar = useSidebar();
const { projects } = useWorkbench();

const projectName = computed(() => sidebar.allAgents.value ? 'All agents' : projects.value.find((item) => item.project.id === sidebar.projectId.value)?.project.name ?? '');

const processTabs = computed(() => sidebar.tabs.value.filter((tab): tab is ProcessTab => tab.kind === 'process'));
const shownProcesses = computed(() => processTabs.value.slice(0, PROCESSES_SHOWN));
const hiddenProcesses = computed(() => Math.max(0, processTabs.value.length - PROCESSES_SHOWN));

// Every agent in every family, roots first, with its own processes.
const families = computed(() => digests.value.map((digest) => {
  const owned = processesByOwner(sidebar.ownedProcesses(digest.family));
  const project = sidebar.allAgents.value ? sidebar.projectOf(digest.tab) : null;
  const nodes: CanvasNode[] = [];
  const visit = (agent: AgentNode, isRoot: boolean): { tree: CanvasTree; count: number } => {
    const node: CanvasNode = { id: agent.session.id, session: agent.session, digest, isRoot, descendants: 0, processes: owned.get(agent.session.processId ?? '') ?? [], project };
    nodes.push(node);
    const children = agent.children.map((child) => visit(child, false));
    node.descendants = children.reduce((sum, child) => sum + child.count, 0);
    return { tree: { id: node.id, children: children.map((child) => child.tree) }, count: node.descendants + 1 };
  };
  return { tree: visit(digest.family.root, true).tree, nodes };
}));
const nodes = computed(() => families.value.flatMap((family) => family.nodes));

const tally = computed(() => {
  const states = nodes.value.map((node) => sidebar.activity(node.session).self);
  const working = states.filter((self) => self === 'working').length;
  const attention = digests.value.filter((digest) => digest.state === 'attention').length;
  return [
    { id: 'agents', count: nodes.value.length, label: nodes.value.length === 1 ? 'agent' : 'agents' },
    ...(working ? [{ id: 'working', count: working, label: 'working' }] : []),
    ...(attention ? [{ id: 'attention', count: attention, label: attention === 1 ? 'needs you' : 'need you' }] : [])
  ];
});

const root = ref<HTMLElement | null>(null);
const viewportEl = ref<HTMLElement | null>(null);
const main = document.getElementById('workbench-main');
const { width, height } = useElementSize(viewportEl, { width: main?.clientWidth ?? 0, height: (main?.clientHeight ?? 0) - 48 });

// Families wrap to show as many as they can at as large a size as they can.
const layout = computed(() => layoutCanvasToFit(families.value.map((family) => family.tree), width.value, height.value));

// Cards the user moved stay put, on this device, per project or All agents.
const scope = computed(() => sidebar.expansionScope.value);
const overrides = shallowRef<Record<string, Point>>(readCanvasPositions(scope.value));
watch(scope, (next) => { overrides.value = readCanvasPositions(next); });
const moved = computed(() => nodes.value.some((node) => overrides.value[node.id]));

const positions = computed(() => new Map(nodes.value.map((node) => [node.id, overrides.value[node.id] ?? layout.value.positions.get(node.id) ?? { x: 0, y: 0 }])));

const drawnEdges = computed(() => layout.value.edges.flatMap((edge) => {
  const from = positions.value.get(edge.from);
  const to = positions.value.get(edge.to);
  return from && to ? [{ id: edge.id, to: edge.to, path: edgePath(edge.kind, from, to) }] : [];
}));

const workingIds = computed(() => new Set(nodes.value.filter((node) => sidebar.activity(node.session).self === 'working').map((node) => node.id)));
const flowingEdges = computed(() => drawnEdges.value.filter((edge) => workingIds.value.has(edge.to)));

// One dot where a parent's edges leave it, whatever their number.
const anchors = computed(() => {
  const seen = new Map<string, Point & { id: string }>();
  for (const edge of layout.value.edges) {
    const key = `${edge.from}:${edge.kind}`;
    const from = positions.value.get(edge.from);
    if (from && !seen.has(key)) seen.set(key, { id: key, ...edgeAnchor(edge.kind, from) });
  }
  return [...seen.values()];
});

// Cards not shown, such as a hidden project's in All agents, keep their places.
function saveOverrides(next: Record<string, Point>): void {
  overrides.value = next;
  writeCanvasPositions(scope.value, next);
}

function tidy(): void {
  const shown = new Set(nodes.value.map((node) => node.id));
  saveOverrides(Object.fromEntries(Object.entries(overrides.value).filter(([id]) => !shown.has(id))));
  fit();
}

const view = reactive<Viewport>({ x: 0, y: 0, zoom: 1 });
// A fitted view keeps fitting, as agents come and go and the window resizes,
// until the user pans or zooms.
const fitted = ref(false);

function setView(next: Viewport, fitting = false): void {
  Object.assign(view, next);
  fitted.value = fitting;
  views.set(scope.value, { view: { ...next }, fitted: fitting });
}

function fit(): void {
  const bounds = canvasBounds(positions.value.values());
  if (bounds && width.value && height.value) setView(fitViewport(bounds, width.value, height.value), true);
}

function centre(): Point {
  return { x: width.value / 2, y: height.value / 2 };
}

function zoomTo(zoom: number, at = centre()): void {
  setView(zoomAbout(view, zoom, at));
}

function zoomBy(factor: number, at = centre()): void {
  zoomTo(view.zoom * factor, at);
}

watch(scope, (next) => {
  const known = views.get(next);
  if (known) {
    Object.assign(view, known.view);
    fitted.value = known.fitted;
  } else {
    fitted.value = true;
  }
  if (fitted.value) void nextTick(fit);
}, { immediate: true });

// Pressing the background pans; pressing a card moves it, once the press
// has moved far enough not to be a click. Only then does the canvas take the
// pointer, so a click still lands on the card.
interface Press { pointerId: number; start: Point; origin: Point; moved: boolean }
const pan = ref<Press | null>(null);
const drag = ref<(Press & { id: string }) | null>(null);
const panning = computed(() => Boolean(pan.value?.moved));

watch([width, height, () => canvasBounds(positions.value.values())], () => {
  if (fitted.value && !drag.value) fit();
}, { deep: true });

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest('[data-canvas-interactive]')) return;
  const start = { x: event.clientX, y: event.clientY };
  const id = event.target.closest<HTMLElement>('[data-canvas-card]')?.dataset.canvasId;
  if (id) drag.value = { pointerId: event.pointerId, start, origin: { ...positions.value.get(id)! }, moved: false, id };
  else pan.value = { pointerId: event.pointerId, start, origin: { x: view.x, y: view.y }, moved: false };
}

function onPointerMove(event: PointerEvent): void {
  const press = drag.value ?? pan.value;
  if (!press || press.pointerId !== event.pointerId) return;
  // Released outside the canvas before it took the pointer.
  if (!(event.buttons & 1)) return onPointerUp(event);
  const dx = event.clientX - press.start.x;
  const dy = event.clientY - press.start.y;
  if (!press.moved) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    press.moved = true;
    viewportEl.value?.setPointerCapture(event.pointerId);
    // A moved card stays where it's dropped, so the view stops fitting.
    if (drag.value) setView({ ...view });
  }
  if (drag.value) overrides.value = { ...overrides.value, [drag.value.id]: { x: Math.round(press.origin.x + dx / view.zoom), y: Math.round(press.origin.y + dy / view.zoom) } };
  else setView({ zoom: view.zoom, x: press.origin.x + dx, y: press.origin.y + dy });
}

function onPointerUp(event: PointerEvent): void {
  if (drag.value?.pointerId === event.pointerId) {
    if (drag.value.moved) saveOverrides(overrides.value);
    drag.value = null;
  }
  if (pan.value?.pointerId === event.pointerId) pan.value = null;
}

// Scrolling pans; a pinch, which arrives as Ctrl+scroll, zooms about the pointer.
function onWheel(event: WheelEvent): void {
  const rect = viewportEl.value?.getBoundingClientRect();
  if (!rect) return;
  if (event.ctrlKey || event.metaKey) {
    zoomBy(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025)), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    return;
  }
  const scale = event.deltaMode === 1 ? 16 : 1;
  const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
  const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
  setView({ zoom: view.zoom, x: view.x - dx * scale, y: view.y - dy * scale });
}

// A card reached by keyboard comes into view.
const REVEAL_MARGIN = 24;
function reveal(id: string): void {
  const point = positions.value.get(id);
  if (!point) return;
  const left = view.x + point.x * view.zoom;
  const top = view.y + point.y * view.zoom;
  const right = left + CARD_WIDTH * view.zoom;
  const bottom = top + CARD_HEIGHT * view.zoom;
  let { x, y } = view;
  if (left < REVEAL_MARGIN) x += REVEAL_MARGIN - left;
  else if (right > width.value - REVEAL_MARGIN) x -= right - (width.value - REVEAL_MARGIN);
  if (top < REVEAL_MARGIN) y += REVEAL_MARGIN - top;
  else if (bottom > height.value - REVEAL_MARGIN) y -= bottom - (height.value - REVEAL_MARGIN);
  if (x !== view.x || y !== view.y) setView({ zoom: view.zoom, x, y });
}

// Arrow keys move between cards by where they sit; + and - zoom, 0 fits.
const ARROWS: Record<string, { axis: 'x' | 'y'; sign: 1 | -1 }> = {
  ArrowLeft: { axis: 'x', sign: -1 },
  ArrowRight: { axis: 'x', sign: 1 },
  ArrowUp: { axis: 'y', sign: -1 },
  ArrowDown: { axis: 'y', sign: 1 }
};

function cardButtons(): HTMLElement[] {
  return [...(root.value?.querySelectorAll<HTMLElement>('[data-canvas-node]') ?? [])];
}

function focusedId(): string | null {
  return (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-canvas-card]')?.dataset.canvasId ?? null;
}

function focusNode(id: string | undefined): void {
  if (id) root.value?.querySelector<HTMLElement>(`[data-canvas-card][data-canvas-id="${CSS.escape(id)}"] [data-canvas-node]`)?.focus({ preventScroll: true });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    board.close();
    return;
  }
  if (event.key === '+' || event.key === '=') return void (event.preventDefault(), zoomBy(ZOOM_STEP));
  if (event.key === '-') return void (event.preventDefault(), zoomBy(1 / ZOOM_STEP));
  if (event.key === '0') return void (event.preventDefault(), fit());
  const arrow = ARROWS[event.key];
  if (!arrow || event.shiftKey) return;
  event.preventDefault();
  const current = focusedId();
  const from = current ? positions.value.get(current) : null;
  if (!from) {
    cardButtons()[0]?.focus({ preventScroll: true });
    return;
  }
  let best: string | undefined;
  let bestScore = Infinity;
  for (const [id, point] of positions.value) {
    if (id === current) continue;
    // Along the arrow, from edge to edge; across it, from centre to centre.
    const along = (arrow.axis === 'x' ? point.x - from.x : point.y - from.y) * arrow.sign;
    const across = arrow.axis === 'x' ? point.y - from.y : point.x - from.x;
    if (along < 1) continue;
    const score = along + Math.abs(across) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  focusNode(best);
}

// Start on the most urgent agent, so Enter goes straight to what needs you;
// Esc goes back to where you were.
onMounted(() => {
  const urgent = digests.value.find((digest) => digest.state === 'attention')?.session.id;
  const target = urgent ?? nodes.value[0]?.id;
  if (target) focusNode(target);
  else root.value?.focus({ preventScroll: true });
});
</script>

<script lang="ts">
// Where the view was, per scope, for coming back from an agent this session.
const views = new Map<string, { view: Viewport; fitted: boolean }>();
</script>

<style scoped>
.canvas-flow path {
  animation: canvas-flow 900ms linear infinite;
}

@keyframes canvas-flow {
  to { stroke-dashoffset: -12; }
}

@media (prefers-reduced-motion: reduce) {
  .canvas-flow path { animation: none; }
}

.canvas-surface {
  background-image: radial-gradient(circle at 1px 1px, hsl(var(--muted-foreground) / 0.16) 1px, transparent 0);
}
</style>
