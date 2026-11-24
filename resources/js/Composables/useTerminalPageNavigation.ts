import { computed, inject, watch, type Ref } from 'vue';
import { useWorkbenchNavigation } from './useWorkbenchNavigation';
import { firstDisplayedTabRoute, projectFirstTab } from '../lib/projectLocations';
import { sidebarContextKey } from '../Components/Sidebar/sidebarContext';

export function useTerminalPageNavigation() {
  const navigation = useWorkbenchNavigation();
  const { route, router, activeProject } = navigation;
  const activeAgentId = computed(() => navigation.selectedAgent.value && navigation.selectedAgent.value.processStatus !== 'closed'
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

// A project's own page opens its first tab, unless the page is a home of its
// own, such as a phone's agent list. It runs before any terminal page
// mounts there, which the tab would only replace.
export function useProjectFirstTab(staysHome: Readonly<Ref<boolean>>) {
  const { route, router, activeProject } = useWorkbenchNavigation();
  const sidebar = inject(sidebarContextKey, null);
  const firstTab = computed(() => {
    if (sidebar && activeProject.value && !sidebar.allAgents.value) {
      return firstDisplayedTabRoute(activeProject.value.project.id, sidebar.tabs.value);
    }
    return projectFirstTab(activeProject.value);
  });
  watch([firstTab, staysHome, () => route.name], ([tab, home, name]) => {
    if (tab && !home && name === 'project') void router.replace(tab);
  }, { immediate: true });
  return firstTab;
}
