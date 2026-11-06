import { computed, inject, onBeforeUnmount, provide, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import { matchesAgentTabSelection, type AgentTabFamily } from '../../lib/agentTabs';
import { ownedProcessesForSessions, type LiveProcessRecord } from '../../lib/processTabs';
import { activityLookup, type RowActivity } from '../../lib/rowActivity';
import { createFolderInLayout, deleteFolderFromLayout, folderKey, placeInLayout, renameFolderInLayout, type StripTab, type TabFolder, type TabLayout } from '../../lib/tabStrip';
import { tabSnoozed } from '../../lib/snooze';
import { randomId } from '../../lib/randomId';
import { timersForProcesses } from '../../lib/timers';
import { ALL_AGENTS_SCOPE } from '../../lib/allAgents';
import { unreadUrgency } from '../../Composables/useNotifications';
import { familyAttention, sessionAttention, type SidebarAttention, type SidebarTreeView } from '../../lib/sidebarTree';
import type { ProcessRecord, ProjectSummary, SessionRecord, TimerRecord } from '../../types';

export type SidebarPage = 'worktrees' | 'history' | 'todos' | 'scratchpads' | 'media';
export type AgentTab = Extract<StripTab, { kind: 'agent' }>;

// Everything the sidebar reads or does, built once by the workbench layout.
export interface SidebarContext extends SidebarTreeView {
  projectId: ComputedRef<string>;
  // Whether agents show in the sidebar, rather than as tabs.
  shown: ComputedRef<boolean>;
  tabs: ComputedRef<StripTab[]>;
  // Whether the list shows every shown project's agents, and which projects
  // there are to show. Its view options are kept apart from any project's.
  allAgents: ComputedRef<boolean>;
  expansionScope: ComputedRef<string>;
  projects: ComputedRef<ProjectSummary[]>;
  projectOf: (tab: StripTab) => ProjectSummary | null;
  // The projects the list shows: the route's, or every shown one.
  shownProjectIds: ComputedRef<readonly string[]>;
  page: ComputedRef<SidebarPage | null>;
  worktreeCount: ComputedRef<number>;
  // Whether the project is a repository, which the Personal project is not.
  repository: ComputedRef<boolean>;
  now: Ref<number>;
  ownedProcesses: (family: AgentTabFamily) => LiveProcessRecord[];
  familyTimers: (family: AgentTabFamily) => TimerRecord[];
  memberCount: (family: AgentTabFamily) => number;
  sessionActive: (session: SessionRecord) => boolean;
  processActive: (process: ProcessRecord) => boolean;
  familyActive: (family: AgentTabFamily) => boolean;
  // An agent's activity, with the subagents below it.
  activity: (session: SessionRecord) => RowActivity;
  sessionAttention: (session: SessionRecord) => SidebarAttention | null;
  familyAttention: (family: AgentTabFamily) => SidebarAttention | null;
  selectSession: (rootId: string, session: SessionRecord) => void;
  selectProcess: (process: ProcessRecord) => void;
  navigate: (page: SidebarPage) => void;
  // The saved layout: folders, and which tabs are filed in them.
  layout: ComputedRef<TabLayout>;
  // Moves a tab beside others in its folder, or out of folders.
  moveTab: (key: string, beforeKey: string | null, afterKey: string | null) => void;
  // Files a tab in a folder, or takes it out with null.
  placeTab: (key: string, folder: string | null, beforeKey?: string | null, afterKey?: string | null) => void;
  moveFolder: (id: string, beforeKey: string | null, afterKey: string | null) => void;
  createFolder: (name: string, keys: readonly string[]) => TabFolder;
  renameFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void;
}

export const sidebarContextKey: InjectionKey<SidebarContext> = Symbol('sidebarContext');

export function useSidebar(): SidebarContext {
  const context = inject(sidebarContextKey);
  if (!context) throw new Error('Sidebar context missing');
  return context;
}

export interface SidebarInput {
  projectId: () => string;
  shown: () => boolean;
  tabs: () => StripTab[];
  allAgents: () => boolean;
  projects: () => ProjectSummary[];
  projectOf: (id: string) => ProjectSummary | null;
  shownProjectIds: () => readonly string[];
  processes: () => ProcessRecord[];
  timers: () => TimerRecord[];
  worktreeCount: () => number;
  repository: () => boolean;
  activeTerminalId: () => string | null;
  activeSessionId: () => string | null;
  page: () => SidebarPage | null;
  selectSession: (rootId: string, session: SessionRecord) => void;
  selectProcess: (process: ProcessRecord) => void;
  navigate: (page: SidebarPage) => void;
  layout: () => TabLayout;
  updateLayout: (edit: (layout: TabLayout) => TabLayout) => void;
}

// The list row a session or process belongs to: the agent family that holds
// the session, or whose agents started the process.
export function familyTabOf(sidebar: SidebarContext, of: { sessionId?: string | null | undefined; processId?: string | null | undefined }): AgentTab | null {
  return sidebar.tabs.value.find((tab): tab is AgentTab => tab.kind === 'agent' && (
    (Boolean(of.sessionId) && tab.family.options.some((option) => option.session.id === of.sessionId))
    || (Boolean(of.processId) && sidebar.ownedProcesses(tab.family).some((process) => process.id === of.processId))
  )) ?? null;
}

export function provideSidebarContext(input: SidebarInput): SidebarContext {
  const owned = computed(() => new Map(input.tabs().flatMap((tab) => tab.kind === 'agent'
    ? [[tab.family.rootId, ownedProcessesForSessions(tab.family.options.map((option) => option.session), input.processes())] as const]
    : [])));
  const ownedProcesses = (family: AgentTabFamily) => owned.value.get(family.rootId) ?? [];
  const familyTimers = (family: AgentTabFamily) => {
    const ids = new Set<string>(ownedProcesses(family).map((process) => process.id));
    for (const option of family.options) if (option.session.processId) ids.add(option.session.processId);
    return timersForProcesses(input.timers(), ids);
  };
  const sessionActive = (session: SessionRecord) => matchesAgentTabSelection(session, input.activeTerminalId(), input.activeSessionId());
  const processActive = (process: ProcessRecord) => Boolean(input.activeTerminalId() && process.ptyProcessId === input.activeTerminalId());
  const activityFor = computed(() => activityLookup(input.tabs().flatMap((tab) => tab.kind === 'agent' ? [tab.family] : [])));

  // Ticks so timer countdowns stay current.
  const now = ref(Date.now());
  const clock = setInterval(() => { now.value = Date.now(); }, 1_000);
  onBeforeUnmount(() => clearInterval(clock));

  const context: SidebarContext = {
    projectId: computed(input.projectId),
    shown: computed(input.shown),
    tabs: computed(input.tabs),
    allAgents: computed(input.allAgents),
    expansionScope: computed(() => input.allAgents() ? ALL_AGENTS_SCOPE : input.projectId()),
    projects: computed(input.projects),
    projectOf: (tab) => input.projectOf(tab.kind === 'agent' ? tab.family.rootId : tab.process.id),
    shownProjectIds: computed(input.shownProjectIds),
    page: computed(input.page),
    worktreeCount: computed(input.worktreeCount),
    repository: computed(input.repository),
    now,
    ownedProcesses,
    familyTimers,
    memberCount: (family) => family.options.length - 1 + ownedProcesses(family).length,
    sessionActive,
    processActive,
    familyActive: (family) => family.options.some((option) => sessionActive(option.session)) || ownedProcesses(family).some(processActive),
    activity: (session) => activityFor.value(session),
    unreadUrgency,
    sessionAttention: (session) => sessionAttention(context, session),
    familyAttention: (family) => familyAttention(context, family),
    selectSession: input.selectSession,
    selectProcess: input.selectProcess,
    navigate: input.navigate,
    layout: computed(input.layout),
    // Snoozed tabs wait at the end and keep their places.
    moveTab: (key, beforeKey, afterKey) => {
      const tab = input.tabs().find((candidate) => candidate.key === key);
      if (tab && !tabSnoozed(tab)) input.updateLayout((layout) => placeInLayout(layout, key, { folder: tab.folder, before: beforeKey, after: afterKey }));
    },
    // The list slides the row to its new place.
    placeTab: (key, folder, beforeKey = null, afterKey = null) => input.updateLayout((layout) => placeInLayout(layout, key, { folder, before: beforeKey, after: afterKey })),
    moveFolder: (id, beforeKey, afterKey) => input.updateLayout((layout) => placeInLayout(layout, folderKey(id), { folder: null, before: beforeKey, after: afterKey })),
    createFolder: (name, keys) => {
      const folder = { id: randomId(), name };
      input.updateLayout((layout) => createFolderInLayout(layout, folder, keys));
      return folder;
    },
    renameFolder: (id, name) => input.updateLayout((layout) => renameFolderInLayout(layout, id, name)),
    deleteFolder: (id) => input.updateLayout((layout) => deleteFolderFromLayout(layout, id)),
  };
  provide(sidebarContextKey, context);
  return context;
}
