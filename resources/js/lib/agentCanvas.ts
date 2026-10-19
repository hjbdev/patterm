// The canvas lays agent families out as flowcharts: each root agent on top,
// its subagents in a row beneath it, and their own subagents stacked below
// each of those, indented a step a level. Families sit side by side and wrap
// into rows. Cards are a fixed size, so the layout needs no measuring, and a
// card the user has dragged keeps where they put it.

export const CARD_WIDTH = 300;
export const CARD_HEIGHT = 140;
// Between a root and its row of subagents, and between rows of families.
const ROW_GAP = 48;
const FAMILY_ROW_GAP = 72;
const COLUMN_GAP = 24;
const FAMILY_GAP = 64;
// Each stacked level steps right by this, and stacked cards this far apart.
const STACK_INDENT = 40;
const STACK_GAP = 16;
// A stack's rail runs down from this far into its parent.
const RAIL_INSET = 24;
const CORNER = 8;

export interface CanvasTree {
  id: string;
  children: readonly CanvasTree[];
}

export interface Point { x: number; y: number }

// `row`: from a root to the row beneath it. `stack`: down a rail to a card
// stacked below.
export interface CanvasEdge { id: string; from: string; to: string; kind: 'row' | 'stack' }

export interface CanvasLayout {
  positions: Map<string, Point>;
  edges: CanvasEdge[];
}

interface Block { width: number; height: number; place: (x: number, y: number) => void }

export function layoutCanvas(families: readonly CanvasTree[], maxWidth: number): CanvasLayout {
  const positions = new Map<string, Point>();
  const edges: CanvasEdge[] = [];

  // A subagent and everything below it, stacked.
  function stack(node: CanvasTree): Block {
    const below: { block: Block; offset: number }[] = [];
    let height = CARD_HEIGHT;
    let width = CARD_WIDTH;
    for (const child of node.children) {
      edges.push({ id: `${node.id}>${child.id}`, from: node.id, to: child.id, kind: 'stack' });
      const block = stack(child);
      below.push({ block, offset: height + STACK_GAP });
      height += STACK_GAP + block.height;
      width = Math.max(width, STACK_INDENT + block.width);
    }
    return {
      width,
      height,
      place(x, y) {
        positions.set(node.id, { x, y });
        for (const { block, offset } of below) block.place(x + STACK_INDENT, y + offset);
      }
    };
  }

  function family(root: CanvasTree): Block {
    const columns = root.children.map((child) => {
      edges.push({ id: `${root.id}>${child.id}`, from: root.id, to: child.id, kind: 'row' });
      return stack(child);
    });
    const rowWidth = columns.reduce((sum, block) => sum + block.width, 0) + COLUMN_GAP * Math.max(0, columns.length - 1);
    const width = Math.max(CARD_WIDTH, rowWidth);
    const height = CARD_HEIGHT + (columns.length ? ROW_GAP + Math.max(...columns.map((block) => block.height)) : 0);
    return {
      width,
      height,
      place(x, y) {
        // The root centres over the first cards of its first and last columns.
        const last = columns[columns.length - 1];
        positions.set(root.id, { x: last ? x + (rowWidth - last.width) / 2 : x, y });
        let left = x;
        for (const block of columns) {
          block.place(left, y + CARD_HEIGHT + ROW_GAP);
          left += block.width + COLUMN_GAP;
        }
      }
    };
  }

  // Families go left to right until the next would pass the width, then wrap.
  const blocks = families.map(family);
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const block of blocks) {
    if (x > 0 && x + block.width > maxWidth) {
      x = 0;
      y += rowHeight + FAMILY_ROW_GAP;
      rowHeight = 0;
    }
    block.place(x, y);
    x += block.width + FAMILY_GAP;
    rowHeight = Math.max(rowHeight, block.height);
  }
  return { positions, edges };
}

// Wraps families at the width that lets the whole canvas show at the largest
// zoom: full size if it fits, stepping down to half size, where it wraps to
// the screen's shape and scrolls.
const FIT_ZOOMS = [1, 0.9, 0.8, 0.7, 0.6, 0.5];

export function layoutCanvasToFit(families: readonly CanvasTree[], width: number, height: number): CanvasLayout {
  let layout: CanvasLayout | null = null;
  for (const zoom of FIT_ZOOMS) {
    const room = { width: (width - FIT_PADDING * 2) / zoom, height: (height - FIT_PADDING * 2) / zoom };
    layout = layoutCanvas(families, Math.max(CARD_WIDTH, room.width));
    const bounds = canvasBounds(layout.positions.values());
    if (!bounds || (bounds.width <= room.width && bounds.height <= room.height)) return layout;
  }
  return layout!;
}

