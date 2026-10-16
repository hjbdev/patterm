import { reactive, watch } from 'vue';
import { activeAgentSessions } from './agentTabs';
import type { TabLayout } from './tabStrip';
import type { ProcessRecord, ProjectSummary, ProjectWorkbench, SessionRecord, TimerRecord } from '../types';

// "All agents" shows every shown project's open agents together. It stays on
// while you open agents in different projects, until you pick a project.
// Remembered on this device, like the sidebar's view options.
export interface AllAgentsState {
  active: boolean;
  // Projects switched off in the Projects menu. New projects show.
  hidden: string[];
}

// The key the sidebar's view options are kept under while showing all agents.
export const ALL_AGENTS_SCOPE = 'all';
const STORAGE_KEY = 'patterm.allAgents';

export function readAllAgentsState(storage?: Pick<Storage, 'getItem'>): AllAgentsState {
  try {
    const value = JSON.parse((storage ?? localStorage).getItem(STORAGE_KEY) ?? 'null') as Partial<AllAgentsState> | null;
    return {
      active: value?.active === true,
      hidden: Array.isArray(value?.hidden) ? value.hidden.filter((id): id is string => typeof id === 'string') : []
    };
  } catch {
    return { active: false, hidden: [] };
  }
}

export const allAgents = reactive<AllAgentsState>(readAllAgentsState());
watch(allAgents, (value) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // The choice still applies until the page reloads.
  }
}, { deep: true });

export function projectShown(state: AllAgentsState, projectId: string): boolean {
  return !state.hidden.includes(projectId);
}

export function setProjectShown(state: AllAgentsState, projectId: string, shown: boolean): void {
  const rest = state.hidden.filter((id) => id !== projectId);
  state.hidden = shown ? rest : [...rest, projectId];
}

// Projects that can be listed: the assistant's own project never shows.
export function listedProjects(projects: readonly ProjectWorkbench[]): ProjectWorkbench[] {
  return projects.filter((item) => item.project.kind !== 'assistant');
}

export function openAgentCount(project: ProjectWorkbench): number {
  return activeAgentSessions(project.projectSessions).length;
}

export interface AllAgentsView {
  sessions: SessionRecord[];
  processes: ProcessRecord[];
  timers: TimerRecord[];
  // The project each listed session and process belongs to, by record ID.
  owners: Map<string, ProjectSummary>;
}

export function buildAllAgentsView(projects: readonly ProjectWorkbench[], hidden: readonly string[]): AllAgentsView {
  const listed = listedProjects(projects);
  const shown = listed.filter((item) => !hidden.includes(item.project.id));
  const owners = new Map<string, ProjectSummary>();
  for (const item of listed) {
    for (const session of item.projectSessions) owners.set(session.id, item.project);
    for (const process of item.processes) owners.set(process.id, item.project);
  }
  return {
    sessions: shown.flatMap((item) => item.projectSessions),
    processes: shown.flatMap((item) => item.processes),
    timers: shown.flatMap((item) => item.timers),
    owners
  };
}

// A layout change made while some projects are hidden covers only the tabs
// that show. The hidden projects' tabs keep their places beside the tabs they
// followed, and their pins, for when those projects show again.
export function keepHiddenTabs(previous: TabLayout, next: TabLayout, hidden: (key: string) => boolean): TabLayout {
  const shown = new Set(next.order);
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const key of previous.order) {
    if (shown.has(key)) anchor = key;
    else if (hidden(key)) after.set(anchor, [...after.get(anchor) ?? [], key]);
  }
  return {
    order: [...after.get(null) ?? [], ...next.order.flatMap((key) => [key, ...after.get(key) ?? []])],
    pinned: [...next.pinned, ...previous.pinned.filter((key) => hidden(key) && !next.pinned.includes(key))]
  };
}

// Pinned tabs first, as you placed them, then the rest kept together by project.
export function tabsGroupedByProject<T extends { pinned: boolean }>(tabs: readonly T[], projects: readonly ProjectSummary[], ownerOf: (tab: T) => ProjectSummary | null): T[] {
  return [...tabs.filter((tab) => tab.pinned), ...groupByProject(tabs.filter((tab) => !tab.pinned), projects, ownerOf).flatMap((group) => group.items)];
}

// Items in project order, keeping their own order within each project.
export function groupByProject<T>(items: readonly T[], projects: readonly ProjectSummary[], ownerOf: (item: T) => ProjectSummary | null): Array<{ project: ProjectSummary; items: T[] }> {
  return projects
    .map((project) => ({ project, items: items.filter((item) => ownerOf(item)?.id === project.id) }))
    .filter((group) => group.items.length);
}
