import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import * as vue from 'vue';

// Exercise the actual record composable and its Vue watchers, with controlled
// network responses and browser storage. No application implementation is copied here.
const source = fs.readFileSync(new URL('../resources/js/Composables/useContextRecord.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
});
const load = new Function('exports', 'require', 'sessionStorage', 'setTimeout', 'clearTimeout', 'window', outputText);

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

function todo(id = 'a') {
  return { id, title: id, notes: 'original', status: 'open', priority: 'medium', revision: 1, assignments: [], blockers: [], blocked: false, lease: null };
}

function note(id = 'a') {
  return { id, title: id, body: 'original', status: 'active', revision: 1 };
}

async function flush() {
  for (let i = 0; i < 10; i++) await vue.nextTick();
}

// One loaded copy of the composable module. Editors mounted from the same copy
// share its module state, like components in one page.
function loadModule(call, tabStorage, read = call) {
  const timers = new Map();
  let nextTimer = 0;
  const module = { cleanup: [], timers };
  const modules = {
    vue: { ...vue, onBeforeUnmount: callback => module.cleanup.push(callback) },
    // Cached reads go straight to the controlled network here.
    '../lib/projectContext': { contextCall: call, contextRead: read },
    './useWorkbenchNavigation': { useWorkbenchNavigation: () => ({ activeProject: vue.ref(null) }) }
  };
  module.exports = {};
  load(module.exports, name => modules[name], tabStorage,
    callback => { timers.set(++nextTimer, callback); return nextTimer; }, id => timers.delete(id), {});
  return module;
}

function mount(t, call, tabStorage = storage(), kind = 'todos', module = loadModule(call, tabStorage)) {
  const projectId = vue.ref('p'), recordId = vue.ref('a');
  const scope = vue.effectScope();
  const cleanup = module.cleanup = [];
  const editor = scope.run(() => module.exports.useContextRecord(vue.ref(kind === 'todos' ? 'todo' : 'scratchpad'), projectId, recordId));
  let mounted = true;
  const unmount = () => { if (!mounted) return; mounted = false; cleanup.splice(0).forEach(callback => callback()); scope.stop(); };
  t.after(unmount);
  return { editor, projectId, recordId, unmount, tabStorage, timers: module.timers, module };
}

for (const kind of ['todos', 'scratchpads']) {
  test(`${kind}: one tab's successful save cannot remove another tab's conflicting draft`, async t => {
    let saved = kind === 'todos' ? todo() : note();
    const pending = [];
    const call = async (name, project, args) => {
      if (name.endsWith('_get')) return { ...saved };
      if (name.endsWith('_list')) return { items: [], total: 0 };
      if (name.endsWith('_update')) return new Promise((resolve, reject) => pending.push({ args, resolve, reject }));
      throw new Error(`Unexpected call ${name}`);
    };
    const a = mount(t, call, storage(), kind);
    const b = mount(t, call, storage(), kind);
    await flush();
    a.editor.body.value = 'tab A draft';
    const saveA = a.editor.save();
    b.editor.body.value = 'tab B draft';
    const saveB = b.editor.save();
    saved = { ...saved, ...pending[0].args, revision: 2 };
    pending[0].resolve({ ...saved });
    await saveA;
    pending[1].reject(new Error('Revision conflict'));
    await saveB;
    assert.match(b.editor.saveError.value, /Revision conflict/);
    b.unmount();
    const reloaded = mount(t, call, b.tabStorage, kind);
    await flush();
    assert.equal(reloaded.editor.body.value, 'tab B draft');
    assert.equal(reloaded.editor.record.value.revision, 1, 'Recovery must retain the original revision guard');
    assert.equal(reloaded.editor.dirty.value, true);
  });
}

