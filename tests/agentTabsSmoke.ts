import assert from 'node:assert/strict';

import {
  activeAgentFamilyIndex,
  agentOptionIndent,
  agentOptionTargetByDelta,
  buildAgentTabFamilies,
  familyOwnerLabel,
  matchesAgentTabSelection,
} from '../resources/js/lib/agentTabs';
import { activeProcesses, ownedProcessesForSessions, topLevelProcessesForSessions } from '../resources/js/lib/processTabs';
import {
  buildStripTabs,
  createFolderInLayout,
  deleteFolderFromLayout,
  entryTabs,
  forgetClosedTabs,
  layoutEntries,
  placeInLayout,
  readLegacyTabLayout,
  reconcileTabOrder,
  renameFolderInLayout,
  withLiveTabs,
  type StripTab,
  type TabLayout,
} from '../resources/js/lib/tabStrip';
import { isNavigationModeToggle, navigationModeAction, type NavigationModeKey } from '../resources/js/lib/navigationMode';
import { formatDuration, timerLabel, timerRemaining, timersForProcesses } from '../resources/js/lib/timers';
import type { ProcessRecord, SessionRecord, TimerRecord } from '../resources/js/types';

function session(id: string, parentId: string | null = null, ptyProcessId: string | null = `pty-${id}`, exitedAt: string | null = null): SessionRecord {
  return {
    id,
    parentId,
    ptyProcessId,
    processId: `process-${id}`,
    worktreeId: null,
    harness: 'opencode',
    interfaceMode: 'tui',
    sessionRole: parentId ? 'child' : 'orchestrator',
    resumeStatus: 'unknown',
    activity: 'idle',
    lastTitle: id,
    displayName: null,
    model: null,
    reasoning: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    exitedAt
  };
}

function processRecord(
  id: string,
  parentProcessId: string | null,
  status = 'running',
  ptyProcessId: string | null = `pty-${id}`
): ProcessRecord {
  return {
    id,
    parentProcessId,
    kind: 'command',
    name: id,
    command: id,
    cwd: null,
    argv: [],
    status,
    activity: 'idle',
    ptyProcessId,
    worktreeId: null,
    autoRestart: false,
    exitedAt: status === 'running' ? null : '2026-01-01T00:01:00.000Z',
    exitCode: null
  };
}

const rootA = session('root-a');
const childA = session('child-a', 'root-a');
const grandchildA = session('grandchild-a', 'child-a');
const rootB = session('root-b');
const rootC = session('root-c');
const exited = session('exited', null, 'pty-exited', '2026-01-01T00:01:00.000Z');
const missingPty = session('missing-pty', null, null);

const rootProcess = processRecord('root-process', rootA.processId);
const childProcess = processRecord('child-process', childA.processId);
const unrelatedProcess = processRecord('unrelated-process', rootB.processId);
const exitedProcess = processRecord('exited-process', childA.processId, 'exited');
const missingPtyProcess = processRecord('missing-pty-process', childA.processId, 'running', null);
assert.deepEqual(
  topLevelProcessesForSessions([rootA, childA], [rootProcess, childProcess, unrelatedProcess, processRecord('standalone', null), exitedProcess, missingPtyProcess]).map((process) => process.id),
  ['unrelated-process', 'standalone'],
  'standalone and orphaned processes get tabs without duplicating agent-owned processes'
);
assert.deepEqual(
  activeProcesses([rootProcess, exitedProcess, missingPtyProcess]).map((process) => process.id),
  ['root-process'],
  'process tabs include only running PTY-backed processes'
);
assert.deepEqual(
  ownedProcessesForSessions([rootA, childA, grandchildA], [rootProcess, childProcess, unrelatedProcess, exitedProcess, missingPtyProcess]).map((process) => process.id),
  ['root-process', 'child-process'],
  'agent families include live processes directly owned by roots and nested subagents'
);

const families = buildAgentTabFamilies([rootA, childA, grandchildA, rootB, rootC, exited, missingPty], {
  'root-a': 'child-a'
});

