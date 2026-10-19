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

// What All agents leaves out: the projects you switched off, and any that
// are snoozed. Snoozed ones collapse to a heading instead of disappearing.
export function allAgentsHiding(state: AllAgentsState, projects: readonly ProjectWorkbench[]): AllAgentsState {
  const snoozed = projects.filter((item) => item.project.snoozedUntil && !state.hidden.includes(item.project.id)).map((item) => item.project.id);
  return snoozed.length ? { ...state, hidden: [...state.hidden, ...snoozed] } : state;
}

// Projects that can be listed: the assistant's own project never shows.
export function listedProjects(projects: readonly ProjectWorkbench[]): ProjectWorkbench[] {
  return projects.filter((item) => item.project.kind !== 'assistant');
}

// Where an agent launched from All agents can start: each shown project, and
// each paired host a local project is linked with. `targetProjectId` names the
// project on the host that runs it.
export interface LaunchTarget { projectId: string; targetProjectId: string; host: string | null; project: ProjectSummary }

export function launchTargets(projects: readonly ProjectWorkbench[], state: AllAgentsState): LaunchTarget[] {
  return listedProjects(projects)
    .filter((item) => projectShown(state, item.project.id))
    .flatMap(({ project }) => [
      { projectId: project.id, targetProjectId: project.id, host: project.host ?? null, project },
      ...(project.host ? [] : (project.remotes ?? []).map((remote) => ({ projectId: project.id, targetProjectId: remote.projectId, host: remote.host, project })))
    ]);
}

// The targets whose host has this agent CLI.
export function targetsWithHarness(targets: readonly LaunchTarget[], harness: string, harnessesOn: (host: string | null) => readonly { harness: string }[]): LaunchTarget[] {
  return targets.filter((target) => harnessesOn(target.host).some((record) => record.harness === harness));
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
// that show. The hidden projects' tabs keep their slots, and so their order
// and pins, for when those projects show again; the shown tabs fill the other
// slots in their new order.
export function keepHiddenTabs(previous: TabLayout, next: TabLayout, hidden: (key: string) => boolean): TabLayout {
  const shown = new Set(next.order);
  const queue = [...next.order];
  const order = previous.order.flatMap((key) => shown.has(key) ? [queue.shift()!] : hidden(key) ? [key] : []);
  return {
    order: [...order, ...queue],
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
