import { agentLabel, type AgentTabFamily } from './agentTabs';
import type { AgentNode } from './agentTree';
import type { LiveProcessRecord } from './processTabs';
import type { RowActivity } from './rowActivity';
import type { StripTab } from './tabStrip';
import { timerLabel, timerRemaining, timerRemainingToMinute } from './timers';
import type { ProcessRecord, SessionRecord, TimerRecord } from '../types';

export type SidebarUrgency = 'low' | 'normal' | 'high';
export type SidebarAttention = 'permission' | 'error' | 'close' | 'unread';

// What the sidebar's tree helpers read about the workbench. The sidebar
// context provides it; tests pass a stand-in.
export interface SidebarTreeView {
  sessionActive: (session: SessionRecord) => boolean;
  processActive: (process: ProcessRecord) => boolean;
  ownedProcesses: (family: AgentTabFamily) => LiveProcessRecord[];
  unreadUrgency: (processId: string | null | undefined) => SidebarUrgency | null;
}

// Indentation stops growing past this depth so labels stay readable; deeper
// agents still fold and keep their guide lines.
export const MAX_INDENT_DEPTH = 5;

// Why an agent needs you, if it does.
export function sessionAttention(view: SidebarTreeView, session: SessionRecord): SidebarAttention | null {
  if (session.activity === 'permission') return 'permission';
  if (session.activity === 'error') return 'error';
  if (session.closeRequest) return 'close';
  return view.unreadUrgency(session.processId) === 'high' ? 'unread' : null;
}

// The most pressing reason anyone in a family needs you.
export function familyAttention(view: SidebarTreeView, family: AgentTabFamily): SidebarAttention | null {
  const states = family.options.map((option) => sessionAttention(view, option.session));
  if (view.ownedProcesses(family).some((process) => view.unreadUrgency(process.id) === 'high')) states.push('unread');
  return states.find((state) => state === 'permission') ?? states.find((state) => state === 'error') ?? states.find((state) => state === 'close') ?? states.find(Boolean) ?? null;
}

// The status group a family sits in when the sidebar groups by status:
// anything in it waiting on you, then working (the root or any subagent),
// else idle. Unknown counts as idle.
export type SidebarStatus = 'attention' | 'working' | 'idle';
export const SIDEBAR_STATUSES: readonly { id: SidebarStatus; label: string }[] = [
  { id: 'attention', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'idle', label: 'Idle' }
];

export function familyStatus(view: SidebarTreeView, family: AgentTabFamily, activity: RowActivity): SidebarStatus {
  if (familyAttention(view, family)) return 'attention';
  return activity.self === 'working' || activity.subagents.working ? 'working' : 'idle';
}

// The member of a family that is waiting on you, root first.
export function waitingSession(view: SidebarTreeView, family: AgentTabFamily): SessionRecord | null {
  return family.options.find((option) => {
    const state = sessionAttention(view, option.session);
    return state === 'permission' || state === 'error';
  })?.session ?? family.options.find((option) => option.session.closeRequest)?.session ?? null;
}

// What a family is waiting on you for, naming the subagent when it isn't the root.
export function familyWaitingOn(view: SidebarTreeView, family: AgentTabFamily): string | null {
  const session = waitingSession(view, family);
  if (!session) return null;
  if (session.activity !== 'permission' && session.activity !== 'error') return session === family.root.session ? 'Ready to close' : `${agentLabel(session)} is ready to close`;
  const reason = session.activity === 'permission' ? 'needs permission' : 'stopped with an error';
  return session === family.root.session ? reason[0]!.toUpperCase() + reason.slice(1) : `${agentLabel(session)} ${reason}`;
}

// The dot for a family row: its root's unread state while its members show,
// else the most urgent state anywhere in it, counting anything waiting on you.
export function familyUrgency(view: SidebarTreeView, family: AgentTabFamily, membersShown: boolean): SidebarUrgency | null {
  if (membersShown) return view.unreadUrgency(family.root.session.processId);
  if (familyAttention(view, family)) return 'high';
  const ids = [...family.options.map((option) => option.session.processId), ...view.ownedProcesses(family).map((process) => process.id)];
  return mostUrgent(ids.map((id) => view.unreadUrgency(id)));
}

