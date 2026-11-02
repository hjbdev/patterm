import assert from 'node:assert/strict';
import { effectScope, nextTick, ref } from 'vue';

import { buildAgentTabFamilies, type AgentTabFamily } from '../resources/js/lib/agentTabs';
import { ownedProcessesForSessions, type LiveProcessRecord } from '../resources/js/lib/processTabs';
import {
  descendants,
  familyAttention,
  familyTimerSummary,
  familyUrgency,
  familyStatus,
  familyWaitingOn,
  nextWaiting,
  nodeUrgency,
  processesByOwner,
  selectedThread,
  sessionAttention,
  sortByActivity,
  type SidebarTreeView,
  type SidebarUrgency
} from '../resources/js/lib/sidebarTree';
import { activityLookup } from '../resources/js/lib/rowActivity';
import { buildStripTabs } from '../resources/js/lib/tabStrip';
import { useSettledValues } from '../resources/js/Composables/useSettledValues';
import { useSidebarExpansion } from '../resources/js/Composables/useSidebarExpansion';
import type { ActivityState, ProcessRecord, SessionRecord, TimerRecord } from '../resources/js/types';

function session(id: string, parentId: string | null = null, activity: ActivityState = 'idle'): SessionRecord {
  return {
    id,
    parentId,
    ptyProcessId: `pty-${id}`,
    processId: `process-${id}`,
    worktreeId: null,
    harness: 'claude',
    interfaceMode: 'tui',
    sessionRole: parentId ? 'child' : 'orchestrator',
    resumeStatus: 'unknown',
    activity,
    lastTitle: id,
    displayName: null,
    model: null,
    reasoning: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    exitedAt: null
  };
}

function processRecord(id: string, ownerId: string): ProcessRecord {
  return {
    id,
    parentProcessId: `process-${ownerId}`,
    kind: 'command',
    name: id,
    command: id,
    cwd: null,
    argv: [],
    status: 'running',
    activity: 'idle',
    ptyProcessId: `pty-${id}`,
    worktreeId: null,
    autoRestart: false,
    exitedAt: null,
    exitCode: null
  };
}

// root
// ├─ child          (owns build)
// │  └─ grandchild  (owns trace, waits for permission)
// │     └─ great    (deepest)
// ├─ sibling
// └─ (owns server)
const sessions = [
  session('root'),
  session('child', 'root'),
  session('grandchild', 'child', 'permission'),
  session('great', 'grandchild', 'working'),
  session('sibling', 'root'),
  session('other')
];
const processes = [processRecord('server', 'root'), processRecord('build', 'child'), processRecord('trace', 'grandchild')];
const families = buildAgentTabFamilies(sessions);
const tabs = buildStripTabs(families, []);
const family = families.find((candidate) => candidate.rootId === 'root')!;

function view(selection: { session?: string; process?: string } = {}, unread: Record<string, SidebarUrgency> = {}): SidebarTreeView {
  return {
    sessionActive: (candidate) => candidate.id === selection.session,
    processActive: (candidate) => candidate.id === selection.process,
    ownedProcesses: (candidate: AgentTabFamily): LiveProcessRecord[] => ownedProcessesForSessions(candidate.options.map((option) => option.session), processes),
    unreadUrgency: (processId) => (processId ? unread[processId] : undefined) ?? null
  };
}

// Processes sit under the agent that started them, at any depth.
const owned = processesByOwner(ownedProcessesForSessions(sessions, processes));
assert.deepEqual([...owned.keys()].sort(), ['process-child', 'process-grandchild', 'process-root']);
assert.deepEqual(owned.get('process-grandchild')?.map((process) => process.id), ['trace']);

const child = family.root.children.find((node) => node.session.id === 'child')!;
const below = descendants(child, owned);
assert.deepEqual(below.sessions.map((node) => node.session.id), ['grandchild', 'great'], 'descendants reach every depth');
assert.deepEqual(below.processes.map((process) => process.id).sort(), ['build', 'trace']);

// The thread is the path from the root to the selected agent, and nothing below it.
assert.deepEqual([...selectedThread(view({ session: 'grandchild' }), tabs)!].sort(), ['child', 'grandchild', 'root']);
assert.deepEqual([...selectedThread(view({ session: 'root' }), tabs)!], ['root'], 'selecting the root dims every member');
assert.deepEqual([...selectedThread(view({ process: 'build' }), tabs)!].sort(), ['build', 'child', 'root'], 'a selected process brings its owner’s path');
assert.equal(selectedThread(view(), tabs), null, 'nothing dims without a selection');

