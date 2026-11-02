<template>
  <!-- A status label pinned on an agent: a pill washed with its colour, or a
       dot where a row has no room for the name. Either names the label, and
       who set it, in a tooltip. The empty title keeps a row's own native
       title from showing over it. -->
  <Tooltip>
    <TooltipTrigger as-child>
      <span
        v-if="dot"
        class="inline-block h-2 w-2 shrink-0 rounded-full"
        :style="{ backgroundColor: statusLabelDot(label.color) }"
        title=""
        role="img"
        :aria-label="description"
      />
      <span
        v-else
        class="inline-flex h-4 min-w-0 max-w-40 shrink items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium leading-none"
        :style="statusLabelStyle(label.color)"
        title=""
      >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :style="{ backgroundColor: statusLabelDot(label.color) }" aria-hidden="true" />
        <span class="truncate">{{ label.name }}</span>
        <span v-if="label.setBy === 'user'" class="sr-only">, set by you</span>
      </span>
    </TooltipTrigger>
    <TooltipContent :side="side ?? 'top'" class="max-w-64 bg-popover text-popover-foreground">
      <p class="break-words">{{ label.name }}</p>
      <p v-if="label.setBy === 'user'" class="text-muted-foreground">Set by you</p>
    </TooltipContent>
  </Tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { statusLabelDot, statusLabelStyle, type StatusLabelColor } from '../lib/statusLabels';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

// `side` moves the tooltip off whatever else opens beside the row, such as a tab's menu below it.
const props = defineProps<{
  label: { name: string; color: StatusLabelColor; setBy?: 'agent' | 'user' };
  dot?: boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
}>();

const description = computed(() => props.label.setBy === 'user' ? `${props.label.name}, set by you` : props.label.name);
</script>
