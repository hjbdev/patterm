import type { HarnessInstallationDto, ProjectWorkbenchDto, WorkbenchSnapshotDto } from '../Repositories/WorkbenchRepository';
import type { SidebarState } from './SettingsService';

// Changes to one keyed list. `upsert` holds new and changed items in their
// final order; a new item goes straight after the key in `after`, or first
// when `after` is null. `order` lists every key and is only sent when kept
// items changed their relative order. `replace` is the whole list, sent when
// keys are not unique.
export interface KeyedPatch<T> {
  remove?: string[];
  upsert?: Array<{ item: T; after: string | null }>;
  order?: string[];
  replace?: T[];
}

export interface ProjectPatch {
  id: string;
  project?: ProjectWorkbenchDto['project'];
  projectSessions?: KeyedPatch<ProjectWorkbenchDto['projectSessions'][number]>;
  processes?: KeyedPatch<ProjectWorkbenchDto['processes'][number]>;
  worktrees?: KeyedPatch<ProjectWorkbenchDto['worktrees'][number]>;
  timers?: KeyedPatch<ProjectWorkbenchDto['timers'][number]>;
}

// New projects arrive whole; changed projects carry list patches only.
export interface WorkbenchChanges {
  projects?: {
    remove?: string[];
    add?: Array<{ item: ProjectWorkbenchDto; after: string | null }>;
    change?: ProjectPatch[];
    order?: string[];
  };
  harnesses?: KeyedPatch<HarnessInstallationDto>;
  sidebarState?: SidebarState;
}

// `epoch` identifies one server run. Versions restart with each epoch.
export interface WorkbenchPatch {
  epoch: string;
  from: number;
  to: number;
  changes: WorkbenchChanges;
}

const PROJECT_LISTS = ['projectSessions', 'processes', 'worktrees', 'timers'] as const;

// Serialisations of items already compared, so unchanged rows are encoded
// once rather than on every rebuild.
const encoded = new WeakMap<object, string>();

function encode(value: object): string {
  let json = encoded.get(value);
  if (json === undefined) {
    json = JSON.stringify(value);
    encoded.set(value, json);
  }
  return json;
}

function same(previous: object, next: object): boolean {
  return previous === next || encode(previous) === encode(next);
}

// Compares two keyed lists. Unchanged items in `next` are replaced by their
// previous objects, so a later comparison reuses their serialisation.
export function diffKeyed<T extends object>(previous: readonly T[], next: T[], key: (item: T) => string): KeyedPatch<T> | undefined {
  const before = new Map(previous.map((item) => [key(item), item]));
  const nextKeys = next.map(key);
  const kept = new Set(nextKeys);
  if (before.size !== previous.length || kept.size !== next.length) {
    return previous.length === next.length && previous.every((item, index) => same(item, next[index]!)) ? undefined : { replace: next };
  }
  const remove = [...before.keys()].filter((id) => !kept.has(id));
  const previousOrder = previous.map(key).filter((id) => kept.has(id));
  const nextOrder = nextKeys.filter((id) => before.has(id));
  const reordered = previousOrder.some((id, index) => id !== nextOrder[index]);
  const upsert: Array<{ item: T; after: string | null }> = [];
  next.forEach((item, index) => {
    const old = before.get(nextKeys[index]!);
    if (old && same(old, item)) {
      next[index] = old;
      return;
    }
    upsert.push({ item, after: index > 0 ? nextKeys[index - 1]! : null });
  });
  if (!remove.length && !upsert.length && !reordered) return undefined;
  return {
    ...(remove.length ? { remove } : {}),
    ...(upsert.length ? { upsert } : {}),
    ...(reordered ? { order: nextKeys } : {})
  };
}

function diffProject(previous: ProjectWorkbenchDto, next: ProjectWorkbenchDto): ProjectPatch | undefined {
  const patch: ProjectPatch = { id: next.project.id };
  let changed = false;
  if (!same(previous.project, next.project)) {
    patch.project = next.project;
    changed = true;
  } else {
    next.project = previous.project;
  }
  for (const list of PROJECT_LISTS) {
    const listPatch = diffKeyed<object>(previous[list], next[list], (item) => (item as { id: string }).id);
    if (listPatch) {
      (patch as unknown as Record<string, unknown>)[list] = listPatch;
      changed = true;
    }
  }
  return changed ? patch : undefined;
}

// Describes how to turn `previous` into `next`, or returns undefined when they
// render the same. Unchanged parts of `next` are swapped for the objects in
// `previous`, so `next` can serve as the base of the following comparison.
export function diffWorkbench(previous: WorkbenchSnapshotDto, next: WorkbenchSnapshotDto): WorkbenchChanges | undefined {
  const changes: WorkbenchChanges = {};
  const before = new Map(previous.projects.map((project) => [project.project.id, project]));
  const nextIds = next.projects.map((project) => project.project.id);
  const kept = new Set(nextIds);
  if (before.size === previous.projects.length && kept.size === next.projects.length) {
    const remove = [...before.keys()].filter((id) => !kept.has(id));
    const previousOrder = previous.projects.map((project) => project.project.id).filter((id) => kept.has(id));
    const nextOrder = nextIds.filter((id) => before.has(id));
    const add: Array<{ item: ProjectWorkbenchDto; after: string | null }> = [];
    const change: ProjectPatch[] = [];
    next.projects.forEach((project, index) => {
      const old = before.get(project.project.id);
      if (!old) {
        add.push({ item: project, after: index > 0 ? nextIds[index - 1]! : null });
        return;
      }
      const patch = diffProject(old, project);
      if (patch) change.push(patch);
      else next.projects[index] = old;
    });
    const reordered = previousOrder.some((id, index) => id !== nextOrder[index]);
    if (remove.length || add.length || change.length || reordered) {
      changes.projects = {
        ...(remove.length ? { remove } : {}),
        ...(add.length ? { add } : {}),
        ...(change.length ? { change } : {}),
        ...(reordered ? { order: nextIds } : {})
      };
    }
  } else if (encode(previous.projects) !== JSON.stringify(next.projects)) {
    // Duplicate project ids cannot be patched by key; resend every project.
    changes.projects = { remove: [...before.keys()], add: next.projects.map((item, index) => ({ item, after: index > 0 ? nextIds[index - 1]! : null })) };
  }
  const harnesses = diffKeyed(previous.harnesses, next.harnesses, (item) => item.id);
  if (harnesses) changes.harnesses = harnesses;
  if (!same(previous.sidebarState, next.sidebarState)) changes.sidebarState = next.sidebarState;
  else next.sidebarState = previous.sidebarState;
  return Object.keys(changes).length ? changes : undefined;
}
