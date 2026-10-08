import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

// DiffPatchView runs its real <script setup> with a stubbed FileDiff so the
// container route is covered: the library must create its own diffs-container
// custom element (which adopts the base stylesheet). Passing a plain div as
// fileContainer bypasses that stylesheet and stacks line numbers vertically.
const page = fs.readFileSync(new URL('../resources/js/Components/DiffPatchView.vue', import.meta.url), 'utf8');
const source = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('diffPatchView.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getFullText(parsed)).join('\n');
const { outputText } = ts.transpileModule(executable, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });

test('the diff renderer uses the library-managed container route', async () => {
  const renders = [];
  class FileDiffStub {
    constructor(options) { this.options = options; }
    render(props) { renders.push(props); }
    cleanUp() {}
  }
  const documentStub = {
    createElement: () => ({
      className: '',
      children: [],
      appendChild(child) { this.children.push(child); },
      replaceChildren() { this.children = []; }
    })
  };
  const props = { patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new', cacheKey: 'a' };
  const setup = new Function(
    'computed', 'nextTick', 'onBeforeUnmount', 'onMounted', 'ref', 'watch',
    'FileDiff', 'parsePatchFiles', 'document', 'requestAnimationFrame', 'defineProps',
    `${outputText}
return { container, renderPatch, isEmpty, isDeferred, isRendering };`
  );
  const api = setup(
    computed, nextTick, () => {}, () => {}, ref, watch,
    FileDiffStub,
    () => [{ files: [{ name: 'a.ts' }, { name: 'b.ts' }] }],
    documentStub,
    (callback) => { callback(); return 1; },
    () => props
  );
  api.container.value = { replaceChildren() {}, appendChild() {} };
  await api.renderPatch();
  assert.equal(api.isEmpty.value, false);
  assert.equal(renders.length, 2, 'every parsed file is rendered');
  for (const render of renders) {
    assert.ok(render.containerWrapper, 'the library creates its own diffs-container inside the wrapper');
    assert.equal(render.fileContainer, undefined, 'a plain div must not be passed as fileContainer, which bypasses the base stylesheet');
  }
});
