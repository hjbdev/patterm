import type { ProjectWorkbench } from '../types';
import { activeAgentSessions } from './agentTabs';
import { activeProcesses } from './processTabs';

export interface ProjectLocation {
  name: string;
  fullPath: string;
  sessionId?: string | undefined;
  processId?: string | undefined;
}

interface RouteLike {
  name?: unknown;
  fullPath: string;
  params: Record<string, unknown>;
}

const lastLocations = new Map<string, ProjectLocation>();

// The bare project route is a place to return to when it shows a page of its
// own, such as the board; when it redirects to the first tab, that tab is
// remembered over it straight away.
export function rememberProjectLocation(route: RouteLike): void {
  if (route.name === 'launch') return;
  const { projectId, sessionId, processId } = route.params;
  if (typeof projectId !== 'string' || typeof route.name !== 'string') return;
  lastLocations.set(projectId, {
    name: route.name,
    fullPath: route.fullPath,
    sessionId: typeof sessionId === 'string' ? sessionId : undefined,
    processId: typeof processId === 'string' ? processId : undefined
  });
}

export function lastProjectLocation(projectId: string): ProjectLocation | undefined {
  return lastLocations.get(projectId);
}

// Returns the saved path when its agent or process still exists, otherwise null.
export function resolveProjectReturnPath(project: ProjectWorkbench | undefined, location: ProjectLocation | undefined): string | null {
  if (!project || !location) return null;
  if (location.name === 'agent') {
    return activeAgentSessions(project.projectSessions).some((session) => session.id === location.sessionId) ? location.fullPath : null;
  }
  if (location.name === 'process') {
    return activeProcesses(project.processes).some((process) => process.id === location.processId) ? location.fullPath : null;
  }
  return location.fullPath;
}

// Where a project's own page goes when it doesn't show the board: its first
// agent, or else its first process. Null when it has neither.
export function projectFirstTab(project: ProjectWorkbench | null | undefined): { name: 'agent'; params: { projectId: string; sessionId: string } } | { name: 'process'; params: { projectId: string; processId: string } } | null {
  if (!project) return null;
  const projectId = project.project.id;
  const session = activeAgentSessions(project.projectSessions)[0];
  if (session) return { name: 'agent', params: { projectId, sessionId: session.id } };
  const process = activeProcesses(project.processes)[0];
  return process ? { name: 'process', params: { projectId, processId: process.id } } : null;
}
