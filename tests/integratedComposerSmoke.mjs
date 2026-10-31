import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, shallowRef, useId, watch } from 'vue';

const require = createRequire(import.meta.url);
const composer = require('../dist/tests/resources/js/lib/integratedComposer.js');
const composerDocument = require('../dist/tests/resources/js/lib/composerDocument.js');
const { CHIP } = composerDocument;

// Stub browser-only object URL handling before any draft creates previews.
let previewId = 0;
URL.createObjectURL = () => `blob:test/${++previewId}`;
URL.revokeObjectURL = () => {};
// The composer store reads the global upload bridge, so the active harness
// routes uploads to its own controllable queue.
let activeUpload = async () => { throw new Error('No active upload harness'); };
globalThis.window = { patterm: { uploadFile: (file) => activeUpload(file) } };
// Touch screens skip focusing on arrival, which would open the keyboard.
let touch = false;

const page = fs.readFileSync(new URL('../resources/js/Components/IntegratedComposer.vue', import.meta.url), 'utf8');
const source = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('composer.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getFullText(parsed)).join('\n');
const { outputText } = ts.transpileModule(executable, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
const uuid = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function file(name, type, body = 'data') {
  return new File([body], name, { type });
}

function createHarness({ processId = 'composer_test', provider = 'codex', agents, processes, launchers } = {}) {
  const lifecycle = { mounted: [], beforeUnmount: [] };
  const emitted = [];
  const calls = [];
  const uploads = [];
  const timers = new Map();
  let timerId = 0;
  const props = reactive({ processId, provider, controls: { selectors: [], commands: [{ name: 'compact', description: 'Compact' }] }, controlling: true, sending: false, pending: false, ended: false, agents, processes, launchers });
  const windowMock = {
    patterm: {
      runtime: 'browser',
      call: (tool, args) => new Promise((resolve, reject) => {
        const entry = { tool, args, settled: false };
        entry.resolve = (value) => { entry.settled = true; resolve(value); };
        entry.reject = (error) => { entry.settled = true; reject(error); };
        calls.push(entry);
      })
    }
  };
  activeUpload = (fileValue) => new Promise((resolve, reject) => {
    const entry = { file: fileValue, settled: false };
    entry.resolve = (value) => { entry.settled = true; resolve(value); };
    entry.reject = (error) => { entry.settled = true; reject(error); };
    uploads.push(entry);
  });
  const editors = [];
  const bindings = {
    computed,
    nextTick,
    onMounted: callback => lifecycle.mounted.push(callback),
    onBeforeUnmount: callback => lifecycle.beforeUnmount.push(callback),
    ref,
    shallowRef,
    useId,
    watch,
    touchScreen: () => touch,
    createComposerEditor: (options) => {
      const editor = fakeEditor(options);
      editors.push(editor);
      return editor;
    },
    defineProps: () => props,
    defineEmits: () => (event, payload) => emitted.push({ event, payload }),
    window: windowMock,
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => { timers.delete(id); },
    ...composer
  };
  const setup = new Function(...Object.keys(bindings), `${outputText}
return {
  editor, picker, mode, menuIndex, files, searchError, searching, menuOpen, canSend, agentMatches, processMatches, launcherMatches, menuItems, placeholder,
  getDraft: () => draft.value,
  evaluate, onKeydown, submit, chooseFile, chooseAgent, chooseProcess, chooseLauncher, chooseCommand, onPaste, onDrop, onPick
};`);
  const scope = effectScope();
  const pane = scope.run(() => setup(...Object.keys(bindings).map(key => bindings[key])));
  // Shows text as if the user had typed it, with the caret at the end.
  const setEditor = (text) => {
    const editor = pane.editor.value;
    editor.load(text);
    pane.getDraft().text = text;
    return editor;
  };
  return { pane, props, emitted, calls, uploads, timers, scope, lifecycle, editors, setEditor };
}

// Stands in for the Tiptap editor: a run of characters and chips with a
// caret, reporting edits the way the real editor does.
function fakeEditor(options) {
  let units = [];
  let caret = 0;
  const text = () => units.map(unit => typeof unit === 'string' ? unit : CHIP).join('');
  const chips = () => units.filter(unit => typeof unit !== 'string');
  const editor = {
    focused: 0,
    refreshed: 0,
    destroyed: false,
    load(value, list = []) {
      let next = 0;
      units = value.split('').flatMap(unit => unit === CHIP ? (next < list.length ? [list[next++]] : []) : [unit]);
      caret = units.length;
    },
    getText: text,
    getSelection: () => ({ start: caret, end: caret }),
    // A caret move without an edit, such as an arrow key or a click.
    setCaret(at) {
      caret = at;
      options.onSelectionChange();
    },
    replace(start, end, insert) {
      const added = typeof insert === 'string' ? insert.split('') : [insert, ' '];
      units.splice(start, end - start, ...added);
      caret = start + added.length;
      options.onChange(text(), chips());
    },
    setText(value, list) { editor.load(value, list); },
    focus() { editor.focused++; },
    refresh() { editor.refreshed++; },
    destroy() { editor.destroyed = true; }
  };
  editor.load(options.text, options.chips);
  return editor;
}

function mentionAgent(processId, name, { parent = null } = {}) {
  return { session: { id: `session_${processId}`, processId, harness: 'claude', activity: 'idle', exitedAt: null }, processId, name, parent };
}

function runTimers(harness) {
  for (const [id, timer] of [...harness.timers]) {
    harness.timers.delete(id);
    timer.callback();
  }
}

test('each agent gets its own focused editor, except ended sessions', async () => {
  composer.clearDrafts();
  composer.draftFor('composer_focus_next').text = `ask ${CHIP} first`;
  composer.draftFor('composer_focus_next').chips = [{ kind: 'agent', token: 'process_3', name: 'Reviewer', harness: 'codex' }];
  const harness = createHarness({ processId: 'composer_focus' });
  harness.lifecycle.mounted.forEach(callback => callback());
  await nextTick();
  assert.equal(harness.editors.length, 1);
  assert.equal(harness.editors[0].focused, 1, 'a newly opened agent focuses the editor');
  harness.props.processId = 'composer_focus_next';
  await nextTick();
  await nextTick();
  assert.equal(harness.editors[0].destroyed, true, "the previous agent's editor and its undo history go");
  assert.equal(harness.editors[1].getText(), `ask ${CHIP} first`, "the next agent's draft opens with its chip");
  assert.equal(harness.editors[1].focused, 1, 'switching agents focuses the editor');
  harness.props.ended = true;
  harness.props.processId = 'composer_focus_ended';
  await nextTick();
  await nextTick();
  assert.equal(harness.editors[2].focused, 0, 'an ended session leaves focus unchanged');
  harness.lifecycle.beforeUnmount.forEach(callback => callback());
  assert.equal(harness.editors[2].destroyed, true);
  harness.scope.stop();
  touch = true;
  const phone = createHarness({ processId: 'composer_focus_phone' });
  phone.lifecycle.mounted.forEach(callback => callback());
  await nextTick();
  assert.equal(phone.editors[0].focused, 0, 'a touch screen opens an agent without the keyboard');
  phone.props.processId = 'composer_focus_phone_next';
  await nextTick();
  await nextTick();
  assert.equal(phone.editors[1].focused, 0, 'a touch screen switches agents without the keyboard');
  phone.lifecycle.beforeUnmount.forEach(callback => callback());
  phone.scope.stop();
  touch = false;
});

test('mention search is bounded, debounced, and keyboard selectable', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_mention' });
  harness.setEditor('@ap');
  harness.pane.evaluate();
  assert.equal(harness.calls.length, 0, 'search waits for the debounce');
  assert.equal([...harness.timers.values()][0]?.delay, 120);
  runTimers(harness);
  await flush();
  assert.equal(harness.calls[0]?.tool, 'integrated_files_search');
  assert.deepEqual(harness.calls[0]?.args, { process_id: 'composer_mention', query: 'ap', limit: 20 });
  harness.calls[0].resolve([
    { path: 'src/app.ts', name: 'app.ts' },
    { path: 'src/app.test.ts', name: 'app.test.ts' }
  ]);
  await flush();
  assert.equal(harness.pane.menuOpen.value, true);
  assert.equal(harness.pane.files.value.length, 2);
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(harness.pane.menuIndex.value, 1);
  harness.pane.onKeydown({ key: 'ArrowUp', preventDefault() {} });
  assert.equal(harness.pane.menuIndex.value, 0);
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  harness.pane.onKeydown({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(harness.pane.getDraft().text, '@src/app.test.ts ');
  assert.deepEqual(harness.pane.getDraft().references, [{ path: 'src/app.test.ts', name: 'app.test.ts' }]);
  assert.equal(harness.pane.menuOpen.value, false);
  harness.scope.stop();
});

test('a stale mention search cannot replace newer results', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_stale_search' });
  harness.setEditor('@a');
  harness.pane.evaluate();
  runTimers(harness);
  await flush();
  harness.setEditor('@ab');
  harness.pane.evaluate();
  runTimers(harness);
  await flush();
  assert.equal(harness.calls.length, 2);
  harness.calls[1].resolve([{ path: 'src/ab.ts', name: 'ab.ts' }]);
  await flush();
  harness.calls[0].resolve([{ path: 'src/a.ts', name: 'a.ts' }]);
  await flush();
  assert.deepEqual(harness.pane.files.value.map(entry => entry.path), ['src/ab.ts']);
  harness.pane.onKeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(harness.pane.menuOpen.value, false);
  harness.scope.stop();
});

test('Escape closes the slash menu and Enter submits only outside IME composition', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_ime' });
  harness.setEditor('/co');
  harness.pane.evaluate();
  assert.equal(harness.pane.menuOpen.value, true);
  harness.pane.onKeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(harness.pane.menuOpen.value, false);

  harness.props.controls = { selectors: [], commands: [] };
  harness.setEditor('/co');
  harness.pane.evaluate();
  assert.equal(harness.pane.menuOpen.value, false, 'an agent without native commands has no slash menu');

  harness.setEditor('hello');
  const prevented = [];
  harness.pane.onKeydown({ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 229, preventDefault: () => prevented.push('prevented') });
  harness.pane.onKeydown({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229, preventDefault: () => prevented.push('prevented') });
  assert.equal(harness.emitted.length, 0, 'composition Enter is not a submission');
  assert.equal(prevented.length, 0, 'composition Enter keeps its default behaviour');
  harness.pane.onKeydown({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, preventDefault: () => prevented.push('prevented') });
  await flush();
  assert.equal(prevented.length, 1);
  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].event, 'send');
  assert.equal(harness.emitted[0].payload.text, 'hello');
  assert.match(harness.emitted[0].payload.messageId, /^[0-9a-f-]{36}$/);
  harness.scope.stop();
});

