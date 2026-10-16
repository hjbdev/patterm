import assert from 'node:assert/strict';

import {
  activeAgentFamilyIndex,
  agentFamilyTargetAt,
  agentFamilyTargetByDelta,
  agentOptionIndent,
  agentOptionTargetByDelta,
  buildAgentTabFamilies,
  familyOwnerLabel,
  matchesAgentTabSelection,
  type AgentTabFamily,
} from '../resources/js/lib/agentTabs';
import { activeProcesses, ownedProcessesForSessions, topLevelProcessesForSessions } from '../resources/js/lib/processTabs';
import {
  EMPTY_TAB_LAYOUT,
  buildStripTabs,
  moveStripTab,
  readStoredTabLayout,
  reconcileTabOrder,
  setStripTabPinned,
  stripTabLayout,
  writeStoredTabLayout,
  type StripTab,
} from '../resources/js/lib/tabStrip';
import { resolveActiveTerminalSelection } from '../resources/js/lib/terminalSelection';
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
assert.equal(agentFamilyTargetByDelta(mixedFamilies, null, 1, integratedChild.id)?.session.id, rootA.id, 'horizontal navigation wraps from the selected Integrated family');
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

assert.equal(agentFamilyTargetByDelta(families, 'pty-child-a', 1)?.session.id, 'root-b', 'Ctrl+D moves to the next root family');
assert.equal(agentFamilyTargetByDelta(families, 'pty-child-a', -1)?.session.id, 'root-c', 'Ctrl+A wraps to the previous root family');
assert.equal(agentFamilyTargetByDelta(families, 'pty-root-c', 1)?.session.id, 'child-a', 'horizontal navigation wraps forward');

assert.equal(agentFamilyTargetAt(families, 0)?.session.id, 'child-a', 'Ctrl+1 selects the first family active session');
assert.equal(agentFamilyTargetAt(families, 8), null, 'out-of-range Ctrl+9 has no target');

assert.equal(agentOptionTargetByDelta(families, 'pty-child-a', 1)?.session.id, 'grandchild-a', 'Ctrl+S moves down the active family options');
assert.equal(agentOptionTargetByDelta(families, 'pty-child-a', -1)?.session.id, 'root-a', 'Ctrl+W moves up the active family options');
assert.equal(agentOptionTargetByDelta(families, 'pty-root-a', -1)?.session.id, 'grandchild-a', 'vertical navigation wraps upward');
assert.equal(agentOptionTargetByDelta(families, 'pty-grandchild-a', 1)?.session.id, 'root-a', 'vertical navigation wraps downward');
assert.equal(agentOptionTargetByDelta(families, 'pty-unknown', 1), null, 'unknown active terminal has no vertical target');
assert.equal(
  resolveActiveTerminalSelection({
    next: [{ id: 'pty-root-a' }, { id: 'pty-child-a' }],
    previous: [{ id: 'pty-root-a' }],
    activeTerminalId: 'pty-root-a',
    pendingExplicitTerminalId: null
  }),
  'pty-root-a',
  'a fresh child agent tab does not steal focus from the active terminal'
);
assert.equal(
  resolveActiveTerminalSelection({
    next: [{ id: 'pty-root-a' }, { id: 'pty-child-a' }],
    previous: [{ id: 'pty-root-a' }],
    activeTerminalId: 'pty-root-a',
    pendingExplicitTerminalId: 'pty-child-a'
  }),
  'pty-child-a',
  'explicit terminal selection still switches to the requested child agent tab'
);
assert.equal(
  resolveActiveTerminalSelection({
    next: [{ id: 'pty-root-b' }],
    previous: [{ id: 'pty-root-a' }, { id: 'pty-root-b' }],
    activeTerminalId: 'pty-root-a',
    pendingExplicitTerminalId: null
  }),
  'pty-root-b',
  'when a stopped active terminal disappears from tabs, selection falls back to the remaining live tab'
);

