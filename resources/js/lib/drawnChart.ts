// Compiles a drawn chart spec into a TanStack Charts definition. The agent
// names fields and meanings; this module picks scales, orientation, paints and
// label placement so every chart reads the same way in Patterm's theme.

import { defineChart } from '@tanstack/charts/scene';
import { barX, barY } from '@tanstack/charts/bar';
import { cell, rect } from '@tanstack/charts/rect';
import { dot } from '@tanstack/charts/dot';
import { lineY } from '@tanstack/charts/line';
import { areaY } from '@tanstack/charts/area';
import { ruleX, ruleY } from '@tanstack/charts/rule';
import { text } from '@tanstack/charts/text';
import { group } from '@tanstack/charts/group';
import { decorative } from '@tanstack/charts/mark/decorative';
import { stackRowsX } from '@tanstack/charts/transform/stack';
import { tooltip } from '@tanstack/charts/tooltip';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import type { ChartMark, InferableScaleLike } from '@tanstack/charts';
import type { ChartDefinition } from '@tanstack/charts/vue';
import { formatDrawnNumber, type DrawnChart, type DrawnScalar, type DrawnState, type DrawnTone } from '../../../app/Services/DrawnUi';
import { toneColor, toneWash } from './drawnUi';

type Row = Record<string, DrawnScalar>;
// Marks with different datum types share one list.
type AnyMark = ChartMark<any, any, any, any, any, any, any>;

export const DRAWN_HATCH = 'url(#drawn-ui-hatch)';
const SERIES_TONES: DrawnTone[] = ['accent', 'neutral', 'muted', 'good', 'warn', 'bad'];

export interface CompiledChart {
  definition: ChartDefinition;
  height: number;
  legend: Array<{ label: string; color: string; state?: DrawnState | undefined }>;
}

interface Paint { color: string; state?: DrawnState | undefined }

