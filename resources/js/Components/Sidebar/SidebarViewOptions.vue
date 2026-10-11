<template>
  <!-- How the list shows its agents, remembered on this device. -->
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button type="button" aria-label="Sidebar view options" title="View options" class="flex h-7 w-7 shrink-0 items-center justify-center rounded-tab text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <SlidersHorizontal class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-56">
      <DropdownMenuItem class="pl-8 text-[13px]" @select="expansion.setAll(true)">Expand all</DropdownMenuItem>
      <DropdownMenuItem class="pl-8 text-[13px]" @select="expansion.setAll(false)">Collapse all</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem v-model="expansion.state.value.groupByStatus" class="text-[13px]" @select.prevent>Group by status</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem v-model="expansion.state.value.followActive" class="text-[13px]" @select.prevent>Open the agent I'm in</DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem v-model="expansion.state.value.summaries" class="text-[13px]" @select.prevent>Show every summary</DropdownMenuCheckboxItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { SlidersHorizontal } from 'lucide-vue-next';
import { useSidebarExpansion } from '../../Composables/useSidebarExpansion';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { useSidebar } from './sidebarContext';

const sidebar = useSidebar();
const expansion = useSidebarExpansion(() => sidebar.projectId.value);
</script>
