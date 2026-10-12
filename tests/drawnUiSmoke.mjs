import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

// Charts is ESM-only, so the shared schema, the action and the chart compiler
// are bundled together for Node.
const outfile = path.resolve('dist/tests/drawn-ui.mjs');
await build({
  stdin: {
    contents: `
      export * from './app/Services/DrawnUi';
      export { SaveDrawnUiAction } from './app/Actions/SaveDrawnUiAction';
      export { McpToolRegistry } from './app/MCP/ToolRegistry';
      export { DRAWN_UI_EXAMPLES } from './resources/js/lib/drawnUiExamples';
      export { groupTranscriptMessages, normaliseMessages } from './app/Services/TranscriptProjection';
      export { projectCodexItem } from './app/Services/CodexTranscript';
      export { splitProcessMentions } from './resources/js/lib/agentMentions';
      export { renderPlainMarkdown } from './resources/js/lib/markdown';
      export { compileChart } from './resources/js/lib/drawnChart';
      export { layoutFlow } from './resources/js/lib/drawnUi';
      export { createChartScene } from '@tanstack/charts';
    `,
    resolveDir: path.resolve('.'),
    loader: 'ts'
  },
  outfile, bundle: true, platform: 'node', format: 'esm', external: ['vue'], logLevel: 'error'
});
const ui = await import(pathToFileURL(outfile).href);

const figure = (fig) => ({ claim: 'A point', figure: fig });
const errorsOf = (raw) => { const result = ui.parseDrawnUi(raw); assert.equal(result.ok, false, 'expected a rejection'); return result.errors.join('\n'); };

test('short forms expand to the long form', () => {
  const short = ui.parseDrawnUi(figure({ type: 'chart', mark: 'bar', fields: ['phase', 'ms'], data: [['Open', 120], ['Paint', 300]], x: 'ms', y: 'phase' }));
  const long = ui.parseDrawnUi({ sections: [figure({ type: 'chart', mark: 'bar', fields: ['phase', 'ms'], data: [{ phase: 'Open', ms: 120 }, { phase: 'Paint', ms: 300 }], x: 'ms', y: 'phase' })] });
  assert.ok(short.ok && long.ok);
  assert.deepEqual(short.value, long.value);
  const stringy = ui.parseDrawnUi({ claim: 'x', inputs: JSON.stringify([{ id: 'n', label: 'N', min: 0, max: 9, value: 1 }]), figure: JSON.stringify({ type: 'stats', items: [{ label: 'n', value: '=n' }] }) });
  assert.ok(stringy.ok, 'nested JSON text is read as values');
  assert.ok(ui.parseDrawnUi({ claim: 'x', figure: { type: 'choice', id: 'next-feature', ask: true, options: [{ value: 'a', label: 'A' }] } }).ok, 'choice ids may use hyphens');
  const table = ui.parseDrawnUi(figure({ type: 'table', columns: [{ key: 'm' }, { key: 'v', kind: 'verdict' }], rows: [['Paint', 'better']] }));
  assert.ok(table.ok);
  assert.deepEqual(table.value.sections[0].figure.rows, [{ m: 'Paint', v: 'better' }]);
  const extras = ui.parseDrawnUi(figure({ type: 'chart', mark: 'bar', fields: ['phase', 'ms'], data: [['Open', 120, { tone: 'warn', note: 'slow' }]], x: 'ms', y: 'phase' }));
  assert.ok(extras.ok);
  assert.deepEqual(extras.value.sections[0].figure.data[0], { phase: 'Open', ms: 120, tone: 'warn', note: 'slow' }, 'a trailing object carries row options');
  const shared = ui.parseDrawnUi({ inputs: [{ id: 'n', label: 'N', min: 0, max: 9, value: 3 }], sections: [{ claim: '{n * 2}', figure: { type: 'stats', items: [{ label: 'a', value: '=n' }] } }, { claim: 'b', figure: { type: 'stats', items: [{ label: 'b', value: '=n + 1' }] } }] });
  assert.ok(shared.ok, 'top-level inputs are shared by every section');
  const vars = ui.sectionVars(shared.value.sections[1], { n: 5 }, shared.value);
  assert.equal(ui.resolveFormulas(shared.value.sections[1].figure, vars).items[0].value, 6);
});

