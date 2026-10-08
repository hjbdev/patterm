<template>
  <!-- Project pages as icons, for the collapsed rail. -->
  <nav class="flex flex-col items-center gap-1" aria-label="Project">
    <Tooltip v-for="link in links" :key="link.page">
      <TooltipTrigger as-child>
        <button
          type="button"
          :aria-label="link.label"
          :aria-current="sidebar.page.value === link.page ? 'page' : undefined"
          class="flex h-8 w-8 items-center justify-center rounded-tab text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :class="sidebar.page.value === link.page && 'bg-primary/10 text-foreground'"
          @click="sidebar.navigate(link.page)"
        >
          <component :is="link.icon" class="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" class="bg-popover text-popover-foreground">{{ link.label }}</TooltipContent>
    </Tooltip>
  </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useSidebar } from './sidebarContext';
import { projectPages } from './sidebarPages';

const sidebar = useSidebar();
const links = computed(() => projectPages(sidebar));
</script>