assert.equal(families.length, 3, 'only live PTY-backed root families are shown');
const integratedSession = { ...session('integrated', null, null), interfaceMode: 'integrated' as const };
assert.equal(buildAgentTabFamilies([rootA, rootB, rootC, integratedSession]).length, 4, 'live Integrated sessions are shown without a PTY');
assert.equal(matchesAgentTabSelection(integratedSession, null, null), false, 'a missing PTY and session selection do not activate an Integrated tab');
assert.equal(matchesAgentTabSelection(integratedSession, null, integratedSession.id), true, 'the routed Integrated session activates its tab');
assert.equal(matchesAgentTabSelection(rootA, null, integratedSession.id), false, 'a TUI tab stays inactive while Integrated is selected');
const secondIntegrated = { ...session('integrated-b', null, null), interfaceMode: 'integrated' as const };
const integratedChild = { ...session('integrated-child', secondIntegrated.id, null), interfaceMode: 'integrated' as const };
const mixedFamilies = buildAgentTabFamilies([rootA, integratedSession, secondIntegrated, integratedChild], { [secondIntegrated.id]: integratedChild.id });
assert.equal(activeAgentFamilyIndex(mixedFamilies, null, integratedChild.id), 2, 'the selected Integrated child identifies its own family');
assert.equal(agentOptionTargetByDelta(mixedFamilies, null, -1, integratedChild.id)?.session.id, secondIntegrated.id, 'vertical navigation starts from the selected Integrated child');
assert.equal(activeAgentFamilyIndex(mixedFamilies, null), -1, 'no routed session means no active family');
assert.deepEqual(families.map((family) => family.rootId), ['root-a', 'root-b', 'root-c']);

// A failed parent remains a selectable family root while its children run.
const deadRoot = { ...integratedSession, exitedAt: new Date().toISOString(), processStatus: 'failed', activity: 'working' as const };
const survivingChild = { ...integratedChild, parentId: deadRoot.id };
const recoveredFamilies = buildAgentTabFamilies([deadRoot, survivingChild]);
assert.deepEqual(recoveredFamilies.map((family) => family.rootId), [deadRoot.id], 'a crash does not promote surviving children to roots');
assert.deepEqual(recoveredFamilies[0]?.options.map((option) => option.session.id), [deadRoot.id, survivingChild.id]);
assert.equal(buildAgentTabFamilies([{ ...deadRoot, processStatus: 'closed' }]).length, 0, 'explicitly closed sessions stay hidden');
assert.equal(buildAgentTabFamilies([deadRoot]).length, 1, 'a failed Integrated agent stays available even without children');

const oldFailure = { ...deadRoot, exitedAt: new Date(Date.now() - 48 * 3_600_000).toISOString() };
assert.equal(buildAgentTabFamilies([oldFailure]).length, 0, 'old failures without live descendants do not return to the sidebar');
assert.equal(buildAgentTabFamilies([{ ...deadRoot, processStatus: 'stopped' }]).length, 0, 'deliberately stopped sessions do not return to the sidebar');
assert.equal(buildAgentTabFamilies([{ ...deadRoot, processStatus: 'exited' }]).length, 0, 'normally completed sessions do not return to the sidebar');
assert.deepEqual(buildAgentTabFamilies([oldFailure, survivingChild])[0]?.options.map(option => option.session.id), [deadRoot.id, survivingChild.id], 'a parent of a live child remains grouped even beyond the history window');

const oldMiddle = { ...oldFailure, id: 'old-middle', processId: 'process-old-middle', parentId: oldFailure.id };
assert.deepEqual(buildAgentTabFamilies([oldFailure, oldMiddle, { ...survivingChild, parentId: oldMiddle.id }])[0]?.options.map(option => option.session.id), [oldFailure.id, oldMiddle.id, survivingChild.id], 'ended intermediate ancestors retain the live grandchild family');

