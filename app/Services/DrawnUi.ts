// Drawn UI: agents describe a figure as data and Patterm draws it with its
// own components. This module is the one definition of that data, shared by
// the MCP tool (which rejects bad specs with exact paths) and the renderer
// (which re-checks transcript input before drawing). It is pure so smoke tests
// and the browser can both use it.

import { z } from 'zod';
import { DRAWN_ID, type TranscriptTool } from './TranscriptProjection';

export const DRAWN_UI_TOOL = 'patterm.ui.save';
export const MAX_DRAWN_UI_BYTES = 200_000;

const short = z.string().trim().min(1).max(120);
const text = z.string().trim().min(1).max(600);
const field = z.string().min(1).max(64);
const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/, 'use letters, digits and _; start with a letter');
const refId = z.string().regex(new RegExp(`^${DRAWN_ID}$`), 'use letters, digits, _ and -');
const finite = z.number().finite();
const scalar = z.union([z.string().max(600), finite, z.boolean(), z.null()]);
// "=agents * turns" — a number computed from the section's inputs.
const formula = z.string().regex(/^=/, 'a formula starts with =').max(400);
const numberish = z.union([finite, formula]);

export const DRAWN_TONES = ['neutral', 'accent', 'good', 'warn', 'bad', 'muted'] as const;
export const DRAWN_STATES = ['measured', 'projected', 'unknown'] as const;
const tone = z.enum(DRAWN_TONES);
const state = z.enum(DRAWN_STATES);
const highlight = z.record(scalar).refine((value) => Object.keys(value).length === 1, 'name exactly one field, such as { "phase": "Snapshot" }');

const axis = z.object({
  label: short.optional(),
  min: finite.optional(),
  max: finite.optional(),
  ticks: z.array(z.union([finite, z.object({ value: finite, label: short }).strict()])).max(20).optional(),
  every: z.number().int().min(1).max(100).optional()
}).strict();
const position = z.union([finite, z.string().max(120)]);

export const DRAWN_MARKS = ['bar', 'line', 'area', 'point', 'interval', 'cell'] as const;
const chart = z.object({
  type: z.literal('chart'),
  mark: z.enum(DRAWN_MARKS),
  data: z.array(z.record(scalar)).min(1).max(2000),
  fields: z.array(field).min(1).max(40).optional(),
  x: field,
  y: field,
  x2: field.optional(),
  color: field.optional(),
  colors: z.record(z.union([tone, z.object({ tone: z.union([tone, z.literal('soft')]).optional(), state: state.optional(), label: short.optional() }).strict()])).optional(),
  stack: z.boolean().optional(),
  scale: z.object({ x: z.enum(['linear', 'log']).optional(), y: z.enum(['linear', 'log']).optional() }).strict().optional(),
  unit: z.object({ x: z.string().max(24).optional(), y: z.string().max(24).optional() }).strict().optional(),
  axis: z.object({ x: axis.optional(), y: axis.optional() }).strict().optional(),
  text: field.optional(),
  highlight: highlight.optional(),
  refs: z.array(z.object({
    x: position.optional(),
    y: z.union([numberish, z.array(z.object({ from: position, value: finite }).strict()).min(1).max(50)]).optional(),
    label: short.optional()
  }).strict()).max(20).optional(),
  bands: z.array(z.object({ x: z.tuple([position, position]).optional(), y: z.tuple([finite, finite]).optional(), label: short.optional(), tone: tone.optional() }).strict()).max(20).optional(),
  events: z.array(z.object({ x: position, label: short }).strict()).max(20).optional(),
  regions: z.array(z.object({ x: z.tuple([finite, finite]).optional(), y: z.tuple([finite, finite]).optional(), label: short.optional(), tone: tone.optional(), state: state.optional() }).strict()).max(20).optional(),
  title: short.optional()
}).strict();

