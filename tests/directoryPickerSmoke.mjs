import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import * as vue from 'vue';

const transpile = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

const serverPathSource = fs.readFileSync(new URL('../resources/js/lib/serverPath.ts', import.meta.url), 'utf8');
const serverPath = { exports: {} };
new Function('module', 'exports', 'require', transpile(serverPathSource))(serverPath, serverPath.exports, () => ({}));

const libSource = fs.readFileSync(new URL('../resources/js/lib/directoryPicker.ts', import.meta.url), 'utf8');
const lib = { exports: {} };
new Function('module', 'exports', 'require', transpile(libSource))(lib, lib.exports, (name) => name === 'vue' ? vue : serverPath.exports);

// Run the real DirectoryBrowser setup against a controllable RPC.
const component = fs.readFileSync(new URL('../resources/js/Components/DirectoryBrowser.vue', import.meta.url), 'utf8');
const source = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('browser.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) => statement.getFullText(parsed)).join('\n');
const setup = new Function('computed', 'nextTick', 'onMounted', 'ref', 'watch', 'defineProps', 'defineEmits', 'focusElement', 'DRIVES_PATH', 'directoryPlaceholder', 'displayServerPath', 'splitDirectoryQuery', 'withTrailingSlash', 'window',
  `${transpile(executable)}\nreturn { query, current, error, visible, onKeydown, drives, placeholder };`);

function mount() {
  const calls = [];
  const selected = [];
  const window = { patterm: { call: (_tool, args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })) } };
  const browser = setup(vue.computed, vue.nextTick, () => {}, vue.ref, vue.watch, () => ({}), () => (event, path) => { if (event === 'select') selected.push(path); },
    () => {}, lib.exports.DRIVES_PATH, lib.exports.directoryPlaceholder, lib.exports.displayServerPath, lib.exports.splitDirectoryQuery, lib.exports.withTrailingSlash, window);
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

test('typed Windows paths split at either separator', () => {
  const { splitDirectoryQuery, withTrailingSlash, displayServerPath, directoryPlaceholder, DRIVES_PATH } = lib.exports;
  assert.deepEqual(splitDirectoryQuery('C:\\Users\\me\\De'), { directory: 'C:\\Users\\me\\', filter: 'De' });
  assert.deepEqual(splitDirectoryQuery('C:/Users/me/De'), { directory: 'C:/Users/me/', filter: 'De' });
  assert.deepEqual(splitDirectoryQuery('C:\\'), { directory: 'C:\\', filter: '' });
  assert.deepEqual(splitDirectoryQuery('C:'), { directory: 'C:\\', filter: '' }, 'a bare drive letter is the drive root');
  assert.deepEqual(splitDirectoryQuery('~\\Dev\\pat'), { directory: '~\\Dev\\', filter: 'pat' });
  assert.deepEqual(splitDirectoryQuery(`${DRIVES_PATH}D`), { directory: DRIVES_PATH, filter: 'D' });
  // POSIX paths keep splitting on '/' only.
  assert.deepEqual(splitDirectoryQuery('/srv/co'), { directory: '/srv/', filter: 'co' });
  assert.deepEqual(splitDirectoryQuery('~'), { directory: '~', filter: '' });
  assert.deepEqual(splitDirectoryQuery('rep'), { directory: '', filter: 'rep' });

  assert.equal(withTrailingSlash('C:\\Users\\me'), 'C:\\Users\\me\\');
  assert.equal(withTrailingSlash('C:\\'), 'C:\\');
  assert.equal(withTrailingSlash('C:/work/'), 'C:/work/');
  assert.equal(withTrailingSlash('D:'), 'D:\\');
  assert.equal(withTrailingSlash('/srv/repo'), '/srv/repo/');
  assert.equal(withTrailingSlash('/'), '/');

  assert.equal(displayServerPath('C:\\Users\\me\\Dev', 'C:\\Users\\me'), '~\\Dev');
  assert.equal(displayServerPath('c:\\users\\ME', 'C:\\Users\\me'), '~', 'Windows paths compare ignoring case');
  assert.equal(displayServerPath('C:\\Users\\mellow', 'C:\\Users\\me'), 'C:\\Users\\mellow', 'a sibling that shares the prefix is not under home');
  assert.equal(displayServerPath('D:\\work', 'C:\\Users\\me'), 'D:\\work');
  assert.equal(displayServerPath('/home/me/Dev', '/home/me'), '~/Dev');
  assert.equal(displayServerPath('/home/Me', '/home/me'), '/home/Me', 'POSIX paths stay case-sensitive');
  assert.equal(displayServerPath('/srv', undefined), '/srv');

  assert.equal(directoryPlaceholder('C:\\Users\\me'), 'C:\\path\\to\\repo');
  assert.equal(directoryPlaceholder('/home/me'), '/path/to/repo');
  assert.equal(directoryPlaceholder(undefined), '/path/to/repo');
});

