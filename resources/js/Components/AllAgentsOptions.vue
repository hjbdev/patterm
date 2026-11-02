<template>
  <!-- All agents' view options in the tab strip, as the sidebar has its own. -->
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="icon" class="h-7 w-7 rounded-tab text-muted-foreground" aria-label="All agents options" title="All agents options">
        <SlidersHorizontal class="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-56">
      <DropdownMenuCheckboxItem v-model="expansion.view.value.groupByProject" class="gap-2 text-[13px]" @select.prevent>
        <Folders class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />Group by project
      </DropdownMenuCheckboxItem>
      <DropdownMenuSeparator />
      <AllAgentsProjectsMenu />
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { Folders, SlidersHorizontal } from 'lucide-vue-next';
import { useSidebarExpansion } from '../Composables/useSidebarExpansion';
import { ALL_AGENTS_SCOPE } from '../lib/allAgents';
import AllAgentsProjectsMenu from './AllAgentsProjectsMenu.vue';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

// Shares the sidebar's All agents options, so both layouts group alike.
const expansion = useSidebarExpansion(() => ALL_AGENTS_SCOPE);
</script>