const cell = z.union([scalar, z.object({ value: scalar.optional(), state: state.optional(), tone: tone.optional() }).strict()]);
export const DRAWN_COLUMN_KINDS = ['text', 'number', 'status', 'verdict', 'mono'] as const;
const table = z.object({
  type: z.literal('table'),
  columns: z.array(z.object({ key: field, label: z.string().max(120).optional(), kind: z.enum(DRAWN_COLUMN_KINDS).optional() }).strict()).min(1).max(12),
  rows: z.array(z.record(cell)).min(1).max(500),
  header: z.boolean().optional(),
  highlight: highlight.optional()
}).strict();

const diagram = z.object({
  type: z.literal('diagram'),
  layout: z.enum(['flow', 'sequence', 'nest']).optional(),
  nodes: z.array(z.object({
    id: field,
    label: short,
    sub: short.optional(),
    kind: z.enum(['step', 'store', 'external']).optional(),
    tone: tone.optional(),
    parent: field.optional(),
    highlight: z.boolean().optional(),
    note: text.optional()
  }).strict()).min(1).max(40),
  edges: z.array(z.object({
    from: field,
    to: field,
    label: short.optional(),
    text: text.optional(),
    highlight: z.boolean().optional(),
    async: z.boolean().optional(),
    mono: z.boolean().optional()
  }).strict()).max(80).optional(),
  stepThrough: z.boolean().optional(),
  steps: z.array(z.object({ text, highlight: z.array(field).max(40).optional() }).strict()).min(1).max(30).optional()
}).strict();

export const DRAWN_FORMATS = ['compact', 'percent', 'duration'] as const;
const stats = z.object({
  type: z.literal('stats'),
  items: z.array(z.object({
    label: short,
    value: z.union([finite, z.string().max(80)]).optional(),
    unit: z.string().max(24).optional(),
    state: state.optional(),
    tone: tone.optional(),
    format: z.enum(DRAWN_FORMATS).optional(),
    delta: z.object({ text: short, tone: tone.optional() }).strict().optional(),
    of: numberish.optional(),
    detail: z.array(short).max(8).optional(),
    note: text.optional()
  }).strict()).min(1).max(8)
}).strict();

const steps = z.object({
  type: z.literal('steps'),
  items: z.array(z.object({ title: short, body: text.optional(), status: z.enum(['done', 'now', 'next']).optional(), date: z.string().trim().min(1).max(40).optional() }).strict()).min(1).max(20)
}).strict();

const choice = z.object({
  type: z.literal('choice'),
  id: refId.optional(),
  question: text.optional(),
  ask: z.boolean().optional(),
  options: z.array(z.object({
    value: field,
    label: short,
    detail: text.optional(),
    pros: z.array(short).max(6).optional(),
    cons: z.array(short).max(6).optional(),
    pick: z.boolean().optional(),
    key: z.string().regex(/^[a-z0-9]$/, 'one lowercase letter or digit').optional()
  }).strict()).min(1).max(8),
  items: z.array(z.object({ id: field, body: text, meta: short.optional() }).strict()).min(1).max(50).optional()
}).strict();

const image = z.object({
  type: z.literal('image'),
  path: z.string().min(1).max(1000),
  title: short.optional(),
  caption: text.optional(),
  alt: short.optional()
}).strict();

const figure = z.discriminatedUnion('type', [chart, table, diagram, stats, steps, choice, image]);

const input = z.object({
  id: ident,
  label: short,
  min: finite,
  max: finite,
  step: z.number().positive().finite().optional(),
  value: finite,
  unit: z.string().max(12).optional()
}).strict();

const section = z.object({
  claim: z.string().trim().min(1).max(300),
  figure,
  source: text.optional(),
  inputs: z.array(input).min(1).max(6).optional(),
  constants: z.record(ident, finite).optional()
}).strict();

export const drawnUiInput = z.object({
  // Names the figure so the reply can place it with [patterm_figure:<id>].
  id: refId.optional(),
  title: short.optional(),
  // Sliders every section shares, drawn once above them.
  inputs: z.array(input).min(1).max(6).optional(),
  constants: z.record(ident, finite).optional(),
  sections: z.array(section).min(1).max(8)
}).strict();

