import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import * as vue from 'vue';

// Exercise the actual query module with the real QueryClient, a stub
// workbench and a browser bridge driven here.
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../resources/js/lib/serverQuery.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });

const dataListeners = [], connectionListeners = [], calls = [];
// The workbench's projects, for which paired hosts announce their history.
const projects = vue.ref([]);
const window = {
  patterm: {
    call: (name, args) => new Promise((resolve) => calls.push({ name, args, resolve })),
    onDataChanged: (listener) => { dataListeners.push(listener); return () => {}; },
    connectionState: () => 'connected',
    onConnectionChanged: (listener) => { connectionListeners.push(listener); return () => {}; }
  }
};
const modules = {
  vue,
  '@tanstack/vue-query': require('@tanstack/vue-query'),
  '../Composables/useWorkbench': { useWorkbench: () => ({ lifecycleRevision: vue.ref(0), projects }) }
};
const exports = {};
new Function('exports', 'require', 'window', outputText)(exports, (name) => modules[name], window);
const { topicCall, topicChanged, topicRead } = exports;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function answer(value) {
  await settle();
  calls.shift().resolve(value);
  await settle();
}
const announce = (topics) => dataListeners.forEach((listener) => listener(topics));

test('topic reads are cached until their topic changes', async () => {
  const first = topicCall('history', 'history_list', { project_id: 'p' });
  await answer('one');
  assert.equal(await first, 'one');
  assert.equal(await topicCall('history', 'history_list', { project_id: 'p' }), 'one');
  assert.equal(calls.length, 0, 'a revisit reads nothing');
  announce(['routines']);
  assert.equal(await topicCall('history', 'history_list', { project_id: 'p' }), 'one', 'another topic leaves it cached');
});

test('a read under way when a change is announced cannot stand in for a later one', async () => {
  const before = topicCall('history', 'history_list', { project_id: 'p', limit: 1 });
  await settle();
  announce(['history']);
  const after = topicCall('history', 'history_list', { project_id: 'p', limit: 1 });
  await answer('old');
  await answer('new');
  assert.equal(await before, 'old');
  assert.equal(await after, 'new');
  assert.equal(await topicCall('history', 'history_list', { project_id: 'p', limit: 1 }), 'new');
});

test('a reconnect reads again', async () => {
  connectionListeners.forEach((listener) => listener('disconnected'));
  connectionListeners.forEach((listener) => listener('connected'));
  const read = topicCall('history', 'history_list', { project_id: 'p' });
  await answer('after reconnect');
  assert.equal(await read, 'after reconnect');
});

test("a paired host's records always read", async () => {
  for (const value of ['remote one', 'remote two']) {
    const read = topicCall('history', 'history_list', { project_id: 'workstation:p' });
    await answer(value);
    assert.equal(await read, value);
  }
});

test('data that changes unannounced reads again while fresh says so, and own writes bump the topic', async () => {
  const list = () => topicRead('mcp-servers', ['mcp_servers_list'], () => window.patterm.call('mcp_servers_list', {}), (cached) => cached.pending);
  const pending = list();
  await answer({ pending: true });
  assert.deepEqual(await pending, { pending: true });
  const expired = list();
  await answer({ pending: false });
  assert.deepEqual(await expired, { pending: false }, 'a list with a pending sign-in reads again');
  assert.deepEqual(await list(), { pending: false }, 'without one it stays cached');
  topicChanged('mcp-servers');
  const written = list();
  await answer({ pending: false, saved: true });
  assert.deepEqual(await written, { pending: false, saved: true });
});

test("a paired host's history is cached once that host announces it; older hosts always read", async () => {
  projects.value = [
    { project: { id: 'local', remotes: [{ host: 'workstation', projectId: 'workstation:p', sharesHistory: true }] } },
    { project: { id: 'laptop:q', host: 'laptop' } }
  ];
  const remote = () => topicCall('history', 'history_list', { project_id: 'workstation:p', limit: 2 });
  const first = remote();
  await answer('shared');
  assert.equal(await first, 'shared');
  assert.equal(await remote(), 'shared', 'a revisit reads nothing');
  assert.equal(calls.length, 0);
  announce(['history']);
  const changed = remote();
  await answer('shared again');
  assert.equal(await changed, 'shared again', 'its announcement reads again');
  for (const value of ['older one', 'older two']) {
    const read = topicCall('history', 'history_list', { project_id: 'laptop:q' });
    await answer(value);
    assert.equal(await read, value, 'a host that does not announce history always reads');
  }
  const settings = topicCall('settings', 'harness_presets', { project_id: 'workstation:p' });
  await answer('presets');
  assert.equal(await settings, 'presets');
  const again = topicCall('settings', 'harness_presets', { project_id: 'workstation:p' });
  await answer('presets again');
  assert.equal(await again, 'presets again', 'other topics are not announced, so they always read');
  projects.value = [];
});
