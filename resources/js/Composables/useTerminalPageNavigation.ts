import { computed, watch } from 'vue';
import { useWorkbenchNavigation } from './useWorkbenchNavigation';
import { activeAgentSessions } from '../lib/agentTabs';
import { activeProcesses } from '../lib/processTabs';

export function useTerminalPageNavigation() {
  const navigation = useWorkbenchNavigation();
  const { route, router, activeProject } = navigation;
  const activeAgentId = computed(() => navigation.selectedAgent.value && !navigation.selectedAgent.value.exitedAt
    ? navigation.selectedAgent.value.id : null);
  watch([() => route.fullPath, navigation.activeTerminalId, activeAgentId], ([path, terminalId, agentId], [previousPath, previousTerminalId, previousAgentId]) => {
    // Only follow an exit on the page being viewed, not an invalid saved link.
    const selectedAgentEnded = route.name === 'agent' && previousAgentId && !agentId;
    const selectedTerminalEnded = previousTerminalId && !terminalId;
    if (path === previousPath && (selectedAgentEnded || selectedTerminalEnded) && activeProject.value
      && (route.name === 'agent' || route.name === 'process')) {
      void router.replace({ name: 'project', params: { projectId: activeProject.value.project.id } });
    }
  });
  watch([activeProject, () => route.name], () => {
    const project = activeProject.value;
    if (!project || route.name !== 'project') return;
    const session = activeAgentSessions(project.projectSessions)[0];
    const process = activeProcesses(project.processes)[0];
    if (session) void router.replace({ name: 'agent', params: { projectId: project.project.id, sessionId: session.id } });
    else if (process) void router.replace({ name: 'process', params: { projectId: project.project.id, processId: process.id } });
  }, { immediate: true });
  return navigation;
}
