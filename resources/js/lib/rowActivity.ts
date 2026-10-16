// What tabs and sidebar rows show about an agent's own activity and that of
// the subagents below it. Thinking counts as working. Unknown, when Patterm
// could not tell whether a turn is running, looks idle but is described as
// unknown.

import type { ActivityState, ProcessRecord, SessionRecord } from '../types';
import type { AgentTabFamily } from './agentTabs';
import type { AgentNode } from './agentTree';

// Closing is an idle agent that asked to be closed.
export type Pulse = 'working' | 'permission' | 'question' | 'error' | 'closing' | 'idle' | 'unknown' | 'dead';
type BusyPulse = Exclude<Pulse, 'closing' | 'idle' | 'unknown' | 'dead'>;

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
    const subagents = { working: 0, permission: 0, question: 0, error: 0 };
    for (const child of node.children) {
      const below = visit(child);
      if (below.self !== 'closing' && below.self !== 'idle' && below.self !== 'unknown' && below.self !== 'dead') subagents[below.self] += 1;
      subagents.working += below.subagents.working;
      subagents.permission += below.subagents.permission;
      subagents.question += below.subagents.question;
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
  return summarize(process.status === 'running' ? pulse(shownActivity(process)) : 'idle', NO_SUBAGENTS);
}

// An agent's own activity as rows show it. One that is idle while a background
// task it started still runs, such as a shell it waits on, is busy and shows
// as working; its turn has only ended.
export function shownActivity(record: Pick<SessionRecord, 'activity' | 'backgroundTasks' | 'exitedAt'>): ActivityState {
  const idle = record.activity === 'idle' || record.activity === 'unknown';
  return idle && !record.exitedAt && (record.backgroundTasks ?? 0) > 0 ? 'working' : record.activity;
}

// The most urgent state among the subagents, or null while they are all idle.
export function subagentPulse(activity: RowActivity): BusyPulse | null {
  if (activity.subagents.permission) return 'permission';
  if (activity.subagents.question) return 'question';
  if (activity.subagents.error) return 'error';
  return activity.subagents.working ? 'working' : null;
}

// Text colour for a subagent count: muted while idle or working (working adds
// a shimmer, see WorkingShimmer), amber or red
// while one needs permission, has a question, or has an error.
export function subagentCountClass(activity: RowActivity): string {
  switch (subagentPulse(activity)) {
    case 'permission':
    case 'question':
      return 'text-warning';
    case 'error':
      return 'text-destructive';
    default:
      return 'text-muted-foreground';
  }
}

// What a row's member count holds, such as "2 subagents, 1 process".
export function memberLabel(agents: number, processes: number): string {
  return [agents && `${agents} ${agents === 1 ? 'subagent' : 'subagents'}`, processes && `${processes} ${processes === 1 ? 'process' : 'processes'}`].filter(Boolean).join(', ');
}

// Whether a row's subagent count sits inside its status ring. A row that shows
// `?`, `✕` or `✓` keeps the count at its end instead.
export function countInRing(activity: RowActivity): boolean {
  return activity.self !== 'permission' && activity.self !== 'question' && activity.self !== 'error' && activity.self !== 'closing' && activity.self !== 'dead';
}

const SELF_LABELS: Record<Pulse, string> = { working: 'Working', permission: 'Needs permission', question: 'Has a question', error: 'Error', closing: 'Ready to close', idle: 'Idle', unknown: 'Unknown', dead: 'Dead' };

// For screen readers and tooltips, such as "Idle, 2 subagents working".
export function describeActivity(activity: RowActivity): string {
  const { working, permission, question, error } = activity.subagents;
  const subagents = (count: number, singular: string, plural: string): string => `${count} ${count === 1 ? `subagent ${singular}` : `subagents ${plural}`}`;
  return [
    SELF_LABELS[activity.self],
    permission ? subagents(permission, 'needs permission', 'need permission') : null,
    question ? subagents(question, 'has a question', 'have questions') : null,
    error ? subagents(error, 'has an error', 'have errors') : null,
    working ? subagents(working, 'working', 'working') : null
  ].filter(Boolean).join(', ');
}

const NO_SUBAGENTS: Readonly<Record<BusyPulse, number>> = { working: 0, permission: 0, question: 0, error: 0 };

function sessionPulse(session: SessionRecord): Pulse {
  if (session.exitedAt) return 'dead';
  return session.closeRequest ? 'closing' : pulse(shownActivity(session));
}

function pulse(activity: ActivityState): Pulse {
  switch (activity) {
    case 'working':
    case 'thinking':
      return 'working';
    case 'permission':
      return 'permission';
    case 'question':
      return 'question';
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
  const key = `${self}|${subagents.working}|${subagents.permission}|${subagents.question}|${subagents.error}`;
  let activity = interned.get(key);
  if (!activity) {
    activity = Object.freeze({ self, subagents: Object.freeze({ ...subagents }) });
    interned.set(key, activity);
  }
  return activity;
}
