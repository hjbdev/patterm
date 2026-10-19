<template>
  <!-- Opens the canvas, the project's page, or goes back from it. -->
  <Tooltip>
    <TooltipTrigger as-child>
      <button
        type="button"
        aria-label="Canvas"
        :aria-pressed="board.open.value"
        :class="cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-tab text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          board.open.value && 'bg-primary/10 text-foreground'
        )"
        @click="board.toggle"
      >
        <Workflow class="h-3.5 w-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent :side="side ?? 'top'" class="bg-popover text-popover-foreground">Canvas <kbd class="ml-1 rounded border border-border/70 px-1 text-[10px]">Ctrl ⇧ Space</kbd></TooltipContent>
  </Tooltip>
</template>

<script setup lang="ts">
import { Workflow } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { useBoardRoute } from '../../Composables/useBoard';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

defineProps<{ side?: 'top' | 'right' | 'bottom' | 'left' }>();
const board = useBoardRoute();
</script>
