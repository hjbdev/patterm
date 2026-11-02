<template>
  <!-- A status label pinned on an agent: a pill washed with its colour, or a
       dot where a row has no room for the name. Either names the label, and
       who set it, in a tooltip. The empty title keeps a row's own native
       title from showing over it. -->
  <Tooltip :open="open" @update:open="open = $event && !noTooltip">
    <TooltipTrigger as-child>
      <span
        v-if="dot"
        v-bind="$attrs"
        class="inline-block h-2 w-2 shrink-0 rounded-full"
        :style="{ backgroundColor: statusLabelDot(label.color) }"
        title=""
        role="img"
        :aria-label="description"
      />
      <span
        v-else
        v-bind="$attrs"
        class="inline-flex h-4 min-w-0 max-w-40 shrink items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium leading-none"
        :style="statusLabelStyle(label.color)"
        title=""
      >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :style="{ backgroundColor: statusLabelDot(label.color) }" aria-hidden="true" />
        <span class="truncate">{{ label.name }}</span>
        <span v-if="label.setBy === 'user'" class="sr-only">, set by you</span>
      </span>
    </TooltipTrigger>
    <TooltipContent class="max-w-64 bg-popover text-popover-foreground">
      <p class="break-words">{{ label.name }}</p>
      <p v-if="label.setBy === 'user'" class="text-muted-foreground">Set by you</p>
    </TooltipContent>
  </Tooltip>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { statusLabelDot, statusLabelStyle, type StatusLabelColor } from '../lib/statusLabels';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

// Classes and attributes go to the pill, not the headless tooltip around it.
defineOptions({ inheritAttrs: false });

// `noTooltip` stands it down while something else already shows the label,
// such as a tab's menu, so the two don't overlap.
const props = defineProps<{
  label: { name: string; color: StatusLabelColor; setBy?: 'agent' | 'user' };
  dot?: boolean;
  noTooltip?: boolean;
}>();

// Held, it refuses to open and closes if it was open, so it can't come back
// when the hold lifts. Its pointer listeners stay on, unlike `disabled`, so
// the next hover still opens it.
const open = ref(false);
watch(() => props.noTooltip, (held) => { if (held) open.value = false; });

const description = computed(() => props.label.setBy === 'user' ? `${props.label.name}, set by you` : props.label.name);
</script>
