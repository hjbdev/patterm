import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import * as vue from 'vue';

// The real context reads, query cache, workbench and record editor, with only
// the browser bridge and route navigation stubbed.
const output = path.resolve('dist/tests/client-cache-fixture.cjs');
await build({
  stdin: { contents: `export { projectContextVersion } from './resources/js/lib/projectContext';
    export { useContextRecord } from './resources/js/Composables/useContextRecord';
    export { useWorkbench } from './resources/js/Composables/useWorkbench';`, resolveDir: process.cwd() },
  outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['vue', '@tanstack/vue-query'],
  plugins: [{ name: 'navigation-stub', setup(builder) {
    builder.onResolve({ filter: /useWorkbenchNavigation$/ }, () => ({ path: 'navigation', namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `import { ref } from 'vue'; export function useWorkbenchNavigation() { return { activeProject: ref(null) }; }`, loader: 'js' }));
  } }]
});

const connections = [], announcements = [], calls = [];
let state = 'connecting';
let serve = () => { throw new Error('unexpected call'); };
const values = new Map();
globalThis.sessionStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
globalThis.window = {
  patterm: {
    workbench: async () => ({ epoch: 'e1', version: 1, terminalAvailable: true, harnesses: [], sidebarState: {}, projects: [
      // A local project whose revision is known, linked with an older paired
      // host's project, whose revision is not.
      { project: { id: 'p', contextRevision: 3, remotes: [{ host: 'workstation', projectId: 'workstation:q' }] }, projectSessions: [], processes: [], worktrees: [], timers: [] },
      // A project whose revisions are all known.
      { project: { id: 'r', contextRevision: 5 }, projectSessions: [], processes: [], worktrees: [], timers: [] }
    ] }),
    call: async (name, args) => { calls.push({ name, args }); return serve(name, args); },
    connectionState: () => state,
    onConnectionChanged: (listener) => { connections.push(listener); listener(state); return () => {}; },
    onDataChanged: (listener) => { announcements.push(listener); return () => {}; },
    onWorkbenchPatch: () => () => {}
  },
  addEventListener() {}
};
const fixture = createRequire(import.meta.url)(output);
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const connect = (next) => { state = next; connections.forEach((listener) => listener(next)); };

test.after(() => { fs.unlinkSync(output); delete globalThis.window; delete globalThis.sessionStorage; });

test("an older paired host's context reads follow announcements and reconnects, not the first connection", async () => {
  await fixture.useWorkbench().refresh();
  const local = fixture.projectContextVersion('r');
  const first = fixture.projectContextVersion('workstation:q');
  assert.ok(first, 'unknown revisions still give a version');
  connect('connected');
  assert.equal(fixture.projectContextVersion('workstation:q'), first, 'the socket opening is not a reconnect');
  connect('disconnected');
  connect('connected');
  const reconnected = fixture.projectContextVersion('workstation:q');
  assert.notEqual(reconnected, first, 'a reconnect may have missed an announcement');
  announcements.forEach((listener) => listener(['context']));
  assert.notEqual(fixture.projectContextVersion('workstation:q'), reconnected, 'a context announcement reads again');
  assert.equal(fixture.projectContextVersion('r'), local, 'known revisions ignore the fallback signal');
  assert.equal(fixture.projectContextVersion('p'), fixture.projectContextVersion('workstation:q').replace(/^e1:/, 'e1:3,'), 'a project linked with that host follows it too');
});

test('a long note reuses its cached chunks, reloads them fresh, and never shows a mix of revisions', async () => {
  const lines = Array.from({ length: 2500 }, (_, index) => `line ${index}`);
  let revisionAt = () => 1;
  serve = (name, args) => {
    assert.equal(name, 'scratchpad_get');
    const offset = args.offset ?? 0;
    return { id: 'a', title: 'a', status: 'active', revision: revisionAt(offset), total_lines: lines.length, body: lines.slice(offset, offset + args.limit).join('\n') };
  };
  const mount = () => {
    const scope = vue.effectScope();
    const editor = scope.run(() => fixture.useContextRecord(vue.ref('scratchpad'), vue.ref('p'), vue.ref('a')));
    return { editor, scope };
  };
  const first = mount();
  await settle();
  assert.equal(first.editor.body.value, lines.join('\n'));
  assert.deepEqual(calls.map((call) => call.args.offset ?? 0), [0, 1000, 2000]);
  first.scope.stop();
  calls.length = 0;

  const reopened = mount();
  await settle();
  assert.equal(reopened.editor.body.value, lines.join('\n'));
  assert.equal(calls.length, 0, 'reopening reads the note and its chunks from the cache');

  revisionAt = (offset) => offset >= 2000 ? 2 : 1;
  await reopened.editor.reload();
  await settle();
  assert.deepEqual(calls.map((call) => call.args.offset ?? 0), [0, 1000, 2000], 'a reload reads everything fresh');
  assert.match(reopened.editor.error.value, /changed while loading/);
  assert.equal(reopened.editor.record.value?.revision, 1, 'the record shown is the earlier whole one');
  assert.equal(reopened.editor.body.value, lines.join('\n'));
  reopened.scope.stop();
});