// What a family waits on names the agent, however deep.
assert.equal(familyWaitingOn(view(), family), 'grandchild needs permission');
const waitingRoot = buildAgentTabFamilies([session('lone', null, 'permission')])[0]!;
assert.equal(familyWaitingOn(view(), waitingRoot), 'Needs permission');
const askingRoot = buildAgentTabFamilies([session('asker', null, 'question')])[0]!;
assert.equal(familyWaitingOn(view(), askingRoot), 'Has a question', 'a question is not a permission');
// An Integrated prompt says what it asks, naming a subagent that asks it.
const saying = buildAgentTabFamilies([{ ...session('sayer', null, 'question'), asking: 'Which events go in the first pass?' }])[0]!;
assert.equal(familyWaitingOn(view(), saying), 'Which events go in the first pass?');
const sayingChild = buildAgentTabFamilies([session('lead'), { ...session('helper', 'lead', 'permission'), asking: 'Allow Edit CHANGELOG.md?' }])[0]!;
assert.equal(familyWaitingOn(view(), sayingChild), 'helper: Allow Edit CHANGELOG.md?');
const stale = buildAgentTabFamilies([{ ...session('moved', null, 'error'), asking: 'Allow Edit CHANGELOG.md?' }])[0]!;
assert.notEqual(familyWaitingOn(view(), stale), 'Allow Edit CHANGELOG.md?', 'only a live prompt says what it asks');
assert.equal(sessionAttention(view(), session('asker', null, 'question')), 'question');
const mixed = buildAgentTabFamilies([session('mixed', null, 'working'), session('mixed-ask', 'mixed', 'question'), session('mixed-perm', 'mixed', 'permission')])[0]!;
assert.equal(familyAttention(view(), mixed), 'permission', 'a permission outranks a question');
assert.equal(familyWaitingOn(view(), families.find((candidate) => candidate.rootId === 'other')!), null);
assert.equal(sessionAttention(view({}, { 'process-other': 'high' }), session('other')), 'unread', 'a high-urgency notification needs you');
const closing = { ...session('done'), closeRequest: { summary: 'Merged.', requestedAt: '2026-10-06T00:00:00Z' } };
assert.equal(sessionAttention(view(), closing), 'close', 'an agent asking to be closed needs you');
assert.equal(familyWaitingOn(view(), buildAgentTabFamilies([closing])[0]!), 'Ready to close');
assert.equal(activityLookup([])(closing).self, 'closing');

// The phone's back button points at the next agent asking for something,
// skipping the one shown and anyone merely working or ready to close.
const queue = buildStripTabs(buildAgentTabFamilies([session('busy', null, 'working'), closing, session('first'), session('first-ask', 'first', 'question'), session('second', null, 'permission')]), []);
const next = nextWaiting(queue, null);
assert.deepEqual([next?.family.rootId, next?.session.id], ['first', 'first-ask'], 'a subagent asking puts its family next, naming the subagent');
assert.equal(nextWaiting(queue, 'first')?.session.id, 'second', 'the agent shown is skipped');
assert.equal(nextWaiting(buildStripTabs(buildAgentTabFamilies([{ ...session('gone', null, 'question'), exitedAt: '2026-10-29T00:00:00Z' }]), []), null), null, 'a stopped agent is not asking');

// Grouped by status, anything waiting on you comes first, then any work below the root.
const statusOf = (candidates: AgentTabFamily[], id: string, unread: Record<string, SidebarUrgency> = {}) => {
  const found = candidates.find((candidate) => candidate.rootId === id)!;
  return familyStatus(view({}, unread), found, activityLookup(candidates)(found.root.session));
};
assert.equal(statusOf(families, 'root'), 'attention', 'a subagent asking permission puts its family in Needs you');
assert.equal(statusOf(families, 'other'), 'idle');
assert.equal(statusOf(families, 'other', { 'process-other': 'high' }), 'attention', 'an urgent notification needs you');
const busy = buildAgentTabFamilies([session('a', null, 'thinking'), session('b'), session('b1', 'b', 'working'), session('c', null, 'unknown')]);
assert.equal(statusOf(busy, 'a'), 'working', 'thinking counts as working');
assert.equal(statusOf(busy, 'b'), 'working', 'a working subagent keeps its family working');
assert.equal(statusOf(busy, 'c'), 'idle', 'unknown counts as idle');

