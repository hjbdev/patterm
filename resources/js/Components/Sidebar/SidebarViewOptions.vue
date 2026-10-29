<template>
  <!-- How the list shows its agents, remembered on this device. -->
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <!-- With a label, the list's own heading opens it. -->
      <button v-if="label" type="button" :aria-label="`${label}: view options`" :class="cn('flex h-6 items-center gap-1 rounded-tab px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted/50 data-[state=open]:text-foreground', triggerClass)">
        {{ label }}<ChevronDown class="h-3 w-3" aria-hidden="true" />
      </button>
      <button v-else type="button" aria-label="Sidebar view options" title="View options" :class="cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-tab text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', triggerClass)">
        <SlidersHorizontal class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent :align="label ? 'start' : 'end'" class="w-56">
      <DropdownMenuCheckboxItem v-model="expansion.state.value.subtitles" class="text-[13px]" @select.prevent>Show subtitles</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem v-model="expansion.state.value.members" class="text-[13px]" @select.prevent>Show subagents and servers</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem :model-value="groupingByStatus" class="text-[13px]" @update:model-value="setGrouping('status', Boolean($event))" @select.prevent>Group by status</DropdownMenuCheckboxItem>
      <!-- One grouping at a time; with neither, All agents keeps the order you give it. -->
      <DropdownMenuCheckboxItem v-if="sidebar.allAgents.value" :model-value="expansion.state.value.groupByProject" class="text-[13px]" @update:model-value="setGrouping('project', Boolean($event))" @select.prevent>Group by project</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem v-model="expansion.state.value.followActive" class="text-[13px]" @select.prevent>Open the agent I'm in</DropdownMenuCheckboxItem>
      <!-- Shared with the tab strip, which toggles it from the command palette. -->
      <DropdownMenuCheckboxItem :model-value="showSnoozed" class="text-[13px]" @update:model-value="setShowSnoozed(Boolean($event))" @select.prevent>Show snoozed</DropdownMenuCheckboxItem>
      <template v-if="sidebar.allAgents.value">
        <DropdownMenuSeparator />
        <AllAgentsProjectsMenu />
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDown, SlidersHorizontal } from 'lucide-vue-next';
import { useSidebarExpansion } from '../../Composables/useSidebarExpansion';
import { setShowSnoozed, showSnoozed } from '../../Composables/useSnooze';
import AllAgentsProjectsMenu from '../AllAgentsProjectsMenu.vue';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useSidebar } from './sidebarContext';

defineProps<{ label?: string; triggerClass?: string }>();
const sidebar = useSidebar();
const expansion = useSidebarExpansion(() => sidebar.expansionScope.value);
const groupingByStatus = computed(() => expansion.state.value.groupByStatus && !(sidebar.allAgents.value && expansion.state.value.groupByProject));

// Grouping by status and by project take turns.
function setGrouping(by: 'status' | 'project', on: boolean): void {
  const state = expansion.state.value;
  if (by === 'status') state.groupByStatus = on;
  else state.groupByProject = on;
  if (on) state[by === 'status' ? 'groupByProject' : 'groupByStatus'] = false;
}
</script>
