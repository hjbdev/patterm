import type { AgentTabFamily } from './agentTabs';
import type { Reference } from './projectContext';
import type { LiveProcessRecord } from './processTabs';
import type { RowActivity } from './rowActivity';
import type { SidebarUrgency } from './sidebarTree';
import type { StripTab } from './tabStrip';
import type { DiffTotals } from './worktreeDiff';
import type { SessionRecord } from '../types';

// What the sidebar's agent card and the board say about an agent family: who
// it is, what it needs or is doing, its summary and members, and where its
// work lives. useAgentDigests builds them from the workbench, notifications,
// and each root session's context; the helpers here word them.

// Needs you, working, waiting on its subagents or a timer, finished and asking
// to close, or idle.
export type DigestState = 'attention' | 'working' | 'waiting' | 'done' | 'idle';

export interface DigestMember {
  key: string;
  session?: SessionRecord;
  process?: LiveProcessRecord;
  name: string;
  depth: number;
  activity: RowActivity;
  state: 'attention' | 'working' | 'done' | 'idle';
}

// The summary's opening sentence, which says what the thread is for, and the
// rest, which says where it stands.
export interface DigestSummary { goal: string; now: string; at: string }

// Why it needs you, in its own words where it gave any.
export interface DigestAsk { kind: 'permission' | 'error' | 'close' | 'message'; from: string | null; text: string }

type AgentTab = Extract<StripTab, { kind: 'agent' }>;

export interface AgentDigest {
  key: string;
  tab: AgentTab;
  family: AgentTabFamily;
  session: SessionRecord;
  name: string;
  harness: string | null;
  model: string | null;
  activity: RowActivity;
  state: DigestState;
  // A few words, such as "Needs permission" or "Waiting on 2 subagents".
  status: string;
  // What it needs from you, when it does: who asks (null for the root) and what.
  ask: DigestAsk | null;
  summary: DigestSummary | null;
  members: DigestMember[];
  counts: { subagents: number; processes: number };
  timer: { remaining: string; title: string } | null;
  branch: string | null;
  diff: DiffTotals | null;
  todo: string | null;
  links: Reference[];
  startedAt: string;
  // The latest summary, or the start when there is none.
  updatedAt: string;
  unread: SidebarUrgency | null;
  active: boolean;
  holdsSelection: boolean;
}

export const STATE_ORDER: readonly DigestState[] = ['attention', 'working', 'waiting', 'done', 'idle'];

export function memberState(activity: RowActivity): DigestMember['state'] {
  switch (activity.self) {
    case 'permission':
    case 'error':
      return 'attention';
    case 'working':
      return 'working';
    case 'closing':
      return 'done';
    default:
      return 'idle';
  }
}

// Summaries open with what the thread is for; the sentences after it say
// where it stands.
export function splitSummary(text: string): { goal: string; now: string } {
  const sentences = text.trim().split(/(?<=[.!?])\s+(?=["'A-Z0-9])/);
  const goal = sentences[0] ?? text;
  return { goal, now: sentences.slice(1).join(' ') || goal };
}

// claude-opus-5-5 → Opus 5.5; gpt-5-codex stays as it is.
export function modelLabel(model: string | null): string | null {
  if (!model) return null;
  const claude = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
  if (claude) return `${capitalize(claude[1]!)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  return model.replace(/^gpt-/, 'GPT-');
}

// 2m, 3h, 2d.
export function shortAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// 5m ago, or just now.
export function ago(iso: string, now: number): string {
  const short = shortAgo(iso, now);
  return short === 'now' ? 'just now' : `${short} ago`;
}

// 2 subagents · 1 process.
export function membersLabel(counts: AgentDigest['counts'], separator: string): string {
  const { subagents, processes } = counts;
  return [
    subagents && `${subagents} ${subagents === 1 ? 'subagent' : 'subagents'}`,
    processes && `${processes} ${processes === 1 ? 'process' : 'processes'}`
  ].filter(Boolean).join(separator);
}

export function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}
