import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import type { PeekImage } from '../lib/peek';
import {
  columnsThatFit, CONVERSATION_MIN, find, GAP, layout, neighbour, newId, place, removeTab, removeTile, resizeTile, restoreColumns, shift, tileOf, tileWithKind, updateTile, zoneMinWidth, ZONE_MIN,
  type Column, type Direction, type PinKind, type Tile
} from '../lib/tiling';

// Each agent keeps its own pinned panels, in this browser, for its most
// recently used sessions. New agents start with the last zone width used.
const STORAGE_KEY = 'patterm.pins.v1';
const WIDTH_KEY = 'patterm.pins.width';
const MAX_SAVED = 60;
const DEFAULT_WIDTH = 480;
// A new column asks for this much of the zone, as far as there's room.
const COLUMN_WIDTH = 320;
// Alt with + and − resizes by this much, as Hyprland's resizeactive does.
const STEP = 40;

interface Saved { columns: Column[]; width: number; at: number }
// Layouts are read from storage when they're needed and merged into it when
// written, so windows open side by side keep each other's. This window's
// changes wait briefly before they're written.
const pending = new Map<string, Saved | null>();
let pendingWidth: number | null = null;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
function storedLayouts(): Record<string, Saved> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, Saved> : {};
  } catch {
    return {};
  }
}
function savedLayout(sessionId: string): Saved | undefined {
  return pending.has(sessionId) ? pending.get(sessionId) ?? undefined : storedLayouts()[sessionId];
}
function lastWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= ZONE_MIN ? stored : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}
function save(sessionId: string, columns: Column[], width: number): void {
  const kept = restoreColumns(columns);
  pending.set(sessionId, kept.length ? { columns: kept, width: Math.round(width), at: Date.now() } : null);
  if (kept.length) pendingWidth = Math.round(width);
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const all = storedLayouts();
    for (const [id, layout] of pending) {
      if (layout) all[id] = layout;
      else delete all[id];
    }
    const ids = Object.keys(all);
    if (ids.length > MAX_SAVED) ids.sort((a, b) => all[a]!.at - all[b]!.at).slice(0, ids.length - MAX_SAVED).forEach((id) => delete all[id]);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
      if (pendingWidth !== null) localStorage.setItem(WIDTH_KEY, String(pendingWidth));
    } catch { /* Pins still hold for this window. */ }
    pending.clear();
    pendingWidth = null;
  }, 250);
}

// True while the agent shown has panels pinned beside it, so the workbench's
// main card gives way to the conversation's and the panels' own cards.
export const workspaceTiled = ref(false);