test('submission waits for uploads and a failed upload blocks the send with an actionable error', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_uploads' });
  harness.setEditor('see attached');
  harness.pane.onPick({ target: { files: [file('shot.png', 'image/png')], value: '' } });
  await flush();
  assert.equal(harness.pane.getDraft().attachments[0]?.status, 'uploading');
  assert.equal(harness.pane.canSend.value, false, 'uploads block submission');
  harness.pane.submit();
  assert.equal(harness.emitted.length, 0);
  harness.uploads[0].reject(new Error('Upload storage is full'));
  await flush();
  assert.equal(harness.pane.getDraft().attachments[0]?.status, 'error');
  assert.equal(harness.pane.getDraft().attachments[0]?.error, 'Upload storage is full');
  harness.pane.submit();
  assert.equal(harness.emitted.length, 0, 'a failed attachment keeps the send blocked');
  composer.removeAttachment('composer_uploads', harness.pane.getDraft().attachments[0].id);
  await flush();
  harness.pane.submit();
  assert.equal(harness.emitted.length, 1);
  harness.scope.stop();
});

test('a successful upload enables the send and a retry recovers a failed one', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_upload_ok' });
  harness.setEditor('ship it');
  harness.pane.onPick({ target: { files: [file('shot.png', 'image/png')], value: '' } });
  await flush();
  harness.uploads[0].resolve('/tmp/uploads/shot.png');
  await flush();
  assert.equal(harness.pane.getDraft().attachments[0]?.status, 'ready');
  harness.pane.submit();
  assert.equal(harness.emitted.length, 1);
  assert.deepEqual(harness.emitted[0].payload.attachments, [{ path: '/tmp/uploads/shot.png', name: 'shot.png', mime: 'image/png' }]);
  harness.scope.stop();
});