export function compileChart(spec: DrawnChart): CompiledChart {
  const rows = spec.data as Row[];
  const categorical = (field: string | undefined) => Boolean(field) && rows.some((row) => typeof row[field!] === 'string');
  const xCat = categorical(spec.x), yCat = categorical(spec.y);
  const num = (row: Row, field: string | undefined): number => field && typeof row[field] === 'number' ? row[field] as number : Number.NaN;
  const str = (row: Row, field: string | undefined): string => field ? String(row[field] ?? '') : '';
  const unit = (axis: 'x' | 'y') => spec.unit?.[axis] ? ` ${spec.unit[axis]}` : '';

  // Series in the order the agent listed colours, then first appearance.
  const present = spec.color ? [...new Set(rows.map((row) => str(row, spec.color)))] : [];
  const series = spec.colors ? [...Object.keys(spec.colors).filter((key) => present.includes(key)), ...present.filter((key) => !(key in spec.colors!))] : present;
  const seriesInfo = (value: string): { tone: DrawnTone | 'soft'; state?: DrawnState | undefined; label?: string | undefined } => {
    const entry = spec.colors?.[value];
    if (typeof entry === 'string') return { tone: entry };
    if (entry) return { tone: entry.tone ?? SERIES_TONES[series.indexOf(value) % SERIES_TONES.length]!, state: entry.state, label: entry.label };
    return { tone: SERIES_TONES[Math.max(0, series.indexOf(value)) % SERIES_TONES.length]! };
  };
  const [highlightKey, highlightValue] = spec.highlight ? Object.entries(spec.highlight)[0]! : [];
  const lineLike = spec.mark === 'line' || spec.mark === 'area' || spec.mark === 'point';
  const paintOf = (row: Row): Paint => {
    const state = (row.state as DrawnState | undefined) ?? (spec.color ? seriesInfo(str(row, spec.color)).state : undefined);
    if (typeof row.tone === 'string') return { color: toneColor(row.tone as DrawnTone), state };
    if (spec.color) return { color: toneColor(seriesInfo(str(row, spec.color)).tone), state };
    if (highlightKey !== undefined) return { color: row[highlightKey] === highlightValue ? toneColor('accent') : toneColor('neutral'), state };
    return { color: lineLike ? toneColor('fg') : toneColor('neutral'), state };
  };
  const fill = (row: Row) => { const paint = paintOf(row); return paint.state === 'unknown' ? DRAWN_HATCH : paint.state === 'projected' ? 'none' : paint.color; };
  const stroke = (row: Row) => { const paint = paintOf(row); return paint.state === 'projected' ? paint.color : paint.state === 'unknown' ? 'var(--drawn-hatch)' : 'none'; };
  const dash = (row: Row) => paintOf(row).state === 'projected' ? '4 3' : 'none';
  const valueLabel = (row: Row, field: string, axis: 'x' | 'y'): string => {
    if (spec.text && row[spec.text] !== undefined && row[spec.text] !== null) return String(row[spec.text]);
    const state = paintOf(row).state;
    if (state === 'unknown' || typeof row[field] !== 'number') return 'unknown';
    return `${state === 'projected' ? '~' : ''}${formatDrawnNumber(row[field])}${unit(axis)}`;
  };
  const tip = (row: Row): string => {
    if (typeof row.note === 'string') return row.note;
    const names = [yCat ? str(row, spec.y) : '', xCat ? str(row, spec.x) : '', spec.color ? str(row, spec.color) : ''].filter(Boolean);
    const value = spec.mark === 'interval' || (spec.x2 && !xCat)
      ? `${formatDrawnNumber(num(row, spec.x))}–${formatDrawnNumber(num(row, spec.x2))}${unit('x')}`
      : yCat ? valueLabel(row, spec.x, 'x') : valueLabel(row, spec.y, 'y');
    const label = spec.mark === 'point' && spec.text ? str(row, spec.text) : '';
    return `${[label, ...names].filter(Boolean).join(' · ')}${names.length || label ? ': ' : ''}${value}${paintOf(row).state === 'projected' ? ' (projected)' : ''}`;
  };

  // Unknown bars need some length to carry their hatching.
  const known = rows.map((row) => num(row, yCat ? spec.x : spec.y)).filter(Number.isFinite);
  const placeholder = Math.max(1, ...known) * 0.3;
  const valueOf = (row: Row, field: string) => Number.isFinite(num(row, field)) ? num(row, field) : placeholder;

  const marks: AnyMark[] = [];
  const legend: CompiledChart['legend'] = [];
  const overlay = { channel: 'y' as const, scale: scaleLinear().domain([0, 1]), axis: false as const };
  const overlayX = { channel: 'x' as const, scale: scaleLinear().domain([0, 1]), axis: false as const };
  let rowHeight = 32;

  // Shaded areas sit under the data.
  for (const region of spec.regions ?? []) {
    const box = { x1: region.x?.[0] ?? 0, x2: region.x?.[1] ?? 0, y1: region.y?.[0] ?? 0, y2: region.y?.[1] ?? 0 };
    marks.push(decorative(rect([box], {
      x1: (d) => region.x ? d.x1 : 0, x2: (d) => region.x ? d.x2 : 1, y1: (d) => region.y ? d.y1 : 0, y2: (d) => region.y ? d.y2 : 1,
      ...(region.x ? {} : { xScale: 'overlayX' }), ...(region.y ? {} : { yScale: 'overlay' }),
      fill: region.state === 'unknown' ? DRAWN_HATCH : toneWash(region.tone), inset: 0
    })));
    if (region.label) marks.push(decorative(text([box], {
      x: (d) => region.x ? d.x1 : 0, y: (d) => region.y ? d.y2 : 1,
      ...(region.x ? {} : { xScale: 'overlayX' }), ...(region.y ? {} : { yScale: 'overlay' }),
      text: () => region.label!, anchor: 'start', dx: 6, dy: 10, fontSize: 11, fill: region.state === 'unknown' ? 'var(--drawn-text)' : toneColor(region.tone)
    })));
  }
  for (const band of spec.bands ?? []) {
    const wash = toneWash(band.tone ?? 'accent');
    if (band.x) {
      const [from, to] = band.x;
      if (xCat) {
        const cats = [...new Set(rows.map((row) => str(row, spec.x)))];
        const a = cats.indexOf(String(from)), b = cats.indexOf(String(to));
        const covered = a >= 0 && b >= 0 ? cats.slice(Math.min(a, b), Math.max(a, b) + 1) : [];
        marks.push(decorative(rect(covered, { x1: (d) => d, x2: (d) => d, y1: () => 0, y2: () => 1, yScale: 'overlay', fill: wash, inset: 0 })));
      } else {
        marks.push(decorative(rect([band.x], { x1: (d) => Number(d[0]), x2: (d) => Number(d[1]), y1: () => 0, y2: () => 1, yScale: 'overlay', fill: wash, inset: 0 })));
      }
      if (band.label) marks.push(decorative(text([band.x], { x: (d) => xCat ? String(d[0]) : (Number(d[0]) + Number(d[1])) / 2, y: () => 1, yScale: 'overlay', text: () => band.label!, anchor: xCat ? 'start' : 'middle', dy: -8, fontSize: 11, fill: toneColor(band.tone ?? 'accent') })));
    }
    if (band.y) {
      marks.push(decorative(rect([band.y], { x1: () => 0, x2: () => 1, xScale: 'overlayX', y1: (d) => d[0], y2: (d) => d[1], fill: wash, inset: 0 })));
      if (band.label) marks.push(decorative(text([band.y], { x: () => 1, xScale: 'overlayX', y: (d) => d[1], text: () => band.label!, anchor: 'end', dx: -4, dy: 9, fontSize: 11, fill: toneColor(band.tone ?? 'accent') })));
    }
  }

  if (spec.mark === 'bar' && spec.x2 && !xCat && !yCat) {
    // Bins: each row spans x..x2. rect paints are per mark, so split by paint.
    for (const [paint, members] of byPaint(rows, paintOf)) {
      marks.push(rect(members, {
        key: keyOf(members), x1: (d) => num(d, spec.x), x2: (d) => num(d, spec.x2), y1: () => 0, y2: (d) => num(d, spec.y),
        fill: paint.state === 'unknown' ? DRAWN_HATCH : paint.state === 'projected' ? `color-mix(in srgb, ${paint.color} 35%, transparent)` : paint.color,
        inset: 1
      }));
    }
  } else if (spec.mark === 'bar' && yCat) {
    rowHeight = spec.color && !spec.stack ? 12 * Math.max(1, series.length) + 16 : 34;
    if (spec.stack && spec.color) {
      const stacked = stackRowsX(rows, { x: (d: Row) => valueOf(d, spec.x), y: (d: Row) => str(d, spec.y), z: (d: Row) => str(d, spec.color) }) as Array<Row & { x1: number; x2: number }>;
      marks.push(barX(stacked, { key: keyOf(stacked), x1: (d) => d.x1, x2: (d) => d.x2, y: (d) => str(d, spec.y), fill, stroke, strokeDasharray: dash, strokeWidth: 1.5, inset: 1 }));
      const total = Math.max(...stacked.map((d) => d.x2));
      marks.push(decorative(text(stacked.filter((d) => d.x2 - d.x1 > total * 0.1), { x: (d) => d.x1, y: (d) => str(d, spec.y), text: (d) => formatDrawnNumber(num(d, spec.x)), anchor: 'start', dx: 6, fontSize: 11, fill: (d) => paintOf(d).state ? 'var(--drawn-text)' : 'var(--drawn-on-fill)' })));
    } else if (spec.color) {
      marks.push(barX(rows, { key: keyOf(rows), x: (d) => valueOf(d, spec.x), y: (d) => str(d, spec.y), z: (d) => str(d, spec.color), layout: group({ padding: 0.1 }), fill, stroke, strokeDasharray: dash, strokeWidth: 1.5 }));
    } else {
      // A log axis has no zero, so bars start at the bottom of its domain.
      const logFloor = spec.scale?.x === 'log' ? logDomain(rows.map((row) => num(row, spec.x)), spec.axis?.x)[0] : null;
      marks.push(barX(rows, { key: keyOf(rows), ...(logFloor === null ? { x: (d: Row) => valueOf(d, spec.x) } : { x1: () => logFloor, x2: (d: Row) => valueOf(d, spec.x) }), y: (d) => str(d, spec.y), fill, stroke, strokeDasharray: dash, strokeWidth: 1.5, maxThickness: 18 }));
      marks.push(decorative(text(rows, { x: (d) => valueOf(d, spec.x), y: (d) => str(d, spec.y), text: (d) => valueLabel(d, spec.x, 'x'), anchor: 'start', dx: 6, fontSize: 12, fill: (d) => highlightKey !== undefined && d[highlightKey] === highlightValue ? 'var(--drawn-fg)' : 'var(--drawn-text)' })));
    }
  } else if (spec.mark === 'bar') {
    if (spec.color && !spec.stack) {
      marks.push(barY(rows, { key: keyOf(rows), x: (d) => str(d, spec.x), y: (d) => valueOf(d, spec.y), z: (d) => str(d, spec.color), layout: group({ padding: 0.1 }), fill, stroke, strokeDasharray: dash, strokeWidth: 1.5 }));
    } else {
      marks.push(barY(rows, { key: keyOf(rows), x: (d) => str(d, spec.x), y: (d) => valueOf(d, spec.y), fill, stroke, strokeDasharray: dash, strokeWidth: 1.5, maxThickness: 48 }));
    }
  } else if (spec.mark === 'line' || spec.mark === 'area') {
    for (const value of series.length ? series : ['']) {
      const members = rows.filter((row) => !spec.color || str(row, spec.color) === value).sort((a, b) => num(a, spec.x) - num(b, spec.x));
      if (!members.length) continue;
      const color = value ? toneColor(seriesInfo(value).tone) : toneColor('fg');
      const projected = members.every((row) => paintOf(row).state === 'projected');
      if (spec.mark === 'area') marks.push(decorative(areaY(members, { key: keyOf(members), x: (d) => num(d, spec.x), y: (d) => num(d, spec.y), fill: color, fillOpacity: 0.14 })));
      marks.push(lineY(members, { key: keyOf(members), x: (d) => num(d, spec.x), y: (d) => num(d, spec.y), stroke: color, strokeWidth: 2, ...(projected ? { strokeDasharray: '5 4' } : {}) }));
      const last = members.at(-1)!;
      marks.push(decorative(dot([last], { x: (d) => num(d, spec.x), y: (d) => num(d, spec.y), r: 3, fill: color })));
      marks.push(decorative(text([last], { x: (d) => num(d, spec.x), y: (d) => num(d, spec.y), text: (d) => `${value || (spec.text ? str(d, spec.text) : spec.y)} · ${projected ? '~' : ''}${formatDrawnNumber(num(d, spec.y))}${unit('y')}`, anchor: 'start', dx: 8, fontSize: 12, fill: color === toneColor('neutral') ? 'var(--drawn-text)' : color })));
    }
  } else if (spec.mark === 'point') {
    for (const [paint, members] of byPaint(rows, paintOf)) {
      marks.push(dot(members, { key: keyOf(members), x: (d) => num(d, spec.x), y: (d) => num(d, spec.y), r: 4.5, fill: paint.state === 'projected' ? 'var(--drawn-card)' : paint.color, stroke: paint.color, strokeWidth: 1.5 }));
    }
    if (spec.text) marks.push(decorative(text(rows, { x: (d) => num(d, spec.x), y: (d) => num(d, spec.y), text: (d) => str(d, spec.text), anchor: 'start', dx: 8, fontSize: 11, fill: 'var(--drawn-fg)' })));
  } else if (spec.mark === 'interval') {
    rowHeight = 36;
    marks.push(barX(rows, { key: keyOf(rows), x1: (d) => num(d, spec.x), x2: (d) => num(d, spec.x2), y: (d) => str(d, spec.y), fill, stroke, strokeDasharray: dash, strokeWidth: 1.5, maxThickness: 18 }));
    if (spec.text) {
      const lo = Math.min(...rows.map((row) => num(row, spec.x))), hi = Math.max(...rows.map((row) => num(row, spec.x2)));
      const fits = (row: Row) => (num(row, spec.x2) - num(row, spec.x)) / Math.max(1e-9, hi - lo) * 480 > str(row, spec.text).length * 6.5 + 14;
      marks.push(decorative(text(rows.filter((row) => row[spec.text!] && fits(row)), { x: (d) => num(d, spec.x), y: (d) => str(d, spec.y), text: (d) => str(d, spec.text), anchor: 'start', dx: 6, fontSize: 11, fill: (d) => paintOf(d).state ? 'var(--drawn-text)' : 'var(--drawn-on-fill)' })));
    }
  } else if (spec.mark === 'cell') {
    rowHeight = 22;
    for (const value of series) {
      const info = seriesInfo(value);
      const members = rows.filter((row) => str(row, spec.color) === value);
      marks.push(cell(members, { key: keyOf(members), x: (d) => str(d, spec.x), y: (d) => str(d, spec.y), fill: info.state === 'unknown' ? DRAWN_HATCH : toneColor(info.tone), inset: 1.5, radius: 2 }));
    }
  }

  // Reference lines and events go on top.
  for (const ref of spec.refs ?? []) {
    if (ref.x !== undefined) {
      marks.push(ruleX([ref.x], { x: (d) => d, stroke: 'var(--drawn-fg)', strokeOpacity: 0.55, strokeDasharray: '3 3' }));
      if (ref.label) marks.push(decorative(text([ref.x], { x: (d) => d, y: () => 1, yScale: 'overlay', text: () => `${ref.label}${typeof ref.x === 'number' ? ` ${formatDrawnNumber(ref.x)}${unit('x')}` : ''}`, anchor: 'start', dx: 4, dy: -8, fontSize: 11, fill: 'var(--drawn-text)' })));
    }
    if (typeof ref.y === 'number') {
      marks.push(ruleY([ref.y], { y: (d) => d, stroke: 'var(--drawn-fg)', strokeOpacity: 0.55, strokeDasharray: '3 3' }));
      if (ref.label) marks.push(decorative(text([ref.y], { x: () => 1, xScale: 'overlayX', y: (d) => d, text: () => `${ref.label} ${formatDrawnNumber(ref.y)}${unit('y')}`, anchor: 'end', dy: -8, fontSize: 11, fill: 'var(--drawn-text)' })));
    }
    if (Array.isArray(ref.y)) {
      // Steps on a category axis run from band edge to band edge.
      const cats = xCat ? [...new Set(rows.map((row) => str(row, spec.x)))] : [];
      const at = (from: DrawnScalar) => xCat ? Math.max(0, cats.indexOf(String(from))) / Math.max(1, cats.length) : Number(from);
      const end = xCat ? 1 : Math.max(...rows.map((row) => num(row, spec.x2 ?? spec.x)).filter(Number.isFinite));
      const steps = ref.y;
      const points = steps.flatMap((step, index) => [{ x: at(step.from), y: step.value }, { x: index + 1 < steps.length ? at(steps[index + 1]!.from) : end, y: step.value }]);
      marks.push(decorative(lineY(points, { x: (d) => d.x, y: (d) => d.y, ...(xCat ? { xScale: 'overlayX' } : {}), stroke: 'var(--drawn-fg)', strokeOpacity: 0.55, strokeDasharray: '3 3' })));
      if (ref.label) marks.push(decorative(text([points.at(-1)!], { x: () => 1, xScale: 'overlayX', y: (d) => d.y, text: () => ref.label!, anchor: 'end', dy: -8, fontSize: 11, fill: 'var(--drawn-text)' })));
    }
  }
  for (const event of spec.events ?? []) {
    marks.push(ruleX([event.x], { x: (d) => d, stroke: toneColor('accent'), strokeOpacity: 1, strokeWidth: 1.2 }));
    marks.push(decorative(text([event.x], { x: (d) => d, y: () => 1, yScale: 'overlay', text: () => event.label, anchor: 'start', dx: 4, dy: -8, fontSize: 11, fill: toneColor('accent') })));
  }

  if (spec.color && spec.mark !== 'line' && spec.mark !== 'area') {
    for (const value of series) {
      const info = seriesInfo(value);
      legend.push({ label: info.label ?? value, color: toneColor(info.tone), state: info.state });
    }
  }

  const categories = (field: string) => [...new Set(rows.map((row) => str(row, field)))];
  const axisFor = (axis: 'x' | 'y', isCat: boolean) => {
    const options = spec.axis?.[axis];
    const ticks = options?.ticks;
    const tickValues = ticks?.map((tick) => typeof tick === 'number' ? tick : tick.value);
    const tickLabels = new Map(ticks?.flatMap((tick) => typeof tick === 'number' ? [] : [[tick.value, tick.label] as const]) ?? []);
    const every = isCat && axis === 'x' ? options?.every ?? Math.ceil(categories(spec.x).length / 9) : 1;
    const cats = isCat ? categories(spec[axis]) : [];
    return {
      ...(options?.label ? { label: options.label } : {}),
      ticks: {
        ...(tickValues ? { values: tickValues } : isCat && every > 1 ? { values: cats.filter((_, index) => index % every === 0) } : {}),
        format: (value: unknown) => tickLabels.get(value as number) ?? (typeof value === 'number' ? formatDrawnNumber(value) : String(value))
      },
      line: false
    };
  };
  const continuous = (axis: 'x' | 'y') => {
    const options = spec.axis?.[axis];
    if (spec.scale?.[axis] === 'log') {
      const field = axis === 'x' ? spec.x : spec.y;
      const [lo, hi] = logDomain(rows.map((row) => num(row, field)), options);
      return logScale(lo, hi);
    }
    if (options?.min !== undefined || options?.max !== undefined) {
      const field = axis === 'x' ? spec.x : spec.y;
      const values = rows.flatMap((row) => [num(row, field), axis === 'x' && spec.x2 ? num(row, spec.x2) : Number.NaN]).filter(Number.isFinite);
      return scaleLinear().domain([options.min ?? Math.min(0, ...values), options.max ?? Math.max(...values)]);
    }
    return scaleLinear;
  };
  // Categories keep the order rows first use them, whatever order marks draw in.
  const xScale = xCat ? scaleBand<string>().domain(categories(spec.x)).padding(spec.mark === 'cell' ? 0 : 0.2) : continuous('x');
  const yScale = yCat ? scaleBand<string>().domain(categories(spec.y)).padding(spec.mark === 'cell' ? 0 : 0.25) : continuous('y');
  const hasTopLabels = (spec.refs ?? []).some((ref) => ref.x !== undefined && ref.label) || (spec.events ?? []).length > 0 || (spec.bands ?? []).some((band) => band.x && band.label);
  const lineEnds = spec.mark === 'line' || spec.mark === 'area';
  const barEnds = spec.mark === 'bar' && yCat && !spec.stack && !spec.color;

  const definition = defineChart({
    marks,
    scales: {
      x: { scale: xScale as never, nice: !xCat && !spec.axis?.x?.ticks && spec.scale?.x !== 'log', grid: !xCat && yCat, axis: axisFor('x', xCat) },
      y: { scale: yScale as never, nice: !yCat && !spec.axis?.y?.ticks && spec.scale?.y !== 'log', grid: !yCat, axis: axisFor('y', yCat) },
      overlay,
      overlayX
    },
    margin: { top: hasTopLabels ? 26 : 8, right: lineEnds ? 130 : barEnds ? 84 : 12 },
    theme: { foreground: 'var(--drawn-fg)', muted: 'var(--drawn-text)', grid: 'var(--drawn-grid)' }
  } as never, {
    tooltip: { use: tooltip, sticky: false, format: (point: { datum: unknown }) => isRow(point.datum) ? tip(point.datum) : '' }
  } as never) as ChartDefinition;

  const bands = yCat ? categories(spec.y).length : 0;
  const height = yCat ? bands * rowHeight + (hasTopLabels ? 26 : 8) + 30 + (spec.axis?.x?.label ? 16 : 0) : 240;
  return { definition, height, legend };
}

