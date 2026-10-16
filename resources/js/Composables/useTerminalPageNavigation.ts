import { computed, watch, type Ref } from 'vue';
import { useWorkbenchNavigation } from './useWorkbenchNavigation';
import { projectFirstTab } from '../lib/projectLocations';

export function useTerminalPageNavigation() {
  const navigation = useWorkbenchNavigation();
  const { route, router, activeProject } = navigation;
  const activeAgentId = computed(() => navigation.selectedAgent.value && navigation.selectedAgent.value.processStatus !== 'closed'
    && (!navigation.selectedAgent.value.exitedAt || navigation.selectedAgent.value.interfaceMode === 'integrated')
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
  return navigation;
}

// A project's own page opens its first tab, unless it shows the board. It
// runs before any terminal page mounts there, which the tab would only replace.
export function useProjectFirstTab(boardIsHome: Readonly<Ref<boolean>>) {
  const { route, router, activeProject } = useWorkbenchNavigation();
  const firstTab = computed(() => projectFirstTab(activeProject.value));
  watch([firstTab, boardIsHome, () => route.name], ([tab, board, name]) => {
    if (tab && !board && name === 'project') void router.replace(tab);
  }, { immediate: true });
  return firstTab;
}