// Nested sub-agents keep their place at any depth, even when listed before their parents.
const greatGrandchildA = session('great-grandchild-a', 'grandchild-a');
const siblingA = session('sibling-a', 'root-a');
const [deepFamily] = buildAgentTabFamilies([greatGrandchildA, grandchildA, siblingA, childA, rootA]);
assert.deepEqual(
  deepFamily?.options.map((option) => [option.session.id, option.depth, option.parentId]),
  [['root-a', 0, null], ['sibling-a', 1, 'root-a'], ['child-a', 1, 'root-a'], ['grandchild-a', 2, 'child-a'], ['great-grandchild-a', 3, 'grandchild-a']],
  'each nested agent follows its own parent, one level deeper'
);
assert.deepEqual(deepFamily?.options.map((option) => agentOptionIndent(option.depth)), [0, 0, 0, 12, 24], 'menus indent grandchildren and deeper under their parents');
const grandchildProcess = processRecord('grandchild-process', grandchildA.processId);
assert.deepEqual(
  ownedProcessesForSessions(deepFamily!.options.map((option) => option.session), [grandchildProcess]).map((process) => process.id),
  ['grandchild-process'],
  'processes of deeper agents stay in the family'
);
assert.equal(familyOwnerLabel(deepFamily!, grandchildProcess.parentProcessId), 'grandchild-a', 'a nested owner is named beside its process');
assert.equal(familyOwnerLabel(deepFamily!, rootProcess.parentProcessId), null, 'root-owned processes need no owner label');
assert.equal(families[0]?.active.id, 'child-a', 'selected child is the active tab label for its root family');
assert.equal(activeAgentFamilyIndex(families, 'pty-child-a'), 0);

