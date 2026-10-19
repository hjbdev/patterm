import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';

// Run the component's actual handlers and watchers with a harmless window.close.
function transpile(source) {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
const library = {};
new Function('exports', transpile(fs.readFileSync(new URL('../resources/js/lib/commandPalette.ts', import.meta.url), 'utf8')))(library);
const timers = {};
new Function('exports', transpile(fs.readFileSync(new URL('../resources/js/lib/timers.ts', import.meta.url), 'utf8')))(timers);
const page = fs.readFileSync(new URL('../resources/js/Components/CommandPalette.vue', import.meta.url), 'utf8');
const source = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('palette.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getFullText(parsed)).join('\n');
const dependencies = { computed, nextTick, reactive, ref, watch, ...library, useId: () => 'palette', useWorkbench: () => ({ revision: ref(0), projects: ref([]) }), onMounted: () => {}, onBeforeUnmount: () => {}, defineEmits: () => () => {}, agentLabel: session => session.displayName, publishedIntegratedControls: () => null, sendWorkspaceRequest: () => false, toast: { success: () => {}, error: () => {} },
  harnessLabel: id => id, showSnoozed: ref(false), setShowSnoozed: () => {}, launchParams: () => ({}), launchSummary: () => '', presetLabel: () => '', worktreeLabel: () => '', interfaceLabel: () => '', resumeInPlace: rows => rows,
  displayPath: path => path, sessionStatusIcon: () => ({ label: 'Idle' }), processStatusIcon: () => ({ label: 'Exited' }), Sparkles: {}, Brain: {}, ShieldCheck: {}, Zap: {}, ...timers,
  usePaletteSources: () => {
    const empty = computed(() => []);
    return { launch: reactive({ harness: '', presetId: null, worktreeId: null, interfaceMode: 'integrated', prompt: '' }), launchHarnesses: empty, launchPresets: empty, launchWorktrees: empty, chooseHarness: () => {}, rememberHarness: () => {}, conversationCommands: empty, timers: empty, timerCommands: empty, searchCommands: empty, searching: ref(false), now: ref(0) };
  } };
const setup = new Function(...Object.keys(dependencies), 'defineProps', 'defineModel', 'window', `${transpile(executable)}\nreturn { open, query, highlighted, visibleRows, runHighlighted, runCommand, handleEscape, handleEscapeKey, reloadCommands, page, error };`);
const quit = { id: 'renderer:quit', label: 'Quit', hint: 'close Patterm Desktop', confirmation: 'This stops running agents, commands, and timers.', group: 'quit', kind: 'renderer' };

async function mount(t, { listed = [quit], query = 'quit', runs = [], timerSets = [] } = {}) {
  let closes = 0;
  const scope = effectScope();
  t.after(() => scope.stop());
  const palette = scope.run(() => setup(...Object.values(dependencies),
    () => ({ context: { active_project_id: null, active_terminal_id: null, active_tab: null } }), () => ref(false),
    { close: () => closes++, patterm: { commandsList: async () => ({ commands: listed }), commandsRun: async payload => { runs.push(payload); return payload.id === quit.id ? { rendererAction: 'quit' } : { refresh: true }; }, timerSet: async payload => { timerSets.push(payload); } } }));
  palette.open.value = true;
  await palette.reloadCommands();
  await nextTick();
  palette.query.value = query;
  await nextTick();
  return { palette, closes: () => closes };
}

async function enter(palette, extra = {}) {
  palette.runHighlighted({ repeat: false, isComposing: false, ...extra });
  for (let i = 0; i < 5; i++) await nextTick();
}

test('Empty Quit runs on the first Enter', async t => {
  const { confirmation, ...emptyQuit } = quit;
  const { palette, closes } = await mount(t, { listed: [emptyQuit] });
  await enter(palette);
  assert.equal(closes(), 1);
});

test('Quit with running work requires two distinct Enter presses and ignores key repeat and composition', async t => {
  const { palette, closes } = await mount(t);
  await enter(palette, { isComposing: true });
  await enter(palette);
  assert.equal(closes(), 0, 'First Enter must only arm confirmation');
  assert.equal(palette.open.value, true);
  await enter(palette, { repeat: true });
  assert.equal(closes(), 0, 'Holding Enter must not confirm');
  await enter(palette);
  assert.equal(closes(), 1);
});

for (const reset of ['query', 'selection', 'escape', 'reopen']) {
  test(`${reset} cancels pending Quit confirmation`, async t => {
    const { palette, closes } = await mount(t);
    await enter(palette);
    assert.equal(closes(), 0);
    if (reset === 'query') { palette.query.value = 'qu'; palette.query.value = 'quit'; }
    if (reset === 'selection') { palette.highlighted.value = 1; palette.highlighted.value = 0; }
    if (reset === 'escape') {
      let prevented = false;
      palette.handleEscape({ preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true);
    }
    if (reset === 'reopen') {
      palette.open.value = false;
      await nextTick();
      palette.open.value = true;
      await nextTick();
      palette.query.value = 'quit';
    }
    await nextTick();
    await enter(palette);
    assert.equal(closes(), 0, 'Reset must require a fresh confirmation');
    await enter(palette);
    assert.equal(closes(), 1);
  });
}

test('Clicking Quit also requires confirmation', async t => {
  const { palette, closes } = await mount(t);
  await palette.runCommand(quit);
  assert.equal(closes(), 0);
  await palette.runCommand(quit);
  assert.equal(closes(), 1);
});

test('Closing an agent with running subagents asks first and then confirms', async t => {
  const close = { id: 'process:close:agent', label: 'Close agent', confirmation: 'Closing Root also closes 1 subagent: Child.', confirmVerb: 'close all of them', group: 'current', kind: 'backend' };
  const runs = [];
  const { palette } = await mount(t, { listed: [close], query: 'close agent', runs });
  assert.equal(palette.visibleRows.value[0]?.command.id, close.id);
  await enter(palette);
  assert.deepEqual(runs, [], 'First Enter must only arm confirmation');
  await enter(palette);
  assert.deepEqual(runs.map(run => [run.id, run.input]), [[close.id, { confirmed: true }]]);
  assert.equal(palette.open.value, false);
});

test('Escape goes back a level from a page, and only closes from the top', async t => {
  const actions = { id: 'navigate:agent:p:a', label: 'Child', group: 'agent', kind: 'navigate', actions: [{ id: 'process:close:a', label: 'Close agent', group: 'agent', kind: 'backend' }] };
  const { palette } = await mount(t, { listed: [actions], query: 'child' });
  await palette.runCommand({ id: 'page:a', label: 'Child', group: 'agent', kind: 'page', actions: actions.actions });
  assert.equal(palette.page.value?.title, 'Child');
  let stopped = false;
  let prevented = false;
  palette.handleEscapeKey({ isComposing: false, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  assert.equal(palette.page.value, null, 'Escape leaves the page');
  assert.ok(prevented && stopped, 'the dialog never sees an Escape that went back');
  assert.equal(palette.query.value, 'child', 'the list keeps its search');
  prevented = false;
  stopped = false;
  palette.handleEscapeKey({ isComposing: false, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  assert.ok(!prevented && !stopped, 'at the top, Escape is left for the dialog to close');
});

test('A workbench update with the same target keeps the open page', async t => {
  const props = reactive({ context: { active_project_id: null, active_terminal_id: null, active_tab: null, active_session_id: 's' } });
  const scope = effectScope();
  t.after(() => scope.stop());
  const palette = scope.run(() => setup(...Object.values(dependencies), () => props, () => ref(false),
    { close: () => {}, patterm: { commandsList: async () => ({ commands: [] }), commandsRun: async () => ({}) } }));
  palette.open.value = true;
  await nextTick();
  await palette.runCommand({ id: 'page:a', label: 'Child', group: 'agent', kind: 'page', actions: [{ id: 'x', label: 'X', group: 'agent', kind: 'backend' }] });
  // Workbench updates hand the palette a new context object with the same values.
  props.context = { ...props.context };
  await nextTick();
  assert.equal(palette.page.value?.title, 'Child');
  props.context = { ...props.context, active_session_id: 'other' };
  await nextTick();
  assert.equal(palette.page.value, null, 'a different agent resets the palette');
});

test('Renaming takes the name in the palette input, and Escape returns to the list', async t => {
  const rename = { id: 'process:rename:a', label: 'Rename agent…', group: 'current', kind: 'backend', input: { type: 'text', title: 'Rename agent', placeholder: 'Agent name', value: 'Old name' } };
  const runs = [];
  const { palette } = await mount(t, { listed: [rename], query: 'rename', runs });
  await enter(palette);
  assert.equal(palette.page.value?.title, 'Rename agent');
  assert.equal(palette.query.value, 'Old name', 'the input starts from the current name');
  palette.query.value = '';
  await enter(palette);
  assert.deepEqual(runs, [], 'an empty name is not sent');
  assert.equal(palette.error.value, 'Type a name.');
  palette.handleEscapeKey({ isComposing: false, preventDefault: () => {}, stopPropagation: () => {} });
  assert.equal(palette.page.value, null);
  assert.equal(palette.query.value, 'rename', 'the list keeps its search');
  await enter(palette);
  palette.query.value = 'New name';
  assert.equal(palette.visibleRows.value[0]?.command.label, 'Rename to “New name”');
  await enter(palette);
  assert.deepEqual(runs.map(run => [run.id, run.input]), [[rename.id, { name: 'New name' }]]);
  assert.equal(palette.open.value, false);
});

test('A timer reads its duration first, and the words after it are its message', async t => {
  const timer = { id: 'timer:set:a', label: 'Set timer…', group: 'current', kind: 'backend', input: { type: 'timer-form', title: 'Set timer' } };
  const timerSets = [];
  const { palette } = await mount(t, { listed: [timer], query: 'set timer', timerSets });
  await enter(palette);
  assert.deepEqual(palette.visibleRows.value.map(row => row.command.label), ['30 seconds', '1 minute', '5 minutes', '15 minutes', '1 hour']);
  palette.query.value = 'soon';
  assert.equal(palette.visibleRows.value[0]?.command.hint, 'Start with a duration, like 10m');
  palette.query.value = '10m check the build';
  assert.equal(palette.visibleRows.value[0]?.command.label, 'Set timer for 10 minutes');
  await enter(palette);
  assert.deepEqual(timerSets, [{ owner_process_id: 'a', seconds: 600, label: 'check the build', body: 'check the build' }]);
});

test('A list of choices opens on the current one', async t => {
  const { palette } = await mount(t, { listed: [], query: '' });
  await palette.runCommand({ id: 'page:model', label: 'Model', group: 'current', kind: 'page', actions: [
    { id: 'pick:a', label: 'Opus', group: 'current', kind: 'renderer' },
    { id: 'pick:b', label: 'Sonnet', current: true, group: 'current', kind: 'renderer' }
  ] });
  assert.equal(palette.visibleRows.value[palette.highlighted.value]?.command.id, 'pick:b');
});
