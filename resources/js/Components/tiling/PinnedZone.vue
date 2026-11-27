<template>
  <!-- The panels pinned beside the conversation, tiled in columns. The gap
       before them sets their width. A dragged tile lifts out of the layout
       as a small copy of itself that follows the pointer, and the rest hold
       still until it drops. -->
  <template v-if="visible">
    <div
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      aria-label="Resize pinned panels"
      :aria-valuenow="zoneWidth"
      :aria-valuemin="minWidth"
      :aria-valuemax="maxWidth"
      class="group/gutter relative z-10 flex w-2 shrink-0 cursor-col-resize touch-none items-center justify-center self-stretch outline-none"
      @pointerdown="startZoneResize"
      @pointermove="moveZoneResize"
      @pointerup="endZoneResize"
      @pointercancel="endZoneResize"
      @dblclick="width = clampWidth(320 * Math.max(1, columns.length))"
      @keydown.left.prevent="width = clampWidth(zoneWidth + 24)"
      @keydown.right.prevent="width = clampWidth(zoneWidth - 24)"
    >
      <span class="h-10 w-[3px] rounded-full transition-colors" :class="zoneResize ? 'bg-white/45' : 'bg-transparent group-hover/gutter:bg-white/20 group-focus-visible/gutter:bg-white/45'" aria-hidden="true" />
    </div>
    <section ref="zone" aria-label="Pinned panels" class="relative min-h-0 shrink-0" :style="{ width: `${zoneWidth}px` }" :data-pinned-resizing="resizing || zoneResize ? '' : undefined">
      <template v-if="size.w">
        <!-- A full-screen tile sits over the whole page; clicking around it restores it. -->
        <div v-if="maximised" class="fixed inset-0 z-50 bg-black/70 duration-200 animate-in fade-in-0" aria-hidden="true" @click="toggleMaximise(maximised)" />
        <PinnedTile
          v-for="entry in rendered"
          :key="entry.tile.id"
          :class="[entry.leaving && 'pinned-tile-leave', !entry.leaving && maximised === entry.tile.id && 'pinned-tile-fullscreen']"
          :enter="!spawned.has(entry.tile.id)"
          :style="entry.leaving ? (entry.full ? FULLSCREEN : rectStyle(entry.leaving)) : tileStyle(entry.tile)"
          :tile="entry.tile"
          :focused="!entry.leaving && focus === entry.tile.id"
          :maximised="maximised === entry.tile.id"
          :lifted="lifted === entry.tile.id"
          :joining="target?.type === 'join' && target.tileId === entry.tile.id"
          :flashing="flashTile === entry.tile.id"
          @pointerenter="hover(entry.tile.id)"
          @pointerdown="hover(entry.tile.id)"
          @grab="(event, kind) => grabTile(entry.tile, kind, event)"
          @activate="(kind) => activate(entry.tile.id, kind)"
          @close="(kind) => close(entry.tile.id, kind)"
          @maximise="toggleMaximise(entry.tile.id)"
        >
          <template #default="{ kind }"><slot name="panel" :kind="kind" :tile="entry.tile" /></template>
        </PinnedTile>
        <template v-if="!started">
          <div
            v-for="gutter in shownGeometry.gutters"
            :key="gutter.kind === 'column' ? `${gutter.left}|${gutter.right}` : `${gutter.above}|${gutter.below}`"
            role="separator"
            :aria-orientation="gutter.kind === 'column' ? 'vertical' : 'horizontal'"
            :aria-label="gutter.kind === 'column' ? 'Resize columns' : 'Resize panels'"
            class="group/gutter absolute left-0 top-0 z-10 flex touch-none items-center justify-center"
            :class="gutter.kind === 'column' ? 'cursor-col-resize' : 'cursor-row-resize'"
            :style="rectStyle(gutter.rect)"
            @pointerdown="startGutter(gutter, $event)"
            @pointermove="moveGutter"
            @pointerup="endGutter"
            @pointercancel="endGutter"
            @dblclick="evenGutter(gutter)"
          >
            <span class="rounded-full transition-colors" :class="[gutter.kind === 'column' ? 'h-10 w-[3px]' : 'h-[3px] w-10', resizing === gutter ? 'bg-white/45' : 'bg-transparent group-hover/gutter:bg-white/20']" aria-hidden="true" />
          </div>
        </template>
        <!-- A tab or chip on its way to a tile of its own. Its position is
             written straight to its style as the pointer moves. -->
        <div v-if="ghostKind" ref="ghost" class="pointer-events-none absolute left-0 top-0 z-50 flex flex-col overflow-hidden rounded-xl border border-white/20 bg-background opacity-95 shadow-2xl shadow-black/70" :style="{ width: `${GHOST.w}px`, height: `${GHOST.h}px` }">
          <div class="flex h-10 shrink-0 items-center gap-1.5 border-b border-white/[0.04] px-3">
            <component :is="PIN_META[ghostKind].icon" class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span class="text-[13px] font-medium">{{ PIN_META[ghostKind].title }}</span>
          </div>
          <div class="flex-1 bg-white/[0.02]" />
        </div>
      </template>
    </section>
    <!-- While dragging, nothing under the pointer reacts to it. -->
    <div v-if="started" class="fixed inset-0 z-[60] cursor-grabbing" aria-hidden="true" />
  </template>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import type { PinnedPanels } from '../../Composables/usePinnedPanels';