export type DrawnUi = z.infer<typeof drawnUiInput>;
export type DrawnSection = DrawnUi['sections'][number];
export type DrawnFigure = DrawnSection['figure'];
export type DrawnChart = z.infer<typeof chart>;
export type DrawnTable = z.infer<typeof table>;
export type DrawnDiagram = z.infer<typeof diagram>;
export type DrawnStats = z.infer<typeof stats>;
export type DrawnSteps = z.infer<typeof steps>;
export type DrawnChoice = z.infer<typeof choice>;
export type DrawnImage = z.infer<typeof image>;
export type DrawnTone = typeof DRAWN_TONES[number];
export type DrawnState = typeof DRAWN_STATES[number];
export type DrawnScalar = z.infer<typeof scalar>;

/* ---------- formulas: arithmetic only ---------- */

type Formula =
  | { kind: 'num'; value: number }
  | { kind: 'name'; name: string }
  | { kind: 'neg'; arg: Formula }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' | '^'; left: Formula; right: Formula }
  | { kind: 'call'; fn: keyof typeof FUNCTIONS; args: Formula[] };

const FUNCTIONS = { min: Math.min, max: Math.max, round: Math.round, floor: Math.floor, ceil: Math.ceil, abs: Math.abs, sqrt: Math.sqrt };

export function parseFormula(source: string): Formula {
  const tokens = source.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|[A-Za-z_]\w*|[-+*/^(),]|\S/g) ?? [];
  let index = 0;
  const peek = () => tokens[index];
  const next = () => tokens[index++];
  const expect = (token: string) => { if (next() !== token) throw new Error(`expected ${token}`); };
  const primary = (): Formula => {
    const token = next();
    if (token === undefined) throw new Error('unexpected end');
    if (/^\d/.test(token)) return { kind: 'num', value: Number(token) };
    if (token === '(') { const inner = sum(); expect(')'); return inner; }
    if (token === '-') return { kind: 'neg', arg: power() };
    if (/^[A-Za-z_]/.test(token)) {
      if (peek() !== '(') return { kind: 'name', name: token };
      if (!Object.hasOwn(FUNCTIONS, token)) throw new Error(`unknown function ${token}; use ${Object.keys(FUNCTIONS).join(', ')}`);
      next();
      const args = [sum()];
      while (peek() === ',') { next(); args.push(sum()); }
      expect(')');
      return { kind: 'call', fn: token as keyof typeof FUNCTIONS, args };
    }
    throw new Error(`unexpected ${token}`);
  };
  const power = (): Formula => { const base = primary(); if (peek() === '^') { next(); return { kind: 'op', op: '^', left: base, right: power() }; } return base; };
  const product = (): Formula => { let left = power(); while (peek() === '*' || peek() === '/') { const op = next() as '*' | '/'; left = { kind: 'op', op, left, right: power() }; } return left; };
  const sum = (): Formula => { let left = product(); while (peek() === '+' || peek() === '-') { const op = next() as '+' | '-'; left = { kind: 'op', op, left, right: product() }; } return left; };
  const result = sum();
  if (index < tokens.length) throw new Error(`unexpected ${tokens[index]}`);
  return result;
}

export function formulaNames(formula: Formula): string[] {
  if (formula.kind === 'name') return [formula.name];
  if (formula.kind === 'neg') return formulaNames(formula.arg);
  if (formula.kind === 'op') return [...formulaNames(formula.left), ...formulaNames(formula.right)];
  if (formula.kind === 'call') return formula.args.flatMap(formulaNames);
  return [];
}

export function evaluateFormula(formula: Formula, vars: Record<string, number>): number {
  switch (formula.kind) {
    case 'num': return formula.value;
    // Only the section's own inputs and constants, never inherited keys.
    case 'name': return Object.hasOwn(vars, formula.name) && typeof vars[formula.name] === 'number' ? vars[formula.name]! : Number.NaN;
    case 'neg': return -evaluateFormula(formula.arg, vars);
    case 'call': return (FUNCTIONS[formula.fn] as (...args: number[]) => number)(...formula.args.map((arg) => evaluateFormula(arg, vars)));
    case 'op': {
      const left = evaluateFormula(formula.left, vars);
      const right = evaluateFormula(formula.right, vars);
      return formula.op === '+' ? left + right : formula.op === '-' ? left - right : formula.op === '*' ? left * right : formula.op === '/' ? left / right : left ** right;
    }
  }
}

