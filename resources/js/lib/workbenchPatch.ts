import type { HarnessInstallationRecord, ProjectWorkbench, SidebarState } from '../types';

// Mirrors app/Services/WorkbenchPatch.ts. The server publishes one patch per
// workbench change; this side applies it to the snapshot the client holds.

export interface KeyedPatch<T> {
  remove?: string[];
  upsert?: Array<{ item: T; after: string | null }>;
  order?: string[];
  replace?: T[];
}

type ProjectList = 'projectSessions' | 'processes' | 'worktrees' | 'timers';

export type ProjectPatch = { id: string; project?: ProjectWorkbench['project'] }
  & { [List in ProjectList]?: KeyedPatch<ProjectWorkbench[List][number]> };

export interface WorkbenchChanges {
  projects?: {
    remove?: string[];
    add?: Array<{ item: ProjectWorkbench; after: string | null }>;
    change?: ProjectPatch[];
    order?: string[];
  };
  harnesses?: KeyedPatch<HarnessInstallationRecord>;
  sidebarState?: SidebarState;
  terminalAvailable?: boolean;
}

export interface WorkbenchPatch {
  epoch: string;
  from: number;
  to: number;
  changes: WorkbenchChanges;
}

export interface WorkbenchSnapshot {
  projects: ProjectWorkbench[];
  harnesses: HarnessInstallationRecord[];
  sidebarState: SidebarState;
  terminalAvailable: boolean;
}

const PROJECT_LISTS: readonly ProjectList[] = ['projectSessions', 'processes', 'worktrees', 'timers'];

function insertAfter<T>(items: T[], item: T, after: string | null, key: (item: T) => string): void {
  const index = after === null ? -1 : items.findIndex((candidate) => key(candidate) === after);
  items.splice(index + 1, 0, item);
}

function reorder<T>(items: T[], order: string[], key: (item: T) => string): T[] {
  const byKey = new Map(items.map((item) => [key(item), item]));
  return order.map((id) => byKey.get(id)).filter((item): item is T => item !== undefined);
}

// Returns a new list. Items the patch does not touch keep their identity, so
// Vue only re-renders the rows that changed.
export function applyKeyed<T>(items: readonly T[], patch: KeyedPatch<T> | undefined, key: (item: T) => string): T[] {
  if (!patch) return items as T[];
  if (patch.replace) return patch.replace;
  const removed = new Set(patch.remove ?? []);
  let next = removed.size ? items.filter((item) => !removed.has(key(item))) : [...items];
  const positions = new Map(next.map((item, index) => [key(item), index]));
  for (const { item, after } of patch.upsert ?? []) {
    const index = positions.get(key(item));
    if (index === undefined) {
      insertAfter(next, item, after, key);
      positions.clear();
      next.forEach((entry, position) => positions.set(key(entry), position));
    } else {
      next[index] = item;
    }
  }
  if (patch.order) next = reorder(next, patch.order, key);
  return next;
}

const byId = (item: { id: string }) => item.id;
const byProjectId = (item: ProjectWorkbench) => item.project.id;

function applyProject(project: ProjectWorkbench, patch: ProjectPatch): ProjectWorkbench {
  const next = { ...project, project: patch.project ?? project.project };
  for (const list of PROJECT_LISTS) {
    (next as Record<ProjectList, unknown>)[list] = applyKeyed(project[list] as Array<{ id: string }>, patch[list] as KeyedPatch<{ id: string }> | undefined, byId);
  }
  return next;
}

export function applyWorkbenchChanges(snapshot: WorkbenchSnapshot, changes: WorkbenchChanges): WorkbenchSnapshot {
  let projects = snapshot.projects;
  const projectChanges = changes.projects;
  if (projectChanges) {
    const removed = new Set(projectChanges.remove ?? []);
    const patches = new Map((projectChanges.change ?? []).map((patch) => [patch.id, patch]));
    projects = projects
      .filter((project) => !removed.has(project.project.id))
      .map((project) => {
        const patch = patches.get(project.project.id);
        return patch ? applyProject(project, patch) : project;
      });
    for (const { item, after } of projectChanges.add ?? []) insertAfter(projects, item, after, byProjectId);
    if (projectChanges.order) projects = reorder(projects, projectChanges.order, byProjectId);
  }
  return {
    projects,
    harnesses: applyKeyed(snapshot.harnesses, changes.harnesses, byId),
    sidebarState: changes.sidebarState ?? snapshot.sidebarState,
    terminalAvailable: changes.terminalAvailable ?? snapshot.terminalAvailable
  };
}

// True when the change adds, removes, starts, stops, or closes a session or
// process. Activity and title updates are not lifecycle changes.
export function changesLifecycle(previous: WorkbenchSnapshot, changes: WorkbenchChanges): boolean {
  const projectChanges = changes.projects;
  if (!projectChanges) return false;
  if (projectChanges.add?.length || projectChanges.remove?.length) return true;
  for (const patch of projectChanges.change ?? []) {
    const project = previous.projects.find((item) => item.project.id === patch.id);
    if (!project) return true;
    for (const list of ['projectSessions', 'processes'] as const) {
      const listPatch = patch[list];
      if (!listPatch) continue;
      if (listPatch.remove?.length || listPatch.replace) return true;
      const before = new Map<string, { exitedAt: string | null; status?: string }>(project[list].map((item) => [item.id, item]));
      for (const { item } of listPatch.upsert ?? []) {
        const old = before.get(item.id);
        if (!old || old.exitedAt !== item.exitedAt || ('status' in item && old.status !== item.status)) return true;
      }
    }
  }
  return false;
}