// Folded agents report what's waiting below them; open ones only their own state.
assert.equal(nodeUrgency(view(), child, owned, false), 'high', 'a folded agent shows the permission request below it');
assert.equal(nodeUrgency(view(), child, owned, true), null);
const sibling = family.root.children.find((node) => node.session.id === 'sibling')!;
assert.equal(nodeUrgency(view({}, { 'process-sibling': 'normal' }), sibling, owned, false), 'normal');
assert.equal(familyUrgency(view(), family, false), 'high');
assert.equal(familyUrgency(view({}, { 'process-root': 'low' }), family, true), 'low', 'an open family shows only its root’s dot');

// A family row shows its soonest running countdown and lists every timer in its tooltip.
function timer(id: string, fields: Partial<TimerRecord>): TimerRecord {
  return { id, kind: 'delay', status: 'pending', ownerProcessId: 'process-root', watched: [], label: null, body: '', firesAtUnixMs: null, pausedRemainingMs: null, createdAtUnixMs: 0, ...fields };
}
const now = 1_000_000;
const ownerName = (processId: string | null) => (processId === 'process-child' ? 'child' : null);
const paused = timer('paused', { status: 'paused', firesAtUnixMs: now + 60_000, pausedRemainingMs: 60_000 });
const watch = timer('watch', { kind: 'idle_any', ownerProcessId: 'process-child', firesAtUnixMs: now + 252_000 });
assert.equal(familyTimerSummary([], now, ownerName), null);
assert.deepEqual(familyTimerSummary([timer('report', { kind: 'report_all' })], now, ownerName), { remaining: '', title: 'When all report' }, 'a watch without a timeout keeps its icon');
assert.equal(familyTimerSummary([paused], now, ownerName)?.remaining, 'Paused', 'a paused timer doesn’t count down');
assert.deepEqual(familyTimerSummary([paused, watch], now, ownerName), {
  remaining: '≤ 4m',
  title: 'Timer · Paused\nWhen any is idle · child · ≤ 4m 12s'
}, 'a running countdown shows before a paused timer, and a watch’s timeout reads as an upper bound');

// A paired host's records carry host-qualified IDs and cross-references, and
// build the same tree. One of its agents may also sit under a local agent.
function remote<T extends SessionRecord | ProcessRecord>(record: T): T {
  const q = (id: string | null) => id === null ? null : `workstation:${id}`;
  return 'parentProcessId' in record
    ? { ...record, id: q(record.id)!, parentProcessId: q(record.parentProcessId), ptyProcessId: q(record.ptyProcessId), host: 'workstation' }
    : { ...record, id: q(record.id)!, parentId: q(record.parentId), processId: q(record.processId), ptyProcessId: q(record.ptyProcessId), host: 'workstation' };
}
const remoteSessions = [
  remote(session('lead')),
  remote(session('helper', 'lead', 'permission')),
  { ...remote(session('visitor')), parentId: 'root' }
];
const remoteProcesses = [remote(processRecord('watch', 'helper')), remote(processRecord('serve', 'lead'))];
const mixedSessions = [...sessions, ...remoteSessions];
const mixedProcesses = [...processes, ...remoteProcesses];
const mixedFamilies = buildAgentTabFamilies(mixedSessions);
const mixedTabs = buildStripTabs(mixedFamilies, mixedProcesses.filter((process) => !process.parentProcessId) as LiveProcessRecord[], { order: [], pinned: ['agent:workstation:lead'] });
const lead = mixedFamilies.find((candidate) => candidate.rootId === 'workstation:lead')!;
assert.deepEqual(lead.options.map((option) => option.session.id), ['workstation:lead', 'workstation:helper'], 'a qualified parent ID nests its subagent');
assert.ok(mixedFamilies.find((candidate) => candidate.rootId === 'root')!.options.some((option) => option.session.id === 'workstation:visitor'), 'a remote agent started by a local one sits in its family');
assert.equal(mixedTabs.find((tab) => tab.key === 'agent:workstation:lead')?.pinned, true, 'a remote family pins by its qualified key');
const remoteView: SidebarTreeView = {
  ...view({ process: 'workstation:watch' }, { 'workstation:process-serve': 'normal' }),
  ownedProcesses: (candidate) => ownedProcessesForSessions(candidate.options.map((option) => option.session), mixedProcesses)
};
const remoteOwned = processesByOwner(remoteView.ownedProcesses(lead));
assert.deepEqual([...remoteOwned.keys()].sort(), ['workstation:process-helper', 'workstation:process-lead'], 'processes sit under their qualified owner');
assert.deepEqual([...selectedThread(remoteView, mixedTabs)!].sort(), ['workstation:helper', 'workstation:lead', 'workstation:watch'], 'the selected thread follows qualified parents');
assert.equal(familyWaitingOn(remoteView, lead), 'helper needs permission');
assert.equal(familyStatus(remoteView, lead, activityLookup(mixedFamilies)(lead.root.session)), 'attention', 'a remote family groups by status');
assert.equal(familyUrgency(remoteView, lead, false), 'high', 'a folded remote family shows what waits below it');