test('bad specs name the exact path and the fix', () => {
  assert.match(errorsOf(figure({ type: 'iframe', src: 'https://example.com' })), /sections\[0\]\.figure\.type: expected type "chart"/);
  assert.match(errorsOf(figure({ type: 'chart', mark: 'pie', data: [{ a: 1 }], x: 'a', y: 'a' })), /figure\.mark: expected "bar" \| .*got "pie"/);
  assert.match(errorsOf(figure({ type: 'chart', mark: 'interval', data: [{ lane: 'A', from: 0 }], x: 'from', y: 'lane' })), /figure\.x2: interval needs x2/);
  assert.match(errorsOf(figure({ type: 'chart', mark: 'bar', data: [{ a: 'x', b: 1 }], x: 'b', y: 'missing' })), /figure\.y: no row has a field "missing"/);
  assert.match(errorsOf(figure({ type: 'choice', ask: true, options: [{ value: 'a', label: 'A' }] })), /figure\.id: ask: true needs an id/);
  assert.match(errorsOf(figure({ type: 'stats', items: [{ label: 'x', value: 1, colour: 'red' }] })), /unknown option "colour"; options here are label, value, unit, state, tone/);
  assert.match(errorsOf(figure({ type: 'steps', items: [{ title: 'a' }], state: 'projected' })), /sections\[0\]\.figure: unknown option "state"; options here are type, items/);
  assert.match(errorsOf(figure({ type: 'diagram', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] })), /cannot loop back/);
  assert.match(errorsOf(figure({ type: 'diagram', nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'z' }] })), /edges\[0\]\.to: no node with id "z"/);
  assert.match(errorsOf({ claim: 'x', figure: { type: 'stats', items: [{ label: 'x', value: 1, of: '=total * 2' }] } }), /"total" is not an input or constant/);
  assert.match(errorsOf({ sections: [] }), /sections/);
  assert.match(errorsOf({ claim: 'x'.repeat(10), figure: { type: 'steps', items: [{ title: 'a', body: 'b'.repeat(250_000) }] } }), /byte limit/);
});