assert.equal(agentOptionTargetByDelta(families, 'pty-child-a', 1)?.session.id, 'grandchild-a', 'Ctrl+S moves down the active family options');
assert.equal(agentOptionTargetByDelta(families, 'pty-child-a', -1)?.session.id, 'root-a', 'Ctrl+W moves up the active family options');
assert.equal(agentOptionTargetByDelta(families, 'pty-root-a', -1)?.session.id, 'grandchild-a', 'vertical navigation wraps upward');
assert.equal(agentOptionTargetByDelta(families, 'pty-grandchild-a', 1)?.session.id, 'root-a', 'vertical navigation wraps downward');
assert.equal(agentOptionTargetByDelta(families, 'pty-unknown', 1), null, 'unknown active terminal has no vertical target');
{
  const keys = (tabs: readonly StripTab[]) => tabs.map((tab) => tab.key);
  const shell = activeProcesses([processRecord('shell', null)]);

  assert.deepEqual(keys(buildStripTabs(families, shell)), ['agent:root-a', 'agent:root-b', 'agent:root-c', 'process:shell'], 'new tabs list agents before processes');

  const reordered = buildStripTabs(families, shell, { order: ['agent:root-c', 'process:shell', 'agent:root-a'], folders: [], filed: {} });
  assert.deepEqual(keys(reordered), ['agent:root-c', 'process:shell', 'agent:root-a', 'agent:root-b'], 'custom order interleaves processes and appends new tabs');

  // Folders sit among the tabs where they were put, holding theirs in order.
  const later = { id: 'later', name: 'Later' };
  const layout: TabLayout = {
    order: ['agent:root-c', 'folder:later', 'agent:root-b', 'process:shell', 'agent:root-a'],
    folders: [later],
    filed: { 'agent:root-a': 'later', 'process:shell': 'later', 'agent:closed': 'later' }
  };
  const filed = buildStripTabs(families, shell, layout);
  assert.deepEqual(filed.map((tab) => tab.folder), [null, null, 'later', 'later'], 'tabs know the folder they are filed in');
  assert.equal(buildStripTabs(families, shell, { ...layout, folders: [] }).every((tab) => !tab.folder), true, 'tabs filed in a deleted folder are loose');
  const entries = layoutEntries(filed, layout);
  assert.deepEqual(entries.map((entry) => entry.key), ['agent:root-c', 'folder:later', 'agent:root-b'], 'folders sit among the tabs where they were put');
  assert.deepEqual(entries[1]!.kind === 'folder' && keys(entries[1]!.tabs), ['process:shell', 'agent:root-a'], 'a folder holds its tabs in layout order');
  assert.deepEqual(keys(entryTabs(entries)), ['agent:root-c', 'process:shell', 'agent:root-a', 'agent:root-b'], "each folder's tabs show in its place");
  assert.deepEqual(layoutEntries([], { ...layout, filed: {} }).map((entry) => entry.key), ['folder:later'], 'empty folders still show');

  const live = withLiveTabs(layout, ['agent:root-a', 'agent:root-b', 'agent:root-c', 'agent:new', 'process:shell']);
  assert.deepEqual(live.order.slice(-1), ['agent:new'], 'edits can place tabs beside ones the layout has not seen');
  const moved = placeInLayout(live, 'agent:root-c', { folder: 'later', before: 'agent:root-a' });
  assert.deepEqual(moved.filed['agent:root-c'], 'later');
  assert.deepEqual(keys(layoutEntries(buildStripTabs(families, shell, moved), moved).flatMap((entry) => entry.kind === 'folder' ? entry.tabs : [])), ['process:shell', 'agent:root-c', 'agent:root-a'], 'a tab moves into a folder beside its tabs');
  const appended = placeInLayout(live, 'agent:root-b', { folder: 'later' });
  assert.deepEqual(keys(buildStripTabs(families, shell, appended).filter((tab) => tab.folder)), ['process:shell', 'agent:root-a', 'agent:root-b'], 'with no neighbour, a tab goes to the end of the folder');
  const out = placeInLayout(live, 'agent:root-a', { folder: null, after: 'folder:later' });
  assert.equal(out.filed['agent:root-a'], undefined);
  assert.deepEqual(layoutEntries(buildStripTabs(families, shell, out), out).map((entry) => entry.key), ['agent:root-c', 'folder:later', 'agent:root-a', 'agent:root-b'], 'a tab taken out of a folder can sit just after it');
  const folderMoved = placeInLayout(live, 'folder:later', { folder: 'later', before: 'agent:root-c' });
  assert.equal(folderMoved.order[0], 'folder:later', 'folders move among the tabs');
  assert.equal(folderMoved.filed['folder:later'], undefined, 'folders never go in folders');
  assert.deepEqual(placeInLayout(live, 'agent:root-b', { folder: 'missing' }).filed['agent:root-b'], undefined, 'a tab cannot go in a folder that does not exist');

  const retros = { id: 'retros', name: 'Retros' };
  const created = createFolderInLayout(live, retros, ['agent:root-b']);
  assert.equal(created.order.indexOf('folder:retros'), live.order.indexOf('agent:root-b'), 'a new folder takes the place of the first tab it holds');
  assert.equal(created.filed['agent:root-b'], 'retros');
  assert.equal(renameFolderInLayout(created, 'retros', 'Retrospectives').folders[1]!.name, 'Retrospectives');
  const deleted = deleteFolderFromLayout(live, 'later');
  assert.deepEqual(deleted.order.slice(0, 4), ['agent:root-c', 'process:shell', 'agent:root-a', 'agent:root-b'], "a deleted folder's tabs stay where it was");
  assert.deepEqual([deleted.folders, deleted.filed], [[], {}]);
  assert.equal(deleteFolderFromLayout(deleted, 'later'), deleted, 'deleting a folder already gone changes nothing');

  const pruned = forgetClosedTabs(layout, (key) => key !== 'agent:closed' && key !== 'agent:root-b');
  assert.deepEqual(pruned.order, ['agent:root-c', 'folder:later', 'process:shell', 'agent:root-a'], 'closed tabs are forgotten, folders kept');
  assert.equal('agent:closed' in pruned.filed, false);

  assert.deepEqual(
    reconcileTabOrder(['agent:c', 'agent:missing', 'agent:c', 'agent:a'], ['agent:a', 'agent:b', 'agent:c']),
    ['agent:c', 'agent:a', 'agent:b'],
    'reconciliation drops missing and duplicate tabs, then appends new live tabs'
  );

  // Layouts saved on a device before they moved to the server carry over,
  // pinned tabs in a folder at the top.
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null };
  store.set('patterm.tabs.v1.project-a', JSON.stringify({ order: ['agent:root-a', 'process:shell', 'agent:root-b'], pinned: ['process:shell', 'agent:gone'] }));
  assert.deepEqual(readLegacyTabLayout('project-a', storage), {
    order: ['folder:pinned', 'process:shell', 'agent:root-a', 'agent:root-b'],
    folders: [{ id: 'pinned', name: 'Pinned' }],
    filed: { 'process:shell': 'pinned' }
  }, 'pins become a folder');
  store.set('patterm.tabs.v1.project-b', JSON.stringify({ order: ['agent:root-a'], pinned: [] }));
  assert.deepEqual(readLegacyTabLayout('project-b', storage), { order: ['agent:root-a'], folders: [], filed: {} }, 'an unpinned layout keeps its order');
  assert.equal(readLegacyTabLayout('project-c', storage), null, 'nothing saved, nothing carried over');
  store.set('patterm.tabs.v1.project-a', '{');
  assert.equal(readLegacyTabLayout('project-a', storage), null, 'unreadable layouts are ignored');
}

