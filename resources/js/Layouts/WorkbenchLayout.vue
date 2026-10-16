<template>
  <TooltipProvider :delay-duration="300">
    <CommandPalette v-model:open="paletteOpen"
      :context="commandContext"
      @navigate="navigateCommandResult"
      @workspace-search="searchQuery = $event; searchOpen = true"
      @settings="openSettings"
      @usage="openUsage"
      @routines="openRoutines"
      @refresh="refresh"
      @open-target="navigateSearchResult"
    />

    <WorkspaceSearchDialog v-model:open="searchOpen" :initial-query="searchQuery" @navigate="navigateSearchResult">
      <template #trigger>
        <span class="hidden" />
      </template>
    </WorkspaceSearchDialog>

    <!-- The docked assistant takes a column on the right; everything else narrows beside it. -->
    <div class="bg-[#080808]" :class="assistantDocked ? 'pr-[calc(var(--assistant-dock-width)+0.375rem)]' : ''">
    <RouterView v-if="showStandalonePage" />

    <!-- On phones the bar sits at the bottom, within thumb reach. -->
    <div v-else data-workbench :data-keyboard="keyboardOpen || undefined" class="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#080808] text-foreground">
      <WorkbenchTopBar
        data-workbench-bar
        class="max-sm:order-last"
        :projects="projects"
        :active-project-id="activeProjectId"
        :sidecar-status="sidecarStatus"
        :sidecar-available="sidecarAvailable"
        :show-recent-projects="showRecentProjects"
        :all-agents="showingAll"
        :all-agents-count="activeAgentModeSessions.length"
        @select-project="pickProject"
        @select-all-agents="allAgents.active = true"
        @command-palette="paletteOpen = true"
        @settings="openSettings"
          @usage="openUsage"
          @routines="openRoutines"
      >
        <template v-if="activeProject" #terminal-tabs>
          <!-- Phones get the same tab menu in either navigation mode. -->
          <div class="min-w-0 flex-1 sm:hidden">
            <MobileTabs
              :project-id="activeProject.project.id"
              :families="currentAgentFamilies"
              :processes="currentStripProcesses"
              :all-processes="scopeProcesses"
              :project-of="showingAll ? projectOf : undefined"
              :shown-project-ids="showingAll ? shownProjectIds : undefined"
              :active-terminal-id="activeWorkspacePage === 'workbench' && projectViewMode === 'agents' ? activeTerminalId : null"
              :active-session-id="activeWorkspacePage === 'workbench' && projectViewMode === 'agents' ? selectedAgent?.id ?? null : null"
              @select="(rootId, session) => selectAgentTabTarget({ rootId, session })"
              @select-process="selectAgentProcess"
            />
          </div>
          <div v-if="sidebarMode" class="hidden flex-1 sm:block" />
          <!-- The vertical padding leaves room for a tab's mention glow, which the scroller would clip. -->
          <div v-else class="-my-2 hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto py-2 [scrollbar-width:none] sm:flex" @wheel="scrollTabStrip">
            <TabStrip
              v-if="currentStripTabs.length"
              class="shrink-0"
              :tabs="shownStripTabs"
              :grouped-by-project="groupedByProject"
              :sessions="activeAgentModeSessions"
              :processes="scopeProcesses"
              :timers="scopeTimers"
              :project-of="showingAll ? projectOf : undefined"
              :active-terminal-id="activeWorkspacePage === 'workbench' && projectViewMode === 'agents' ? activeTerminalId : null"
              :active-session-id="activeWorkspacePage === 'workbench' && projectViewMode === 'agents' ? selectedAgent?.id : null"
              :selected-by-root="selectedAgentByRoot"
              @update:selected-by-root="selectedAgentByRoot = $event"
              @update:layout="updateCurrentTabLayout"
              @select="selectAgentSession"
              @select-process="selectAgentProcess"
            />
            <HarnessLaunchTabs v-for="projectId in shownProjectIds" :key="projectId" :project-id="projectId" />
            <div class="flex shrink-0 items-center">
              <AllAgentsOptions v-if="showingAll" />
              <LaunchAgentMenu
                :project-id="activeProject.project.id"
                :choose-project="showingAll"
              />
            </div>
          </div>
        </template>
      </WorkbenchTopBar>

      <div class="flex min-h-0 flex-1">
      <WorkbenchSidebar v-if="sidebarMode" />

      <main id="workbench-main" class="relative mx-1.5 mb-1.5 max-sm:mb-0 max-sm:mt-1.5 min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border-t border-white/5 bg-background">
        <div v-if="!loaded" class="p-5 text-sm text-muted-foreground">Loading project…</div>
        <div v-else-if="!activeProject" class="p-5 text-sm text-muted-foreground">Project not found. Select another project from the toolbar.</div>
        <RouterView v-else />
        <div
          v-if="navigationMode"
          role="status"
          class="pointer-events-none absolute bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-primary/40 bg-popover/95 px-3 py-1.5 text-xs text-muted-foreground shadow-lg"
        >
          <span class="font-medium text-foreground">Navigate</span>
          <span class="flex items-center gap-1"><kbd class="rounded border border-border/70 px-1 text-[10px]">A</kbd><kbd class="rounded border border-border/70 px-1 text-[10px]">D</kbd> tabs</span>
          <span class="flex items-center gap-1"><kbd class="rounded border border-border/70 px-1 text-[10px]">W</kbd><kbd class="rounded border border-border/70 px-1 text-[10px]">S</kbd> subagents</span>
          <span class="flex items-center gap-1"><kbd class="rounded border border-border/70 px-1 text-[10px]">1–9</kbd> jump</span>
          <span class="flex items-center gap-1"><kbd class="rounded border border-border/70 px-1 text-[10px]">Esc</kbd> done</span>
        </div>
      </main>
      </div>
    </div>
    </div>

    <AssistantDock />
    <CloseConfirmDialog />
    <template v-if="sidebarMode">
      <SidebarDialogs />
    </template>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref } from 'vue';
