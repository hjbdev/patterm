import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import * as vue from 'vue';
import { cachedConversation, forgetConversation, hasCachedConversation, rememberConversation } from '../dist/tests/app/Services/TranscriptProjection.js';

// Exercise the actual prefetch module with a stub workbench, browser and
// network, and the real conversation cache.
const source = fs.readFileSync(new URL('../resources/js/lib/prefetch.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });

function load({ connection = undefined, runtime = 'browser', touch = false, preference = null, visible = true } = {}) {
  const storage = new Map(preference ? [['patterm.prefetch.conversations', preference]] : []);
  const calls = [];
  const contextReads = [];
  const projects = vue.ref([]);
  const document = { visibilityState: visible ? 'visible' : 'hidden', listeners: [], addEventListener(_name, listener) { this.listeners.push(listener); } };
  const globals = {
    window: { patterm: { runtime, call: (name, args) => new Promise((resolve) => calls.push({ name, args, resolve })) } },
    navigator: connection ? { connection } : {},
    document,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    matchMedia: () => ({ matches: touch }),
    PerformanceObserver: undefined
  };
  const modules = {
    vue,
    '../Composables/useWorkbench': { useWorkbench: () => ({ projects, lifecycleRevision: vue.ref(0), loaded: vue.ref(true) }) },
    './integratedConversation': { hasCachedConversation, rememberConversation, normaliseConversation: (value) => ({ messages: value.messages ?? [], permissions: [], questions: [], forms: [], usage: null, tasks: [], queue: [] }) },
    './projectContext': {
      contextRead: (name, projectId, args) => new Promise((resolve) => contextReads.push({ name, projectId, args, resolve })),
      projectContextVersion: () => 'v'
    }
  };
  const exports = {};
  new Function('exports', 'require', ...Object.keys(globals), outputText)(exports, (name) => modules[name], ...Object.values(globals));
  return { prefetch: exports, calls, contextReads, projects, document, storage };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const session = (id, mode = 'integrated') => ({ id, processId: `process_${id}`, interfaceMode: mode, exitedAt: null });
const project = (id, sessions) => ({ project: { id }, projectSessions: sessions, processes: [], worktrees: [], timers: [] });

test('link classes follow the connection', () => {
  assert.equal(load({ runtime: 'desktop', connection: { saveData: true } }).prefetch.linkClass(), 'fast', 'the desktop app is always fast');
  assert.equal(load({ connection: { saveData: true } }).prefetch.linkClass(), 'slow');
  assert.equal(load({ connection: { effectiveType: '2g' } }).prefetch.linkClass(), 'slow');
  assert.equal(load({ connection: { rtt: 400 } }).prefetch.linkClass(), 'slow');
  assert.equal(load({ connection: { type: 'cellular', rtt: 50 } }).prefetch.linkClass(), 'cellular');
  assert.equal(load({ connection: { type: 'wifi', rtt: 50 } }).prefetch.linkClass(), 'fast');
  assert.equal(load({ touch: true }).prefetch.linkClass(), 'cellular', 'a phone that reports nothing is treated as on mobile data');
  assert.equal(load({}).prefetch.linkClass(), 'fast');
});

test('the preference is stored per device and defaults to automatic', () => {
  const { prefetch, storage } = load({});
  assert.equal(prefetch.prefetchPreference(), 'auto');
  prefetch.setPrefetchPreference('never');
  assert.equal(storage.get('patterm.prefetch.conversations'), 'never');
  assert.equal(prefetch.prefetchPreference(), 'never');
});

test('at most two reads run at once, the pointer first, and none while hidden', async () => {
  const hidden = load({ visible: false });
  hidden.projects.value = [project('p', [session('a', 'tui')])];
  hidden.prefetch.prefetchProject('p', hidden.prefetch.Tier.Current);
  await settle();
  assert.equal(hidden.contextReads.length, 0, 'a hidden tab reads nothing');

  const { prefetch, contextReads, projects } = load({});
  projects.value = [project('p', ['a', 'b', 'c'].map((id) => session(id, 'tui')))];
  prefetch.prefetchProject('p', prefetch.Tier.Other);
  prefetch.prefetchTab(session('elsewhere', 'tui'));
  await settle();
  assert.deepEqual(contextReads.map((read) => read.args.session_id), ['a', 'b']);
  assert.deepEqual(contextReads[0].args, { session_id: 'a', limit: 100 }, 'the panel’s own arguments, so it finds the read cached');
  prefetch.prefetchSession('p', session('urgent', 'tui'), prefetch.Tier.Intent);
  contextReads[0].resolve();
  await settle();
  assert.equal(contextReads[2].args.session_id, 'urgent', 'what the pointer is on goes ahead of the queue');
  assert.ok(!contextReads.some((read) => read.args.session_id === 'elsewhere'), 'a tab no project lists reads nothing');
  prefetch.prefetchTab(session('c', 'tui'));
  contextReads.slice(0, 3).forEach((read) => read.resolve());
  await settle();
  assert.ok(contextReads.some((read) => read.args.session_id === 'c' && read.projectId === 'p'), 'a tab reads against the project that lists it');
});

test('conversations prefetch on fast links, not on slow ones or when turned off', async () => {
  const fast = load({ connection: { type: 'wifi', rtt: 40 } });
  fast.prefetch.prefetchSession('p', session('a'), fast.prefetch.Tier.Other);
  await settle();
  assert.deepEqual(fast.calls.map((call) => [call.name, call.args]), [['integrated_get', { process_id: 'process_a', transcript_only: true }]], 'without the command and model lists');

  const slow = load({ connection: { saveData: true } });
  slow.prefetch.prefetchSession('p', session('a'), slow.prefetch.Tier.Intent);
  await settle();
  assert.equal(slow.calls.length, 0, 'data saver reads no conversation');

  const off = load({ preference: 'never' });
  off.prefetch.prefetchSession('p', session('a'), off.prefetch.Tier.Intent);
  await settle();
  assert.equal(off.calls.length, 0);

  const forced = load({ connection: { saveData: true }, preference: 'always' });
  forced.prefetch.prefetchSession('p', session('a'), forced.prefetch.Tier.Other);
  await settle();
  assert.equal(forced.calls.length, 1, 'Always reads conversations on any link');
});

test('on mobile data only the hovered or open project’s conversations prefetch, each once', async () => {
  const { prefetch, calls, contextReads } = load({ connection: { type: 'cellular', rtt: 60 } });
  // Context reads finish at once here, so they never hold the two slots.
  const finishContext = async () => { await settle(); contextReads.splice(0).forEach((read) => read.resolve()); await settle(); };
  prefetch.prefetchSession('other', session('x'), prefetch.Tier.Other);
  await finishContext();
  await settle();
  assert.equal(calls.length, 0, 'another project in the background reads no conversation');
  prefetch.prefetchSession('other', session('y'), prefetch.Tier.Intent);
  await finishContext();
  assert.equal(calls.length, 1, 'the pointer on it does');
  forgetConversation();
  calls[0].resolve({ messages: [], provider: 'claude' });
  await settle();
  forgetConversation('process_y');
  prefetch.prefetchSession('other', session('y'), prefetch.Tier.Intent);
  await finishContext();
  assert.equal(calls.length, 1, 'once per window');
});

test('a read-ahead conversation fills the cache without evicting opened ones', async () => {
  forgetConversation();
  const entry = { messages: [], permissions: [], questions: [], forms: [], usage: null, tasks: [], queue: [], controls: { selectors: [], commands: [] }, provider: null, streaming: false, historyTruncated: false, historyUnavailable: false, historyCursor: null, historyLoaded: false };
  for (let index = 0; index < 8; index++) rememberConversation(`opened_${index}`, entry);
  rememberConversation('ahead', entry, { evict: false });
  assert.equal(cachedConversation('ahead'), undefined, 'no room, so it is dropped');
  assert.ok(cachedConversation('opened_0'), 'the oldest opened conversation stays');
  forgetConversation('opened_1');
  const { prefetch, calls } = load({ runtime: 'desktop' });
  prefetch.prefetchSession('p', session('z'), prefetch.Tier.Other);
  await settle();
  calls[0].resolve({ messages: [{ id: 'm' }], provider: 'codex', streaming: true, history_truncated: true, history_cursor: { next: 'c1' } });
  await settle();
  const cached = cachedConversation('process_z');
  assert.equal(cached?.provider, 'codex');
  assert.equal(cached?.historyCursor, 'c1');
  assert.equal(cached?.streaming, true);
  forgetConversation();
});
