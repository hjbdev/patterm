<template>
  <!-- Which projects All agents shows. Toggling one keeps the menu open, so
       several can be set at once. -->
  <DropdownMenuSub>
    <DropdownMenuSubTrigger class="gap-2 text-[13px]">
      <Layers class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      <span class="flex-1">Projects</span>
      <span class="text-xs tabular-nums text-muted-foreground">{{ shownCount }}/{{ listed.length }}</span>
    </DropdownMenuSubTrigger>
    <DropdownMenuPortal>
      <DropdownMenuSubContent class="max-h-80 w-60 overflow-y-auto">
        <DropdownMenuCheckboxItem
          v-for="item in listed"
          :key="item.project.id"
          :model-value="projectShown(allAgents, item.project.id)"
          class="gap-2 text-[13px]"
          @update:model-value="setProjectShown(allAgents, item.project.id, Boolean($event))"
          @select.prevent
        >
          <ProjectLogo :project="item.project" :size="14" />
          <span class="min-w-0 flex-1 truncate">{{ item.project.name }}</span>
          <HostBadge v-if="item.project.host" :host="item.project.host" />
          <span class="text-xs tabular-nums text-muted-foreground">{{ openAgentCount(item, botHidden.sessions) || '' }}</span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem class="gap-2 text-[13px]" :disabled="!allAgents.hidden.length" @select.prevent="allAgents.hidden = []">
          <ListChecks class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          Show all projects
        </DropdownMenuItem>
        <DropdownMenuItem v-if="current" class="gap-2 text-[13px]" @select.prevent="showOnly(current.project.id)">
          <Crosshair class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span class="truncate">Only {{ current.project.name }}</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuPortal>
  </DropdownMenuSub>
</template>

<script setup lang="ts">
import { useBots } from '../Composables/useBots';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { Crosshair, Layers, ListChecks } from 'lucide-vue-next';
import { useWorkbench } from '../Composables/useWorkbench';
import { allAgents, listedProjects, openAgentCount, projectShown, setProjectShown } from '../lib/allAgents';
import HostBadge from './HostBadge.vue';
import ProjectLogo from './ProjectLogo.vue';
import {
  DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuPortal, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger
} from './ui/dropdown-menu';

// A bot's helpers never count as the project's agents.
const { hidden: botHidden } = useBots();
const { projects } = useWorkbench();
const route = useRoute();
const listed = computed(() => listedProjects(projects.value));
const shownCount = computed(() => listed.value.filter((item) => projectShown(allAgents, item.project.id)).length);
// The project of the page you're on.
const current = computed(() => listed.value.find((item) => item.project.id === route.params.projectId) ?? null);

function showOnly(projectId: string): void {
  allAgents.hidden = listed.value.filter((item) => item.project.id !== projectId).map((item) => item.project.id);
}
</script>