const formulaCache = new Map<string, Formula>();
function cachedFormula(source: string): Formula {
  let parsed = formulaCache.get(source);
  if (!parsed) {
    parsed = parseFormula(source);
    if (formulaCache.size > 500) formulaCache.clear();
    formulaCache.set(source, parsed);
  }
  return parsed;
}

// Replaces every "=formula" string in a figure with its number.
export function resolveFormulas<T>(value: T, vars: Record<string, number>): T {
  if (Array.isArray(value)) return value.map((item) => resolveFormulas(item, vars)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveFormulas(item, vars)])) as T;
  if (typeof value === 'string' && value.startsWith('=')) {
    try { return evaluateFormula(cachedFormula(value.slice(1)), vars) as T; } catch { return Number.NaN as T; }
  }
  return value;
}

const COMPACT = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });
const PLAIN = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

export function formatDrawnNumber(value: unknown, format?: typeof DRAWN_FORMATS[number]): string {
  if (typeof value !== 'number') return value === undefined || value === null ? '—' : String(value);
  if (!Number.isFinite(value)) return '—';
  if (format === 'percent') return `${Math.round(value)}%`;
  if (format === 'compact') return COMPACT.format(value);
  if (format === 'duration') return value >= 120 ? `${(value / 60).toFixed(1)} h` : `${Math.round(value)} min`;
  return PLAIN.format(value);
}

// "At this rate it lasts {budget / rate|duration}" with formulas filled in.
export function fillClaim(claim: string, vars: Record<string, number>): string {
  return claim.replace(/\{([^}|]+)(?:\|(\w+))?\}/g, (_, source: string, format?: string) => {
    try { return formatDrawnNumber(evaluateFormula(cachedFormula(source.replace(/^\s*=/, '')), vars), format as typeof DRAWN_FORMATS[number]); } catch { return '?'; }
  });
}

export function sectionVars(section: DrawnSection, values: Record<string, number> = {}, shared: SharedVars = {}): Record<string, number> {
  const vars: Record<string, number> = { ...(shared.constants ?? {}), ...(section.constants ?? {}) };
  for (const item of [...(shared.inputs ?? []), ...(section.inputs ?? [])]) vars[item.id] = values[item.id] ?? item.value;
  return vars;
}

// Steps for a flow's Back/Next. Without explicit steps, it walks the edges.
export function flowSteps(diagram: DrawnDiagram): Array<{ text: string; highlight: string[] }> {
  if (diagram.steps) return diagram.steps.map((step) => ({ text: step.text, highlight: step.highlight ?? [] }));
  const label = (id: string) => diagram.nodes.find((node) => node.id === id)?.label ?? id;
  return (diagram.edges ?? []).map((edge) => ({ text: edge.text ?? edge.label ?? `${label(edge.from)} → ${label(edge.to)}`, highlight: [edge.from, `${edge.from}>${edge.to}`, edge.to] }));
}

/* ---------- validation ---------- */

export type DrawnUiResult = { ok: true; value: DrawnUi } | { ok: false; errors: string[] };

export function parseDrawnUi(raw: unknown): DrawnUiResult {
  let size = 0;
  try { size = JSON.stringify(raw)?.length ?? 0; } catch { return { ok: false, errors: ['input: could not be read as JSON'] }; }
  if (size > MAX_DRAWN_UI_BYTES) return { ok: false, errors: [`input: ${size} bytes is over the ${MAX_DRAWN_UI_BYTES} byte limit; summarise the data first`] };
  const expanded = expandShorthand(raw);
  const parsed = drawnUiInput.safeParse(expanded);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 8).map((issue) => `${pathText(issue.path)}: ${issueText(issue, expanded)}`) };
  const errors: string[] = [];
  const shared = { inputs: parsed.data.inputs, constants: parsed.data.constants };
  parsed.data.sections.forEach((item, index) => checkSection(item, `sections[${index}]`, errors, shared));
  checkInputs(parsed.data.inputs, 'inputs', errors);
  return errors.length ? { ok: false, errors: errors.slice(0, 8) } : { ok: true, value: parsed.data };
}