import {
  find, hitTest, layout, place, removeTab, removeTile, targetKey, tileOf, tileWithKind, TILE_MIN,
  type Column, type DropTarget, type GutterSpec, type PinKind, type Rect, type Tile
} from '../../lib/tiling';
import PinnedTile from './PinnedTile.vue';
import { PIN_META } from './pinMeta';

const props = defineProps<{ panels: PinnedPanels }>();
defineSlots<{ panel(props: { kind: PinKind; tile: Tile }): unknown }>();
const { columns, width, zoneWidth, minWidth, maxWidth, maxColumns, clampWidth, size, dragging, interacting, tiles, focus, maximised, flashTile, hover, activate, close, toggleMaximise, setFocus, flash, epoch } = props.panels;

// A lifted tile shrinks to about this size; a ghost is this size.
const LIFT = { w: 340, h: 240 } as const;
const GHOST = { w: 280, h: 180 } as const;

const zone = ref<HTMLElement | null>(null), ghost = ref<HTMLElement | null>(null);

// ---- Dragging ---------------------------------------------------------------
// Whatever is dragged floats, as a window dragged with SUPER does in Hyprland:
// a tile or tab leaves the layout, the rest close up behind it and hold still,
// and they make room only when it drops. Only a tile that would take it as a
// tab says so. A drop on nothing, or Escape, puts it back. Alt lifts a tile as
// it's pressed; otherwise a drag starts once the pointer has moved, so a click
// still switches a tab or opens a chip.
type Source = { type: 'tile'; tileId: string; liftOnPress: boolean } | { type: 'tab'; tileId: string; kind: PinKind } | { type: 'chip'; kind: PinKind };
// Only what changes the layout is reactive; the pointer's position isn't, so
// following it repaints the floating copy and nothing else.
const source = shallowRef<Source | null>(null);
const started = ref(false);
const target = shallowRef<DropTarget | null>(null);
let pointer = { x: 0, y: 0 }, start = { x: 0, y: 0 }, grab = { x: 0, y: 0 }, lift = { w: 0, h: 0, scale: 1 };
let zoneBox: DOMRect | null = null, frame = 0;
// Whether the pointer has moved far enough to be a drag, not a click.
let moved = false;

const visible = computed(() => columns.value.length > 0 || started.value);
const lifted = computed(() => started.value && source.value?.type === 'tile' ? source.value.tileId : null);
const ghostKind = computed(() => started.value && source.value && source.value.type !== 'tile' ? source.value.kind : null);
// The layout shown, and dropped into: without what's being dragged.
const shown = computed<Column[]>(() => {
  const from = source.value;
  if (!started.value || !from) return columns.value;
  if (from.type === 'tile') return removeTile(columns.value, from.tileId);
  if (from.type === 'tab') return removeTab(columns.value, from.tileId, from.kind);
  return columns.value;
});
const shownGeometry = computed(() => layout(shown.value, size.w, size.h));
// Tiles as shown: a group a tab is dragged from shows the tabs it has left.
const shownTiles = computed(() => {
  if (shown.value === columns.value) return tiles.value;
  const byId = new Map(shown.value.flatMap((column) => column.tiles).map((tile) => [tile.id, tile]));
  return tiles.value.map((tile) => byId.get(tile.id) ?? tile);
});

