<template>
  <!-- Project pages, always in view below the agents, with anything else for the footer after them. -->
  <nav aria-label="Project" class="flex items-center gap-0.5">
    <Tooltip v-for="link in links" :key="link.page" :disabled="Boolean(labelled)">
      <TooltipTrigger as-child>
        <button
          type="button"
          :aria-label="link.count ? `${link.label} (${link.count})` : link.label"
          :aria-current="sidebar.page.value === link.page ? 'page' : undefined"
          class="relative flex items-center justify-center rounded-tab text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :class="[labelled ? 'min-h-11 min-w-14 flex-col gap-1 px-1 py-1.5' : 'h-8 w-8', sidebar.page.value === link.page && 'bg-primary/10 text-foreground']"
          @click="sidebar.navigate(link.page)"
        >
          <component :is="link.icon" class="h-4 w-4" />
          <span v-if="labelled" aria-hidden="true" class="text-[10px] leading-none">{{ link.label }}</span>
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

// Labelled under each icon where there is no pointer to show a tooltip.
defineProps<{ labelled?: boolean }>();
const sidebar = useSidebar();
const links = computed(() => projectPages(sidebar));
</script>