// Agents may send one section without the wrapper, chart rows as arrays in
// `fields` order, and table rows as arrays in column order. Everything after
// this sees the long form.
function expandShorthand(input: unknown): unknown {
  const raw = jsonValue(input);
  if (!isRecord(raw)) return raw;
  const { title, id, ...rest } = raw;
  const envelope = !('sections' in raw) && 'figure' in raw ? { ...(title === undefined ? {} : { title }), ...(id === undefined ? {} : { id }), sections: [rest] } : raw;
  const sections = jsonValue(envelope.sections);
  if (!Array.isArray(sections)) return envelope;
  return {
    ...envelope,
    sections: sections.map((item) => {
      const section = jsonValue(item);
      if (!isRecord(section)) return section;
      const figure = jsonValue(section.figure);
      return {
        ...section,
        ...(section.inputs === undefined ? {} : { inputs: jsonValue(section.inputs) }),
        ...(section.constants === undefined ? {} : { constants: jsonValue(section.constants) }),
        figure: isRecord(figure) ? expandFigure(figure) : figure
      };
    })
  };
}

// Some clients send nested arguments as JSON text when the tool schema
// leaves their shape open; read those as the values they spell.
function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
}

function expandFigure(figure: Record<string, unknown>): Record<string, unknown> {
  const zip = (keys: unknown, rows: unknown): unknown => {
    if (!Array.isArray(keys) || !Array.isArray(rows) || !rows.some(Array.isArray)) return rows;
    // A last element that is an object carries the row's own options, such as { state, tone, note }.
    return rows.map((row) => {
      if (!Array.isArray(row)) return row;
      const extra = row.length > keys.length && isRecord(row[row.length - 1]) ? row[row.length - 1] as Record<string, unknown> : {};
      return { ...Object.fromEntries(keys.flatMap((key, index) => typeof key === 'string' && row[index] !== undefined ? [[key, row[index]]] : [])), ...extra };
    });
  };
  if (figure.type === 'chart') return { ...figure, data: zip(figure.fields, figure.data) };
  if (figure.type === 'table' && Array.isArray(figure.columns)) return { ...figure, rows: zip(figure.columns.map((column) => isRecord(column) ? column.key : undefined), figure.rows) };
  return figure;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pathText(path: Array<string | number>): string {
  return path.reduce<string>((out, part) => typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${part}` : part, '') || 'input';
}

function issueText(issue: z.ZodIssue, data: unknown): string {
  if (issue.code === 'invalid_union_discriminator') return `expected type ${issue.options.map((option) => `"${String(option)}"`).join(' | ')}`;
  if (issue.code === 'invalid_enum_value') return `expected ${issue.options.map((option) => `"${String(option)}"`).join(' | ')}, got "${String(issue.received)}"`;
  if (issue.code === 'unrecognized_keys') {
    const allowed = optionsAt(drawnUiInput, data, issue.path);
    return `unknown option${issue.keys.length > 1 ? 's' : ''} ${issue.keys.map((key) => `"${key}"`).join(', ')}${allowed ? `; options here are ${allowed.join(', ')}` : ''}`;
  }
  return issue.message;
}

// The option names an object accepts, so a rejected key comes with the right ones.
function optionsAt(schema: z.ZodTypeAny, data: unknown, path: Array<string | number>): string[] | null {
  let current: z.ZodTypeAny = schema;
  let value = data;
  let index = 0;
  for (;;) {
    while (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodEffects) current = current instanceof z.ZodEffects ? current.innerType() : current._def.innerType;
    if (current instanceof z.ZodDiscriminatedUnion) {
      const type = isRecord(value) ? value[current.discriminator] : undefined;
      const option = current.optionsMap.get(type as z.Primitive);
      if (!option) return null;
      current = option;
      continue;
    }
    if (index === path.length) return current instanceof z.ZodObject ? Object.keys(current.shape) : null;
    const step = path[index++]!;
    if (current instanceof z.ZodArray && typeof step === 'number') { current = current.element; value = Array.isArray(value) ? value[step] : undefined; continue; }
    if (current instanceof z.ZodObject && typeof step === 'string') { current = current.shape[step]; value = isRecord(value) ? value[step] : undefined; if (!current) return null; continue; }
    if (current instanceof z.ZodRecord) { current = current.valueSchema; value = isRecord(value) ? value[step as string] : undefined; continue; }
    return null;
  }
}

type SharedVars = Pick<DrawnUi, 'inputs' | 'constants'>;

function checkInputs(inputs: DrawnSection['inputs'], path: string, errors: string[]): void {
  for (const [index, input] of (inputs ?? []).entries()) {
    if (input.min >= input.max) errors.push(`${path}[${index}]: min must be below max`);
    if (input.value < input.min || input.value > input.max) errors.push(`${path}[${index}].value: must be between min and max`);
  }
}

function checkSection(item: DrawnSection, path: string, errors: string[], shared: SharedVars = {}): void {
  const known = new Set([...(shared.inputs ?? []), ...(item.inputs ?? [])].map((input) => input.id).concat(Object.keys({ ...shared.constants, ...item.constants })));
  const formulas: Array<[string, string]> = [];
  collectFormulas(item.figure, `${path}.figure`, formulas);
  for (const match of item.claim.matchAll(/\{([^}|]+)(?:\|(\w+))?\}/g)) {
    formulas.push([`${path}.claim`, `=${match[1]!.replace(/^\s*=/, '')}`]);
    if (match[2] && !(DRAWN_FORMATS as readonly string[]).includes(match[2])) errors.push(`${path}.claim: unknown format "${match[2]}"; use ${DRAWN_FORMATS.join(' | ')}`);
  }
  for (const [where, source] of formulas) {
    try {
      const names = formulaNames(parseFormula(source.slice(1))).filter((name) => !known.has(name));
      if (names.length) errors.push(`${where}: ${names.map((name) => `"${name}"`).join(', ')} ${names.length > 1 ? 'are' : 'is'} not an input or constant of this section`);
    } catch (error) {
      errors.push(`${where}: formula ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  checkInputs(item.inputs, `${path}.inputs`, errors);
  const figurePath = `${path}.figure`;
  const fig = item.figure;
  if (fig.type === 'chart') checkChart(fig, figurePath, errors);
  if (fig.type === 'table') checkTable(fig, figurePath, errors);
  if (fig.type === 'diagram') checkDiagram(fig, figurePath, errors);
  if (fig.type === 'choice') checkChoice(fig, figurePath, errors);
}

function collectFormulas(value: unknown, path: string, out: Array<[string, string]>): void {
  if (Array.isArray(value)) value.forEach((item, index) => collectFormulas(item, `${path}[${index}]`, out));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) collectFormulas(item, `${path}.${key}`, out);
  else if (typeof value === 'string' && value.startsWith('=') && value.length > 1) out.push([path, value]);
}

function isNumberish(value: unknown): boolean {
  return typeof value === 'number' || (typeof value === 'string' && value.startsWith('='));
}

function checkChart(chart: DrawnChart, path: string, errors: string[]): void {
  const fields = new Set(chart.data.flatMap((row) => Object.keys(row)));
  for (const key of ['x', 'y', 'x2', 'color', 'text'] as const) {
    const name = chart[key];
    if (name && !fields.has(name)) errors.push(`${path}.${key}: no row has a field "${name}"; fields are ${[...fields].slice(0, 12).join(', ')}`);
  }
  const categorical = (name: string) => chart.data.some((row) => typeof row[name] === 'string' && !String(row[name]).startsWith('='));
  const numeric = (name: string) => chart.data.every((row) => row[name] === undefined || row[name] === null || isNumberish(row[name]));
  if (chart.mark === 'interval') {
    if (!chart.x2) errors.push(`${path}.x2: interval needs x2, the field holding where each interval ends`);
    if (!categorical(chart.y)) errors.push(`${path}.y: interval needs a text field on y for the lanes`);
  }
  if (chart.mark === 'cell') {
    if (!categorical(chart.x) || !categorical(chart.y)) errors.push(`${path}: cell needs text fields on both x and y`);
    if (!chart.color) errors.push(`${path}.color: cell needs color, the field holding each cell's state`);
  }
  if (chart.mark === 'bar' && !chart.x2 && categorical(chart.x) === categorical(chart.y)) errors.push(`${path}: bar needs one text field (the categories) and one number field; use x2 for bins`);
  if ((chart.mark === 'line' || chart.mark === 'area' || chart.mark === 'point') && (!numeric(chart.y))) errors.push(`${path}.y: ${chart.mark} needs numbers on y`);
  if ((chart.mark === 'line' || chart.mark === 'area') && !numeric(chart.x)) errors.push(`${path}.x: ${chart.mark} needs numbers on x; use bar for categories`);
  for (const key of ['x', 'y'] as const) {
    if (chart.scale?.[key] !== 'log') continue;
    if (chart.data.some((row) => typeof row[chart[key]] === 'number' && (row[chart[key]] as number) <= 0)) errors.push(`${path}.scale.${key}: a log scale needs values above 0`);
    const { min, max } = chart.axis?.[key] ?? {};
    if ((min !== undefined && min <= 0) || (max !== undefined && max <= 0)) errors.push(`${path}.axis.${key}: a log scale needs min and max above 0`);
    else if (min !== undefined && max !== undefined && min >= max) errors.push(`${path}.axis.${key}: min must be below max`);
  }
  chart.data.forEach((row, index) => {
    if (row.tone !== undefined && !(DRAWN_TONES as readonly unknown[]).includes(row.tone)) errors.push(`${path}.data[${index}].tone: expected ${DRAWN_TONES.join(' | ')}`);
    if (row.state !== undefined && !(DRAWN_STATES as readonly unknown[]).includes(row.state)) errors.push(`${path}.data[${index}].state: expected ${DRAWN_STATES.join(' | ')}`);
  });
  const [key] = chart.highlight ? Object.keys(chart.highlight) : [];
  if (key && !fields.has(key)) errors.push(`${path}.highlight: no row has a field "${key}"`);
}

function checkTable(table: DrawnTable, path: string, errors: string[]): void {
  const keys = new Set(table.columns.map((column) => column.key));
  if (keys.size !== table.columns.length) errors.push(`${path}.columns: keys must be unique`);
  if (!table.rows.some((row) => table.columns.some((column) => row[column.key] !== undefined))) errors.push(`${path}.rows: no row has a value for any column key (${[...keys].join(', ')})`);
  table.rows.forEach((row, index) => {
    if (row.tone !== undefined && !(DRAWN_TONES as readonly unknown[]).includes(row.tone)) errors.push(`${path}.rows[${index}].tone: expected ${DRAWN_TONES.join(' | ')}`);
    if (row.state !== undefined && !(DRAWN_STATES as readonly unknown[]).includes(row.state)) errors.push(`${path}.rows[${index}].state: expected ${DRAWN_STATES.join(' | ')}`);
  });
}

function checkDiagram(diagram: DrawnDiagram, path: string, errors: string[]): void {
  const ids = new Set<string>();
  for (const [index, node] of diagram.nodes.entries()) {
    if (ids.has(node.id)) errors.push(`${path}.nodes[${index}].id: "${node.id}" is used twice`);
    ids.add(node.id);
  }
  const layout = diagram.layout ?? 'flow';
  const edges = diagram.edges ?? [];
  edges.forEach((edge, index) => {
    if (!ids.has(edge.from)) errors.push(`${path}.edges[${index}].from: no node with id "${edge.from}"`);
    if (!ids.has(edge.to)) errors.push(`${path}.edges[${index}].to: no node with id "${edge.to}"`);
  });
  if (layout === 'nest') {
    diagram.nodes.forEach((node, index) => { if (node.parent && !ids.has(node.parent)) errors.push(`${path}.nodes[${index}].parent: no node with id "${node.parent}"`); });
    const parent = new Map(diagram.nodes.map((node) => [node.id, node.parent]));
    for (const node of diagram.nodes) {
      const seen = new Set<string>();
      for (let current: string | undefined = node.id; current; current = parent.get(current)) {
        if (seen.has(current)) { errors.push(`${path}.nodes: parents loop back through "${current}"`); return; }
        seen.add(current);
      }
    }
  }
  if (layout === 'sequence' && diagram.nodes.length < 2) errors.push(`${path}.nodes: a sequence needs at least two nodes`);
  if (layout === 'flow') {
    if (flowHasCycle(diagram.nodes.map((node) => node.id), edges)) errors.push(`${path}.edges: a flow cannot loop back; use layout "sequence" for back-and-forth`);
    if (diagram.stepThrough && !diagram.steps && !edges.length) errors.push(`${path}.edges: stepThrough on a flow steps through its edges, or through steps: [{ text, highlight: [ids] }]`);
    const targets = new Set([...ids, ...edges.map((edge) => `${edge.from}>${edge.to}`)]);
    diagram.steps?.forEach((step, index) => step.highlight?.forEach((id) => { if (!targets.has(id)) errors.push(`${path}.steps[${index}].highlight: "${id}" is not a node id or a "from>to" edge`); }));
  }
  if (layout === 'sequence' && diagram.stepThrough && !edges.length) errors.push(`${path}.edges: stepThrough on a sequence steps through its edges`);
}

function flowHasCycle(ids: string[], edges: Array<{ from: string; to: string }>): boolean {
  const out = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges) out.get(edge.from)?.push(edge.to);
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const next of out.get(id) ?? []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  return ids.some(visit);
}