{
  const keys = (tabs: readonly StripTab[]) => tabs.map((tab) => tab.key);
  const stripFamilies = (tabs: readonly StripTab[]): AgentTabFamily[] => tabs.flatMap((tab) => tab.kind === 'agent' ? [tab.family] : []);
  const shell = activeProcesses([processRecord('shell', null)]);

  assert.deepEqual(keys(buildStripTabs(families, shell)), ['agent:root-a', 'agent:root-b', 'agent:root-c', 'process:shell'], 'new tabs list agents before processes');

  const reordered = buildStripTabs(families, shell, { order: ['agent:root-c', 'process:shell', 'agent:root-a'], pinned: [] });
  assert.deepEqual(keys(reordered), ['agent:root-c', 'process:shell', 'agent:root-a', 'agent:root-b'], 'custom order interleaves processes and appends new tabs');
  assert.equal(agentFamilyTargetAt(stripFamilies(reordered), 0)?.session.id, 'root-c', 'Ctrl+1 follows custom visual order');
  assert.equal(agentFamilyTargetByDelta(stripFamilies(reordered), 'pty-root-c', 1)?.session.id, 'child-a', 'horizontal navigation follows custom visual order');

  const pinned = buildStripTabs(families, shell, {
    order: ['agent:root-c', 'process:shell', 'agent:root-a', 'agent:root-b'],
    pinned: ['agent:root-a', 'process:shell', 'agent:closed']
  });
  assert.deepEqual(keys(pinned), ['process:shell', 'agent:root-a', 'agent:root-c', 'agent:root-b'], 'pinned tabs lead the strip in layout order');
  assert.deepEqual(pinned.map((tab) => tab.pinned), [true, true, false, false]);
  assert.deepEqual(stripTabLayout(pinned), {
    order: ['process:shell', 'agent:root-a', 'agent:root-c', 'agent:root-b'],
    pinned: ['process:shell', 'agent:root-a']
  }, 'saved layouts forget closed tabs');

  assert.deepEqual(moveStripTab(pinned, 'agent:root-b', 2).order, ['process:shell', 'agent:root-a', 'agent:root-b', 'agent:root-c'], 'tabs move left');
  assert.deepEqual(moveStripTab(pinned, 'agent:root-c', 3).order, ['process:shell', 'agent:root-a', 'agent:root-b', 'agent:root-c'], 'tabs move right');
  assert.deepEqual(moveStripTab(pinned, 'agent:root-b', 0).order, ['process:shell', 'agent:root-a', 'agent:root-b', 'agent:root-c'], 'unpinned tabs stay out of the pinned group');
  assert.deepEqual(moveStripTab(pinned, 'process:shell', 10).order, ['agent:root-a', 'process:shell', 'agent:root-c', 'agent:root-b'], 'pinned tabs stay in the pinned group');
  assert.deepEqual(moveStripTab(pinned, 'agent:unknown', 1), stripTabLayout(pinned), 'moving an unknown tab is a no-op');

  assert.deepEqual(setStripTabPinned(pinned, 'agent:root-b', true), {
    order: ['process:shell', 'agent:root-a', 'agent:root-b', 'agent:root-c'],
    pinned: ['process:shell', 'agent:root-a', 'agent:root-b']
  }, 'pinning moves a tab to the end of the pinned group');
  assert.deepEqual(setStripTabPinned(pinned, 'process:shell', false), {
    order: ['agent:root-a', 'process:shell', 'agent:root-c', 'agent:root-b'],
    pinned: ['agent:root-a']
  }, 'unpinning moves a tab to the start of the unpinned group');
  assert.deepEqual(setStripTabPinned(pinned, 'agent:root-a', true), stripTabLayout(pinned), 'pinning a pinned tab is a no-op');

  assert.deepEqual(
    reconcileTabOrder(['agent:c', 'agent:missing', 'agent:c', 'agent:a'], ['agent:a', 'agent:b', 'agent:c']),
    ['agent:c', 'agent:a', 'agent:b'],
    'reconciliation drops missing and duplicate tabs, then appends new live tabs'
  );

  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  writeStoredTabLayout('project-a', { order: ['agent:root-a', 'process:shell'], pinned: ['process:shell'] }, storage);
  assert.deepEqual(readStoredTabLayout('project-a', storage), { order: ['agent:root-a', 'process:shell'], pinned: ['process:shell'] }, 'tab layouts persist per project');
  assert.deepEqual(readStoredTabLayout('project-b', storage), EMPTY_TAB_LAYOUT, 'projects without a saved layout use the default order');
  const storedKey = [...store.keys()][0]!;
  store.set(storedKey, '{"order":"agent:root-a","pinned":[1,"process:shell"]}');
  assert.deepEqual(readStoredTabLayout('project-a', storage), { order: [], pinned: ['process:shell'] }, 'malformed layout fields are ignored');
  store.set(storedKey, '{');
  assert.deepEqual(readStoredTabLayout('project-a', storage), EMPTY_TAB_LAYOUT, 'unreadable layouts fall back to the default order');
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