import { RouterView } from 'vue-router';
import { useMediaQuery } from '@vueuse/core';
import AssistantDock from '../Components/Assistant/AssistantDock.vue';
import CloseConfirmDialog from '../Components/CloseConfirmDialog.vue';
import CommandPalette from '../Components/CommandPalette.vue';
import LaunchAgentMenu from '../Components/LaunchAgentMenu.vue';
import HarnessLaunchTabs from '../Components/HarnessLaunchTabs.vue';
import MobileTabs from '../Components/MobileTabs.vue';
import TabStrip from '../Components/TabStrip.vue';
import WorkbenchTopBar from '../Components/WorkbenchTopBar.vue';
import AllAgentsOptions from '../Components/AllAgentsOptions.vue';
import WorkspaceSearchDialog from '../Components/WorkspaceSearchDialog.vue';
import SidebarDialogs from '../Components/Sidebar/SidebarDialogs.vue';
import WorkbenchSidebar from '../Components/Sidebar/WorkbenchSidebar.vue';
import { provideSidebarContext } from '../Components/Sidebar/sidebarContext';
import { TooltipProvider } from '../Components/ui/tooltip';
import { APPEARANCE_SETTINGS_CHANGED_EVENT, applyUiFont, lastKnownAppearanceSettings, loadAppearanceSettings, navigationLayoutHint, normalizeAppearanceSettings, type AppearanceSettings, type NavigationLayout } from '../appearance/AppearanceSettings';
import { useWorkbench } from '../Composables/useWorkbench';
import { useHarnessLaunchCleanup, useHarnessLaunchesFor } from '../Composables/useHarnessLaunch';
import { useSoftKeyboard } from '../Composables/useSoftKeyboard';
import { useWorkbenchNavigation } from '../Composables/useWorkbenchNavigation';
import {
  agentOptionTargetByDelta,
  activeAgentSessions,
  buildAgentTabFamilies,
  matchesAgentTabSelection,
  type AgentTabSelectionTarget,
  type SelectedAgentByRoot
} from '../lib/agentTabs';
import { assistantLayout } from '../lib/assistantLayout';
import { assistant } from '../lib/assistant';
import { openCommandPaletteKey } from '../lib/commandPalette';
import { isNavigationModeToggle, navigationModeAction } from '../lib/navigationMode';
import { activeProcesses, topLevelProcessesForSessions } from '../lib/processTabs';
import { buildStripTabs, readStoredTabLayout, writeStoredTabLayout, type StripTab, type TabLayout } from '../lib/tabStrip';
import { ALL_AGENTS_SCOPE, allAgents, buildAllAgentsView, listedProjects, projectShown, tabsGroupedByProject } from '../lib/allAgents';
import { useSidebarExpansion } from '../Composables/useSidebarExpansion';
import type { ProcessRecord, ProjectSummary, SessionRecord } from '../types';
import { startPrefetch } from '../lib/prefetch';

