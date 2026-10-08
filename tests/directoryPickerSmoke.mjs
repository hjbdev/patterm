import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import * as vue from 'vue';

const transpile = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

const libSource = fs.readFileSync(new URL('../resources/js/lib/directoryPicker.ts', import.meta.url), 'utf8');
const lib = { exports: {} };
new Function('module', 'exports', 'require', transpile(libSource))(lib, lib.exports, () => vue);

// Run the real DirectoryBrowser setup against a controllable RPC.
const component = fs.readFileSync(new URL('../resources/js/Components/DirectoryBrowser.vue', import.meta.url), 'utf8');
const source = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('browser.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) => statement.getFullText(parsed)).join('\n');
const setup = new Function('computed', 'nextTick', 'onMounted', 'ref', 'watch', 'defineProps', 'defineEmits', 'focusElement', 'splitDirectoryQuery', 'withTrailingSlash', 'window',
  `${transpile(executable)}\nreturn { query, current, error, visible, onKeydown };`);

function mount() {
  const calls = [];
  const selected = [];
  const window = { patterm: { call: (_tool, args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })) } };
  const browser = setup(vue.computed, vue.nextTick, () => {}, vue.ref, vue.watch, () => ({}), () => (event, path) => { if (event === 'select') selected.push(path); },
    () => {}, lib.exports.splitDirectoryQuery, lib.exports.withTrailingSlash, window);
  const enter = () => browser.onKeydown({ key: 'Enter', preventDefault() {} });
  const tab = () => browser.onKeydown({ key: 'Tab', preventDefault() {} });
  return { browser, calls, selected, enter, tab };
}

const listing = (path, names = []) => ({ path, parent: '/', home: '/home/me', entries: names.map((name) => ({ name, path: `${path}/${name}`, git: false })), truncated: false });

test('picking never uses a listing for an earlier folder', async () => {
  const { browser, calls, selected, enter } = mount();
  browser.query.value = '/srv/';
  await vue.nextTick();
  calls.at(-1).resolve(listing('/srv', ['repo']));
  await vue.nextTick();
  assert.equal(browser.current.value?.path, '/srv');

  // While /srv/repo/ loads, the /srv listing can't be picked.
  browser.query.value = '/srv/repo/';
  await vue.nextTick();
  assert.equal(browser.current.value, null);
  enter();
  assert.deepEqual(selected, [], 'Enter during a load picks nothing');

  calls.at(-1).resolve(listing('/srv/repo'));
  await vue.nextTick();
  enter();
  assert.deepEqual(selected, ['/srv/repo']);

  // A failed load leaves nothing to pick until the path is valid again.
  browser.query.value = '/missing/';
  await vue.nextTick();
  calls.at(-1).reject(new Error('path does not exist: /missing'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(browser.error.value, /does not exist/);
  enter();
  assert.deepEqual(selected, ['/srv/repo'], 'Enter after an error picks nothing');

  browser.query.value = '/srv/repo/';
  await vue.nextTick();
  calls.at(-1).resolve(listing('/srv/repo'));
  await vue.nextTick();
  assert.equal(browser.current.value?.path, '/srv/repo', 'recovers once the typed folder loads');
});

test('completion and opening never use entries from an earlier folder', async () => {
  const { browser, calls, enter, tab } = mount();
  browser.query.value = '/srv/';
  await vue.nextTick();
  calls.at(-1).resolve(listing('/srv', ['repo']));
  await vue.nextTick();

  browser.query.value = '/elsewhere/rep';
  await vue.nextTick();
  assert.deepEqual(browser.visible.value, [], 'no rows while the new folder loads');
  tab();
  enter();
  assert.equal(browser.query.value, '/elsewhere/rep', 'Tab and Enter wait for the folder');

  calls.at(-1).reject(new Error('path does not exist: /elsewhere'));
  await new Promise((resolve) => setImmediate(resolve));
  tab();
  enter();
  assert.equal(browser.query.value, '/elsewhere/rep', 'and do nothing after it fails');
});

test('the typed filter goes to the server', async () => {
  const { browser, calls } = mount();
  browser.query.value = '/srv/rep';
  await vue.nextTick();
  assert.deepEqual(calls.at(-1).args, { path: '/srv/', filter: 'rep', show_hidden: false });
  browser.query.value = '/srv/.con';
  await vue.nextTick();
  assert.deepEqual(calls.at(-1).args, { path: '/srv/', filter: '.con', show_hidden: true });
});