function grabTile(tile: Tile, kind: PinKind | null, event: PointerEvent): void {
  // A single tab, or the header itself, carries the whole tile.
  begin(kind && tile.tabs.length > 1 ? { type: 'tab', tileId: tile.id, kind } : { type: 'tile', tileId: tile.id, liftOnPress: event.altKey }, event);
}
// A chip dragged from the conversation's header pins its panel where it lands;
// one already pinned moves.
function grabChip(kind: PinKind, event: PointerEvent): void {
  const tile = tileWithKind(columns.value, kind);
  begin(!tile ? { type: 'chip', kind } : tile.tabs.length === 1 ? { type: 'tile', tileId: tile.id, liftOnPress: false } : { type: 'tab', tileId: tile.id, kind }, event);
}
function begin(next: Source, event: PointerEvent): void {
  if (event.button !== 0 || source.value) return;
  source.value = next;
  start = { x: event.clientX, y: event.clientY };
  pointer = { ...start };
  window.addEventListener('pointermove', pointerMove);
  window.addEventListener('pointerup', pointerUp);
  window.addEventListener('pointercancel', stopDrag);
  window.addEventListener('keydown', dragKey, true);
  document.addEventListener('selectstart', preventSelect);
  // Alt lifts a tile as it's pressed.
  if (next.type === 'tile' && next.liftOnPress) void lift_(next);
}
function pointerMove(event: PointerEvent): void {
  pointer = { x: event.clientX, y: event.clientY };
  frame ||= requestAnimationFrame(follow);
}
function follow(): void {
  frame = 0;
  const from = source.value;
  if (!from) return;
  if (!started.value) {
    if (Math.hypot(pointer.x - start.x, pointer.y - start.y) < 5) return;
    void lift_(from);
    return;
  }
  zoneBox ??= zone.value?.getBoundingClientRect() ?? null;
  if (!zoneBox) return;
  const x = pointer.x - zoneBox.left, y = pointer.y - zoneBox.top;
  place_(x, y);
  // A tile pressed with Alt and let go where it is goes back.
  moved ||= Math.hypot(pointer.x - start.x, pointer.y - start.y) >= 5;
  if (!moved) return;
  const next = hitTest(shown.value, shownGeometry.value.rects, x, y, target.value, size, maxColumns.value);
  if (targetKey(next) !== targetKey(target.value)) target.value = next;
}
// Lifting takes the tile's size from where it sits, and shrinks it with a
// transform so its contents don't lay out again.
async function lift_(from: Source): Promise<void> {
  const box = from.type === 'tile' ? tileElement(from.tileId)?.getBoundingClientRect() : null;
  if (from.type === 'tile' && box) {
    lift = { w: box.width, h: box.height, scale: Math.min(1, LIFT.w / box.width, LIFT.h / box.height) };
    // A chip that carries a tile holds it near its corner.
    const inside = start.x >= box.left && start.x <= box.right && start.y >= box.top && start.y <= box.bottom;
    grab = inside ? { x: (start.x - box.left) / box.width, y: (start.y - box.top) / box.height } : { x: 0.14, y: Math.min(0.5, 20 / box.height) };
  } else {
    lift = { w: GHOST.w, h: GHOST.h, scale: 1 };
    grab = { x: 0.14, y: 0.1 };
  }
  started.value = true;
  dragging.value = true;
  maximised.value = null;
  window.getSelection()?.removeAllRanges();
  if (from.type === 'chip') swallowClick();
  await nextTick();
  zoneBox = zone.value?.getBoundingClientRect() ?? null;
  follow();
}
function floating(): HTMLElement | null {
  const from = source.value;
  return from?.type === 'tile' ? tileElement(from.tileId) : ghost.value;
}
function place_(x: number, y: number): void {
  const element = floating();
  if (!element) return;
  // The grabbed point stays under the pointer as the copy shrinks around it.
  element.style.translate = `${Math.round(x - grab.x * lift.w)}px ${Math.round(y - grab.y * lift.h)}px`;
}
function pointerUp(): void {
  const from = source.value, to = target.value;
  if (from && started.value && to) drop(from, to);
  stopDrag();
}
function stopDrag(): void {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  const from = source.value;
  // A tile that was lifted settles back from where it was dropped.
  if (from?.type === 'tile' && started.value) settle(from.tileId);
  source.value = null;
  started.value = false;
  moved = false;
  target.value = null;
  dragging.value = false;
  zoneBox = null;
  window.removeEventListener('pointermove', pointerMove);
  window.removeEventListener('pointerup', pointerUp);
  window.removeEventListener('pointercancel', stopDrag);
  window.removeEventListener('keydown', dragKey, true);
  document.removeEventListener('selectstart', preventSelect);
}
function dragKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  stopDrag();
}
function preventSelect(event: Event): void {
  event.preventDefault();
}
// The click that ends a chip's drag doesn't open the chip.
function swallowClick(): void {
  const swallow = (event: MouseEvent) => { event.stopPropagation(); event.preventDefault(); };
  window.addEventListener('click', swallow, { capture: true, once: true });
  window.addEventListener('pointerup', () => setTimeout(() => window.removeEventListener('click', swallow, { capture: true })), { capture: true, once: true });
}