// Processes keyed by the agent process that owns them.
export function processesByOwner(processes: readonly LiveProcessRecord[]): Map<string, LiveProcessRecord[]> {
  const result = new Map<string, LiveProcessRecord[]>();
  for (const process of processes) {
    if (!process.parentProcessId) continue;
    result.set(process.parentProcessId, [...(result.get(process.parentProcessId) ?? []), process]);
  }
  return result;
}

// Subagents and processes anywhere below a node.
export function descendants(node: AgentNode, owned: ReadonlyMap<string, LiveProcessRecord[]>): { sessions: AgentNode[]; processes: LiveProcessRecord[] } {
  const sessions: AgentNode[] = [];
  const processes: LiveProcessRecord[] = [...(owned.get(node.session.processId ?? '') ?? [])];
  for (const child of node.children) {
    sessions.push(child);
    const below = descendants(child, owned);
    sessions.push(...below.sessions);
    processes.push(...below.processes);
  }
  return { sessions, processes };
}

// The dot for a nested agent: its own unread state, or while folded, the most
// urgent state anywhere below it, counting anything waiting on you as urgent.
export function nodeUrgency(view: SidebarTreeView, node: AgentNode, owned: ReadonlyMap<string, LiveProcessRecord[]>, open: boolean): SidebarUrgency | null {
  const own = view.unreadUrgency(node.session.processId);
  if (open) return own;
  const below = descendants(node, owned);
  if (below.sessions.some((child) => sessionAttention(view, child.session) !== null)) return 'high';
  return mostUrgent([own, ...below.sessions.map((child) => view.unreadUrgency(child.session.processId)), ...below.processes.map((process) => view.unreadUrgency(process.id))]);
}

// The selected thread: the path from the root agent down to the selected
// agent, plus the selected process if a process is selected. Null when
// nothing in a family is selected. Everything else in the sidebar dims.
export function selectedThread(view: SidebarTreeView, tabs: readonly StripTab[]): Set<string> | null {
  for (const tab of tabs) {
    if (tab.kind !== 'agent') continue;
    const { family } = tab;
    let selected: SessionRecord | null = family.options.find((option) => view.sessionActive(option.session))?.session ?? null;
    const selectedProcess = selected ? null : view.ownedProcesses(family).find(view.processActive) ?? null;
    if (selectedProcess) selected = family.options.find((option) => option.session.processId === selectedProcess.parentProcessId)?.session ?? null;
    if (!selected) continue;

    const thread = new Set<string>(selectedProcess ? [selectedProcess.id] : []);
    const byId = new Map(family.options.map((option) => [option.session.id, option.session]));
    for (let session: SessionRecord | undefined = selected; session; session = session.parentId ? byId.get(session.parentId) : undefined) thread.add(session.id);
    return thread;
  }
  return null;
}

// The timer on a family's row: the soonest running countdown, to the minute,
// with every timer listed in its tooltip, as in the tab menu. Watches without
// a timeout show just the icon.
export function familyTimerSummary(timers: readonly TimerRecord[], now: number, ownerName: (processId: string | null) => string | null): { remaining: string; title: string } | null {
  if (!timers.length) return null;
  const shown = timers.find((timer) => timer.status === 'pending' && timer.firesAtUnixMs !== null) ?? timers[0]!;
  return {
    remaining: timerRemainingToMinute(shown, now),
    title: timers.map((timer) => [timerLabel(timer), ownerName(timer.ownerProcessId), timerRemaining(timer, now)].filter(Boolean).join(' · ')).join('\n')
  };
}

export function mostUrgent(urgencies: readonly (SidebarUrgency | null)[]): SidebarUrgency | null {
  if (urgencies.includes('high')) return 'high';
  if (urgencies.includes('normal')) return 'normal';
  return urgencies.find(Boolean) ?? null;
}
