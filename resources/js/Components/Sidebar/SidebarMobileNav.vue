<template>
  <!-- Narrow screens: the current item opens the sidebar's list in the same
       drawer as tabs mode, rising from the bottom within reach of a thumb. -->
  <div class="min-w-0 flex-1 sm:hidden">
    <ResponsiveMenu v-model:open="sidebarLayout.mobileOpen" mobile-only title="Agents">
      <template #trigger>
        <button type="button" class="relative isolate flex h-[30px] w-full min-w-0 items-center gap-2 rounded-tab bg-primary/10 px-2 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Open navigation">
          <template v-if="current.session">
            <TabWash :activity="sidebar.activity(current.session)" />
            <RowStatus :activity="sidebar.activity(current.session)" />
          </template>
          <span class="min-w-0 flex-1 truncate">{{ current.label }}<HostBadge v-if="current.host" :host="current.host" class="ml-1.5" /></span>
          <span v-if="attentionCount" class="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground"><span class="font-semibold text-warning">?</span>{{ attentionCount }}</span>
          <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </template>
      <template #header-actions>
        <div class="flex items-center gap-0.5">
          <BoardButton />
          <SidebarViewOptions />
          <LaunchAgentMenu :project-id="sidebar.projectId.value" nested @started="sidebarLayout.mobileOpen = false" />
        </div>
      </template>
      <template #mobile>
        <SidebarList placement="mobile" />
      </template>
      <template #mobile-footer>
        <SidebarPages class="mt-1 border-t border-white/5 px-1 pt-2" />
      </template>
    </ResponsiveMenu>
  </div>

  <div class="hidden flex-1 sm:block" />
</template>

<script setup lang="ts">
import HostBadge from '../HostBadge.vue';
import { computed } from 'vue';
import { useSelectedHarnessLaunch } from '../../Composables/useHarnessLaunch';
import { harnessLaunchLabel } from '../../lib/harnessLaunches';
import { ChevronDown } from 'lucide-vue-next';
import { agentLabel } from '../../lib/agentTabs';
import type { SessionRecord } from '../../types';
import LaunchAgentMenu from '../LaunchAgentMenu.vue';
import ResponsiveMenu from '../ResponsiveMenu.vue';
import RowStatus from '../RowStatus.vue';
import TabWash from '../TabWash.vue';
import BoardButton from './BoardButton.vue';
import { useSidebar } from './sidebarContext';
import { sidebarLayout } from './sidebarLayout';
import SidebarList from './SidebarList.vue';
import SidebarPages from './SidebarPages.vue';
import SidebarViewOptions from './SidebarViewOptions.vue';

const sidebar = useSidebar();
const activeLaunch = useSelectedHarnessLaunch();
const PAGE_LABELS = { worktrees: 'Worktrees', history: 'History', todos: 'Todos', scratchpads: 'Scratchpads', media: 'Media' } as const;

const current = computed<{ label: string; root?: SessionRecord; rootSelect?: () => void; child?: string; session?: SessionRecord; host?: string | undefined }>(() => {
  const launch = activeLaunch.value;
  if (launch) return { label: harnessLaunchLabel(launch), host: launch.input.host };
  const page = sidebar.page.value;
  if (page) return { label: PAGE_LABELS[page] };
  for (const tab of sidebar.tabs.value) {
    if (tab.kind === 'process') {
      if (sidebar.processActive(tab.process)) return { label: tab.process.name, child: tab.process.name, host: tab.process.host };
      continue;
    }
    const root = tab.family.root.session;
    const rootSelect = () => sidebar.selectSession(tab.family.rootId, root);
    const option = tab.family.options.find((candidate) => sidebar.sessionActive(candidate.session));
    if (option) return option.session === root
      ? { label: agentLabel(root), root, rootSelect, session: root, host: root.host }
      : { label: agentLabel(option.session), root, rootSelect, child: agentLabel(option.session), session: option.session, host: option.session.host };
    const process = sidebar.ownedProcesses(tab.family).find(sidebar.processActive);
    if (process) return { label: process.name, root, rootSelect, child: process.name, host: process.host };
  }
  return { label: 'Agents' };
});

const attentionCount = computed(() => sidebar.tabs.value.filter((tab) => tab.kind === 'agent' && sidebar.familyAttention(tab.family) && !sidebar.familyActive(tab.family)).length);

</script>
