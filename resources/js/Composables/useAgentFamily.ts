import { computed } from 'vue';
import { familyTabOf, useSidebar } from '../Components/Sidebar/sidebarContext';
import type { Reference } from '../lib/projectContext';
import { familyServers } from '../lib/servers';
import type { ProcessRecord, SessionRecord } from '../types';
import { linkLabel } from './useSessionContext';

export function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// The rest of an agent's family, whether or not the sidebar lists them, and
// the servers they started, each paired with the preview link that names its port.
export function useAgentFamily(session: () => SessionRecord, previews: () => Reference[]) {
  const sidebar = useSidebar();
  // The list row this agent belongs to. Only list rows pin and snooze.
  const tab = computed(() => familyTabOf(sidebar, { sessionId: session().id }));
  const menuTab = computed(() => session().id === tab.value?.family.rootId ? tab.value : undefined);
  const family = computed(() => tab.value?.family ?? null);
  const agents = computed(() => family.value?.options.filter((option) => option.session.id !== session().id).map((option) => option.session) ?? []);
  const agentsLabel = computed(() => session().id === tab.value?.family.rootId
    ? counted(agents.value.length, 'subagent', 'subagents')
    : counted(agents.value.length, 'agent', 'agents'));
  const servers = computed(() => familyServers(family.value ? sidebar.ownedProcesses(family.value) : [], previews(), linkLabel));
  const serversLabel = computed(() => servers.value.length === 1 ? servers.value[0]!.label : counted(servers.value.length, 'server', 'servers'));

  function openAgent(member: SessionRecord): void {
    if (tab.value) sidebar.selectSession(tab.value.family.rootId, member);
  }
  function openProcess(process: ProcessRecord): void {
    sidebar.selectProcess(process);
  }
  return { sidebar, tab, menuTab, family, agents, agentsLabel, servers, serversLabel, openAgent, openProcess };
}

export type FamilyServer = ReturnType<typeof useAgentFamily>['servers']['value'][number];
