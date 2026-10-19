import assert from 'node:assert/strict';

import { CARD_HEIGHT, CARD_WIDTH, canvasBounds, edgePath, fitViewport, layoutCanvas, zoomAbout, type CanvasTree } from '../resources/js/lib/agentCanvas';

const leaf = (id: string): CanvasTree => ({ id, children: [] });

// A root over a row of its subagents, their own subagents stacked beneath them.
const orchestrator: CanvasTree = {
  id: 'orchestrator',
  children: [
    { id: 'researcher', children: [leaf('scraper'), leaf('analyst')] },
    leaf('writer'),
    { id: 'coder', children: [leaf('tester')] }
  ]
};
const { positions, edges } = layoutCanvas([orchestrator], 10_000);
const at = (id: string) => positions.get(id)!;

assert.equal(at('researcher').y, at('writer').y, 'a root\'s subagents share a row');
assert.equal(at('writer').y, at('coder').y);
assert.ok(at('researcher').y > at('orchestrator').y + CARD_HEIGHT, 'the row sits below the root');
assert.ok(at('researcher').x < at('writer').x && at('writer').x < at('coder').x, 'the row keeps their order');
assert.equal(at('orchestrator').x, (at('researcher').x + at('coder').x) / 2, 'the root centres over its row');
assert.ok(at('scraper').x > at('researcher').x, 'a stacked subagent steps right');
assert.equal(at('scraper').x, at('analyst').x, 'siblings stack in line');
assert.ok(at('analyst').y >= at('scraper').y + CARD_HEIGHT, 'stacked cards never overlap');
assert.ok(at('writer').x >= at('researcher').x + CARD_WIDTH + (at('scraper').x - at('researcher').x), 'a column is as wide as its stack');
assert.deepEqual(edges.map((edge) => [edge.from, edge.to, edge.kind]), [
  ['orchestrator', 'researcher', 'row'],
  ['researcher', 'scraper', 'stack'],
  ['researcher', 'analyst', 'stack'],
  ['orchestrator', 'writer', 'row'],
  ['orchestrator', 'coder', 'row'],
  ['coder', 'tester', 'stack']
]);

// Families sit side by side, then wrap.
const many = layoutCanvas([leaf('a'), leaf('b'), leaf('c')], CARD_WIDTH * 2 + 100);
assert.equal(many.positions.get('a')!.y, many.positions.get('b')!.y);
assert.ok(many.positions.get('b')!.x > many.positions.get('a')!.x + CARD_WIDTH);
assert.equal(many.positions.get('c')!.x, 0, 'the third wraps to a new row');
assert.ok(many.positions.get('c')!.y > CARD_HEIGHT);

// Edges: a row edge leaves the parent's bottom centre and reaches the child's top centre.
const row = edgePath('row', { x: 0, y: 0 }, { x: 400, y: 200 });
assert.ok(row.startsWith(`M ${CARD_WIDTH / 2} ${CARD_HEIGHT}`), row);
assert.ok(row.endsWith(`V 200`), row);
assert.equal(edgePath('row', { x: 0, y: 0 }, { x: 0, y: 200 }), `M ${CARD_WIDTH / 2} ${CARD_HEIGHT} L ${CARD_WIDTH / 2} 200`, 'a straight drop has no corners');
assert.ok(edgePath('stack', { x: 0, y: 0 }, { x: 40, y: 200 }).endsWith(`H 40`), 'a stack edge turns into the child\'s side');

const bounds = canvasBounds(positions.values())!;
assert.equal(bounds.x, Math.min(...[...positions.values()].map((point) => point.x)));
assert.equal(canvasBounds([]), null);

// A small canvas fits centred at full size; a huge one starts from the top at half size.
const small = fitViewport({ x: 0, y: 0, width: 300, height: 140 }, 1000, 800);
assert.deepEqual(small, { x: 350, y: 330, zoom: 1 });
const huge = fitViewport({ x: 0, y: 0, width: 10_000, height: 10_000 }, 1000, 800);
assert.equal(huge.zoom, 0.5);
assert.equal(huge.y, 48, 'a canvas too big to fit starts at its top');

// Zooming about a point keeps it in place.
const zoomed = zoomAbout({ x: 100, y: 50, zoom: 1 }, 1.25, { x: 300, y: 250 });
assert.deepEqual(zoomed, { x: 50, y: 0, zoom: 1.25 });
assert.equal(zoomAbout({ x: 0, y: 0, zoom: 1 }, 99, { x: 0, y: 0 }).zoom, 1.5, 'zoom is clamped');

console.log('agent canvas smoke passed');