const DIRECTIONS: Record<string, Direction> = { KeyH: 'left', KeyJ: 'down', KeyK: 'up', KeyL: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up', ArrowRight: 'right' };
const GROW: Record<string, number> = { Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1 };
function editable(element: HTMLElement): boolean {
  return element.isContentEditable || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT';
}

// The panels pinned beside an agent's conversation, laid out as a tiling
// window manager would: what's pinned, where, and which tile has focus.
// Focus follows the pointer; `focusElement` moves the keyboard there when a
// key moves focus. Keys use Alt where Hyprland uses SUPER.
export function usePinnedPanels(options: { sessionId: () => string | null; enabled: () => boolean; focusElement: (id: string) => void }) {
  const state = shallowRef<Column[]>([]);
  const preferredWidth = ref(DEFAULT_WIDTH);
  let current: string | null = null;
  const columns = computed<Column[]>({
    get: () => state.value,
    set: (next) => {
      state.value = next;
      if (current) save(current, next, preferredWidth.value);
    }
  });
  const width = computed<number>({
    get: () => preferredWidth.value,
    set: (next) => {
      preferredWidth.value = next;
      if (current) save(current, state.value, next);
    }
  });

  // The row beside the conversation, and the zone inside it, as measured.
  const room = ref(0);
  const size = reactive({ w: 0, h: 0 });
  // Each column keeps a usable width, so the zone's minimum grows with them,
  // and a new column is offered only where it fits. Narrower than the layout
  // needs, pins wait for room and peeks open as a sheet.
  const minWidth = computed(() => zoneMinWidth(state.value.length));
  const maxWidth = computed(() => Math.max(minWidth.value, room.value - CONVERSATION_MIN - GAP));
  const maxColumns = computed(() => columnsThatFit(room.value - CONVERSATION_MIN - GAP));
  const clampWidth = (value: number) => Math.round(Math.max(minWidth.value, Math.min(maxWidth.value, value)));
  const zoneWidth = computed(() => clampWidth(preferredWidth.value));
  // A drag or resize in progress; focus holds still meanwhile.
  const dragging = ref(false), interacting = ref(false);
  const available = computed(() => options.enabled() && room.value >= CONVERSATION_MIN + GAP + minWidth.value);
  const tiled = computed(() => available.value && (state.value.length > 0 || dragging.value));

  const tiles = computed(() => state.value.flatMap((column) => column.tiles));
  const pinned = computed(() => tiles.value.flatMap((tile) => tile.tabs));
  const geometry = computed(() => layout(state.value, size.w, size.h));
  const focus = ref<string>('chat');
  // The tile new pins go beside, which focus on the conversation keeps.
  const lastTile = ref<string | null>(null);
  const maximised = ref<string | null>(null);
  const anchor = computed(() => (lastTile.value ? find(state.value, lastTile.value)?.tile : null) ?? tiles.value.at(-1) ?? null);

  // What the browser and image tiles show, which isn't saved with the layout.
  const browserPeek = ref<{ url?: string | undefined; serverProcessId?: string | null | undefined }>({});
  const imagePeek = ref<{ images: PeekImage[]; index: number } | null>(null);

  // Pointing at a tile, as a pinned chip does, flashes it.
  const flashTile = ref<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  function flash(tileId: string): void {
    flashTile.value = null;
    clearTimeout(flashTimer);
    requestAnimationFrame(() => {
      flashTile.value = tileId;
      flashTimer = setTimeout(() => { flashTile.value = null; }, 900);
    });
  }

  // Counts agents shown, so a switch isn't mistaken for unpinning.
  const epoch = ref(0);
  watch(options.sessionId, (sessionId) => {
    current = null;
    epoch.value++;
    const stored = sessionId ? savedLayout(sessionId) : undefined;
    state.value = restoreColumns(stored?.columns);
    preferredWidth.value = stored?.width && stored.width >= ZONE_MIN ? stored.width : lastWidth();
    current = sessionId;
    focus.value = 'chat';
    lastTile.value = state.value[0]?.tiles[0]?.id ?? null;
    maximised.value = null;
    browserPeek.value = {};
    imagePeek.value = null;
  }, { immediate: true });

  // A new column makes room for itself, while the conversation keeps its share.
  // Restoring an agent's layout, while `current` is unset, keeps its width.
  watch(() => state.value.length, (count, before) => {
    if (current && count > (before ?? 0) && room.value) width.value = Math.max(preferredWidth.value, clampWidth(COLUMN_WIDTH * count));
  }, { flush: 'sync' });

  // Focus a key moved stays put until the pointer itself moves, even as
  // tiles move under it, which would otherwise hand focus to what's below.
  let keysHold = false;
  function setFocus(id: string, move = false): void {
    focus.value = id;
    if (id !== 'chat') lastTile.value = id;
    if (move) {
      keysHold = true;
      options.focusElement(id);
    }
  }
  function hover(id: string): void {
    if (!keysHold && !dragging.value && !interacting.value && focus.value !== id) setFocus(id);
  }
  function pointerMoved(event: PointerEvent): void {
    if (event.movementX || event.movementY) keysHold = false;
  }
  function activate(tileId: string, kind: PinKind): void {
    columns.value = updateTile(state.value, tileId, (tile) => ({ ...tile, active: kind }));
  }
  function locate(kind: PinKind): void {
    const tile = tileWithKind(state.value, kind);
    if (!tile) return;
    if (tile.active !== kind) activate(tile.id, kind);
    setFocus(tile.id);
    if (maximised.value && maximised.value !== tile.id) maximised.value = tile.id;
    flash(tile.id);
  }
  // A new pin splits the tile it goes beside along its longer side, as
  // Hyprland's dwindle layout does: a wide tile gains a column, a tall one a row.
  function pin(kind: PinKind): void {
    if (tileWithKind(state.value, kind)) { locate(kind); return; }
    maximised.value = null;
    const tile = tileOf(kind);
    const at = anchor.value ? find(state.value, anchor.value.id) : null;
    if (!at) columns.value = [...state.value, { id: newId('column-'), tiles: [tile], weight: 1 }];
    else {
      const rect = geometry.value.rects.get(at.tile.id);
      const wide = rect ? rect.w > rect.h * 1.05 : false;
      columns.value = wide && state.value.length < maxColumns.value
        ? place(state.value, { type: 'column', before: state.value[at.ci + 1]?.id ?? null }, tile)
        : place(state.value, { type: 'insert', columnId: at.column.id, before: at.column.tiles[at.ti + 1]?.id ?? null }, tile);
    }
    setFocus(tile.id);
  }
  // Joins the tile new pins go beside, as a tab.
  function pinAsTab(kind: PinKind): void {
    const into = anchor.value;
    if (tileWithKind(state.value, kind)) { locate(kind); return; }
    if (!into) { pin(kind); return; }
    columns.value = place(state.value, { type: 'join', tileId: into.id }, tileOf(kind));
    setFocus(into.id);
    flash(into.id);
  }
  function close(tileId: string, kind: PinKind): void {
    const rects = geometry.value.rects;
    const fallback = neighbour(rects, tileId, 'up') ?? neighbour(rects, tileId, 'down') ?? neighbour(rects, tileId, 'left') ?? neighbour(rects, tileId, 'right');
    columns.value = removeTab(state.value, tileId, kind);
    if (kind === 'image') imagePeek.value = null;
    if (kind === 'browser') browserPeek.value = {};
    if (maximised.value === tileId && !find(state.value, tileId)) maximised.value = null;
    const survivor = fallback && find(state.value, fallback) ? fallback : tiles.value[0]?.id ?? null;
    if (lastTile.value && !find(state.value, lastTile.value)) lastTile.value = survivor;
    if (focus.value !== 'chat' && !find(state.value, focus.value)) focus.value = survivor ?? 'chat';
  }
  function unpin(kind: PinKind): void {
    const tile = tileWithKind(state.value, kind);
    if (tile) close(tile.id, kind);
  }
  function toggleMaximise(tileId: string): void {
    maximised.value = maximised.value === tileId ? null : tileId;
    setFocus(tileId);
  }

  // ---- Keys -----------------------------------------------------------------
  function focusToward(direction: Direction): void {
    if (focus.value === 'chat') {
      if (direction === 'right' && anchor.value) setFocus(anchor.value.id, true);
      return;
    }
    const next = neighbour(layout(state.value, size.w, size.h).rects, focus.value, direction);
    if (next) {
      setFocus(next, true);
      if (maximised.value) maximised.value = next;
    } else if (direction === 'left') {
      maximised.value = null;
      setFocus('chat', true);
    }
  }
  function moveFocused(direction: Direction): void {
    if (focus.value === 'chat') return;
    maximised.value = null;
    columns.value = shift(state.value, focus.value, direction, maxColumns.value);
    keysHold = true;
  }
  // Grows the focused tile, or the conversation, along an axis. A single
  // column grows by widening the zone.
  function grow(axis: 'x' | 'y', delta: number): void {
    if (focus.value === 'chat') {
      if (axis === 'x') width.value = clampWidth(zoneWidth.value - delta);
      return;
    }
    const at = find(state.value, focus.value);
    if (!at) return;
    maximised.value = null;
    if (axis === 'x' && state.value.length === 1) width.value = clampWidth(zoneWidth.value + delta);
    else columns.value = resizeTile(state.value, at.tile.id, axis, delta, size);
  }
  // Alt+G: a group gives up its tab as a tile below; a lone tile joins its neighbour.
  function toggleGroup(tile: Tile): void {
    const at = find(state.value, tile.id)!;
    maximised.value = null;
    if (tile.tabs.length > 1) {
      const popped = tileOf(tile.active);
      columns.value = place(removeTab(state.value, tile.id, tile.active), { type: 'insert', columnId: at.column.id, before: at.column.tiles[at.ti + 1]?.id ?? null }, popped);
      setFocus(popped.id);
      return;
    }
    const rects = geometry.value.rects;
    const into = neighbour(rects, tile.id, 'up') ?? neighbour(rects, tile.id, 'down') ?? neighbour(rects, tile.id, 'left') ?? neighbour(rects, tile.id, 'right');
    if (!into) return;
    columns.value = place(removeTile(state.value, tile.id), { type: 'join', tileId: into }, tile);
    setFocus(into);
    flash(into);
  }
  function cycle(tile: Tile, step: number): void {
    if (tile.tabs.length < 2) return;
    const index = tile.tabs.indexOf(tile.active) + step;
    activate(tile.id, tile.tabs[(index + tile.tabs.length) % tile.tabs.length]!);
  }
  function action(code: string, shiftKey: boolean): boolean {
    const tile = focus.value === 'chat' ? null : find(state.value, focus.value)?.tile ?? null;
    const growth = GROW[code];
    if (growth) { grow(shiftKey ? 'y' : 'x', growth * STEP); return true; }
    switch (code) {
      case 'KeyF': if (tile) toggleMaximise(tile.id); return true;
      case 'KeyQ': if (tile) close(tile.id, tile.active); return true;
      case 'KeyG': if (tile) toggleGroup(tile); return true;
      case 'BracketLeft': if (tile) cycle(tile, -1); return true;
      case 'BracketRight': if (tile) cycle(tile, 1); return true;
      default: return false;
    }
  }
  function keydown(event: KeyboardEvent): void {
    if (!tiled.value || event.defaultPrevented || event.isComposing || !event.altKey || event.metaKey) return;
    keysHold = true;
    // A terminal keeps its Meta keys, and the sidebar its Alt+arrows.
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('[data-patterm-terminal-input], [data-sidebar-row]')) return;
    const direction = DIRECTIONS[event.code];
    if (direction && event.code.startsWith('Arrow') && target && editable(target)) return;
    if (direction) {
      if (event.shiftKey) moveFocused(direction);
      else if (event.ctrlKey) grow(direction === 'left' || direction === 'right' ? 'x' : 'y', (direction === 'right' || direction === 'down' ? 1 : -1) * STEP);
      else focusToward(direction);
    } else if (event.ctrlKey || !action(event.code, event.shiftKey)) return;
    event.preventDefault();
    event.stopPropagation();
  }
  const listen = () => {
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('pointermove', pointerMoved, { passive: true });
  };
  const unlisten = () => {
    window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('pointermove', pointerMoved);
  };
  onMounted(listen);
  onActivated(listen);
  onDeactivated(unlisten);
  onBeforeUnmount(() => {
    unlisten();
    clearTimeout(flashTimer);
  });

  return {
    columns, width, zoneWidth, minWidth, maxWidth, maxColumns, clampWidth, room, size, available, tiled, dragging, interacting, epoch,
    tiles, pinned, geometry, focus, lastTile, maximised, anchor, flashTile, browserPeek, imagePeek,
    setFocus, hover, activate, locate, pin, pinAsTab, close, unpin, toggleMaximise, flash
  };
}

export type PinnedPanels = ReturnType<typeof usePinnedPanels>;
