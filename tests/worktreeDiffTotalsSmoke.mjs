import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import * as vue from 'vue';

// Exercise the actual diff totals composable with a controlled server.
const source = fs.readFileSync(new URL('../resources/js/Composables/useWorktreeDiff.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });

function load() {
  const reads = [];
  const window = { patterm: { call: (name, args) => new Promise((resolve) => reads.push({ name, args, resolve })) } };
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const modules = { vue: { ...vue, onMounted: () => {}, onBeforeUnmount: () => {} }, '../lib/worktreeDiff': {} };
  const exports = {};
  new Function('exports', 'require', 'window', 'document', 'localStorage', outputText)(exports, (name) => modules[name], window, document, { getItem: () => null, setItem() {} });
  return { useWorktreeDiffTotals: exports.useWorktreeDiffTotals, reads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const totals = (files) => ({ totals: { files, additions: files, deletions: 0 } });

test('switching back to fresh totals reads nothing, and a slower read for the previous worktree cannot replace them', async () => {
  const { useWorktreeDiffTotals, reads } = load();
  const ids = vue.ref(['B']);
  const scope = vue.effectScope();
  const { states } = scope.run(() => useWorktreeDiffTotals(ids));
  await settle();
  reads.shift().resolve(totals(2));
  await settle();
  assert.equal(states.value.get('B')?.totals?.files, 2);
  ids.value = ['A'];
  await vue.nextTick();
  const slowA = reads.shift();
  assert.equal(slowA.args.worktree_id, 'A');
  ids.value = ['B'];
  await vue.nextTick();
  assert.equal(reads.length, 0, 'totals read moments ago are shown without running git');
  assert.equal(states.value.get('B')?.totals?.files, 2);
  slowA.resolve(totals(9));
  await settle();
  assert.deepEqual([...states.value.keys()], ['B'], "the previous worktree's late read does not replace them");
  scope.stop();
});