test('formulas are arithmetic only', () => {
  const section = { claim: 'Lasts {budget / rate|duration}', constants: { budget: 600 }, inputs: [{ id: 'rate', label: 'Rate', min: 1, max: 10, value: 5 }], figure: { type: 'stats', items: [{ label: 'per hour', value: '=rate * 60' }] } };
  assert.ok(ui.parseDrawnUi(section).ok);
  const vars = ui.sectionVars(section, { rate: 2 });
  assert.equal(ui.fillClaim(section.claim, vars), 'Lasts 5.0 h');
  assert.equal(ui.fillClaim('{=rate * 2}', vars), '4', 'a leading = in a claim formula is tolerated');
  assert.ok(ui.parseDrawnUi({ ...section, claim: '{=rate|compact}' }).ok);
  const walked = ui.flowSteps({ type: 'diagram', nodes: [{ id: 'a', label: 'Agent' }, { id: 'p', label: 'Patterm' }], edges: [{ from: 'a', to: 'p' }] });
  assert.deepEqual(walked, [{ text: 'Agent → Patterm', highlight: ['a', 'a>p', 'p'] }], 'a flow without steps walks its edges');
  assert.ok(ui.parseDrawnUi({ claim: 'x', figure: { type: 'diagram', stepThrough: true, nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', text: 'hand over' }] } }).ok);
  assert.equal(ui.resolveFormulas(section.figure, vars).items[0].value, 120);
  for (const bad of ['this.x', 'alert(1)', 'a; b', '__proto__.x', '"x"', 'Function("x")']) assert.throws(() => ui.parseFormula(bad), `${bad} does not parse`);
  for (const name of ['constructor', '__proto__', 'toString']) assert.ok(Number.isNaN(ui.evaluateFormula(ui.parseFormula(name), {})), `${name} reads nothing inherited`);
  assert.match(errorsOf({ claim: 'x', figure: { type: 'stats', items: [{ label: 'x', value: 1, of: '=constructor' }] } }), /"constructor" is not an input/);
  assert.equal(ui.evaluateFormula(ui.parseFormula('max(2, 3) ^ 2 - -1'), {}), 10);
});

test('drawn calls are found across harness naming and stay out of tool groups', () => {
  const spec = figure({ type: 'steps', items: [{ title: 'One' }] });
  const claude = { name: 'mcp__patterm__ui_save', family: 'mcp', status: 'completed', title: 'MCP', target: 'patterm: ui_save', input: spec };
  const codex = { name: 'mcpToolCall', family: 'mcp', status: 'completed', title: 'MCP', target: 'patterm: ui.save', input: { server: 'patterm', tool: 'ui_save', arguments: JSON.stringify(spec) } };
  const other = { name: 'mcp__patterm__todo_list', family: 'mcp', status: 'completed', title: 'MCP', target: 'patterm: todo_list' };
  assert.ok(ui.isDrawnUiTool(claude) && ui.isDrawnUiTool(codex));
  assert.ok(!ui.isDrawnUiTool(other) && !ui.isDrawnUiTool({ ...claude, family: 'generic' }));
  assert.deepEqual(ui.drawnUiToolInput(codex), spec);
  assert.deepEqual(ui.drawnUiImages({ ...claude, output: JSON.stringify({ ok: true, images: { 'shot.png': 'a'.repeat(64), bad: 'x' } }) }), { 'shot.png': 'a'.repeat(64) });
  assert.deepEqual(ui.drawnUiImages({ ...claude, result: { content: [{ type: 'text', text: JSON.stringify({ images: { p: 'b'.repeat(64) } }) }] } }), { p: 'b'.repeat(64) });
  const row = (id, tool) => ({ id, role: 'assistant', kind: 'tool', text: '', tool });
  const rows = ui.groupTranscriptMessages([row('1', other), row('2', claude), row('3', { ...claude, status: 'failed', error: 'nothing was saved' }), row('4', other)]);
  assert.deepEqual(rows.map((item) => item.kind), ['tools'], 'saving a figure is a step like any other tool call, rejected or not');
});

test('a reply places a figure with its token', () => {
  const tool = (id, extra = {}) => ({ name: 'mcp__patterm__ui_save', family: 'mcp', status: 'completed', title: 'MCP', target: 'patterm: ui_save', input: { id, claim: 'x', figure: { type: 'steps', items: [{ title: 'a' }] } }, ...extra });
  const unnamed = { ...tool(undefined), output: JSON.stringify({ ok: true, ref: '[patterm_figure:fig_a1b2c3]' }) };
  assert.equal(ui.drawnUiId(tool('pipeline')), 'pipeline');
  assert.equal(ui.drawnUiId(unnamed), 'fig_a1b2c3', 'a generated id comes back in the reply');
  const messages = [
    { id: '1', role: 'assistant', kind: 'tool', text: '', tool: tool('pipeline') },
    { id: '2', role: 'assistant', kind: 'tool', text: '', tool: tool('loose') },
    { id: '3', role: 'assistant', kind: 'text', text: 'First the harness streams.\n\n[patterm_figure:pipeline]\n\nThen it is drawn.' }
  ];
  const rows = ui.groupTranscriptMessages(messages);
  assert.deepEqual(rows.map((row) => row.kind), ['tools', 'message'], 'figures show only where the reply places them');
  assert.deepEqual(ui.splitProcessMentions('see [patterm_figure:pipeline] here').map((part) => part.figure ?? null), [null, 'pipeline', null]);
  assert.match(ui.renderPlainMarkdown('Before\n\n[patterm_figure:pipeline]\n\nAfter', { mentions: true }), /<p>Before<\/p>\n<p><span data-mention="\[patterm_figure:pipeline\]"><\/span><\/p>\n<p>After<\/p>/);
});

test('answers go back as one readable message and lock the card', () => {
  const single = ui.drawnUiAnswerText('ui_9', [{ label: 'Inline card (with tab)', value: 'inline' }]);
  assert.equal(single, 'Answer to ui_9: Inline card (with tab) (inline)');
  const queue = ui.drawnUiAnswerText('ui_14', [{ item: 'n1', label: 'Ping', value: 'ping' }, { item: 'n2', label: 'Silent', value: 'silent' }]);
  assert.equal(queue, 'Answer to ui_14:\n- n1: Ping (ping)\n- n2: Silent (silent)');
  const answered = ui.drawnUiAnswers([{ role: 'assistant', text: 'Answer to ui_9: no' }, { role: 'user', text: single }, { role: 'user', text: queue }]);
  assert.deepEqual([...answered.keys()], ['ui_9', 'ui_14']);
  assert.deepEqual(ui.answeredValues(answered.get('ui_9')), ['inline']);
  assert.deepEqual(ui.answeredValues(answered.get('ui_14')), ['ping', 'silent']);
  const delivery = (state) => ui.drawnUiAnswers([{ role: 'user', text: single, delivery: { state, messageId: 'm1' } }]).has('ui_9');
  assert.equal(delivery('failed'), false, 'a failed send leaves the card open');
  assert.equal(delivery('sending'), true, 'a send in flight locks the card');
  assert.equal(delivery('uncertain'), true, 'an unconfirmed send is not sent twice');
});

test('Codex replies map screenshots to their stored copies', () => {
  const sha = 'a'.repeat(64);
  const reply = { ok: true, ref: '[patterm_figure:shot]', images: { 'shot.png': sha } };
  const projected = ui.projectCodexItem({ type: 'mcpToolCall', id: 'call_1', server: 'patterm', tool: 'ui_save', status: 'completed', arguments: { id: 'shot', claim: 'x', figure: { type: 'image', path: 'shot.png' } }, result: { content: [{ type: 'text', text: JSON.stringify(reply, null, 2) }], structuredContent: null } });
  const [message] = ui.normaliseMessages([projected]);
  assert.ok(ui.isDrawnUiTool(message.tool));
  assert.deepEqual(ui.drawnUiImages(message.tool), { 'shot.png': sha });
});

test('the Settings examples are valid figures', () => {
  for (const example of ui.DRAWN_UI_EXAMPLES) {
    const result = ui.parseDrawnUi(example.spec);
    assert.ok(result.ok, `${example.label}: ${result.ok ? '' : result.errors.join('; ')}`);
  }
});

test('the setting takes ui_save out of the catalog and rejects calls', async () => {
  const registry = new ui.McpToolRegistry();
  let enabled = true;
  registry.register({ name: ui.DRAWN_UI_TOOL, namespace: 'cli.ui', description: 'Save a figure.', inputSchema: { type: 'object' }, unavailable: () => enabled ? null : 'ui.save is turned off' }, () => ({ ok: true }));
  assert.deepEqual(registry.publicTools({}).map(({ name }) => name), ['ui_save']);
  assert.equal('unavailable' in registry.publicTools({})[0], false, 'the catalog carries no functions');
  assert.deepEqual(await registry.callPublic('ui_save', {}), { ok: true });
  enabled = false;
  assert.deepEqual(registry.publicTools({}), []);
  assert.equal(registry.publicTools().length, 1, 'internal listings without a caller keep every tool');
  await assert.rejects(registry.callPublic('ui_save', {}), /turned off/);
});

test('screenshots must live in the caller\'s directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drawn-ui-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'shot.png'), 'png');
  fs.writeFileSync(path.join(root, 'secret.png'), 'png');
  // Windows refuses symlinks without Developer Mode or elevation.
  let linked = true;
  try {
    fs.symlinkSync(path.join(root, 'secret.png'), path.join(work, 'link.png'));
  } catch (error) {
    if (error.code !== 'EPERM' || process.platform !== 'win32') throw error;
    linked = false;
  }
  const stored = [];
  const action = new ui.SaveDrawnUiAction({ fromFile: (file) => { stored.push(file); return { type: 'image', sha256: 'c'.repeat(64), mime: 'image/png', size: 3 }; } });
  const caller = { cwd: work, project_path: null };
  const result = action.execute({ claim: 'x', figure: { type: 'image', path: 'shot.png' } }, caller);
  assert.match(result.ref, /^\[patterm_figure:fig_[0-9a-f]{6}\]$/);
  assert.deepEqual(result.images, { 'shot.png': 'c'.repeat(64) });
  assert.match(result.shown, /^Not shown yet\. Put \[patterm_figure:fig_[0-9a-f]{6}\] on its own line in your reply/);
  for (const outside of ['../secret.png', ...(linked ? ['link.png'] : []), path.join(root, 'secret.png')]) {
    assert.throws(() => action.execute({ claim: 'x', figure: { type: 'image', path: outside } }, caller), /must be an existing file inside your working directory/);
  }
  assert.throws(() => action.execute({ claim: 'x', figure: { type: 'image', path: 'shot.png' } }, { cwd: null, project_path: null }), /inside your working directory/);
  assert.deepEqual(stored, [path.join(fs.realpathSync(work), 'shot.png')]);
  assert.equal(action.execute({ id: 'shot', claim: 'x', figure: { type: 'image', path: 'shot.png' } }, caller).ref, '[patterm_figure:shot]');
  assert.throws(() => action.execute({ claim: 'x', figure: { type: 'nope' } }, caller), /nothing was saved/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('every mark compiles to a chart that draws', () => {
  const charts = [
    { type: 'chart', mark: 'bar', x: 'ms', y: 'phase', refs: [{ x: 1000, label: 'Budget' }], highlight: { phase: 'B' }, data: [{ phase: 'A', ms: 120 }, { phase: 'B', ms: 1900 }, { phase: 'C', state: 'unknown' }] },
    { type: 'chart', mark: 'bar', x: 'day', y: 'n', events: [{ x: 'Tue', label: 'Shipped' }], refs: [{ y: [{ from: 'Mon', value: 4 }, { from: 'Wed', value: 6 }], label: 'Cap' }], data: [{ day: 'Mon', n: 3 }, { day: 'Tue', n: 5 }, { day: 'Wed', n: 7, state: 'projected' }] },
    { type: 'chart', mark: 'bar', x: 'ms', y: 'build', color: 'part', stack: true, data: [{ build: 'A', part: 'x', ms: 2 }, { build: 'A', part: 'y', ms: 3 }] },
    { type: 'chart', mark: 'bar', x: 'minutes', y: 'job', scale: { x: 'log' }, data: [{ job: 'a', minutes: 0.05 }, { job: 'b', minutes: 1440 }] },
    { type: 'chart', mark: 'bar', x: 'from', x2: 'to', y: 'n', data: [{ from: 0, to: 10, n: 4 }, { from: 10, to: 20, n: 2, tone: 'warn' }] },
    { type: 'chart', mark: 'line', x: 't', y: 'mb', color: 's', bands: [{ x: [1, 2], label: 'gc' }], data: [{ t: 0, mb: 1, s: 'a' }, { t: 3, mb: 2, s: 'a' }, { t: 0, mb: 2, s: 'b', state: 'projected' }, { t: 3, mb: 1, s: 'b', state: 'projected' }] },
    { type: 'chart', mark: 'area', x: 't', y: 'n', data: [{ t: 0, n: 1 }, { t: 1, n: 3 }] },
    { type: 'chart', mark: 'point', x: 'x', y: 'y', text: 'job', regions: [{ x: [0, 50], y: [0, 10], tone: 'bad', label: 'Failing' }, { y: [0, 2], state: 'unknown' }], data: [{ job: 'a', x: 20, y: 5 }] },
    { type: 'chart', mark: 'interval', x: 'from', x2: 'to', y: 'lane', text: 'what', data: [{ lane: 'A', from: 0, to: 4, what: 'connected' }, { lane: 'A', from: 4, to: 6, state: 'unknown' }] },
    { type: 'chart', mark: 'cell', x: 'day', y: 'job', color: 'status', colors: { ok: 'good', unk: { state: 'unknown', label: 'Before' } }, data: [{ job: 'a', day: '2 Sep', status: 'unk' }, { job: 'a', day: '1 Sep', status: 'ok' }] }
  ];
  for (const chart of charts) {
    const parsed = ui.parseDrawnUi(figure(chart));
    assert.ok(parsed.ok, `${chart.mark}: ${parsed.ok ? '' : parsed.errors.join(', ')}`);
    const compiled = ui.compileChart(parsed.value.sections[0].figure);
    const scene = ui.createChartScene(compiled.definition, { width: 640, height: compiled.height });
    const shapes = JSON.stringify(scene.nodes);
    assert.ok(shapes.length > 200, `${chart.mark} draws something`);
  }
  const zeroFloor = { ...charts[3], axis: { x: { min: 0, max: 100 } } };
  assert.match(errorsOf(figure(zeroFloor)), /axis\.x: a log scale needs min and max above 0/);
  const unchecked = ui.compileChart({ ...ui.parseDrawnUi(figure(charts[3])).value.sections[0].figure, axis: { x: { min: 0, max: 100 } } });
  assert.ok(ui.createChartScene(unchecked.definition, { width: 640, height: unchecked.height }), 'a zero log floor that slips past validation still draws');
  const log = ui.compileChart(ui.parseDrawnUi(figure(charts[3])).value.sections[0].figure);
  assert.match(JSON.stringify(ui.createChartScene(log.definition, { width: 640, height: log.height }).nodes), /ts-chart__bar/, 'log bars start at the domain floor instead of vanishing');
  const cells = ui.compileChart(ui.parseDrawnUi(figure(charts[9])).value.sections[0].figure);
  assert.deepEqual(cells.legend.map((item) => item.label), ['ok', 'Before'], 'legend follows the colours the agent listed');
});

test('flow layout keeps edge labels clear of the boxes', () => {
  const layout = ui.layoutFlow({ type: 'diagram', nodes: [{ id: 'q', label: 'Q' }, { id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'q', to: 'a', label: 'unknown type' }, { from: 'q', to: 'b' }] });
  const q = layout.nodes.get('q'), a = layout.nodes.get('a');
  assert.ok(a.x - (q.x + q.width) >= 'unknown type'.length * 6.4 + 30, 'the gap fits the longest label');
  assert.equal(layout.nodes.get('a').x, layout.nodes.get('b').x, 'siblings share a column');
  const chain = ui.layoutFlow({ type: 'diagram', nodes: Array.from({ length: 8 }, (_, index) => ({ id: `n${index}`, label: `Step ${index}` })), edges: Array.from({ length: 7 }, (_, index) => ({ from: `n${index}`, to: `n${index + 1}` })) });
  assert.equal(chain.direction, 'down', 'long chains run top to bottom');
  assert.ok(chain.nodes.get('n0').width >= 160 && chain.width === 640, 'boxes stay readable without widening the figure');
});
