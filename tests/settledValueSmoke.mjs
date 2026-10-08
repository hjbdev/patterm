import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

test('settled values ignore flicker and hold what they show', async (t) => {
  const output = path.resolve('dist/tests/settled-value-fixture.cjs');
  await build({ entryPoints: [path.resolve('resources/js/lib/settledValue.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs' });
  const { SettledValue } = createRequire(import.meta.url)(output);
  t.after(() => fs.rmSync(output, { force: true }));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const shown = [];
  // Mirrors the voice status: Listening settles slowly, other phases quickly,
  // and muting shows at once.
  const phase = new SettledValue('listening', (value) => shown.push(value), {
    minimumMs: 800,
    immediate: (next, current) => next === 'muted' || current === 'muted',
    delayFor: (next) => next === 'listening' ? 900 : 200
  });

  // A blip shorter than the delay never shows.
  phase.set('speaking');
  t.mock.timers.tick(150);
  phase.set('listening');
  t.mock.timers.tick(1_000);
  assert.deepEqual(shown, []);

  // A lasting change shows after its delay.
  phase.set('speaking');
  t.mock.timers.tick(199);
  assert.deepEqual(shown, []);
  t.mock.timers.tick(1);
  assert.deepEqual(shown, ['speaking']);

  // Pauses between words do not drop back to Listening.
  phase.set('listening');
  t.mock.timers.tick(600);
  phase.set('speaking');
  t.mock.timers.tick(2_000);
  assert.deepEqual(shown, ['speaking']);

  // A shown phase lasts its minimum even when the next one is ready sooner.
  phase.set('working');
  t.mock.timers.tick(200);
  assert.deepEqual(shown, ['speaking', 'working']);
  phase.set('speaking');
  t.mock.timers.tick(200);
  assert.deepEqual(shown, ['speaking', 'working'], 'working holds for its minimum');
  t.mock.timers.tick(600);
  assert.deepEqual(shown, ['speaking', 'working', 'speaking']);

  // Immediate changes skip both the delay and the minimum.
  phase.set('muted');
  assert.deepEqual(shown.at(-1), 'muted');
  phase.set('speaking');
  assert.deepEqual(shown.at(-1), 'speaking');
  phase.dispose();

  // Tools: each stays readable, and the line clears only after a pause.
  const tools = [];
  const tool = new SettledValue('', (value) => tools.push(value), { minimumMs: 1_200, delayFor: (next) => next ? 0 : 1_000 });
  tool.set('Read notes.txt');
  assert.deepEqual(tools, ['Read notes.txt'], 'the first tool shows at once');
  tool.set('List processes');
  t.mock.timers.tick(1_199);
  assert.deepEqual(tools, ['Read notes.txt'], 'a quick follow-up waits until the first was readable');
  t.mock.timers.tick(1);
  assert.deepEqual(tools, ['Read notes.txt', 'List processes']);
  tool.set('');
  t.mock.timers.tick(500);
  tool.set('Spawn agent');
  t.mock.timers.tick(700);
  assert.deepEqual(tools, ['Read notes.txt', 'List processes', 'Spawn agent'], 'a short gap between tools never blanks the line');
  tool.set('');
  t.mock.timers.tick(999);
  assert.equal(tools.at(-1), 'Spawn agent');
  t.mock.timers.tick(201);
  assert.equal(tools.at(-1), '');
  tool.dispose();
});