// New tiles grow out of the ghost that was dragged in, rather than fading in.
const spawning = reactive(new Map<string, Rect>());
const spawned = reactive(new Set<string>());
function spawnFrom(tileId: string, rect: Rect): void {
  spawning.set(tileId, rect);
  spawned.add(tileId);
  requestAnimationFrame(() => requestAnimationFrame(() => spawning.delete(tileId)));
}
// A dropped tile keeps the point it was held by as it settles, so its
// shrinking undoes around the same place.
const settling = reactive(new Map<string, string>());
let settleTimer: ReturnType<typeof setTimeout> | undefined;
function settle(tileId: string): void {
  settling.set(tileId, `${grab.x * lift.w}px ${grab.y * lift.h}px`);
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => settling.clear(), 400);
}
function drop(from: Source, to: DropTarget): void {
  let next = columns.value;
  let tile: Tile;
  if (from.type === 'tile') {
    const at = find(next, from.tileId);
    if (!at) return;
    tile = at.tile;
    next = removeTile(next, from.tileId);
    if (to.type === 'join') skipLeave.add(from.tileId);
  } else {
    if (from.type === 'tab') next = removeTab(next, from.tileId, from.kind);
    tile = tileOf(from.kind);
    const element = ghost.value, box = zoneBox;
    if (element && box) {
      const rect = element.getBoundingClientRect();
      spawnFrom(tile.id, { x: rect.left - box.left, y: rect.top - box.top, w: rect.width, h: rect.height });
    }
  }
  // A target whose column left with the tile falls back to a new column.
  let placed = place(next, to, tile);
  if (!placed.some((column) => column.tiles.some((item) => item.tabs.includes(tile.active)))) placed = place(next, { type: 'column', before: null }, tile);
  columns.value = placed;
  if (to.type === 'join') {
    activate(to.tileId, tile.active);
    setFocus(to.tileId);
    flash(to.tileId);
  } else setFocus(tile.id);
}

