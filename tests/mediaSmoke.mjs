import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import * as vue from 'vue';

// Exercise the actual media composable with a controlled server.
const source = fs.readFileSync(new URL('../resources/js/Composables/useMedia.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });

function load() {
  const reads = [];
  const modules = {
    vue,
    '../lib/media': {
      listMedia: (projectId, args) => new Promise((resolve) => reads.push({ projectId, args, resolve })),
      mediaGallery: (items) => items.map((item) => ({ key: item.id, sha256: item.sha256 }))
    },
    '../lib/serverQuery': { useTopicRefresh() {} }
  };
  const exports = {};
  new Function('exports', 'require', outputText)(exports, (name) => modules[name]);
  return { useMedia: exports.useMedia, reads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("switching to an agent whose images aren't read drops the previous agent's unfinished read", async () => {
  const { useMedia, reads } = load();
  const props = vue.reactive({ projectId: 'project_1', sessionId: 'session_local' });
  const scope = vue.effectScope();
  const media = scope.run(() => useMedia(props, { pageSize: 8, enabled: () => !props.sessionId.includes(':') }));
  await settle();
  const local = reads.shift();
  assert.equal(local.args.session_id, 'session_local');
  props.sessionId = 'peer:session_remote';
  await vue.nextTick();
  assert.equal(reads.length, 0, "a paired host's agent reads nothing");
  local.resolve({ items: [{ id: 'm1', sha256: 'previous-local-image' }], total: 1 });
  await settle();
  assert.equal(media.items.value.length, 0, "the previous agent's late read does not fill the chip");
  assert.equal(media.total.value, 0);
  assert.equal(media.loading.value, false);
  scope.stop();
});