test('pasting a clipboard image creates an attachment, and Claude accepts dropped text files', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_paste', provider: 'claude' });
  harness.setEditor('look');
  let prevented = false;
  harness.pane.onPaste({
    clipboardData: { items: [{ kind: 'file', getAsFile: () => file('pasted.png', 'image/png') }] },
    preventDefault: () => { prevented = true; }
  });
  await flush();
  assert.equal(prevented, true, 'file paste does not also insert text');
  assert.equal(harness.pane.getDraft().attachments[0]?.status, 'uploading');
  harness.uploads[0].resolve('/tmp/uploads/pasted.png');
  await flush();
  assert.equal(harness.pane.getDraft().attachments[0]?.status, 'ready');

  harness.pane.onDrop({ dataTransfer: { files: [file('notes.md', 'text/markdown')] } });
  await flush();
  assert.equal(harness.pane.getDraft().attachments[1]?.status, 'uploading');
  assert.equal(harness.uploads.length, 2, 'Claude uploads text files as documents');
  harness.scope.stop();
});

test('per-process drafts survive switching and a completed send keeps newer edits', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_draft_a' });
  harness.setEditor('for A @src/a.ts');
  harness.pane.getDraft().references.push({ path: 'src/a.ts', name: 'a.ts' });
  harness.props.processId = 'composer_draft_b';
  await nextTick();
  assert.equal(harness.pane.getDraft().text, '');
  harness.setEditor('for B');
  harness.props.processId = 'composer_draft_a';
  await nextTick();
  assert.equal(harness.pane.getDraft().text, 'for A @src/a.ts');
  assert.deepEqual(harness.pane.getDraft().references, [{ path: 'src/a.ts', name: 'a.ts' }]);

  // A failed attempt reuses its id only while the payload is unchanged.
  const first = composer.payloadFor('composer_draft_a');
  assert.equal(first.ok, true);
  const again = composer.payloadFor('composer_draft_a');
  assert.equal(again.ok && first.ok && again.payload.messageId === first.payload.messageId, true);
  harness.pane.getDraft().text = 'for A @src/a.ts edited';
  const edited = composer.payloadFor('composer_draft_a');
  assert.equal(edited.ok && first.ok && edited.payload.messageId !== first.payload.messageId, true);

  // Newer edits stay after a delivery, and a token still in them is sent again.
  composer.completeSend('composer_draft_a', { ...first.payload, hash: first.hash });
  assert.equal(composer.draftFor('composer_draft_a').text, 'for A @src/a.ts edited');
  const resend = composer.payloadFor('composer_draft_a');
  assert.deepEqual(resend.ok && resend.payload.references.map(reference => reference.path), ['src/a.ts']);

  // An unchanged draft is emptied after a successful send.
  composer.addReference('composer_draft_a', 'src/a.ts', 'a.ts');
  const current = composer.payloadFor('composer_draft_a');
  assert.equal(current.ok, true);
  composer.completeSend('composer_draft_a', { ...current.payload, hash: current.hash });
  assert.equal(composer.draftFor('composer_draft_a').text, '');
  assert.deepEqual(composer.draftFor('composer_draft_a').references, []);
  assert.deepEqual(composer.draftFor('composer_draft_a').attachments, []);
  harness.scope.stop();
});

test('a resolved or rejected upload notifies reactive readers without another interaction', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_reactive' });
  harness.setEditor('text');
  const seen = [];
  const stop = watch(() => composer.draftFor('composer_reactive').attachments[0]?.status, (value) => seen.push(value), { flush: 'sync' });
  harness.pane.onPick({ target: { files: [file('shot.png', 'image/png')], value: '' } });
  await flush();
  assert.deepEqual(seen, ['uploading']);
  harness.uploads[0].resolve('/tmp/uploads/shot.png');
  await flush();
  assert.deepEqual(seen, ['uploading', 'ready'], 'the reactive item updates when the upload resolves');
  assert.equal(harness.pane.canSend.value, true);
  stop();

  const failing = createHarness({ processId: 'composer_reactive_reject' });
  failing.setEditor('text');
  const rejected = [];
  const stopRejected = watch(() => composer.draftFor('composer_reactive_reject').attachments[0]?.status, (value) => rejected.push(value), { flush: 'sync' });
  failing.pane.onPick({ target: { files: [file('shot.png', 'image/png')], value: '' } });
  await flush();
  failing.uploads[0].reject(new Error('Upload storage is full'));
  await flush();
  assert.deepEqual(rejected, ['uploading', 'error']);
  assert.match(composer.draftFor('composer_reactive_reject').attachments[0].error, /storage is full/);
  stopRejected();
  failing.scope.stop();
  harness.scope.stop();
});

test('a search reply from a previous process cannot land during a new debounce', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'search-A' });
  harness.setEditor('@first');
  harness.pane.evaluate();
  runTimers(harness);
  await flush();
  assert.equal(harness.calls.length, 1);
  harness.props.processId = 'search-B';
  await nextTick();
  assert.deepEqual(harness.pane.files.value, [], 'process change clears old results');
  harness.setEditor('@second');
  harness.pane.evaluate();
  // The old reply resolves while the new query is still debouncing.
  harness.calls[0].resolve([{ path: 'private-file-from-A.ts', name: 'private-file-from-A.ts' }]);
  await flush();
  assert.deepEqual(harness.pane.files.value, [], 'the stale reply is dropped before any new request starts');
  runTimers(harness);
  await flush();
  assert.equal(harness.calls[1]?.args.process_id, 'search-B');
  assert.equal(harness.calls[1]?.args.query, 'second');
  harness.calls[1].resolve([{ path: 'b.ts', name: 'b.ts' }]);
  await flush();
  assert.deepEqual(harness.pane.files.value.map(entry => entry.path), ['b.ts']);
  harness.scope.stop();
});