const { projects, sidecarStatus, sidecarAvailable, loaded, refresh } = useWorkbench();
const { router, route, activeProjectId, activeProject, selectedAgent, selectedProcess, activeTerminalId, projectViewMode,
  activeWorkspacePage, selectProject, pickProject, selectTerminal } = useWorkbenchNavigation();
useHarnessLaunchCleanup();
// Reads ahead what the user is likely to open next, as the connection allows.
startPrefetch(() => activeProjectId.value);
const selectedAgentByRoot = ref<SelectedAgentByRoot>({});
const pendingLaunches = useHarnessLaunchesFor(() => shownProjectIds.value);
const navigationMode = ref(false);
const tabLayoutByProject = ref<Record<string, TabLayout>>({});
const paletteOpen = ref(false);
provide(openCommandPaletteKey, () => { paletteOpen.value = true; });
const searchOpen = ref(false);
const searchQuery = ref('');
const mobile = useMediaQuery('(max-width: 639px)');
const keyboardOpen = useSoftKeyboard();
const assistantDocked = computed(() => assistant.enabled && assistantLayout.open && assistantLayout.docked && !assistantLayout.expanded && !mobile.value);
const showStandalonePage = computed(() => !activeProjectId.value || route.name === 'settings' || route.name === 'usage' || route.name === 'routines' || route.name === 'routineLog');

function openSettings(): void {
  void router.push({ name: 'settings' });
}

// The tab strip hides its scrollbar, so map vertical mouse wheels to horizontal scroll.
function scrollTabStrip(event: WheelEvent): void {
  const strip = event.currentTarget as HTMLElement;
  if (event.deltaX !== 0 || event.deltaY === 0 || strip.scrollWidth <= strip.clientWidth) return;
  strip.scrollLeft += event.deltaY;
  event.preventDefault();
}

function openUsage(): void {
  void router.push({ name: 'usage' });
}

function openRoutines(): void {
  void router.push({ name: 'routines' });
}

onMounted(async () => {
  window.addEventListener('keydown', handleAgentTabShortcut, true);
  window.addEventListener('pointerdown', exitNavigationMode, true);
  window.addEventListener('blur', exitNavigationMode);
  // Shared with the terminal pane, which needs the same settings before its first paint.
  const settings = await loadAppearanceSettings();
  applyUiFont(settings);
  navigation.value = settings.navigation;
  showRecentProjects.value = settings.recentProjects;
  window.addEventListener(APPEARANCE_SETTINGS_CHANGED_EVENT, handleAppearanceSettingsChanged);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleAgentTabShortcut, true);
  window.removeEventListener('pointerdown', exitNavigationMode, true);
  window.removeEventListener('blur', exitNavigationMode);
  window.removeEventListener(APPEARANCE_SETTINGS_CHANGED_EVENT, handleAppearanceSettingsChanged);
});

