import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import * as vue from 'vue';

// Exercise the actual autosave composable with controlled save responses.
const source = fs.readFileSync(new URL('../resources/js/Composables/useRoutineAutosave.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
});
const load = new Function('exports', 'require', 'setTimeout', 'clearTimeout', outputText);

function setup() {
  const calls = [];
  const errors = [];
  const saved = [];
  const module = { exports: {} };
  // Timers never fire on their own; tests flush explicitly.
  load(module.exports, (name) => ({ vue })[name], () => 1, () => undefined);
  const autosave = module.exports.useRoutineAutosave({
    save: (routineId, patch) => new Promise((resolve, reject) => calls.push({ routineId, patch, resolve: () => resolve({ routine_id: routineId, ...patch }), reject })),
    // Records whether the dialog would let this reply replace its draft.
    onSaved: (record) => saved.push({ record, replacesDraft: !autosave.hasPending(record.routine_id) }),
    onError: (routineId, message) => errors.push([routineId, message])
  });
  return { autosave, calls, errors, saved };
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

test('edits stay with their routine when the selection changes during a save', async () => {
  const { autosave, calls } = setup();
  autosave.change('A', { name: 'Edited A' });
  const first = autosave.flush();
  await settle();
  autosave.change('A', { prompt: 'Prompt for A' });
  // Closing A flushes its edit; editing B afterwards must not inherit it.
  const closing = autosave.flush();
  autosave.change('B', { name: 'Edited B' });
  const second = autosave.flush();
  calls[0].resolve();
  await settle();
  calls[1].resolve();
  await settle();
  calls[2].resolve();
  assert.equal(await first, true);
  assert.equal(await closing, true);
  assert.equal(await second, true);
  assert.deepEqual(calls.map((call) => [call.routineId, call.patch]), [
    ['A', { name: 'Edited A' }],
    ['A', { prompt: 'Prompt for A' }],
    ['B', { name: 'Edited B' }]
  ]);
});

test('run now waits for the routine\'s save and refuses when it cannot be saved', async () => {
  const { autosave, calls, errors } = setup();
  autosave.change('A', { prompt: 'new prompt' });
  const saving = autosave.flush();
  await settle();
  // Run now on A while its save is in flight waits for it, then retries the failed edit.
  const runNow = autosave.flush('A');
  calls[0].reject(new Error('offline'));
  assert.equal(await saving, false);
  await settle();
  assert.deepEqual(calls[1].patch, { prompt: 'new prompt' });
  calls[1].reject(new Error('still offline'));
  assert.equal(await runNow, false);
  assert.deepEqual(errors.at(-1), ['A', 'still offline']);
  assert.equal(autosave.hasPending('A'), true, 'the failed edit is kept for retry');
  autosave.change('A', { name: 'Renamed' });
  const retry = autosave.flush('A');
  await settle();
  assert.deepEqual(calls[2].patch, { prompt: 'new prompt', name: 'Renamed' });
  calls[2].resolve();
  assert.equal(await retry, true);
  assert.equal(autosave.hasPending('A'), false);
  assert.deepEqual(errors.at(-1), ['A', null]);
});

test('a failed save for another routine does not block run now', async () => {
  const { autosave, calls } = setup();
  autosave.change('B', { prompt: 'B prompt' });
  const saving = autosave.flush();
  const runNow = autosave.flush('A');
  await settle();
  calls[0].reject(new Error('offline'));
  assert.equal(await saving, false);
  assert.equal(await runNow, true);
});

test('an older reply does not replace the draft while newer edits are queued', async () => {
  const { autosave, calls, saved } = setup();
  autosave.change('A', { prompt: 'ab' });
  const first = autosave.flush();
  autosave.change('A', { prompt: 'abc' });
  const second = autosave.flush();
  assert.equal(autosave.hasPending('A'), true);
  await settle();
  calls[0].resolve();
  await first;
  assert.deepEqual(saved.at(-1), { record: { routine_id: 'A', prompt: 'ab' }, replacesDraft: false });
  await settle();
  calls[1].resolve();
  await second;
  assert.deepEqual(saved.at(-1), { record: { routine_id: 'A', prompt: 'abc' }, replacesDraft: true });
  assert.equal(autosave.hasPending('A'), false);
});