test('Shift+Enter keeps a newline even while the mention menu is open', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_shift' });
  harness.setEditor('@ap');
  harness.pane.evaluate();
  runTimers(harness);
  await flush();
  harness.calls[0].resolve([{ path: 'src/app.ts', name: 'app.ts' }]);
  await flush();
  assert.equal(harness.pane.menuOpen.value, true);
  const prevented = [];
  harness.pane.onKeydown({ key: 'Enter', shiftKey: true, isComposing: false, keyCode: 13, preventDefault: () => prevented.push('prevented') });
  assert.equal(prevented.length, 0, 'Shift+Enter is left to insert a newline');
  assert.equal(harness.pane.getDraft().text, '@ap', 'the menu selection is not applied');
  assert.equal(harness.pane.menuOpen.value, true);
  harness.scope.stop();
});

test('composer helpers insert and remove references without touching other text', () => {
  assert.deepEqual(composer.mentionQuery('see @src/ap', 11), { query: 'src/ap', start: 4 });
  assert.equal(composer.mentionQuery('see src/ap', 10), null);
  assert.equal(composer.mentionQuery('mail me@example.com', 19), null, 'an email address is not a mention');
  assert.deepEqual(composer.mentionQuery('@ap', 3), { query: 'ap', start: 0 });
  assert.deepEqual(composer.mentionQuery('line\n@ap', 8), { query: 'ap', start: 5 });
  assert.equal(composer.referenceToken('src/app.ts'), '@src/app.ts');
  assert.equal(composer.referenceToken('src dir/my file.ts'), '@"src dir/my file.ts"');
  assert.deepEqual(
    composer.sentReferences({ text: 'see @"src dir/a b.ts" and @src/b.ts.', references: [{ path: 'src dir/a b.ts', name: 'a b.ts' }, { path: 'src/b.ts', name: 'b.ts' }, { path: 'src/gone.ts', name: 'gone.ts' }] }).map(reference => reference.path),
    ['src dir/a b.ts', 'src/b.ts'],
    'only references whose tokens remain are sent'
  );
  assert.equal(composer.referenceToken('notes!'), '@"notes!"', 'a path ending in punctuation is quoted');
  assert.deepEqual(
    composer.sentReferences({ text: 'see @"notes (old)" and @"notes!", then @src/a.ts.', references: [{ path: 'notes (old)', name: 'notes (old)' }, { path: 'notes!', name: 'notes!' }, { path: 'src/a.ts', name: 'a.ts' }] }).map(reference => reference.path),
    ['notes (old)', 'notes!', 'src/a.ts'],
    'quoted punctuation stays part of the path and a trailing full stop does not'
  );
  const picked = [{ path: 'src/a.ts', name: 'a.ts' }, { path: 'src/a.ts.bak', name: 'a.ts.bak' }, { path: 'config/', name: 'config/' }, { path: 'config/.env.example', name: '.env.example' }];
  assert.deepEqual(
    composer.sentReferences({ text: 'compare @src/a.ts.bak and @config/.env.example', references: picked }).map(reference => reference.path),
    ['src/a.ts.bak', 'config/.env.example'],
    'a path is not found inside a longer file name'
  );
  assert.deepEqual(composer.sentReferences({ text: 'end with @src/a.ts.', references: picked }).map(reference => reference.path), ['src/a.ts']);
  assert.deepEqual(composer.highlightRuns('app.ts', [4, 5, 7], 4), [{ text: 'ap', match: true }, { text: 'p', match: false }, { text: '.', match: true }, { text: 'ts', match: false }]);
  assert.deepEqual(composer.slashQuery('/comp'), { query: 'comp' });
  assert.equal(composer.slashQuery('text /comp'), null);
  const commands = ['autocompact', 'compact-history', 'compact', 'config', 'mcp:compact'].map(name => ({ name }));
  assert.deepEqual(composer.rankCommands(commands, 'compact').map(command => command.name), ['compact', 'compact-history', 'mcp:compact', 'autocompact'], 'exact, prefix, word boundary, then substring');
  assert.deepEqual(composer.rankCommands(commands, 'CO').map(command => command.name), ['config', 'compact', 'compact-history', 'mcp:compact', 'autocompact'], 'prefix ties prefer shorter names');
  assert.deepEqual(composer.rankCommands(commands, '').map(command => command.name), commands.map(command => command.name), 'an empty query keeps the provider order');
  assert.equal(composer.attachmentMime({ name: 'pixel.png', type: 'image/png' }), 'image/png');
  assert.equal(composer.attachmentMime({ name: 'notes.md', type: '' }), 'text/markdown');
  assert.equal(composer.attachmentMime({ name: 'archive.zip', type: 'application/zip' }), null);
});

test('Enter or Tab before results arrive picks the first result for the current query', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_accept_pending' });
  harness.setEditor('see @a');
  harness.pane.evaluate();
  runTimers(harness);
  await flush();
  harness.calls[0].resolve([{ path: 'src/a.ts', name: 'a.ts' }]);
  await flush();
  harness.setEditor('see @ab');
  harness.pane.evaluate();
  assert.equal(harness.pane.searching.value, true);
  const prevented = [];
  harness.pane.onKeydown({ key: 'Enter', shiftKey: false, keyCode: 13, preventDefault: () => prevented.push('prevented') });
  await flush();
  assert.equal(prevented.length, 1);
  assert.equal(harness.emitted.length, 0, 'Enter during a search never submits');
  assert.equal(harness.calls.length, 2, 'the debounced search runs immediately');
  assert.equal(harness.pane.getDraft().text, 'see @ab', 'the stale row is not chosen');
  harness.calls[1].resolve([{ path: 'src/ab.ts', name: 'ab.ts', matches: [4, 5] }]);
  await flush();
  assert.equal(harness.pane.getDraft().text, 'see @src/ab.ts ');
  assert.equal(harness.pane.menuOpen.value, false);

  harness.setEditor('see @src/ab.ts @b');
  harness.pane.evaluate();
  runTimers(harness);
  await flush();
  harness.calls[2].resolve([{ path: 'b.ts', name: 'b.ts' }, { path: 'lib/b.ts', name: 'b.ts' }]);
  await flush();
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  harness.pane.onKeydown({ key: 'Tab', preventDefault() {} });
  await flush();
  assert.equal(harness.pane.getDraft().text, 'see @src/ab.ts @lib/b.ts ', 'Tab accepts the selected row');
  harness.scope.stop();
});

