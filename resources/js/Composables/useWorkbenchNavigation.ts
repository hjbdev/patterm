import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useWorkbench } from './useWorkbench';
import type { ProjectViewMode } from '../lib/workbenchNavigation';
import { lastProjectLocation, resolveProjectReturnPath } from '../lib/projectLocations';
import { allAgents } from '../lib/allAgents';
import { phoneLayout } from '../lib/phoneLayout';

export function useWorkbenchNavigation() {
  const route = useRoute();
  const router = useRouter();
  const { projects, refresh, archivedSessions, archivedProcesses, loadArchived } = useWorkbench();
  const activeProjectId = computed(() => typeof route.params.projectId === 'string' ? route.params.projectId : null);
  const activeProject = computed(() => projects.value.find((item) => item.project.id === activeProjectId.value) ?? null);
  const routeSessionId = computed(() => typeof route.params.sessionId === 'string' ? route.params.sessionId : null);
  const routeProcessId = computed(() => typeof route.params.processId === 'string' ? route.params.processId : null);
  const selectedAgent = computed(() => {
    const id = routeSessionId.value;
    return id ? activeProject.value?.projectSessions.find((session) => session.id === id) ?? archivedSessions.value.get(id) ?? null : null;
  });
  const selectedProcess = computed(() => {
    const id = routeProcessId.value;
    return id ? activeProject.value?.processes.find((process) => process.id === id) ?? archivedProcesses.value.get(id) ?? null : null;
  });
  // Links to sessions and processes that ended before the snapshot's window
  // read them on demand.
  watch([activeProject, routeSessionId, routeProcessId], ([project, sessionId, processId]) => {
    if (!project) return;
    if (sessionId && !project.projectSessions.some((session) => session.id === sessionId)) void loadArchived(project.project.id, { sessionId });
    if (processId && !project.processes.some((process) => process.id === processId)) void loadArchived(project.project.id, { processId });
  }, { immediate: true });
  const activeTerminalId = computed(() => {
    if (selectedAgent.value && !selectedAgent.value.exitedAt) return selectedAgent.value.ptyProcessId;
    return selectedProcess.value?.status === 'running' ? selectedProcess.value.ptyProcessId : null;
  });
  const projectViewMode = computed<ProjectViewMode>(() => route.name === 'todos' || route.name === 'scratchpads' ? route.name : route.name === 'worktrees' ? 'worktrees' : 'agents');
  const activeWorkspacePage = computed(() => route.name === 'history' ? 'history' : 'workbench');

  function selectProject(projectId: string | null) {
    // A phone opens a project at its list, which is the phone's home screen.
    if (projectId && projectId !== activeProjectId.value && !phoneLayout.value) {
      const project = projects.value.find((item) => item.project.id === projectId);
      const returnPath = resolveProjectReturnPath(project, lastProjectLocation(projectId));
      if (returnPath) return router.push(returnPath);
    }
    return router.push(projectId ? { name: 'project', params: { projectId } } : { name: 'projects' });
  }

  async function selectTerminal(projectId: string, terminalId: string) {
    // Launch responses can arrive before the workbench-change notification.
    let project = projects.value.find((item) => item.project.id === projectId);
    if (!project?.projectSessions.some((item) => item.ptyProcessId === terminalId && !item.exitedAt)
      && !project?.processes.some((item) => item.ptyProcessId === terminalId && item.status === 'running')) {
      await refresh();
      project = projects.value.find((item) => item.project.id === projectId);
    }
    const session = project?.projectSessions.find((item) => item.ptyProcessId === terminalId && !item.exitedAt);
    const process = project?.processes.find((item) => item.ptyProcessId === terminalId && item.status === 'running');
    if (session) return router.push({ name: 'agent', params: { projectId, sessionId: session.id } });
    if (process) return router.push({ name: 'process', params: { projectId, processId: process.id } });
  }

  async function selectLaunchedAgent(sessionId: string, terminalId: string | null = null) {
    const projectId = activeProjectId.value;
    if (!projectId) return;
    if (terminalId) return selectTerminal(projectId, terminalId);
    await refresh();
    const session = projects.value.find((item) => item.project.id === projectId)?.projectSessions.find((item) => item.id === sessionId && !item.exitedAt);
    if (session) return router.push({ name: 'agent', params: { projectId, sessionId } });
  }

  // Choosing a project by hand also leaves All agents.
  function pickProject(projectId: string | null) {
    if (projectId) allAgents.active = false;
    return selectProject(projectId);
  }

  function switchViewMode(mode: ProjectViewMode) {
    const projectId = activeProjectId.value;
    if (!projectId) return;
    if (mode === 'todos' || mode === 'scratchpads') return router.push({ name: mode, params: { projectId } });
    if (mode === 'worktrees') return router.push({ name: 'worktrees', params: { projectId } });
    if (selectedAgent.value) return router.push({ name: 'agent', params: { projectId, sessionId: selectedAgent.value.id } });
    return selectProject(projectId);
  }

  function openConversationHistory() {
    if (activeProjectId.value) return router.push({ name: 'history', params: { projectId: activeProjectId.value } });
  }

  return { route, router, activeProjectId, activeProject, selectedAgent, selectedProcess, activeTerminalId,
    projectViewMode, activeWorkspacePage, selectProject, pickProject, selectTerminal, selectLaunchedAgent, switchViewMode, openConversationHistory };
}
