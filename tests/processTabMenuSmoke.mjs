import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { computed, ref } from 'vue';

const page = fs.readFileSync(new URL('../resources/js/Components/ProcessTab.vue', import.meta.url), 'utf8');
const source = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('tabs.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getFullText(parsed)).join('\n');
const { outputText } = ts.transpileModule(executable, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const setup = new Function('computed', 'ref', 'defineProps', 'defineEmits', 'withDefaults', 'window', 'navigator', 'toast', 'confirmClose',
  `${outputText}\nreturn { openRenameProcess, submitRename, copyProcessId, closeProcess, renameName, renameOpen, renameError, renameBusy };`);

test('Shell menu actions use the process record ID and report failures', async () => {
  const calls = [];
  const copied = [];
  const errors = [];
  const confirmations = [];
  let failure = false;
  const tabs = setup(computed, ref, () => ({ process: null, active: false }), () => () => {}, props => props,
    { patterm: { call: async (name, args) => { if (failure) throw new Error('Request failed'); calls.push({ name, args }); } } },
    { clipboard: { writeText: async value => { if (failure) throw new Error('Clipboard failed'); copied.push(value); } } },
    { error: message => errors.push(message) },
    (...args) => confirmations.push(args));
  const shell = { id: 'process_shell', ptyProcessId: 'proc_123', name: 'Shell' };
  tabs.openRenameProcess(shell);
  assert.equal(tabs.renameName.value, 'Shell');
  tabs.renameName.value = '   ';
  await tabs.submitRename();
  assert.equal(calls.length, 0, 'Blank names are not submitted');
  tabs.renameName.value = ' Build shell ';
  await tabs.submitRename();
  assert.deepEqual(calls.shift(), { name: 'rename_process', args: { process_id: shell.id, name: 'Build shell' } });
  assert.equal(tabs.renameOpen.value, false);
  await tabs.copyProcessId(shell);
  assert.deepEqual(copied, [shell.id]);
  // Closing asks first; the confirmation dialog makes the call.
  tabs.closeProcess(shell);
  assert.deepEqual(confirmations, [[shell.id, 'Shell', 'process']]);
  assert.equal(calls.length, 0);
  failure = true;
  tabs.openRenameProcess(shell);
  await tabs.submitRename();
  assert.equal(tabs.renameOpen.value, true);
  assert.equal(tabs.renameBusy.value, false);
  assert.equal(tabs.renameError.value, 'Request failed');
  await tabs.copyProcessId(shell);
  assert.deepEqual(errors, ['Clipboard failed']);
});