test('a Windows server is browsed with backslashes and reaches other drives', async () => {
  const { browser, calls, selected, enter } = mount();
  const home = 'C:\\Users\\me';
  const windowsListing = (path, parent, names = []) => ({
    path, parent, home, entries: names.map((name) => ({ name, path: `${path}${name}`, git: false })), truncated: false
  });

  browser.query.value = 'C:\\';
  await vue.nextTick();
  assert.deepEqual(calls.at(-1).args, { path: 'C:\\', filter: '', show_hidden: false });
  calls.at(-1).resolve(windowsListing('C:\\', lib.exports.DRIVES_PATH, ['Users']));
  await vue.nextTick();
  assert.equal(browser.placeholder.value, 'C:\\path\\to\\repo');
  assert.equal(browser.drives.value, false);

  browser.query.value = 'C:\\Us';
  await vue.nextTick();
  assert.deepEqual(calls.at(-1).args, { path: 'C:\\', filter: 'Us', show_hidden: false }, 'filters the folder before the last backslash');

  // The drive root's parent is the drive list, which can be browsed but never picked.
  browser.query.value = lib.exports.DRIVES_PATH;
  await vue.nextTick();
  assert.deepEqual(calls.at(-1).args, { path: lib.exports.DRIVES_PATH, filter: '', show_hidden: false });
  calls.at(-1).resolve({ path: lib.exports.DRIVES_PATH, parent: null, home, entries: [{ name: 'C:', path: 'C:\\', git: false }, { name: 'D:', path: 'D:\\', git: false }], truncated: false });
  await vue.nextTick();
  assert.equal(browser.drives.value, true);
  assert.deepEqual(browser.visible.value.map((entry) => entry.name), ['C:', 'D:']);
  enter();
  assert.deepEqual(selected, [], 'Enter on the drive list picks nothing');
});

test('the server lists drive letters above a drive root on Windows', { skip: process.platform !== 'win32' && 'drive letters only exist on a Windows server' }, async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const source = fs.readFileSync(new URL('../app/Actions/ListDirectoriesAction.ts', import.meta.url), 'utf8');
  const action = { exports: {} };
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  new Function('module', 'exports', 'require', compiled)(action, action.exports, require);
  const { ListDirectoriesAction, listDirectoriesInput, DRIVES_PATH } = action.exports;
  assert.equal(DRIVES_PATH, lib.exports.DRIVES_PATH, 'server and renderer agree on the drive list path');

  const os = require('node:os');
  const path = require('node:path');
  const lister = new ListDirectoriesAction(os.homedir());
  const root = path.parse(os.homedir()).root;
  assert.equal(lister.execute(listDirectoriesInput.parse({ path: root })).parent, DRIVES_PATH, 'a drive root reaches the drive list');

  const drives = lister.execute(listDirectoriesInput.parse({ path: DRIVES_PATH }));
  assert.equal(drives.path, DRIVES_PATH);
  assert.equal(drives.parent, null);
  assert.ok(drives.entries.some((entry) => entry.path.toLowerCase() === root.toLowerCase()), 'the home drive is listed');
  assert.ok(drives.entries.every((entry) => /^[A-Z]:$/.test(entry.name) && entry.path === `${entry.name}\\`));
  assert.deepEqual(lister.execute(listDirectoriesInput.parse({ path: DRIVES_PATH, filter: root[0].toLowerCase() })).entries.map((entry) => entry.name), [root.slice(0, 2).toUpperCase()], 'the filter applies to drive letters');

  const home = os.homedir();
  assert.equal(lister.execute(listDirectoriesInput.parse({ path: '~\\' })).path, path.resolve(home), '~\\ expands to home');
  assert.equal(lister.execute(listDirectoriesInput.parse({ path: '~/' })).path, path.resolve(home), '~/ still expands');
});

test('the picker stacks above the dialog that opens it', () => {
  // The picker's portal mounts with the app, so a dialog on a page opened
  // later comes after it in the DOM; only a higher layer than z-50 wins.
  const picker = fs.readFileSync(new URL('../resources/js/Components/DirectoryPickerDialog.vue', import.meta.url), 'utf8');
  const content = picker.match(/<DialogContent\b[^>]*>/)[0];
  const layer = (attribute) => Number(content.match(new RegExp(`\\b${attribute}="[^"]*\\bz-\\[(\\d+)\\]`))?.[1] ?? 0);
  assert.ok(layer('class') > 50, 'panel sits above other dialogs');
  assert.ok(layer('overlay-class') > 50, 'backdrop dims the dialog underneath');

  const dialogContent = fs.readFileSync(new URL('../resources/js/Components/ui/dialog/DialogContent.vue', import.meta.url), 'utf8');
  assert.match(dialogContent, /<DialogOverlay[^>]*props\.overlayClass/, 'DialogContent applies overlayClass to its overlay');
});