function handleAppearanceSettingsChanged(event: Event): void {
  const settings = normalizeAppearanceSettings((event as CustomEvent<AppearanceSettings>).detail);
  applyUiFont(settings);
  navigation.value = settings.navigation;
  showRecentProjects.value = settings.recentProjects;
}

function handleAgentTabShortcut(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (!navigationMode.value && (!isNavigationModeToggle(event) || isEditableShortcutTarget(event.target))) return;

  const action = navigationModeAction(event, navigationMode.value);
  if (action.type === 'none') return;
  if (action.type === 'exit') {
    navigationMode.value = false;
    if (!action.consume) return;
  } else if (action.type === 'enter') {
    navigationMode.value = true;
  } else if (action.type === 'option') {
    const target = agentOptionTargetByDelta(currentAgentFamilies.value, activeTerminalId.value, action.delta, selectedAgent.value?.id ?? null);
    if (target) selectAgentTabTarget(target);
  } else {
    selectNavigationTab(action.type === 'jump' ? action.index : null, action.type === 'tab' ? action.delta : 0);
  }
  event.preventDefault();
  event.stopPropagation();
}

// Top-bar tabs in visual order, pinned tabs first.
function selectNavigationTab(index: number | null, delta: number): void {
  const tabs = shownStripTabs.value.map((tab) => tab.kind === 'agent'
    ? {
        id: tab.key,
        selected: tab.family.options.some((option) => matchesAgentTabSelection(option.session, activeTerminalId.value, selectedAgent.value?.id ?? null))
          || activeProjectProcesses.value.some((process) => activeTerminalId.value && process.ptyProcessId === activeTerminalId.value && tab.family.options.some((option) => option.session.processId === process.parentProcessId)),
        select: () => selectAgentTabTarget({ rootId: tab.family.rootId, session: tab.family.active })
      }
    : { id: tab.key, selected: Boolean(activeTerminalId.value && tab.process.ptyProcessId === activeTerminalId.value), select: () => selectAgentProcess(tab.process) });
  tabs.push(...pendingLaunches.value.map((launch) => ({
    id: launch.id,
    selected: route.name === 'launch' && route.params.launchId === launch.id,
    select: () => { void router.push({ name: 'launch', params: { projectId: launch.input.projectId, launchId: launch.id } }); }
  })));
  if (!tabs.length) return;
  const current = tabs.findIndex((tab) => tab.selected);
  const target = tabs[index ?? (current + delta + tabs.length) % tabs.length];
  if (!target) return;
  const focusedTab = document.activeElement instanceof HTMLElement && document.activeElement.hasAttribute('data-patterm-tab-id');
  target.select();
  if (focusedTab) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[data-patterm-tab-id]')]
      .find((element) => element.dataset.pattermTabId === target.id);
    button?.focus();
  }
}