// ---- Tiles ------------------------------------------------------------------
function tileElement(tileId: string): HTMLElement | null {
  return zone.value?.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(tileId)}"]`) ?? null;
}
function rectStyle(rect: Rect): Record<string, string> {
  return { translate: `${Math.round(rect.x)}px ${Math.round(rect.y)}px`, width: `${Math.round(rect.w)}px`, height: `${Math.round(rect.h)}px` };
}
function tileStyle(tile: Tile): Record<string, string | number> {
  if (lifted.value === tile.id) {
    // `translate` is left to the pointer.
    return {
      width: `${Math.round(lift.w)}px`, height: `${Math.round(lift.h)}px`, scale: lift.scale, transformOrigin: `${grab.x * lift.w}px ${grab.y * lift.h}px`,
      zIndex: 40, opacity: 0.94, pointerEvents: 'none', willChange: 'translate', transition: 'scale .18s ease, opacity .15s ease'
    };
  }
  const spawn = spawning.get(tile.id);
  if (spawn) return { ...rectStyle(spawn), transition: 'none', zIndex: 30 };
  if (maximised.value === tile.id) return FULLSCREEN;
  const origin = settling.get(tile.id);
  const extra: Record<string, string | number> = origin ? { transformOrigin: origin, zIndex: 30 } : {};
  const rect = shownGeometry.value.rects.get(tile.id) ?? { x: 0, y: 0, w: size.w, h: size.h };
  return { ...rectStyle(rect), ...extra };
}
// Full screen, a tile leaves the layout for the page, as a dialog would. It
// stays where it is in the DOM, so what it shows isn't mounted again.
const FULLSCREEN: Record<string, string | number> = {
  position: 'fixed', translate: 'none', inset: 'clamp(0.5rem, 2vw, 1.5rem)', width: 'auto', height: 'auto', zIndex: 50, transition: 'none'
};
// Escape restores it, unless what has focus inside it used the key.
function escapeFullScreen(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || !maximised.value) return;
  event.preventDefault();
  toggleMaximise(maximised.value);
}
watch(maximised, (tileId) => {
  if (tileId) window.addEventListener('keydown', escapeFullScreen);
  else window.removeEventListener('keydown', escapeFullScreen);
});
// Which tile was full screen just before a change, as closing it clears that first.
let wasMaximised: string | null = null;
watch(maximised, (_, before) => { wasMaximised = before ?? null; }, { flush: 'sync' });

// Unpinned tiles fade where they were, without unmounting until they've gone.
const leaving = shallowRef<{ tile: Tile; rect: Rect; full: boolean }[]>([]);
const skipLeave = new Set<string>();
let lastEpoch = epoch.value;
watch(columns, (next, before) => {
  const switched = lastEpoch !== epoch.value;
  lastEpoch = epoch.value;
  if (switched || !size.w) { leaving.value = []; skipLeave.clear(); return; }
  const kept = new Set(next.flatMap((column) => column.tiles.map((tile) => tile.id)));
  const rects = layout(before, size.w, size.h).rects;
  const gone = before.flatMap((column) => column.tiles).filter((tile) => !kept.has(tile.id) && !skipLeave.has(tile.id));
  skipLeave.clear();
  if (!gone.length) return;
  const entries = gone.map((tile) => ({ tile, rect: rects.get(tile.id) ?? { x: 0, y: 0, w: size.w, h: size.h }, full: maximised.value === tile.id || wasMaximised === tile.id }));
  leaving.value = [...leaving.value, ...entries];
  setTimeout(() => { leaving.value = leaving.value.filter((entry) => !entries.includes(entry)); }, 200);
});
// Tiles keep their place in the DOM, in the order they were pinned, however
// they move about the layout: moving an element restarts its animations and
// resets its scrolling.
const order = new Map<string, number>();
let nextOrder = 0;
const rendered = computed(() => {
  const entries = [
    ...shownTiles.value.map((tile) => ({ tile, leaving: null as Rect | null, full: false })),
    ...leaving.value.filter((entry) => !tiles.value.some((tile) => tile.id === entry.tile.id)).map((entry) => ({ tile: entry.tile, leaving: entry.rect, full: entry.full }))
  ];
  const present = new Set(entries.map((entry) => entry.tile.id));
  for (const id of order.keys()) if (!present.has(id)) order.delete(id);
  for (const id of present) if (!order.has(id)) order.set(id, nextOrder++);
  return entries.sort((a, b) => order.get(a.tile.id)! - order.get(b.tile.id)!);
});

// The zone's size drives the layout.
let observer: ResizeObserver | undefined;
watch(zone, (element) => {
  observer?.disconnect();
  if (!element) { size.w = 0; size.h = 0; return; }
  observer = new ResizeObserver(([entry]) => {
    size.w = entry!.contentRect.width;
    size.h = entry!.contentRect.height;
  });
  observer.observe(element);
});

