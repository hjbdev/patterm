// A small tiler for the panels pinned beside an agent's conversation:
// columns of tiles, each tile a group of one or more tabs. The layout is
// computed here, so tiles can be positioned absolutely and animate to it.

// Everything that can be pinned. `image` and `context` open from elsewhere,
// such as a picture in the conversation or the command palette.
export const PIN_KINDS = ['browser', 'servers', 'agents', 'todos', 'scratchpads', 'worktrees', 'links', 'secrets', 'media', 'context', 'image'] as const;
export type PinKind = typeof PIN_KINDS[number];
// Kinds whose tile shows the list behind one of the header's chips.
export type ListKind = Exclude<PinKind, 'browser' | 'context' | 'image'>;
export function isListKind(kind: PinKind): kind is ListKind {
  return kind !== 'browser' && kind !== 'context' && kind !== 'image';
}

export interface Tile { id: string; tabs: PinKind[]; active: PinKind; weight: number }
export interface Column { id: string; tiles: Tile[]; weight: number }
export interface Rect { x: number; y: number; w: number; h: number }
export type Direction = 'left' | 'right' | 'up' | 'down';

// Where a drag would land, by id so it survives the source leaving.
export type DropTarget =
  | { type: 'join'; tileId: string }
  | { type: 'insert'; columnId: string; before: string | null }
  | { type: 'column'; before: string | null };

export type GutterSpec =
  | { kind: 'column'; left: string; right: string; rect: Rect }
  | { kind: 'row'; column: string; above: string; below: string; rect: Rect };

export const GAP = 8;
export const MAX_COLUMNS = 3;
// The conversation keeps this much beside the pinned panels, which take at
// least ZONE_MIN; narrower than both, pins wait until there is room.
export const CONVERSATION_MIN = 440;
export const ZONE_MIN = 280;
export const TILE_MIN = { w: 200, h: 100 } as const;
export const SLOT = '__slot';
// The narrowest zone that holds `count` columns, and how many columns fit in a width.
export function zoneMinWidth(count: number): number {
  return Math.max(ZONE_MIN, count * TILE_MIN.w + GAP * Math.max(0, count - 1));
}
export function columnsThatFit(width: number): number {
  return Math.max(1, Math.min(MAX_COLUMNS, Math.floor((width + GAP) / (TILE_MIN.w + GAP))));
}
const SLOT_COLUMN = '__slot-column';

