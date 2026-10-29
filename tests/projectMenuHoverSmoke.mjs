import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { computed, ref } from 'vue';

// Exercise the real hover handlers with a controlled clock.
const page = fs.readFileSync(new URL('../resources/js/Components/WorkbenchTopBar.vue', import.meta.url), 'utf8');
const source = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const parsed = ts.createSourceFile('topbar.ts', source, ts.ScriptTarget.Latest, true);
const executable = parsed.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getFullText(parsed)).join('\n');
const { outputText } = ts.transpileModule(executable, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const setup = new Function('computed', 'ref', 'watch', 'readRecentProjectIds', 'rememberRecentProject', 'shownRecentProjects', 'defineProps', 'defineEmits', 'onBeforeUnmount', 'setTimeout', 'clearTimeout', 'window', 'useUpdates',
  `${outputText}\nreturn { projectMenuOpen, openProjectMenuOnHover, scheduleProjectMenuClose, cancelProjectMenuClose, keepHoverFocus, stopProjectMenuHover };`);

test('Project hover preserves focus, allows crossing into the menu, and cancels timers', () => {
  const timers = new Map();
  let nextId = 0;
  let cleanup;
  let mobile = false;
  const menu = setup(computed, ref, () => {}, () => [], ids => ids, () => [], () => ({ projects: [] }), () => () => {}, callback => { cleanup = callback; },
    (callback, delay) => { assert.equal(delay, 100); timers.set(++nextId, callback); return nextId; }, id => timers.delete(id),
    { matchMedia: () => ({ matches: mobile }) }, () => ref(null));
  const tick = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); };
  menu.openProjectMenuOnHover({ pointerType: 'touch' });
  assert.equal(menu.projectMenuOpen.value, false, 'Touch must use the existing click interaction');
  mobile = true;
  menu.openProjectMenuOnHover({ pointerType: 'mouse' });
  assert.equal(menu.projectMenuOpen.value, false, 'Even a mouse must not open the mobile drawer on hover');
  mobile = false;
  menu.openProjectMenuOnHover({ pointerType: 'mouse' });
  assert.equal(menu.projectMenuOpen.value, true);
  let prevented = false;
  menu.keepHoverFocus({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'Hover must not take keyboard focus');
  menu.scheduleProjectMenuClose();
  assert.equal(menu.projectMenuOpen.value, true, 'Allow time to cross the gap');
  menu.cancelProjectMenuClose();
  tick();
  assert.equal(menu.projectMenuOpen.value, true, 'Entering the menu cancels closing');
  menu.scheduleProjectMenuClose();
  tick();
  assert.equal(menu.projectMenuOpen.value, false);
  menu.openProjectMenuOnHover({ pointerType: 'mouse' });
  menu.scheduleProjectMenuClose();
  menu.stopProjectMenuHover();
  tick();
  assert.equal(menu.projectMenuOpen.value, true, 'Keyboard interaction cancels hover closing');
  prevented = false;
  menu.keepHoverFocus({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'Keyboard opening retains native autofocus');
  menu.projectMenuOpen.value = false;
  menu.openProjectMenuOnHover({ pointerType: 'mouse' });
  menu.scheduleProjectMenuClose();
  cleanup();
  assert.equal(timers.size, 0, 'Unmount clears pending timers');
});
