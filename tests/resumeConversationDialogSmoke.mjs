import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { computed, nextTick, ref, watch } from 'vue';

// Runs the picker's real <script setup> with a controllable transport and
// timers, so paging, search, and stale replies are covered without a DOM.
const page = fs.readFileSync(new URL('../resources/js/Components/ResumeConversationDialog.vue', import.meta.url), 'utf8');
const source = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('dialog.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) => statement.getFullText(parsed)).join('\n');
const { outputText } = ts.transpileModule(executable, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); await nextTick(); };

function mount({ initialQuery = '', onLaunched } = {}) {
  const calls = [];
  const timers = [];
  const open = ref(false);
  const bindings = {
    computed, nextTick, ref, watch, useId: () => 'list', onBeforeUnmount: () => {},
    defineProps: () => ({ projectId: 'project_a', processId: 'process_self', provider: 'claude', providerLabel: 'Claude', initialQuery, onLaunched }),
    defineModel: () => open,
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
    relativeTime: () => 'now',
    window: { patterm: { call: (tool, args) => new Promise((resolve) => calls.push({ tool, args, resolve })) } },
    document: { getElementById: () => null }
  };
  // Cached reads go straight to the server here.
  bindings.topicCall = (_topic, tool, args) => bindings.window.patterm.call(tool, args);
  bindings.useWorkbench = () => ({ lifecycleRevision: ref(0) });
  const setup = new Function(...Object.keys(bindings), `${outputText}\nreturn { query, results, visible, hasMore, loading, reload, loadMore, onScroll, searching, resume };`);
  const dialog = setup(...Object.values(bindings));
  const runTimers = async () => { await flush(); while (timers.length) timers.shift()(); await flush(); };
  return { dialog, calls, open, runTimers };
}

const conversation = (id, extra = {}) => ({ id, provider: 'claude', processId: null, messageCount: 2, title: id, ...extra });

test('without a query the picker pages through recent conversations', async () => {
  const { dialog, calls, open } = mount();
  open.value = true;
  await flush();
  const first = calls.at(-1);
  assert.equal(first.tool, 'history_list');
  assert.deepEqual(first.args, { project_id: 'project_a', provider: 'claude', resumable: true, limit: 50, offset: 0 });
  first.resolve({ conversations: [...Array.from({ length: 49 }, (_, index) => conversation(`c${index}`)), conversation('own', { processId: 'process_self' })] });
  await flush();
  assert.equal(dialog.visible.value.length, 49, 'the current session is not offered');
  assert.equal(dialog.hasMore.value, true);
  dialog.onScroll({ target: { scrollTop: 900, clientHeight: 350, scrollHeight: 1300 } });
  await flush();
  const second = calls.at(-1);
  assert.equal(second.args.offset, 50, 'the next page continues after every loaded row');
  second.resolve({ conversations: [conversation('c48'), conversation('late')] });
  await flush();
  assert.equal(dialog.results.value.length, 51, 'a row already loaded is not repeated');
  assert.equal(dialog.hasMore.value, false);
});

test('a query searches the whole history and a stale reply cannot win', async () => {
  const { dialog, calls, open, runTimers } = mount({ initialQuery: 'webgpu' });
  open.value = true;
  await runTimers();
  const firstSearch = calls.at(-1);
  assert.equal(firstSearch.tool, 'history_search');
  assert.deepEqual(firstSearch.args, { query: 'webgpu', project_id: 'project_a', provider: 'claude', resumable: true, limit: 30 });
  dialog.query.value = 'webgpu renderer';
  await runTimers();
  const secondSearch = calls.at(-1);
  secondSearch.resolve({ conversations: [conversation('renderer', { match: { messageId: 'm1', preview: 'the \u0002webgpu\u0003 renderer' } })] });
  await flush();
  firstSearch.resolve({ conversations: [conversation('stale')] });
  await flush();
  assert.deepEqual(dialog.results.value.map((row) => row.id), ['renderer'], 'the older search reply is dropped');
  const listCalls = calls.filter((call) => call.tool === 'history_list').length;
  dialog.onScroll({ target: { scrollTop: 900, clientHeight: 350, scrollHeight: 1300 } });
  await flush();
  assert.equal(calls.filter((call) => call.tool === 'history_list').length, listCalls, 'search results do not page the recent list');
});

test('a resume that replaces the tab still opens the new session', async () => {
  // The backend closes the replaced tab before it answers, which unmounts the
  // dialog; the launch callback must not depend on it staying mounted.
  const launched = [];
  const { dialog, calls, open } = mount({ onLaunched: (sessionId) => launched.push(sessionId) });
  open.value = true;
  await flush();
  calls.at(-1).resolve({ conversations: [conversation('older')] });
  await flush();
  const resuming = dialog.resume(dialog.visible.value[0]);
  const request = calls.at(-1);
  assert.equal(request.tool, 'history_resume');
  assert.equal(request.args.replace_process_id, 'process_self');
  request.resolve({ session_id: 'session_new' });
  await resuming;
  assert.equal(open.value, false);
  assert.deepEqual(launched, ['session_new']);
});