// ---- Gutters ------------------------------------------------------------------
// Moves apply once a frame, however fast the pointer reports them.
const resizing = shallowRef<GutterSpec | null>(null);
let pair: { a: number; b: number; weightA: number; weightB: number; origin: number } | null = null;
let gutterAt = 0, gutterFrame = 0;
function startGutter(gutter: GutterSpec, event: PointerEvent): void {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  const rects = shownGeometry.value.rects;
  if (gutter.kind === 'column') {
    const left = columns.value.find((column) => column.id === gutter.left)!, right = columns.value.find((column) => column.id === gutter.right)!;
    pair = { a: rects.get(left.tiles[0]!.id)!.w, b: rects.get(right.tiles[0]!.id)!.w, weightA: left.weight, weightB: right.weight, origin: event.clientX };
  } else {
    const column = columns.value.find((item) => item.id === gutter.column)!;
    const above = column.tiles.find((tile) => tile.id === gutter.above)!, below = column.tiles.find((tile) => tile.id === gutter.below)!;
    pair = { a: rects.get(above.id)!.h, b: rects.get(below.id)!.h, weightA: above.weight, weightB: below.weight, origin: event.clientY };
  }
  resizing.value = gutter;
  interacting.value = true;
  event.preventDefault();
}
function moveGutter(event: PointerEvent): void {
  if (!resizing.value) return;
  gutterAt = resizing.value.kind === 'column' ? event.clientX : event.clientY;
  gutterFrame ||= requestAnimationFrame(applyGutter);
}
function applyGutter(): void {
  gutterFrame = 0;
  const gutter = resizing.value;
  if (!gutter || !pair) return;
  const min = gutter.kind === 'column' ? TILE_MIN.w : TILE_MIN.h;
  const total = pair.a + pair.b;
  const a = Math.max(min, Math.min(total - min, pair.a + gutterAt - pair.origin));
  const weight = pair.weightA + pair.weightB;
  const weightA = weight * a / total, weightB = weight - weightA;
  if (gutter.kind === 'column') {
    columns.value = columns.value.map((column) => column.id === gutter.left ? { ...column, weight: weightA } : column.id === gutter.right ? { ...column, weight: weightB } : column);
  } else {
    columns.value = columns.value.map((column) => column.id !== gutter.column ? column : {
      ...column, tiles: column.tiles.map((tile) => tile.id === gutter.above ? { ...tile, weight: weightA } : tile.id === gutter.below ? { ...tile, weight: weightB } : tile)
    });
  }
}
function endGutter(): void {
  if (gutterFrame) { cancelAnimationFrame(gutterFrame); applyGutter(); }
  resizing.value = null;
  interacting.value = false;
  pair = null;
}
function evenGutter(gutter: GutterSpec): void {
  if (gutter.kind === 'column') {
    const half = columns.value.filter((column) => column.id === gutter.left || column.id === gutter.right).reduce((sum, column) => sum + column.weight, 0) / 2;
    columns.value = columns.value.map((column) => column.id === gutter.left || column.id === gutter.right ? { ...column, weight: half } : column);
  } else {
    columns.value = columns.value.map((column) => {
      if (column.id !== gutter.column) return column;
      const half = column.tiles.filter((tile) => tile.id === gutter.above || tile.id === gutter.below).reduce((sum, tile) => sum + tile.weight, 0) / 2;
      return { ...column, tiles: column.tiles.map((tile) => tile.id === gutter.above || tile.id === gutter.below ? { ...tile, weight: half } : tile) };
    });
  }
}

// The gap before the zone sets its width; the conversation keeps its minimum.
const zoneResize = ref(false);
let zoneFrom = { x: 0, width: 0 }, zoneAt = 0, zoneFrame = 0;
function startZoneResize(event: PointerEvent): void {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  zoneFrom = { x: event.clientX, width: zoneWidth.value };
  zoneResize.value = true;
  interacting.value = true;
  event.preventDefault();
}
function moveZoneResize(event: PointerEvent): void {
  if (!zoneResize.value) return;
  zoneAt = event.clientX;
  zoneFrame ||= requestAnimationFrame(() => {
    zoneFrame = 0;
    if (zoneResize.value) width.value = clampWidth(zoneFrom.width + zoneFrom.x - zoneAt);
  });
}
function endZoneResize(): void {
  zoneResize.value = false;
  interacting.value = false;
}

onBeforeUnmount(() => {
  stopDrag();
  window.removeEventListener('keydown', escapeFullScreen);
  observer?.disconnect();
  clearTimeout(settleTimer);
  if (gutterFrame) cancelAnimationFrame(gutterFrame);
  if (zoneFrame) cancelAnimationFrame(zoneFrame);
  interacting.value = false;
});

defineExpose({ grabChip });
</script>
