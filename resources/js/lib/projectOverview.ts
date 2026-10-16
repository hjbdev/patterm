// Live agents per project, for the project list on the home page.

import type { ProjectSummary, ProjectWorkbench, SessionRecord } from '../types';
import { activeAgentSessions, agentLabel } from './agentTabs';
import { awaitingUser, waitingReason } from './activity';
import { buildAgentTree, type AgentNode } from './agentTree';
import { shownActivity } from './rowActivity';

export type AgentState = 'waiting' | 'working' | 'idle';

export interface ProjectAgent {
  session: SessionRecord;
  // Live subagents, depth first.
  subagents: SessionRecord[];
  // The family's most urgent state: one subagent at a prompt makes the family wait.
  state: AgentState;
  waiting: SessionRecord | null;
}

export interface ProjectOverview {
  project: ProjectSummary;
  agents: ProjectAgent[];
  waiting: number;
  working: number;
  idle: number;
  // The latest start or end of any agent the workbench lists, which covers the last day.
  lastActiveAt: string | null;
}

export function agentState(session: SessionRecord): AgentState {
  if (awaitingUser(session.activity) || session.activity === 'error') return 'waiting';
  const activity = shownActivity(session);
  if (activity === 'working' || activity === 'thinking') return 'working';
  return 'idle';
}

// The Personal project first, then projects with live agents, then the most
// recently active.
export function projectOverviews(projects: readonly ProjectWorkbench[]): ProjectOverview[] {
  return projects.map(projectOverview)
    .sort((a, b) => Number(b.project.kind === 'personal') - Number(a.project.kind === 'personal')
      || Number(b.agents.length > 0) - Number(a.agents.length > 0) || time(b.lastActiveAt) - time(a.lastActiveAt));
}

// A subagent at a prompt matters more than the root's summary.
export function agentStatusText(agent: ProjectAgent): string {
  const { waiting } = agent;
  if (waiting && waiting.id !== agent.session.id) return `${agentLabel(waiting)} ${awaitingUser(waiting.activity) ? waitingReason(waiting.activity) : 'hit an error'}`;
  return agent.session.summary?.text ?? '';
}

// Home-relative, as a shell prompt shows it.
export function displayPath(path: string): string {
  return path.replace(/^(?:\/(?:home|Users)\/[^/]+|[a-zA-Z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/, '~');
}

function projectOverview(workbench: ProjectWorkbench): ProjectOverview {
  const agents = buildAgentTree(activeAgentSessions(workbench.projectSessions)).map(projectAgent);
  const times = workbench.projectSessions.flatMap((session) => [session.startedAt, session.exitedAt]).filter((value): value is string => Boolean(value));
  return {
    project: workbench.project,
    agents,
    waiting: agents.filter((agent) => agent.state === 'waiting').length,
    working: agents.filter((agent) => agent.state === 'working').length,
    idle: agents.filter((agent) => agent.state === 'idle').length,
    lastActiveAt: times.reduce<string | null>((latest, value) => !latest || time(value) > time(latest) ? value : latest, null)
  };
}

function projectAgent(root: AgentNode): ProjectAgent {
  const members: SessionRecord[] = [];
  const visit = (node: AgentNode) => {
    members.push(node.session);
    node.children.forEach(visit);
  };
  visit(root);
  const waiting = members.find((member) => agentState(member) === 'waiting') ?? null;
  return {
    session: root.session,
    subagents: members.slice(1),
    state: waiting ? 'waiting' : members.some((member) => agentState(member) === 'working') ? 'working' : 'idle',
    waiting
  };
}

function time(value: string | null): number {
  return (value ? Date.parse(value) : 0) || 0;
}
