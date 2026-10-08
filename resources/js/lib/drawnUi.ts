// Layout and wiring for drawn figures. Components stay presentational: this
// module places diagram nodes, maps tones to theme colours and carries the
// answer channel between the conversation and its cards.

import type { ComputedRef, InjectionKey } from 'vue';
import type { DrawnDiagram, DrawnTone } from '../../../app/Services/DrawnUi';
import type { TranscriptMessage } from '../../../app/Services/TranscriptProjection';

export function toneColor(tone: DrawnTone | 'soft' | 'fg' | undefined): string {
  return `var(--drawn-${tone ?? 'neutral'})`;
}

export function toneWash(tone: DrawnTone | undefined): string {
  return tone && tone !== 'neutral' && tone !== 'muted' ? `var(--drawn-${tone}-wash)` : 'var(--drawn-soft)';
}

// Sending answers belongs to the live conversation. History and other
// read-only transcripts provide nothing, so cards there cannot answer.
export interface DrawnUiAnswerChannel {
  canSend: ComputedRef<boolean>;
  send: (text: string) => Promise<void> | void;
  // Answers waiting in the agent's queue, which the transcript leaves out
  // until they are delivered.
  queued: ComputedRef<Map<string, string>>;
}
export const drawnUiAnswerKey: InjectionKey<DrawnUiAnswerChannel> = Symbol('drawnUiAnswer');
export const drawnUiAnsweredKey: InjectionKey<ComputedRef<Map<string, string>>> = Symbol('drawnUiAnswered');
// Figures a transcript can place inline, by id, and whose conversation they belong to.
export const drawnUiFiguresKey: InjectionKey<ComputedRef<Map<string, TranscriptMessage>>> = Symbol('drawnUiFigures');

export interface FlowBox { id: string; x: number; y: number; width: number; height: number }
export interface FlowLayout { width: number; height: number; nodes: Map<string, FlowBox>; gap: number; direction: 'right' | 'down' }

// Layered: a node's layer is the longest path from a source. Up to four
// layers read left to right; longer chains run top to bottom so boxes keep a
// readable size in a narrow transcript. Gaps widen to fit the longest edge
// label so labels never cross boxes.
export function layoutFlow(diagram: DrawnDiagram, width = 640): FlowLayout {
  const edges = diagram.edges ?? [];
  const incoming = new Map(diagram.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) incoming.get(edge.to)?.push(edge.from);
  const layer = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parents = incoming.get(id) ?? [];
    const value = parents.length ? 1 + Math.max(...parents.map((parent) => depth(parent, seen))) : 0;
    layer.set(id, value);
    return value;
  };
  for (const node of diagram.nodes) depth(node.id, new Set());
  const layers: string[][] = [];
  for (const node of diagram.nodes) (layers[layer.get(node.id) ?? 0] ??= []).push(node.id);
  const count = layers.length;
  const widest = Math.max(...layers.map((ids) => ids?.length ?? 0));
  const longest = Math.max(0, ...edges.map((edge) => edge.label?.length ?? 0));
  const nodes = new Map<string, FlowBox>();
  const boxHeight = 44;
  if (count > 4) {
    const gap = 18;
    const boxWidth = Math.min(220, (width - (widest - 1) * gap) / widest);
    const layerGap = longest ? 40 : 30;
    layers.forEach((ids, index) => {
      const used = ids.length * boxWidth + (ids.length - 1) * gap;
      ids.forEach((id, column) => nodes.set(id, { id, x: (width - used) / 2 + column * (boxWidth + gap), y: index * (boxHeight + layerGap), width: boxWidth, height: boxHeight }));
    });
    return { width, height: count * (boxHeight + layerGap) - layerGap + 4, nodes, gap: layerGap, direction: 'down' };
  }
  const gap = Math.max(count > 3 ? 26 : 56, longest ? longest * 6.4 + 46 : 0);
  const boxWidth = Math.max(80, (width - (count - 1) * gap) / count);
  const rowGap = 16;
  const height = widest * (boxHeight + rowGap) - rowGap + 4;
  layers.forEach((ids, index) => {
    const used = ids.length * (boxHeight + rowGap) - rowGap;
    ids.forEach((id, row) => nodes.set(id, { id, x: index * (boxWidth + gap), y: (height - used) / 2 + row * (boxHeight + rowGap), width: boxWidth, height: boxHeight }));
  });
  return { width: Math.max(width, count * boxWidth + (count - 1) * gap), height, nodes, gap, direction: 'right' };
}

export function flowEdgePath(from: FlowBox, to: FlowBox, gap: number, direction: FlowLayout['direction'] = 'right'): { d: string; labelX: number; labelY: number } {
  if (direction === 'down') {
    const x1 = from.x + from.width / 2, y1 = from.y + from.height;
    const x2 = to.x + to.width / 2, y2 = to.y - 2;
    const mid = y1 + Math.min(gap / 2, 18);
    return { d: `M${x1} ${y1} V${mid} H${x2} V${y2}`, labelX: x2 + 6, labelY: (mid + y2) / 2 + 4 };
  }
  const x1 = from.x + from.width, y1 = from.y + from.height / 2;
  const x2 = to.x - 2, y2 = to.y + to.height / 2;
  const mid = x1 + Math.min(gap / 2, 30);
  return { d: `M${x1} ${y1} H${mid} V${y2} H${x2}`, labelX: mid + 6, labelY: y2 - 6 };
}

export interface NestNode<T> { node: T; children: NestNode<T>[] }
export function nestTree<T extends { id: string; parent?: string | undefined }>(nodes: T[]): NestNode<T>[] {
  const build = (parent: string | undefined): NestNode<T>[] => nodes.filter((node) => node.parent === parent).map((node) => ({ node, children: build(node.id) }));
  return build(undefined);
}
