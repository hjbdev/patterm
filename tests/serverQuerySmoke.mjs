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
const { topicCall, topicChanged, topicRead, trimQueries, queryClient } = exports;

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

test('the first connection is not a reconnect; a later one reads again', async () => {
  // A fresh copy of the module whose socket is still connecting at its first read.
  const listeners = [], pending = [];
  let state = 'connecting';
  const browser = { patterm: {
    call: (name, args) => new Promise((resolve) => pending.push({ name, args, resolve })),
    onDataChanged: () => () => {},
    connectionState: () => state,
    onConnectionChanged: (listener) => { listeners.push(listener); listener(state); return () => {}; }
  } };
  const copy = {};
  new Function('exports', 'require', 'window', outputText)(copy, (name) => modules[name], browser);
  const read = () => copy.topicCall('updates', 'settings_updates_get', {});
  const first = read();
  await settle();
  pending.shift().resolve('state');
  assert.equal(await first, 'state');
  state = 'connected';
  listeners.forEach((listener) => listener('connected'));
  const opened = read();
  await settle();
  assert.equal(pending.length, 0, 'the socket opening reads nothing again');
  assert.equal(await opened, 'state');
  for (const next of ['disconnected', 'connected']) { state = next; listeners.forEach((listener) => listener(next)); }
  const again = read();
  await settle();
  assert.equal(pending.length, 1, 'a reconnect reads again');
  pending.shift().resolve('after reconnect');
  assert.equal(await again, 'after reconnect');
});

test('large reads stay within their budget, dropping the least recently read first', async () => {
  const page = (id) => topicCall('history', 'history_get', { conversation_id: id });
  const cachedIds = () => queryClient.getQueryCache().findAll({ queryKey: ['history_get'] }).map((query) => query.queryKey[1].conversation_id).sort();
  for (const id of ['a', 'b', 'c']) {
    const read = page(id);
    await answer({ messages: [id.repeat(10)] });
    await read;
  }
  await page('a');
  trimQueries('history_get', { entries: 2, size: 1_000_000 });
  assert.deepEqual(cachedIds(), ['a', 'c'], 'reading a again kept it over b');
  assert.equal(calls.length, 0);
  const big = page('d');
  await answer({ messages: ['x'.repeat(500)] });
  await big;
  trimQueries('history_get', { entries: 10, size: 100 });
  assert.deepEqual(cachedIds(), ['d'], 'the newest read stays even when it alone is over the size');
  const reread = page('a');
  await settle();
  assert.equal(calls.length, 1, 'a dropped page reads again');
  await answer({ messages: ['a'] });
  await reread;

  // A cached page being read again keeps its old data while it loads; it is
  // left alone, not evicted and cancelled.
  const refetching = topicRead('history', ['history_get', { conversation_id: 'a' }], () => window.patterm.call('history_get', { refetch: 'a' }), () => true);
  await settle();
  const later = page('e');
  await settle();
  calls.splice(calls.findIndex((call) => call.args.conversation_id === 'e'), 1)[0].resolve({ messages: ['e'] });
  await later;
  trimQueries('history_get', { entries: 1, size: 1_000_000 });
  assert.ok(cachedIds().includes('a'), 'a page being read again stays, though e was read since');
  await answer({ messages: ['a again'] });
  assert.deepEqual(await refetching, { messages: ['a again'] });
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