let sequence = 0;
// Unique across reloads, since saved layouts keep their ids.
export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(++sequence).toString(36)}`;
}
export function tileOf(kind: PinKind, weight = 1): Tile {
  return { id: newId('tile-'), tabs: [kind], active: kind, weight };
}
export function targetKey(target: DropTarget | null): string {
  if (!target) return '';
  return target.type === 'join' ? `join:${target.tileId}` : target.type === 'insert' ? `insert:${target.columnId}:${target.before}` : `column:${target.before}`;
}

const average = (weights: number[]) => weights.length ? weights.reduce((sum, weight) => sum + weight, 0) / weights.length : 1;

export function layout(columns: Column[], width: number, height: number): { rects: Map<string, Rect>; gutters: GutterSpec[] } {
  const rects = new Map<string, Rect>();
  const gutters: GutterSpec[] = [];
  const total = columns.reduce((sum, column) => sum + column.weight, 0) || 1;
  const usableWidth = Math.max(0, width - GAP * (columns.length - 1));
  let x = 0;
  columns.forEach((column, index) => {
    const w = usableWidth * column.weight / total;
    const rowTotal = column.tiles.reduce((sum, tile) => sum + tile.weight, 0) || 1;
    const usableHeight = Math.max(0, height - GAP * (column.tiles.length - 1));
    let y = 0;
    column.tiles.forEach((tile, row) => {
      const h = usableHeight * tile.weight / rowTotal;
      rects.set(tile.id, { x, y, w, h });
      const below = column.tiles[row + 1];
      if (below) gutters.push({ kind: 'row', column: column.id, above: tile.id, below: below.id, rect: { x, y: y + h, w, h: GAP } });
      y += h + GAP;
    });
    const right = columns[index + 1];
    if (right) gutters.push({ kind: 'column', left: column.id, right: right.id, rect: { x: x + w, y: 0, w: GAP, h: height } });
    x += w + GAP;
  });
  return { rects, gutters };
}

export function find(columns: Column[], tileId: string): { column: Column; tile: Tile; ci: number; ti: number } | null {
  for (const [ci, column] of columns.entries()) {
    const ti = column.tiles.findIndex((tile) => tile.id === tileId);
    if (ti >= 0) return { column, tile: column.tiles[ti]!, ci, ti };
  }
  return null;
}
export function tileWithKind(columns: Column[], kind: PinKind): Tile | null {
  for (const column of columns) {
    for (const tile of column.tiles) if (tile.tabs.includes(kind)) return tile;
  }
  return null;
}

function tidy(columns: Column[]): Column[] {
  return columns.filter((column) => column.tiles.length);
}
export function removeTile(columns: Column[], tileId: string): Column[] {
  return tidy(columns.map((column) => ({ ...column, tiles: column.tiles.filter((tile) => tile.id !== tileId) })));
}
export function removeTab(columns: Column[], tileId: string, kind: PinKind): Column[] {
  return tidy(columns.map((column) => ({
    ...column,
    tiles: column.tiles.flatMap((tile) => {
      if (tile.id !== tileId) return [tile];
      const tabs = tile.tabs.filter((item) => item !== kind);
      if (!tabs.length) return [];
      return [{ ...tile, tabs, active: tile.active === kind ? tabs[Math.max(0, tile.tabs.indexOf(kind) - 1)]! : tile.active }];
    })
  })));
}
export function updateTile(columns: Column[], tileId: string, change: (tile: Tile) => Tile): Column[] {
  return columns.map((column) => column.tiles.some((tile) => tile.id === tileId)
    ? { ...column, tiles: column.tiles.map((tile) => tile.id === tileId ? change(tile) : tile) }
    : column);
}

// Puts a tile where a target says: into a group, into a column, or as a new column.
export function place(columns: Column[], target: DropTarget, tile: Tile): Column[] {
  if (target.type === 'join') {
    return updateTile(columns, target.tileId, (into) => ({ ...into, tabs: [...into.tabs, ...tile.tabs.filter((kind) => !into.tabs.includes(kind))], active: tile.active }));
  }
  if (target.type === 'insert') {
    return columns.map((column) => {
      if (column.id !== target.columnId) return column;
      const tiles = [...column.tiles];
      const index = target.before ? tiles.findIndex((item) => item.id === target.before) : -1;
      tiles.splice(index < 0 ? tiles.length : index, 0, { ...tile, weight: average(column.tiles.map((item) => item.weight)) });
      return { ...column, tiles };
    });
  }
  const next = [...columns];
  const index = target.before ? next.findIndex((column) => column.id === target.before) : -1;
  next.splice(index < 0 ? next.length : index, 0, { id: newId('column-'), tiles: [{ ...tile, weight: 1 }], weight: average(columns.map((column) => column.weight)) });
  return next;
}

// The layout while dragging: the source keeps its place, and an empty slot
// opens where it would land.
export function preview(columns: Column[], target: DropTarget | null): Column[] {
  if (!target || target.type === 'join') return columns;
  const slot: Tile = { id: SLOT, tabs: [], active: 'todos', weight: 1 };
  if (target.type === 'column') {
    const next = [...columns];
    const index = target.before ? next.findIndex((column) => column.id === target.before) : -1;
    next.splice(index < 0 ? next.length : index, 0, { id: SLOT_COLUMN, tiles: [slot], weight: average(columns.map((column) => column.weight)) });
    return next;
  }
  return place(columns, target, slot);
}

const inside = (x: number, y: number, rect: Rect) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;

// What the pointer is over, in the zone's coordinates. Over the open slot, or
// in a gap, the current target holds, so the layout doesn't flicker.
export function hitTest(
  columns: Column[], rects: Map<string, Rect>, x: number, y: number,
  current: DropTarget | null, origin: string | null, size: { w: number; h: number }, maxColumns = MAX_COLUMNS
): DropTarget | null {
  if (x < 0 || y < 0 || x > size.w || y > size.h) return null;
  if (!columns.length) return { type: 'column', before: null };
  const slot = rects.get(SLOT);
  if (slot && inside(x, y, slot)) return current;
  for (const [ci, column] of columns.entries()) {
    for (const [ti, tile] of column.tiles.entries()) {
      const rect = rects.get(tile.id);
      if (!rect || !inside(x, y, rect)) continue;
      if (tile.id === origin) return null;
      const rx = (x - rect.x) / Math.max(1, rect.w), ry = (y - rect.y) / Math.max(1, rect.h);
      const originAlone = origin ? find(columns, origin)?.column.tiles.length === 1 : false;
      const roomForColumn = columns.length < maxColumns || originAlone;
      let target: DropTarget;
      if (roomForColumn && rx < 0.22) target = { type: 'column', before: column.id };
      else if (roomForColumn && rx > 0.78) target = { type: 'column', before: columns[ci + 1]?.id ?? null };
      else if (rx >= 0.22 && rx <= 0.78 && ry >= 0.3 && ry <= 0.7) target = { type: 'join', tileId: tile.id };
      else target = { type: 'insert', columnId: column.id, before: ry < 0.5 ? tile.id : column.tiles[ti + 1]?.id ?? null };
      return lands(columns, target, origin) ? target : null;
    }
  }
  return current;
}

// A tile dropped next to itself goes nowhere.
function lands(columns: Column[], target: DropTarget, origin: string | null): boolean {
  if (!origin) return true;
  const from = find(columns, origin);
  if (!from) return true;
  const next = from.column.tiles[from.ti + 1]?.id ?? null;
  if (target.type === 'insert') return !(target.columnId === from.column.id && (target.before === origin || target.before === next));
  if (target.type === 'column' && from.column.tiles.length === 1) return !(target.before === from.column.id || target.before === (columns[from.ci + 1]?.id ?? null));
  return true;
}

// The nearest tile in a direction, by geometry, as a tiler finds it.
export function neighbour(rects: Map<string, Rect>, from: string, direction: Direction): string | null {
  const a = rects.get(from);
  if (!a) return null;
  let best: { id: string; score: number } | null = null;
  for (const [id, b] of rects) {
    if (id === from || id === SLOT) continue;
    const ahead = direction === 'right' ? b.x - (a.x + a.w) : direction === 'left' ? a.x - (b.x + b.w)
      : direction === 'down' ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
    if (ahead < -1) continue;
    const across = direction === 'left' || direction === 'right'
      ? Math.abs((b.y + b.h / 2) - (a.y + a.h / 2))
      : Math.abs((b.x + b.w / 2) - (a.x + a.w / 2));
    const score = ahead + across * 0.6;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id ?? null;
}

// Moves a tile one step: within its column, or into the next column over,
// opening a new column at the edge while there's room.
export function shift(columns: Column[], tileId: string, direction: Direction, maxColumns = MAX_COLUMNS): Column[] {
  const from = find(columns, tileId);
  if (!from) return columns;
  if (direction === 'up' || direction === 'down') {
    const to = from.ti + (direction === 'up' ? -1 : 1);
    if (to < 0 || to >= from.column.tiles.length) return columns;
    const tiles = [...from.column.tiles];
    [tiles[from.ti], tiles[to]] = [tiles[to]!, tiles[from.ti]!];
    return columns.map((column) => column.id === from.column.id ? { ...column, tiles } : column);
  }
  const step = direction === 'left' ? -1 : 1;
  const beside = columns[from.ci + step];
  if (beside) {
    const index = Math.min(beside.tiles.length, Math.round(from.ti / Math.max(1, from.column.tiles.length) * (beside.tiles.length + 1)));
    const target: DropTarget = { type: 'insert', columnId: beside.id, before: beside.tiles[index]?.id ?? null };
    return place(removeTile(columns, tileId), target, from.tile);
  }
  if (from.column.tiles.length === 1 || columns.length >= maxColumns) return columns;
  const target: DropTarget = { type: 'column', before: direction === 'left' ? from.column.id : null };
  return place(removeTile(columns, tileId), target, from.tile);
}

// Grows or shrinks one tile along an axis by `delta` pixels, taking the room
// from its neighbours in proportion, within the minimum sizes.
export function resizeTile(columns: Column[], tileId: string, axis: 'x' | 'y', delta: number, size: { w: number; h: number }): Column[] {
  const at = find(columns, tileId);
  if (!at) return columns;
  const rect = layout(columns, size.w, size.h).rects.get(tileId);
  if (!rect) return columns;
  if (axis === 'x') {
    if (columns.length < 2) return columns;
    const usable = size.w - GAP * (columns.length - 1);
    const target = Math.max(TILE_MIN.w, Math.min(usable - TILE_MIN.w * (columns.length - 1), rect.w + delta));
    const rest = columns.reduce((sum, column) => sum + column.weight, 0) - at.column.weight;
    const weight = target * rest / Math.max(1, usable - target);
    return columns.map((column) => column.id === at.column.id ? { ...column, weight } : column);
  }
  if (at.column.tiles.length < 2) return columns;
  const usable = size.h - GAP * (at.column.tiles.length - 1);
  const target = Math.max(TILE_MIN.h, Math.min(usable - TILE_MIN.h * (at.column.tiles.length - 1), rect.h + delta));
  const rest = at.column.tiles.reduce((sum, tile) => sum + tile.weight, 0) - at.tile.weight;
  const weight = target * rest / Math.max(1, usable - target);
  return updateTile(columns, tileId, (tile) => ({ ...tile, weight }));
}

// A saved layout, checked before use, since it may come from an older build.
export function restoreColumns(value: unknown): Column[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<PinKind>();
  const columns: Column[] = [];
  for (const column of value as Partial<Column>[]) {
    if (!column || typeof column.id !== 'string' || !Array.isArray(column.tiles)) continue;
    const tiles: Tile[] = [];
    for (const tile of column.tiles as Partial<Tile>[]) {
      if (!tile || typeof tile.id !== 'string' || !Array.isArray(tile.tabs)) continue;
      // Pictures are opened from the conversation and aren't kept.
      const tabs = tile.tabs.filter((kind): kind is PinKind => (PIN_KINDS as readonly string[]).includes(kind) && kind !== 'image' && !seen.has(kind));
      if (!tabs.length) continue;
      for (const kind of tabs) seen.add(kind);
      tiles.push({ id: tile.id, tabs, active: tabs.includes(tile.active as PinKind) ? tile.active as PinKind : tabs[0]!, weight: positive(tile.weight) });
    }
    if (tiles.length) columns.push({ id: column.id, tiles, weight: positive(column.weight) });
  }
  return columns.slice(0, MAX_COLUMNS);
}
function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}