// Rows have no ids of their own; their position keeps marks stable.
function keyOf<T extends object>(list: readonly T[]): (datum: T) => number {
  const index = new Map(list.map((item, position) => [item, position]));
  return (datum) => index.get(datum) ?? -1;
}

function isRow(value: unknown): value is Row {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function byPaint(rows: Row[], paintOf: (row: Row) => Paint): Array<[Paint, Row[]]> {
  const groups = new Map<string, [Paint, Row[]]>();
  for (const row of rows) {
    const paint = paintOf(row);
    const key = `${paint.color}|${paint.state ?? ''}`;
    const entry = groups.get(key);
    if (entry) entry[1].push(row);
    else groups.set(key, [paint, [row]]);
  }
  return [...groups.values()];
}

function logDomain(values: number[], axis?: { min?: number | undefined; max?: number | undefined }): [number, number] {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0);
  const ticks = (axis as { ticks?: Array<number | { value: number }> } | undefined)?.ticks?.map((tick) => typeof tick === 'number' ? tick : tick.value).filter((value) => value > 0) ?? [];
  const all = [...positive, ...ticks];
  return [axis?.min ?? Math.min(...all) / 1.6, axis?.max ?? Math.max(...all) * 1.4];
}

// Compact scales have no log; this is the small subset Charts needs.
function logScale(min?: number, max?: number): () => InferableScaleLike<number> {
  const make = (): InferableScaleLike<number> => {
    let domain: [number, number] = [min ?? 1, max ?? 10];
    let range: [number, number] = [0, 1];
    const fixed = min !== undefined && max !== undefined;
    const scale = Object.assign((value: number) => value > 0
      ? range[0] + (Math.log10(value) - Math.log10(domain[0])) / (Math.log10(domain[1]) - Math.log10(domain[0]) || 1) * (range[1] - range[0])
      : undefined, {
      domain: (next?: Iterable<number>) => {
        if (!next) return domain;
        const values = [...next].filter((value) => value > 0);
        if (!fixed && values.length) domain = [min ?? Math.min(...values) / 1.6, max ?? Math.max(...values) * 1.4];
        return scale;
      },
      range: (next?: Iterable<number>) => { if (!next) return range; const values = [...next]; range = [values[0]!, values[1]!]; return scale; },
      copy: () => { const copy = make() as never as { domain: (value: Iterable<number>) => unknown; range: (value: Iterable<number>) => unknown }; copy.domain(domain); copy.range(range); return copy; },
      ticks: () => {
        const out: number[] = [];
        for (let power = Math.ceil(Math.log10(domain[0])); power <= Math.floor(Math.log10(domain[1])); power++) out.push(10 ** power);
        return out;
      }
    });
    return scale as never;
  };
  return make;
}