// Which families are open is remembered per project on this device.
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) }
});
// Sorted by recent activity, a family's newest change, its own or a
// subagent's, puts it first. Agents without a time sort by when they started.
{
  const at = (record: SessionRecord, activityAt: string | null) => ({ ...record, activityAt });
  const sortTabs = buildStripTabs(buildAgentTabFamilies([
    at(session('quiet'), '2026-01-02T00:00:00.000Z'),
    at(session('busy'), '2026-01-01T00:00:00.000Z'),
    at(session('busy-helper', 'busy'), '2026-01-03T00:00:00.000Z'),
    at(session('fresh'), '2026-01-02T12:00:00.000Z'),
    session('old-host')
  ]), []);
  assert.deepEqual(sortByActivity(sortTabs).map((tab) => tab.key), ['agent:busy', 'agent:fresh', 'agent:quiet', 'agent:old-host']);
}

void (async () => {
  // A project's options from before they were shared carry over.
  store.set('patterm.sidebar.expansion.one', JSON.stringify({ subtitles: true, followActive: true, sortByActivity: true, members: 'yes' }));
  const expansion = useSidebarExpansion(() => 'one');
  assert.equal(expansion.isOpen('root'), false, 'families start closed');
  assert.equal(expansion.isNodeOpen('child'), true, 'nested agents start open');
  assert.deepEqual(expansion.view.value, { groupByStatus: false, sortByActivity: true, groupByProject: true, members: true }, 'old options carry over, bad values fall back');
  assert.equal(JSON.parse(store.get('patterm.sidebar.view') ?? '{}').sortByActivity, true, 'carried-over options are saved before the old entry is rewritten');
  expansion.setOpen('root', true);
  expansion.setOpen('child', false);
  expansion.view.value.groupByStatus = true;
  await nextTick();
  const saved = JSON.parse(store.get('patterm.sidebar.expansion.one') ?? '{}') as Record<string, unknown>;
  assert.deepEqual(saved, { overrides: { root: true, child: false }, processes: false, hiddenMembers: [] }, 'a project keeps only what is open');
  assert.equal(JSON.parse(store.get('patterm.sidebar.view') ?? '{}').groupByStatus, true, 'view options are saved once');
  assert.equal(useSidebarExpansion(() => 'one').isNodeOpen('child'), false, 'choices are read back');
  const two = useSidebarExpansion(() => 'two');
  assert.equal(two.isOpen('root'), false, 'each project keeps its own open families');
  assert.equal(two.view.value.groupByStatus, true, 'every project shares the view options');
  const linked = useSidebarExpansion(() => 'workstation:project_1');
  linked.setOpen('workstation:lead', true);
  linked.setOpen('workstation:helper', false);
  await nextTick();
  const reread = useSidebarExpansion(() => 'workstation:project_1');
  assert.equal(reread.isOpen('workstation:lead'), true, 'a remote family keeps its open state');
  assert.equal(reread.isNodeOpen('workstation:helper'), false, 'a remote subagent keeps its folded state');
  assert.equal(reread.isOpen('lead'), false, 'a qualified ID never matches the bare one');
  Reflect.deleteProperty(globalThis, 'localStorage');

  // Settled statuses ignore blips, show lasting changes after their delay,
  // move to Needs you at once, and forget rows that leave.
  const live = ref(new Map([['a', 'idle'], ['b', 'idle']]));
  const scope = effectScope();
  const settled = scope.run(() => useSettledValues(() => live.value, { immediate: (next) => next === 'attention', delayFor: () => 30 }))!;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  assert.equal(settled('a'), 'idle', 'new rows show their status at once');
  live.value = new Map([['a', 'working'], ['b', 'attention']]);
  await nextTick();
  assert.equal(settled('a'), 'idle', 'a change waits to settle');
  assert.equal(settled('b'), 'attention', 'needing you shows at once');
  live.value = new Map([['a', 'idle'], ['b', 'attention']]);
  await nextTick();
  await wait(50);
  assert.equal(settled('a'), 'idle', 'a blip shorter than the delay never shows');
  live.value = new Map([['a', 'working']]);
  await nextTick();
  await wait(50);
  assert.equal(settled('a'), 'working', 'a lasting change shows');
  assert.equal(settled('b'), undefined, 'rows that leave are forgotten');
  scope.stop();
  console.log('sidebar tree smoke passed');
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