// A row edge leaves the parent's bottom centre, turns along a line halfway
// down, and enters the child's top centre. A stack edge runs down the parent's
// rail and turns into the child's left side.
export function edgePath(kind: CanvasEdge['kind'], from: Point, to: Point): string {
  if (kind === 'stack') {
    const x = from.x + RAIL_INSET;
    const top = from.y + CARD_HEIGHT;
    const end = { x: to.x, y: to.y + CARD_HEIGHT / 2 };
    const dx = end.x - x;
    const r = Math.min(CORNER, Math.abs(dx), Math.max(0, end.y - top));
    if (!r) return `M ${x} ${top} L ${end.x} ${end.y}`;
    const sign = Math.sign(dx);
    return `M ${x} ${top} V ${end.y - r} Q ${x} ${end.y} ${x + r * sign} ${end.y} H ${end.x}`;
  }
  const start = { x: from.x + CARD_WIDTH / 2, y: from.y + CARD_HEIGHT };
  const end = { x: to.x + CARD_WIDTH / 2, y: to.y };
  const mid = start.y + (end.y - start.y) / 2;
  const dx = end.x - start.x;
  const r = Math.min(CORNER, Math.abs(dx) / 2, Math.abs(end.y - start.y) / 2);
  if (!r) return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  const sx = Math.sign(dx);
  const sy = Math.sign(end.y - start.y) || 1;
  return `M ${start.x} ${start.y} V ${mid - r * sy} Q ${start.x} ${mid} ${start.x + r * sx} ${mid} H ${end.x - r * sx} Q ${end.x} ${mid} ${end.x} ${mid + r * sy} V ${end.y}`;
}

// Where an edge's dot sits on its parent.
export function edgeAnchor(kind: CanvasEdge['kind'], from: Point): Point {
  return kind === 'stack' ? { x: from.x + RAIL_INSET, y: from.y + CARD_HEIGHT } : { x: from.x + CARD_WIDTH / 2, y: from.y + CARD_HEIGHT };
}

export interface Bounds { x: number; y: number; width: number; height: number }

export function canvasBounds(points: Iterable<Point>): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x + CARD_WIDTH);
    maxY = Math.max(maxY, point.y + CARD_HEIGHT);
  }
  return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface Viewport { x: number; y: number; zoom: number }

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 1.5;
const FIT_PADDING = 48;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

// The whole canvas in view, at no more than full size. When it can't all fit
// even at half size, it starts at half size from the top, where the first
// families are.
export function fitViewport(bounds: Bounds, width: number, height: number): Viewport {
  const room = { width: Math.max(1, width - FIT_PADDING * 2), height: Math.max(1, height - FIT_PADDING * 2) };
  const fit = Math.min(1, room.width / bounds.width, room.height / bounds.height);
  const zoom = clampZoom(Math.max(0.5, fit));
  const x = (width - bounds.width * zoom) / 2 - bounds.x * zoom;
  const y = bounds.height * zoom <= room.height ? (height - bounds.height * zoom) / 2 - bounds.y * zoom : FIT_PADDING - bounds.y * zoom;
  return { x, y, zoom };
}

// Zooming about a point on screen keeps what's under it in place.
export function zoomAbout(view: Viewport, zoom: number, at: Point): Viewport {
  const next = clampZoom(zoom);
  const scale = next / view.zoom;
  return { zoom: next, x: at.x - (at.x - view.x) * scale, y: at.y - (at.y - view.y) * scale };
}

// Cards the user moved, per project or for All agents, kept on this device.
export function readCanvasPositions(scope: string): Record<string, Point> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(canvasKey(scope)) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, Point] => isPoint(entry[1])));
  } catch {
    return {};
  }
}

export function writeCanvasPositions(scope: string, positions: Record<string, Point>): void {
  try {
    if (Object.keys(positions).length) localStorage.setItem(canvasKey(scope), JSON.stringify(positions));
    else localStorage.removeItem(canvasKey(scope));
  } catch { /* Positions are a convenience. */ }
}

function canvasKey(scope: string): string {
  return `patterm.canvas.${scope}`;
}

function isPoint(value: unknown): value is Point {
  return Boolean(value) && typeof value === 'object'
    && Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y);
}
