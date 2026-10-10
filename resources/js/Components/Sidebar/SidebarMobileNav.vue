<template>
  <!-- Narrow screens: the current item opens the sidebar in a sheet. -->
  <div class="min-w-0 flex-1 sm:hidden">
    <Sheet v-model:open="sidebarLayout.mobileOpen">
      <SheetTrigger as-child>
        <button type="button" class="relative isolate flex h-[30px] w-full min-w-0 items-center gap-2 rounded-tab bg-primary/10 px-2 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Open navigation">
          <template v-if="current.session">
            <TabWash :activity="sidebar.activity(current.session)" />
            <TabIcon :activity="sidebar.activity(current.session)"><AgentIcon :harness="current.session.harness" class="h-3.5 w-3.5" /></TabIcon>
          </template>
          <span class="min-w-0 flex-1 truncate">{{ current.label }}<HostBadge v-if="current.host" :host="current.host" class="ml-1.5" /></span>
          <span v-if="attentionCount" class="flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground"><span class="font-semibold text-warning">?</span>{{ attentionCount }}</span>
          <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </SheetTrigger>
      <SheetContent side="left" @open-auto-focus.prevent class="flex w-[85vw] max-w-80 flex-col border-white/5 bg-[#0c0c0c] p-0 pb-[env(safe-area-inset-bottom)] pt-12">
        <SheetTitle class="sr-only">Agents</SheetTitle>
        <SheetDescription class="sr-only">Agents, processes, and project pages</SheetDescription>
        <SidebarList placement="sheet" class="min-h-0 flex-1" />
      </SheetContent>
    </Sheet>
  </div>

  <div class="hidden flex-1 sm:block" />
</template>

<script setup lang="ts">
import HostBadge from '../HostBadge.vue';
import { computed } from 'vue';
import { ChevronDown } from 'lucide-vue-next';
import { agentLabel } from '../../lib/agentTabs';
import type { SessionRecord } from '../../types';
import AgentIcon from '../AgentIcon.vue';
import TabIcon from '../TabIcon.vue';
import TabWash from '../TabWash.vue';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '../ui/sheet';
import { useSidebar } from './sidebarContext';
import { sidebarLayout } from './sidebarLayout';
import SidebarList from './SidebarList.vue';

const sidebar = useSidebar();
const PAGE_LABELS = { worktrees: 'Worktrees', history: 'History', todos: 'Todos', scratchpads: 'Scratchpads', media: 'Media' } as const;

const current = computed<{ label: string; root?: SessionRecord; rootSelect?: () => void; child?: string; session?: SessionRecord; host?: string | undefined }>(() => {
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
