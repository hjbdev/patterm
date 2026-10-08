<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <button type="button" aria-label="Collapse sidebar" :class="cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-tab text-muted-foreground transition-[color,background-color,opacity] hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', props.class)" @click="sidebarLayout.collapsed = true">
        <PanelLeftClose class="h-3.5 w-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent class="bg-popover text-popover-foreground">Collapse sidebar <kbd class="ml-1 rounded border border-border/70 px-1 text-[10px]">Ctrl ⇧ B</kbd></TooltipContent>
  </Tooltip>
</template>

<script setup lang="ts">
import { PanelLeftClose } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { sidebarLayout } from './sidebarLayout';

const props = defineProps<{ class?: string | false | undefined }>();
</script>