for (const kind of ['todos', 'scratchpads']) {
  test(`${kind}: a refresh that returns after an edit leaves the edit in place`, async t => {
    const saved = kind === 'todos' ? todo() : note();
    let finishRefresh;
    let gets = 0;
    const call = async (name) => {
      if (name.endsWith('_get')) return ++gets === 1 ? { ...saved } : new Promise(resolve => { finishRefresh = () => resolve({ ...saved }); });
      if (name.endsWith('_list')) return { items: [], total: 0 };
      throw new Error(`Unexpected call ${name}`);
    };
    const tab = mount(t, call, storage(), kind);
    await flush();
    tab.editor.refresh();
    await flush();
    tab.editor.body.value = 'typed during refresh';
    finishRefresh();
    await flush();
    assert.equal(tab.editor.body.value, 'typed during refresh');
    assert.equal(tab.editor.dirty.value, true);
    assert.equal(tab.editor.saveError.value, '', 'A live edit must not read as a recovered draft');
    assert.equal(tab.timers.size, 1, 'The edit must still be scheduled to save');
  });

  test(`${kind}: leaving a record saves its pending edits and clears the draft`, async t => {
    const updates = [];
    const call = async (name, project, args) => {
      if (name.endsWith('_get')) return kind === 'todos' ? todo(args.todo_id) : note(args.scratchpad_id);
      if (name.endsWith('_list')) return { items: [], total: 0 };
      if (name.endsWith('_update')) {
        updates.push(args);
        return { ...(kind === 'todos' ? todo() : note()), ...args, revision: 2 };
      }
      throw new Error(`Unexpected call ${name}`);
    };
    const tab = mount(t, call, storage(), kind);
    await flush();
    tab.editor.body.value = 'edited before leaving';
    const key = `patterm.context.draft.p.${kind === 'todos' ? 'todo' : 'scratchpad'}.a`;
    assert.notEqual(tab.tabStorage.getItem(key), null);
    tab.recordId.value = 'b';
    await flush();
    assert.equal(updates.length, 1);
    assert.equal(updates[0][kind === 'todos' ? 'todo_id' : 'scratchpad_id'], 'a');
    assert.equal(updates[0][kind === 'todos' ? 'notes' : 'body'], 'edited before leaving');
    assert.equal(tab.tabStorage.getItem(key), null);
    assert.equal(tab.editor.record.value.id, 'b');
  });
}

for (const kind of ['todos', 'scratchpads']) {
  const idKey = kind === 'todos' ? 'todo_id' : 'scratchpad_id';
  const fresh = (id = 'a') => kind === 'todos' ? todo(id) : note(id);
  const contentOf = record => kind === 'todos' ? record.notes : record.body;

  test(`${kind}: a closed editor does not retry its failed save`, async t => {
    const pending = [];
    const call = async (name, project, args) => {
      if (name.endsWith('_get')) return fresh(args[idKey]);
      if (name.endsWith('_list')) return { items: [], total: 0 };
      if (name.endsWith('_update')) return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      throw new Error(`Unexpected call ${name}`);
    };
    const tabStorage = storage();
    const first = mount(t, call, tabStorage, kind);
    await flush();
    first.editor.body.value = 'text A';
    first.unmount();
    assert.equal(pending.length, 1, 'Closing the editor saves its pending edit');
    pending[0].reject(new Error('Connection lost'));
    await flush();
    assert.equal(first.timers.size, 0, 'A closed editor must not schedule a retry');
    const reopened = mount(t, call, tabStorage, kind, first.module);
    await flush();
    assert.equal(reopened.editor.body.value, 'text A', 'The failed edit is recovered on the next visit');
  });

  for (const reopen of ['same editor', 'new editor']) {
    test(`${kind}: reopening during a leave-save in the ${reopen} shows the saved record`, async t => {
      let finish;
      let saved = fresh();
      const call = async (name, project, args) => {
        if (name.endsWith('_get')) return args[idKey] === 'a' ? { ...saved } : fresh(args[idKey]);
        if (name.endsWith('_list')) return { items: [], total: 0 };
        if (name.endsWith('_update')) return new Promise(resolve => { finish = () => { saved = { ...saved, ...args, revision: 2 }; resolve({ ...saved }); }; });
        throw new Error(`Unexpected call ${name}`);
      };
      const tabStorage = storage();
      const first = mount(t, call, tabStorage, kind);
      await flush();
      first.editor.body.value = 'saved on leave';
      let editor = first.editor;
      if (reopen === 'same editor') {
        first.recordId.value = 'b';
        await flush();
        first.recordId.value = 'a';
      } else {
        first.unmount();
        editor = mount(t, call, tabStorage, kind, first.module).editor;
      }
      await flush();
      finish();
      await flush();
      assert.equal(editor.record.value.revision, 2);
      assert.equal(contentOf(editor.record.value), 'saved on leave');
      assert.equal(editor.body.value, 'saved on leave');
      assert.equal(editor.dirty.value, false);
      assert.equal(editor.saveError.value, '');
    });
  }
}

