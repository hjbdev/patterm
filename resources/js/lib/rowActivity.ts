// What tabs and sidebar rows show about an agent's own activity and that of
// the subagents below it. Thinking counts as working. Unknown, when Patterm
// could not tell whether a turn is running, looks idle but is described as
// unknown.

import type { ActivityState, ProcessRecord, SessionRecord } from '../types';
import type { AgentTabFamily } from './agentTabs';
import type { AgentNode } from './agentTree';

// Closing is an idle agent that asked to be closed.
export type Pulse = 'working' | 'permission' | 'error' | 'closing' | 'idle' | 'unknown';
type BusyPulse = Exclude<Pulse, 'closing' | 'idle' | 'unknown'>;

export interface RowActivity {
  readonly self: Pulse;
  // Subagents at any depth below the agent, by state.
  readonly subagents: Readonly<Record<BusyPulse, number>>;
}

// Each agent's activity in the given families, with the subagents below it.
// An agent outside the families gets only its own state.
export function activityLookup(families: readonly AgentTabFamily[]): (session: SessionRecord) => RowActivity {
  const activities = new Map<string, RowActivity>();
  const visit = (node: AgentNode): RowActivity => {
    const subagents = { working: 0, permission: 0, error: 0 };
    for (const child of node.children) {
      const below = visit(child);
      if (below.self !== 'closing' && below.self !== 'idle' && below.self !== 'unknown') subagents[below.self] += 1;
      subagents.working += below.subagents.working;
      subagents.permission += below.subagents.permission;
      subagents.error += below.subagents.error;
    }
    const activity = summarize(sessionPulse(node.session), subagents);
    activities.set(node.session.id, activity);
    return activity;
  };
  for (const family of families) visit(family.root);
  return (session) => activities.get(session.id) ?? summarize(sessionPulse(session), NO_SUBAGENTS);
}

export function processActivity(process: ProcessRecord): RowActivity {
  return summarize(process.status === 'running' ? pulse(process.activity) : 'idle', NO_SUBAGENTS);
}

// The most urgent state among the subagents, or null while they are all idle.
export function subagentPulse(activity: RowActivity): BusyPulse | null {
  if (activity.subagents.permission) return 'permission';
  if (activity.subagents.error) return 'error';
  return activity.subagents.working ? 'working' : null;
}

// Text colour for a subagent count: purple while subagents work, amber or red
// while one needs permission or has an error.
export function subagentCountClass(activity: RowActivity): string {
  switch (subagentPulse(activity)) {
    case 'permission':
      return 'text-warning';
    case 'error':
      return 'text-destructive';
    case 'working':
      return 'text-purple-300';
    default:
      return 'text-muted-foreground';
  }
}

const SELF_LABELS: Record<Pulse, string> = { working: 'Working', permission: 'Needs permission', error: 'Error', closing: 'Ready to close', idle: 'Idle', unknown: 'Unknown' };

// For screen readers and tooltips, such as "Idle, 2 subagents working".
export function describeActivity(activity: RowActivity): string {
  const { working, permission, error } = activity.subagents;
  const subagents = (count: number, singular: string, plural: string): string => `${count} ${count === 1 ? `subagent ${singular}` : `subagents ${plural}`}`;
  return [
    SELF_LABELS[activity.self],
    permission ? subagents(permission, 'needs permission', 'need permission') : null,
    error ? subagents(error, 'has an error', 'have errors') : null,
    working ? subagents(working, 'working', 'working') : null
  ].filter(Boolean).join(', ');
}

const NO_SUBAGENTS: Readonly<Record<BusyPulse, number>> = { working: 0, permission: 0, error: 0 };

function sessionPulse(session: SessionRecord): Pulse {
  return session.closeRequest ? 'closing' : pulse(session.activity);
}

function pulse(activity: ActivityState): Pulse {
  switch (activity) {
    case 'working':
    case 'thinking':
      return 'working';
    case 'permission':
      return 'permission';
    case 'error':
      return 'error';
    case 'unknown':
      return 'unknown';
    default:
      return 'idle';
  }
}

// Equal activities share one frozen object, so rows whose activity didn't
// change keep the same prop and skip re-rendering.
const interned = new Map<string, RowActivity>();

function summarize(self: Pulse, subagents: Readonly<Record<BusyPulse, number>>): RowActivity {
  const key = `${self}|${subagents.working}|${subagents.permission}|${subagents.error}`;
  let activity = interned.get(key);
  if (!activity) {
    activity = Object.freeze({ self, subagents: Object.freeze({ ...subagents }) });
    interned.set(key, activity);
  }
  return activity;
}