test('moving the caret inside an unchanged mention keeps the results without searching again', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_caret' });
  const editor = harness.setEditor('@app');
  harness.pane.evaluate();
  runTimers(harness);
  await flush();
  harness.calls[0].resolve([{ path: 'app.ts', name: 'app.ts' }]);
  await flush();
  harness.pane.evaluate();
  assert.equal(harness.timers.size, 0, 'the same mention does not schedule another search');
  assert.equal(harness.pane.files.value.length, 1);
  editor.setCaret(0);
  assert.equal(harness.pane.menuOpen.value, false, 'leaving the mention closes the menu');
  harness.scope.stop();
});

test('deleting a picked token removes its reference from the payload', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_token_delete' });
  harness.setEditor('@ap');
  harness.pane.evaluate();
  runTimers(harness);
  await flush();
  harness.calls[0].resolve([{ path: 'src/app.ts', name: 'app.ts' }]);
  await flush();
  harness.pane.chooseFile(harness.pane.files.value[0]);
  await flush();
  harness.pane.getDraft().text = 'no file after all';
  harness.pane.submit();
  assert.deepEqual(harness.emitted[0].payload.references, []);
  assert.equal(harness.emitted[0].payload.text, 'no file after all');
  harness.scope.stop();
});

test('Tab completes into a directory and Enter references it', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_directory' });
  harness.setEditor('see @comp');
  harness.pane.evaluate();
  runTimers(harness);
  await flush();
  harness.calls[0].resolve([{ path: 'src/components/', name: 'components/' }]);
  await flush();
  harness.pane.onKeydown({ key: 'Tab', preventDefault() {} });
  await flush();
  assert.equal(harness.pane.getDraft().text, 'see @src/components/', 'Tab completes the path without ending the mention');
  assert.equal(harness.pane.menuOpen.value, true, 'the menu stays open on the directory');
  runTimers(harness);
  await flush();
  assert.equal(harness.calls[1]?.args.query, 'src/components/');
  harness.calls[1].resolve([{ path: 'src/components/button.ts', name: 'button.ts' }]);
  await flush();
  harness.pane.onKeydown({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(harness.pane.getDraft().text, 'see @src/components/button.ts ');
  harness.pane.submit();
  assert.deepEqual(harness.emitted[0].payload.references.map(reference => reference.path), ['src/components/button.ts'], 'the completed-through directory is not sent');

  harness.setEditor('and @comp');
  harness.pane.evaluate();
  runTimers(harness);
  await flush();
  harness.calls[2].resolve([{ path: 'src/components/', name: 'components/' }]);
  await flush();
  harness.pane.onKeydown({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(harness.pane.getDraft().text, 'and @src/components/ ', 'Enter references the directory');
  assert.equal(harness.pane.menuOpen.value, false);
  harness.scope.stop();
});

test('fresh results reset a selection made on the previous rows', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_index_reset' });
  harness.setEditor('@a');
  harness.pane.evaluate();
  runTimers(harness);
  await flush();
  harness.calls[0].resolve([{ path: 'a.ts', name: 'a.ts' }, { path: 'ab.ts', name: 'ab.ts' }, { path: 'abc.ts', name: 'abc.ts' }]);
  await flush();
  harness.setEditor('@abc');
  harness.pane.evaluate();
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(harness.pane.menuIndex.value, 2);
  runTimers(harness);
  await flush();
  harness.calls[1].resolve([{ path: 'abc.ts', name: 'abc.ts' }]);
  await flush();
  assert.equal(harness.pane.menuIndex.value, 0);
  harness.pane.onKeydown({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(harness.pane.getDraft().text, '@abc.ts ');
  harness.scope.stop();
});

test('agents lead the @ menu, match by title, and glow only while highlighted', async () => {
  composer.clearDrafts();
  composer.mentionPreview.value = null;
  const agents = [mentionAgent('process_2', 'Review: PR #16'), mentionAgent('process_3', 'Fix login bug'), mentionAgent('process_4', 'Claude Code')];
  const harness = createHarness({ processId: 'composer_agents', agents });
  assert.match(harness.pane.placeholder.value, /type @ for agents and files/);
  harness.setEditor('@');
  harness.pane.evaluate();
  await flush();
  assert.deepEqual(harness.pane.agentMatches.value.map(agent => agent.processId), ['process_2', 'process_3', 'process_4'], 'a bare @ lists every agent in order');
  assert.equal(composer.mentionPreview.value, 'session_process_2', 'the highlighted first row glows');
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  await flush();
  assert.equal(composer.mentionPreview.value, 'session_process_3', 'the glow follows the highlight');

  harness.setEditor('@LOG');
  harness.pane.evaluate();
  assert.deepEqual(harness.pane.agentMatches.value.map(agent => agent.processId), ['process_3'], 'titles match case-insensitively at word boundaries');
  runTimers(harness);
  await flush();
  harness.calls[0].resolve([{ path: 'src/login.ts', name: 'login.ts' }, { path: 'src/logout.ts', name: 'logout.ts' }]);
  await flush();
  assert.equal(harness.pane.menuIndex.value, 0, 'file results keep the highlighted agent');
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  await flush();
  assert.equal(composer.mentionPreview.value, null, 'a file row has no glow');
  harness.pane.onKeydown({ key: 'ArrowUp', preventDefault() {} });
  await flush();
  assert.equal(composer.mentionPreview.value, 'session_process_3');
  harness.pane.onKeydown({ key: 'Escape', preventDefault() {} });
  await flush();
  assert.equal(composer.mentionPreview.value, null, 'closing the menu clears the glow');

  harness.setEditor('@zzz');
  harness.pane.evaluate();
  await flush();
  assert.deepEqual(harness.pane.agentMatches.value, []);
  assert.equal(composer.mentionPreview.value, null);
  harness.lifecycle.beforeUnmount.forEach(callback => callback());
  harness.scope.stop();
});

test('fresh file results move a stale file selection to the first file, past the agents', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_agent_files', agents: [mentionAgent('process_5', 'Settings page')] });
  harness.setEditor('@s');
  harness.pane.evaluate();
  runTimers(harness);
  await flush();
  harness.calls[0].resolve([{ path: 'src/a.ts', name: 'a.ts' }, { path: 'src/b.ts', name: 'b.ts' }]);
  await flush();
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(harness.pane.menuIndex.value, 2);
  harness.setEditor('@se');
  harness.pane.evaluate();
  assert.equal(harness.pane.menuIndex.value, 0, 'a new query highlights the first agent');
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  runTimers(harness);
  await flush();
  harness.calls[1].resolve([{ path: 'src/settings.ts', name: 'settings.ts' }]);
  await flush();
  assert.equal(harness.pane.menuIndex.value, 1, 'the first fresh file replaces the stale one');
  harness.pane.onKeydown({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(harness.pane.getDraft().text, '@src/settings.ts ');
  harness.scope.stop();
});

test('a picked agent becomes a chip and is sent as its process ID', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_agent_send', agents: [mentionAgent('process_7', 'Fix login bug')] });
  const editor = harness.setEditor('ask @fix');
  harness.pane.evaluate();
  assert.equal(harness.pane.searching.value, true);
  harness.pane.onKeydown({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(harness.pane.getDraft().text, `ask ${CHIP} `, 'Enter swaps the mention for a chip without waiting for files');
  assert.deepEqual(harness.pane.getDraft().chips, [{ kind: 'agent', token: 'process_7', name: 'Fix login bug', harness: 'claude' }]);
  assert.equal(harness.pane.menuOpen.value, false);
  assert.equal(harness.timers.size, 0, 'the pending file search is dropped');
  assert.deepEqual(harness.pane.getDraft().references, [], 'an agent is not a file reference');
  assert.equal(editor.getSelection().start, 6, 'the caret follows the chip and its space');

  editor.replace(6, 6, '@');
  assert.equal(harness.pane.menuOpen.value, true, 'a mention after the chip opens the menu');
  editor.replace(6, 7, 'to check the logs.');
  harness.pane.submit();
  assert.equal(harness.emitted[0].payload.text, 'ask process_7 to check the logs.');
  assert.deepEqual(harness.emitted[0].payload.references, []);

  editor.replace(4, 5, 'Fix login bug');
  assert.deepEqual(harness.pane.getDraft().chips, [], 'deleting the chip drops the mention');
  harness.pane.submit();
  assert.equal(harness.emitted[1].payload.text, 'ask Fix login bug to check the logs.');

  editor.replace(0, harness.pane.getDraft().text.length, { kind: 'agent', token: 'process_7', name: 'Fix login bug', harness: 'claude' });
  editor.replace(2, 2, 'please review.');
  const prepared = composer.payloadFor('composer_agent_send');
  assert.equal(prepared.ok && prepared.payload.text, 'process_7 please review.');
  composer.completeSend('composer_agent_send', { ...prepared.payload, hash: prepared.hash });
  assert.equal(composer.draftFor('composer_agent_send').text, '', 'a delivered draft empties');
  assert.deepEqual(composer.draftFor('composer_agent_send').chips, []);
  await flush();
  assert.equal(editor.getText(), '', 'the editor follows the emptied draft');
  harness.scope.stop();
});

test('processes follow the agents, keep their host, and are sent as process IDs', async () => {
  composer.clearDrafts();
  const shell = (id, host) => ({ process: { id, name: 'shell', status: 'running', activity: 'idle', ptyProcessId: `pty_${id}`, ...(host ? { host } : {}) }, processId: id, name: 'shell', owner: null });
  const launchers = [{ kind: 'harness', name: 'Codex', harness: 'codex', token: '[patterm_harness:codex]' }];
  const harness = createHarness({ processId: 'composer_process', agents: [mentionAgent('process_7', 'Shell fixer')], processes: [shell('process_9'), shell('beta:process_4', 'beta')], launchers });
  const editor = harness.setEditor('tail @sh');
  harness.pane.evaluate();
  assert.deepEqual(harness.pane.menuItems.value.slice(0, 3).map((item) => item.kind === 'agent' ? item.agent.processId : item.process.processId), ['process_7', 'process_9', 'beta:process_4'], 'processes sit between agents and launchers');
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  harness.pane.onKeydown({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.deepEqual(harness.pane.getDraft().chips, [{ kind: 'process', token: 'beta:process_4', name: 'shell', harness: null, host: 'beta' }], 'a remote process chip keeps its host');
  editor.replace(7, 7, 'and @sh');
  harness.pane.chooseProcess(harness.pane.processMatches.value[0]);
  harness.pane.submit();
  assert.equal(harness.emitted[0].payload.text, 'tail beta:process_4 and process_9');
  harness.scope.stop();
});

test('presets and harnesses follow the agents and are sent as launch tokens', async () => {
  composer.clearDrafts();
  const launchers = [
    { kind: 'preset', name: 'Smartypants', harness: 'claude', token: '[patterm_preset:Smartypants]' },
    { kind: 'harness', name: 'Codex', harness: 'codex', token: '[patterm_harness:codex]' }
  ];
  const harness = createHarness({ processId: 'composer_launch', agents: [mentionAgent('process_7', 'Smart search')], launchers });
  assert.match(harness.pane.placeholder.value, /type @ for agents and files/);
  const editor = harness.setEditor('ask @smart');
  harness.pane.evaluate();
  assert.deepEqual(harness.pane.launcherMatches.value.map(launcher => launcher.name), ['Smartypants'], 'launchers match the mention by name');
  harness.pane.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  harness.pane.onKeydown({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.deepEqual(harness.pane.getDraft().chips, [{ kind: 'preset', token: '[patterm_preset:Smartypants]', name: 'Smartypants', harness: 'claude' }], 'Enter on a launcher swaps the mention for its chip without waiting for files');
  assert.equal(harness.timers.size, 0, 'the pending file search is dropped');
  editor.replace(6, 6, 'to review this, and @co');
  assert.deepEqual(harness.pane.launcherMatches.value.map(launcher => launcher.name), ['Codex']);
  harness.pane.chooseLauncher(launchers[1]);
  harness.pane.submit();
  assert.equal(harness.emitted[0].payload.text, `ask [patterm_preset:Smartypants] to review this, and [patterm_harness:codex]`);
  harness.scope.stop();
});

test('a chosen command replaces the draft and its chips', async () => {
  composer.clearDrafts();
  const harness = createHarness({ processId: 'composer_agent_command', agents: [mentionAgent('process_7', 'Fix login bug')] });
  const editor = harness.pane.editor.value;
  editor.replace(0, 0, { kind: 'agent', token: 'process_7', name: 'Fix login bug', harness: 'claude' });
  harness.pane.chooseCommand({ name: 'compact' });
  await flush();
  assert.equal(editor.getText(), '/compact ');
  assert.deepEqual(harness.pane.getDraft().chips, []);
  harness.scope.stop();
});

test('chips are sent as process IDs in order', () => {
  const chips = [{ kind: 'agent', token: 'process_7', name: 'Claude Code', harness: 'claude' }, { kind: 'agent', token: 'process_8', name: 'Claude Code', harness: 'claude' }];
  assert.equal(composer.outgoingText({ text: `pair ${CHIP} with ${CHIP}.`, chips }), 'pair process_7 with process_8.', 'agents that share a title stay distinct');
  assert.equal(composer.outgoingText({ text: `${CHIP} and ${CHIP}`, chips: chips.slice(0, 1) }), 'process_7 and', 'a chip character without a chip is dropped');
  assert.equal(composer.outgoingText({ text: '  plain  ', chips: [] }), 'plain');
});

test('the composer document maps text offsets to editor positions', () => {
  const chip = { kind: 'agent', token: 'process_7', name: 'Fix', harness: 'claude' };
  const other = { kind: 'agent', token: 'process_8', name: 'Review', harness: null };
  const lines = composerDocument.composerLines(`ask ${CHIP} now\n\n${CHIP}${CHIP}`, [chip, other]);
  assert.deepEqual(lines, [[{ text: 'ask ' }, { chip }, { text: ' now' }], [], [{ chip: other }]], 'a chip without a match is dropped');
  assert.equal(composerDocument.composerText(lines), `ask ${CHIP} now\n\n${CHIP}`);
  assert.deepEqual(composerDocument.composerChips(lines), [chip, other]);
  assert.equal(composerDocument.composerText([[{ text: `a${CHIP}b` }]]), 'ab', 'typed chip characters are not chips');

  // "ab\ncd": paragraph one holds positions 1–3, paragraph two 5–7.
  const text = 'ab\ncd';
  assert.deepEqual([0, 2, 3, 5].map(offset => composerDocument.textOffsetToPosition(text, offset)), [1, 3, 5, 7]);
  assert.deepEqual([0, 1, 3, 4, 5, 7].map(position => composerDocument.positionToTextOffset(text, position)), [0, 0, 2, 3, 3, 5]);
  assert.equal(composerDocument.textOffsetToPosition(text, 99), 7, 'offsets past the end clamp');
  assert.equal(composerDocument.positionToTextOffset('', 1), 0);
  for (let offset = 0; offset <= 8; offset++) {
    const sample = `x${CHIP}y\n\nz`;
    if (offset > sample.length) break;
    assert.equal(composerDocument.positionToTextOffset(sample, composerDocument.textOffsetToPosition(sample, offset)), offset, `offset ${offset} round-trips`);
  }
});

test('optimistic image previews survive acceptance and are released after native reconciliation', () => {
  composer.clearDrafts();
  const revoked = [];
  const previousRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    const draft = composer.draftFor('preview_lifetime');
    draft.attachments.push({ id: 'image', name: 'example.png', mime: 'image/png', size: 100, image: true, status: 'ready', serverPath: '/uploads/image', previewUrl: 'blob:optimistic-test' });
    const prepared = composer.payloadFor('preview_lifetime');
    composer.beginOutgoingMessage('preview_lifetime', { ...prepared.payload, hash: prepared.hash }, [], 'claude');
    assert.equal(draft.attachments.length, 0);
    assert.deepEqual(revoked, []);
    const rows = composer.outgoingTranscript('preview_lifetime', [], []);
    assert.equal(rows[0].attachments[0].url, 'blob:optimistic-test');
    composer.completeSend('preview_lifetime', { ...prepared.payload, hash: prepared.hash }, { preserveDraft: true });
    assert.deepEqual(revoked, []);
    composer.reconcileOutgoingMessages('preview_lifetime', [{ id: `user_${prepared.payload.messageId}`, role: 'user', kind: 'text', text: '' }], []);
    assert.deepEqual(revoked, ['blob:optimistic-test']);
    assert.equal(composer.outgoingFor('preview_lifetime').length, 0);
  } finally {
    URL.revokeObjectURL = previousRevoke;
  }
});

test('provider rows and native queues replace optimistic rows by identity', () => {
  for (const provider of ['claude', 'opencode']) {
    composer.clearDrafts();
    composer.draftFor(provider).text = 'hello';
    const prepared = composer.payloadFor(provider);
    composer.beginOutgoingMessage(provider, { ...prepared.payload, hash: prepared.hash }, [], provider);
    const id = `${provider === 'opencode' ? 'msg_' : 'user_'}${prepared.payload.messageId}`;
    const native = { id, role: 'user', kind: 'text', text: 'hello' };
    assert.deepEqual(composer.outgoingTranscript(provider, [native], []), [native]);
    if (provider === 'opencode') {
      const queue = [{ id, text: 'hello', delivery: 'queue' }];
      const waiting = composer.outgoingTranscript(provider, [native], queue);
      assert.equal(waiting.length, 1, 'a natively queued prompt shows once, as a message');
      assert.deepEqual([waiting[0].id, waiting[0].text, waiting[0].delivery.state], [id, 'hello', 'queued']);
      const assistant = { id: 'reply', role: 'assistant', kind: 'text', text: 'working' };
      assert.deepEqual(composer.outgoingTranscript(provider, [assistant], queue).map((row) => row.id), ['reply', id], 'it follows the running turn');
      composer.reconcileOutgoingMessages(provider, [], queue);
      assert.equal(composer.outgoingTranscript(provider, [], []).length, 1, 'leaving the queue cannot hide the message before its native row arrives');
      composer.reconcileOutgoingMessages(provider, [native], []);
    } else composer.reconcileOutgoingMessages(provider, [native], []);
    assert.equal(composer.outgoingFor(provider).length, 0);
    assert.equal(composer.submissionFor(provider), undefined);
  }
});

test('a send behind a natively queued message stays after it', () => {
  composer.clearDrafts();
  const reply = { id: 'reply', role: 'assistant', kind: 'text', text: 'working' };
  const send = (text, transcript) => {
    composer.draftFor('opencode').text = text;
    const prepared = composer.payloadFor('opencode');
    composer.beginOutgoingMessage('opencode', { ...prepared.payload, hash: prepared.hash }, transcript, 'opencode');
    composer.completeSend('opencode', { ...prepared.payload, hash: prepared.hash }, { preserveDraft: true });
    return `msg_${prepared.payload.messageId}`;
  };
  const first = send('first', [reply]);
  const queue = [{ id: first, text: 'first', delivery: 'queue' }];
  const second = send('second', composer.outgoingTranscript('opencode', [reply], queue));
  assert.deepEqual(composer.outgoingTranscript('opencode', [reply], queue).map((row) => row.id), ['reply', first, second]);
  queue.push({ id: second, text: 'second', delivery: 'queue' });
  assert.deepEqual(composer.outgoingTranscript('opencode', [reply], queue).map((row) => row.id), ['reply', first, second]);
});

test('a queued message keeps its native attachments once the local copy is released', () => {
  composer.clearDrafts();
  const native = { id: 'msg_1', role: 'user', kind: 'text', text: '', attachments: [{ name: 'shot.png', mime: 'image/png', sha256: 'abc' }] };
  const [row] = composer.outgoingTranscript('opencode', [native], [{ id: 'msg_1', text: '', delivery: 'queue' }]);
  assert.deepEqual(row.attachments, native.attachments);
  assert.equal(row.delivery.state, 'queued');
});

test('a message Patterm holds during compaction shows only in the queue', () => {
  composer.clearDrafts();
  composer.draftFor('codex').text = 'recap please';
  const prepared = composer.payloadFor('codex');
  composer.beginOutgoingMessage('codex', { ...prepared.payload, hash: prepared.hash }, [], 'codex');
  // Held queue items carry the client message id, not the provider row id.
  const queue = [{ id: prepared.payload.messageId, text: 'recap please', delivery: 'held', reason: 'compact' }];
  assert.deepEqual(composer.outgoingTranscript('codex', [], queue), []);
  composer.reconcileOutgoingMessages('codex', [], queue);
  assert.equal(composer.submissionFor('codex'), undefined, 'a held message no longer blocks the composer');
  const native = { id: 'item_1', clientMessageId: prepared.payload.messageId, role: 'user', kind: 'text', text: 'recap please' };
  composer.reconcileOutgoingMessages('codex', [native], []);
  assert.equal(composer.outgoingFor('codex').length, 0);
});

test('a cancelled held message leaves no sent-looking copy behind', () => {
  composer.clearDrafts();
  composer.draftFor('codex').text = 'never mind';
  const prepared = composer.payloadFor('codex');
  composer.beginOutgoingMessage('codex', { ...prepared.payload, hash: prepared.hash }, [], 'codex');
  const queue = [{ id: prepared.payload.messageId, text: 'never mind', delivery: 'held', reason: 'compact' }];
  composer.reconcileOutgoingMessages('codex', [], queue);
  composer.reconcileOutgoingMessages('codex', [], []);
  assert.equal(composer.outgoingTranscript('codex', [], []).length, 1, 'without a cancel the local copy waits for its native row');
  composer.discardOutgoingMessage('codex', prepared.payload.messageId);
  assert.deepEqual(composer.outgoingTranscript('codex', [], []), []);
});


test('a dead session accepts recovery commands without attachments or a native prompt', async () => {
  composer.clearDrafts();
  const h = createHarness({ processId: 'dead_composer' });
  h.props.ended = true;
  h.props.restartable = true;
  h.setEditor('/restart');
  assert.equal(h.pane.canSend.value, true);
  h.pane.submit();
  assert.equal(h.emitted.at(-1)?.event, 'send');
  h.props.pending = true;
  assert.equal(h.pane.canSend.value, false, 'a restart in flight cannot be submitted twice');
  h.props.pending = false;
  h.setEditor('/resume');
  assert.equal(h.pane.canSend.value, true, 'the history picker is available for recovery');
  h.setEditor('carry on');
  assert.equal(h.pane.canSend.value, false);
  h.setEditor('/restart extra');
  assert.equal(h.pane.canSend.value, false);
  h.setEditor('/restart');
  h.props.controlling = false;
  assert.equal(h.pane.canSend.value, false, 'restart requires browser control');
  h.pane.chooseCommand({ name: 'restart', source: 'patterm' });
  assert.equal(h.emitted.filter(item => item.event === 'command').length, 0);
  h.props.controlling = true;
  h.props.restartable = false;
  assert.equal(h.pane.canSend.value, false, 'a closed session cannot restart');
  h.scope.stop();
});