for (const operation of ['assign', 'dependency_add', 'lease_revoke']) {
  test(`${operation}: changing todo or project while saving cancels the pending operation`, async t => {
    for (const changeProject of [false, true]) {
      let finishSave;
      const mutations = [];
      const call = async (name, project, args) => {
        if (name === 'todo_get') return todo(args.todo_id);
        if (name === 'todo_list') return { items: [], total: 0 };
        if (name === 'todo_update') return new Promise(resolve => { finishSave = () => resolve({ ...todo(), ...args, revision: 2 }); });
        mutations.push({ name, project, args });
        return {};
      };
      const tab = mount(t, call);
      await flush();
      tab.editor.body.value = 'edited a';
      const args = operation === 'assign' ? { assignee_id: 'user' } : operation === 'dependency_add' ? { blocker_id: 'blocker' } : {};
      const pending = tab.editor.relation(operation, args);
      tab.recordId.value = 'b';
      if (changeProject) tab.projectId.value = 'another-project';
      await flush();
      finishSave();
      await pending;
      assert.deepEqual(mutations, [], 'An operation started on A must not execute on the newly selected record');
      tab.unmount();
    }
  });
}

test('assignment still runs on the original todo when navigation does not change', async t => {
  const mutations = [];
  const call = async (name, project, args) => {
    if (name === 'todo_get') return todo(args.todo_id);
    if (name === 'todo_list') return { items: [], total: 0 };
    if (name === 'todo_update') return { ...todo(), ...args, revision: 2 };
    mutations.push({ name, project, args });
    return {};
  };
  const tab = mount(t, call);
  await flush();
  tab.editor.body.value = 'edited a';
  await tab.editor.relation('assign', { assignee_id: 'user' });
  assert.deepEqual(mutations, [{ name: 'todo_assign', project: 'p', args: { todo_id: 'a', assignee_id: 'user' } }]);
});

test('a long note loads every chunk through the cache, and a reload reads them all fresh', async t => {
  const lines = Array.from({ length: 2500 }, (_, index) => `line ${index}`);
  const reply = (args) => ({ id: 'a', title: 'a', status: 'active', revision: 1, total_lines: lines.length,
    body: lines.slice(args.offset ?? 0, (args.offset ?? 0) + args.limit).join('\n') });
  const cached = [], fresh = [];
  const read = async (name, project, args) => { cached.push(args.offset ?? 0); return reply(args); };
  const call = async (name, project, args) => {
    if (name === 'scratchpad_get') { fresh.push(args.offset ?? 0); return reply(args); }
    throw new Error(`Unexpected call ${name}`);
  };
  const tab = mount(t, call, storage(), 'scratchpads', loadModule(call, storage(), read));
  await flush();
  assert.equal(tab.editor.body.value, lines.join('\n'));
  assert.deepEqual(cached, [0, 1000, 2000], 'the first read and both chunks are cached reads');
  assert.deepEqual(fresh, []);
  await tab.editor.reload();
  await flush();
  assert.deepEqual(fresh, [0, 1000, 2000], 'a reload reads the note and its chunks fresh');
  assert.equal(tab.editor.body.value, lines.join('\n'));
});
