import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { computed, reactive, ref } from 'vue';

const page = fs.readFileSync(new URL('../resources/js/Components/MobileTabs.vue', import.meta.url), 'utf8');
const source = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('mobile-tabs.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getFullText(parsed)).join('\n');
const { outputText } = ts.transpileModule(executable, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const setup = new Function('computed', 'ref', 'useHarnessLaunchesFor', 'useSelectedHarnessLaunch', 'defineProps', 'defineEmits', 'ownedProcessesForSessions',
  `${outputText}\nreturn { open, activeAgent, activeProcess, isFamilyActive, selectFamily, selectSession, selectProcess };`);

test('Mobile tabs select the family and expose its children without launching or losing the active title', () => {
  const root = { id: 'root', displayName: 'Parent', ptyProcessId: 'root-pty' };
  const child = { id: 'child', displayName: 'Child', ptyProcessId: 'child-pty' };
  const owned = { id: 'owned', name: 'Build', ptyProcessId: 'owned-pty' };
  const standalone = { id: 'standalone', name: 'Shell', ptyProcessId: 'standalone-pty' };
  const family = { rootId: root.id, root: { session: root }, active: child, options: [{ session: root }, { session: child }] };
  const props = reactive({ families: [family], processes: [standalone], allProcesses: [owned, standalone], activeSessionId: child.id, activeTerminalId: child.ptyProcessId });
  const events = [];
  const tabs = setup(computed, ref, () => computed(() => []), () => computed(() => null), () => props, () => (name, ...args) => events.push([name, ...args]),
    () => [owned]);

  assert.equal(tabs.activeAgent.value?.id, child.id, 'Child session supplies the current tab title');
  assert.equal(tabs.activeProcess.value, null);
  assert.equal(tabs.isFamilyActive(family), true, 'The selected child expands its family');
  props.activeSessionId = root.id;
  props.activeTerminalId = root.ptyProcessId;
  assert.equal(tabs.isFamilyActive(family), true, 'The selected root expands its family');
  props.activeSessionId = child.id;
  props.activeTerminalId = child.ptyProcessId;
  tabs.open.value = true;
  tabs.selectFamily(family);
  assert.deepEqual(events.pop(), ['select', root.id, root]);
  assert.equal(tabs.open.value, true);
  tabs.selectSession(root.id, child);
  assert.deepEqual(events.pop(), ['select', root.id, child]);
  assert.equal(tabs.open.value, false, 'Selecting a child closes the drawer');
  tabs.open.value = true;
  tabs.selectProcess(owned);
  assert.deepEqual(events.pop(), ['selectProcess', owned]);
  assert.equal(tabs.open.value, false);
  props.activeSessionId = null;
  props.activeTerminalId = owned.ptyProcessId;
  assert.equal(tabs.isFamilyActive(family), true, 'An owned process expands its family');
  props.activeTerminalId = standalone.ptyProcessId;
  assert.equal(tabs.activeProcess.value?.id, standalone.id, 'Standalone process supplies the current tab title');
  assert.equal(tabs.isFamilyActive(family), false, 'The family closes when another tab is active');
});

test('Mobile drawer lists the root once and derives expansion from selection', () => {
  assert.match(page, /activityFor\(family\.root\.session\)/);
  assert.match(page, /agentLabel\(family\.root\.session\)/);
  assert.match(page, /v-for="option in family\.options\.slice\(1\)"/);
  assert.match(page, /v-if="isFamilyActive\(family\)"/);
  assert.doesNotMatch(page, /expandedRootId|aria-expanded|rotate-180/);
});