function checkChoice(choice: DrawnChoice, path: string, errors: string[]): void {
  if (choice.ask && !choice.id) errors.push(`${path}.id: ask: true needs an id so the answer can be matched up`);
  if (choice.items && !choice.ask) errors.push(`${path}.ask: a queue (items) must also set ask: true`);
  const values = choice.options.map((option) => option.value);
  if (new Set(values).size !== values.length) errors.push(`${path}.options: values must be unique`);
  const keys = choice.options.flatMap((option) => option.key ? [option.key] : []);
  if (new Set(keys).size !== keys.length) errors.push(`${path}.options: keys must be unique`);
}

/* ---------- transcript rows ---------- */

export { answeredValues, drawnUiAnswers, drawnUiAnswerText, drawnUiId, drawnUiToolInput, figureToken, isDrawnUiTool, isSavedFigure } from './TranscriptProjection';

// The tool's reply maps each image path to its stored copy. Harnesses keep the
// reply as structured content, a content array, or plain text; Codex keeps the
// whole content wrapper as JSON text, so the reply is escaped one level down.
export function drawnUiImages(tool: TranscriptTool): Record<string, string> {
  for (const candidate of [tool.result, tool.output, tool.state]) {
    const images = findImages(candidate, 0);
    if (images) return images;
  }
  return {};
}

function findImages(value: unknown, depth: number): Record<string, string> | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (!value.includes('images')) return null;
    try { return findImages(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = findImages(item, depth + 1); if (found) return found; }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.images && typeof record.images === 'object' && !Array.isArray(record.images)) {
    const images = Object.fromEntries(Object.entries(record.images).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^[0-9a-f]{64}$/.test(entry[1])));
    return images;
  }
  for (const key of ['structuredContent', 'content', 'text', 'result', 'output']) {
    const found = findImages(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}
