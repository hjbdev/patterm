<template>
  <!-- Project pages, always in view below the agents, with anything else for the footer after them. -->
  <nav aria-label="Project" class="flex items-center gap-0.5">
    <Tooltip v-for="link in links" :key="link.page">
      <TooltipTrigger as-child>
        <button
          type="button"
          :aria-label="link.count ? `${link.label} (${link.count})` : link.label"
          :aria-current="sidebar.page.value === link.page ? 'page' : undefined"
          class="relative flex h-8 w-8 items-center justify-center rounded-tab text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :class="sidebar.page.value === link.page && 'bg-primary/10 text-foreground'"
          @click="sidebar.navigate(link.page)"
        >
          <component :is="link.icon" class="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" class="bg-popover text-popover-foreground">{{ link.label }}<span v-if="link.count" class="ml-1.5 text-muted-foreground">{{ link.count }}</span></TooltipContent>
    </Tooltip>
    <slot name="end" />
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