function exitNavigationMode(): void {
  navigationMode.value = false;
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // Agent inputs keep tab shortcuts, matching terminal tabs.
  if (target.dataset.pattermTerminalInput === 'true' || target.hasAttribute('data-patterm-integrated-input')) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function selectAgentTabTarget(target: AgentTabSelectionTarget): void {
  selectedAgentByRoot.value = { ...selectedAgentByRoot.value, [target.rootId]: target.session.id };
  selectAgentSession(target.session);
}

// All agents keeps one order of its own, apart from each project's.
const tabLayoutScope = computed(() => showingAll.value ? ALL_AGENTS_SCOPE : activeProjectId.value);

function updateCurrentTabLayout(layout: TabLayout): void {
  const scope = tabLayoutScope.value;
  if (!scope) return;
  tabLayoutByProject.value = { ...tabLayoutByProject.value, [scope]: layout };
  writeStoredTabLayout(scope, layout);
}

const currentTabLayout = computed(() => {
  const scope = tabLayoutScope.value;
  if (!scope) return undefined;
  return tabLayoutByProject.value[scope] ?? readStoredTabLayout(scope);
});

// All agents lists every shown project's agents instead of the route's
// project's. Opening one goes to its own project and keeps the list.
const showingAll = computed(() => allAgents.active && Boolean(activeProject.value));
const allAgentsView = computed(() => buildAllAgentsView(projects.value, allAgents.hidden));
const scopeProcesses = computed(() => showingAll.value ? allAgentsView.value.processes : activeProject.value?.processes ?? []);
const scopeTimers = computed(() => showingAll.value ? allAgentsView.value.timers : activeProject.value?.timers ?? []);
const listedSummaries = computed(() => listedProjects(projects.value).map((item) => item.project));
// The projects whose agents and starting launches show.
const shownProjectIds = computed(() => showingAll.value
  ? listedSummaries.value.filter((project) => projectShown(allAgents, project.id)).map((project) => project.id)
  : activeProjectId.value ? [activeProjectId.value] : []);
function projectOf(id: string): ProjectSummary | null {
  return allAgentsView.value.owners.get(id) ?? null;
}
// The project a session or process opens in.
function ownerProjectId(id: string): string | null {
  return (showingAll.value ? projectOf(id)?.id : null) ?? activeProject.value?.project.id ?? null;
}

const agentModeSessions = computed<SessionRecord[]>(() => showingAll.value ? allAgentsView.value.sessions : activeProject.value?.projectSessions ?? []);
const activeAgentModeSessions = computed<SessionRecord[]>(() => activeAgentSessions(agentModeSessions.value));
const activeProjectProcesses = computed<ProcessRecord[]>(() => activeProcesses(scopeProcesses.value));
const topLevelProcesses = computed(() => topLevelProcessesForSessions(activeAgentModeSessions.value, activeProjectProcesses.value));
const currentStripTabs = computed(() => buildStripTabs(
  buildAgentTabFamilies(activeAgentModeSessions.value, selectedAgentByRoot.value),
  topLevelProcesses.value,
  currentTabLayout.value
));
// Grouped by project, the top bar's tabs keep each project's together; the
// sidebar groups its own list.
const allAgentsOptions = useSidebarExpansion(() => ALL_AGENTS_SCOPE);
const groupedByProject = computed(() => showingAll.value && allAgentsOptions.state.value.groupByProject);
const shownStripTabs = computed(() => groupedByProject.value ? tabsGroupedByProject(currentStripTabs.value, listedSummaries.value, stripTabProject) : currentStripTabs.value);
function stripTabProject(tab: StripTab): ProjectSummary | null {
  return projectOf(tab.kind === 'agent' ? tab.family.rootId : tab.process.id);
}
const currentAgentFamilies = computed(() => currentStripTabs.value.flatMap((tab) => tab.kind === 'agent' ? [tab.family] : []));
const currentStripProcesses = computed(() => currentStripTabs.value.flatMap((tab) => tab.kind === 'process' ? [tab.process] : []));

// Agents show as tabs or in the sidebar, as chosen in Settings → Appearance.
const navigation = ref<NavigationLayout>(navigationLayoutHint());
const showRecentProjects = ref(lastKnownAppearanceSettings()?.recentProjects ?? false);
const sidebarMode = computed(() => navigation.value === 'sidebar' && Boolean(activeProject.value) && !showStandalonePage.value);
const agentPage = computed(() => activeWorkspacePage.value === 'workbench' && projectViewMode.value === 'agents');
provideSidebarContext({
  projectId: () => activeProjectId.value ?? '',
  shown: () => sidebarMode.value,
  tabs: () => shownStripTabs.value,
  processes: () => scopeProcesses.value,
  timers: () => scopeTimers.value,
  allAgents: () => showingAll.value,
  projects: () => listedSummaries.value,
  projectOf,
  shownProjectIds: () => shownProjectIds.value,
  worktreeCount: () => activeProject.value?.worktrees.length ?? 0,
  repository: () => activeProject.value?.project.kind !== 'personal',
  activeTerminalId: () => agentPage.value ? activeTerminalId.value : null,
  activeSessionId: () => agentPage.value ? selectedAgent.value?.id ?? null : null,
  page: () => route.name === 'worktrees' || route.name === 'history' || route.name === 'todos' || route.name === 'scratchpads' || route.name === 'media' ? route.name : null,
  selectSession: (rootId, session) => selectAgentTabTarget({ rootId, session }),
  selectProcess: selectAgentProcess,
  navigate: (page) => { if (activeProjectId.value) void router.push({ name: page, params: { projectId: activeProjectId.value } }); },
  updateLayout: updateCurrentTabLayout,
});

// Integrated agents have no terminal, so the palette also gets the routed agent
// or process. IDs, not records: a record changes on every workbench update.
const activeSessionId = computed(() => selectedAgent.value?.id ?? null);
const activeProcessId = computed(() => selectedProcess.value?.id ?? null);
const commandContext = computed(() => ({
  active_project_id: activeProjectId.value,
  active_terminal_id: activeTerminalId.value,
  active_tab: activeWorkspacePage.value === 'history' ? 'history' : projectViewMode.value,
  active_session_id: activeSessionId.value,
  active_process_id: activeProcessId.value
}));

function selectAgentSession(session: SessionRecord): void {
  const projectId = ownerProjectId(session.id);
  if (!projectId || session.processStatus === 'closed') return;
  if (session.interfaceMode === 'integrated') void router.push({ name: 'agent', params: { projectId, sessionId: session.id } });
  else if (!session.exitedAt && session.ptyProcessId) selectTerminal(projectId, session.ptyProcessId);
}

function selectAgentProcess(process: ProcessRecord): void {
  const projectId = ownerProjectId(process.id);
  if (!projectId || !process.ptyProcessId || process.status !== 'running') return;
  selectTerminal(projectId, process.ptyProcessId);
}

interface SearchResultTarget {
  project_id: string | null;
  tab: string | null;
  terminal_process_id: string | null;
  record_id?: string;
  conversation_id?: string | null;
  conversation_message_id?: string | null;
}

function navigateSearchResult(target: SearchResultTarget): void {
  const projectId = target.project_id ?? activeProjectId.value;
  if (!projectId) return;
  if (target.tab === 'history') {
    void router.push({ name: 'history', params: { projectId }, query: {
      conversation: target.conversation_id ?? undefined, message: target.conversation_message_id ?? undefined
    } });
  } else if (target.terminal_process_id) {
    void selectTerminal(projectId, target.terminal_process_id);
  } else if (target.tab === 'worktrees' || target.tab === 'todos' || target.tab === 'scratchpads' || target.tab === 'media') {
    void router.push({ name: target.tab, params: { projectId, ...((target.tab === 'todos' || target.tab === 'scratchpads') && target.record_id ? { recordId: target.record_id } : {}) } });
  } else {
    void selectProject(projectId);
  }
}

interface CommandNavigateTarget {
  projectId?: string | undefined;
  tab?: string | undefined;
  terminalProcessId?: string | undefined;
  sessionId?: string | undefined;
  processId?: string | undefined;
  recordId?: string | undefined;
}

function navigateCommandResult(target: CommandNavigateTarget): void {
  if (target.projectId && target.sessionId) {
    void router.push({ name: 'agent', params: { projectId: target.projectId, sessionId: target.sessionId } });
    return;
  }
  if (target.projectId && target.processId) {
    void router.push({ name: 'process', params: { projectId: target.projectId, processId: target.processId } });
    return;
  }
  navigateSearchResult({ project_id: target.projectId ?? null, tab: target.tab ?? null, terminal_process_id: target.terminalProcessId ?? null, ...(target.recordId ? { record_id: target.recordId } : {}) });
}

</script>