{
  const base: TimerRecord = { id: 't', kind: 'delay', status: 'pending', ownerProcessId: 'p1', watched: [], label: null, body: '', firesAtUnixMs: 90_000, pausedRemainingMs: null, createdAtUnixMs: 0 };
  const late = { ...base, id: 'late', firesAtUnixMs: 200_000 };
  const watch = { ...base, id: 'watch', kind: 'report_all' as const, firesAtUnixMs: null };
  const other = { ...base, id: 'other', ownerProcessId: 'p9' };
  assert.deepEqual(timersForProcesses([watch, late, other, base], new Set(['p1'])).map((timer) => timer.id), ['t', 'late', 'watch'], 'family timers sort by deadline');
  assert.equal(timerLabel(base), 'Timer');
  assert.equal(timerLabel({ ...base, label: 'Check CI' }), 'Check CI');
  assert.equal(timerLabel(watch), 'When all report');
  assert.equal(timerRemaining(base, 0), '1m 30s');
  assert.equal(timerRemaining({ ...watch, firesAtUnixMs: 30_000 }, 0), '≤ 30s');
  assert.equal(timerRemaining(watch, 0), '');
  assert.equal(timerRemaining({ ...base, status: 'paused' }, 0), 'Paused');
  assert.equal(formatDuration(-5), '0s');
  assert.equal(formatDuration(3_725_000), '1h 2m');
}

{
  const key = (code: string, key = code.replace(/^(Key|Digit)/, '').toLowerCase(), mods: Partial<NavigationModeKey> = {}): NavigationModeKey =>
    ({ key, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
  const ctrlSpace = key('Space', ' ', { ctrlKey: true });
  assert.deepEqual(navigationModeAction(ctrlSpace, false), { type: 'enter' }, 'Ctrl+Space enters navigation mode');
  assert.deepEqual(navigationModeAction(ctrlSpace, true), { type: 'exit', consume: true }, 'Ctrl+Space toggles navigation mode off');
  assert.deepEqual(navigationModeAction(key('KeyA'), false), { type: 'none' }, 'letters pass through outside navigation mode');
  assert.deepEqual(navigationModeAction(key('KeyA'), true), { type: 'tab', delta: -1 });
  assert.deepEqual(navigationModeAction(key('KeyD', 'D', { shiftKey: true }), true), { type: 'tab', delta: 1 }, 'Shift does not matter');
  assert.deepEqual(navigationModeAction(key('KeyW'), true), { type: 'option', delta: -1 });
  assert.deepEqual(navigationModeAction(key('KeyS'), true), { type: 'option', delta: 1 });
  assert.deepEqual(navigationModeAction(key('Digit3'), true), { type: 'jump', index: 2 });
  assert.deepEqual(navigationModeAction(key('Numpad9', '9'), true), { type: 'jump', index: 8 });
  assert.deepEqual(navigationModeAction(key('Escape', 'Escape'), true), { type: 'exit', consume: true });
  assert.deepEqual(navigationModeAction(key('ShiftLeft', 'Shift', { shiftKey: true }), true), { type: 'none' }, 'modifier presses keep the mode');
  assert.deepEqual(navigationModeAction(key('KeyX'), true), { type: 'exit', consume: false }, 'other keys leave the mode and pass through');
  assert.deepEqual(navigationModeAction(key('KeyA', 'a', { ctrlKey: true }), true), { type: 'exit', consume: false }, 'chords leave the mode and pass through');
  assert.equal(isNavigationModeToggle(key('Space', ' ', { ctrlKey: true, shiftKey: true })), false);
}
