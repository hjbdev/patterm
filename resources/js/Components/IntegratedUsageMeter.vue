<template>
  <!-- Context fill as a ring and percentage. The tooltip lists every figure
       the provider reported, the cost among them, and when the agent last
       sent a model request; touch screens open it with a tap. -->
  <Tooltip v-model:open="open" :disable-closing-trigger="touch">
    <TooltipTrigger as-child>
      <button
        type="button"
        class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs tabular-nums text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        :aria-label="`Session usage: ${allRows.map((row) => `${row.label} ${row.value}`).join(', ')}`"
        data-component="integrated-usage"
        @click="toggle"
      >
        <template v-if="percent !== null">
          <svg viewBox="0 0 16 16" class="h-4 w-4 -rotate-90" :class="usageToneClass(percent)" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" opacity="0.2" />
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" :stroke-dasharray="`${(percent / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`" />
          </svg>
          <span>{{ percent }}%</span>
        </template>
        <span v-else>{{ usage.costUsd !== undefined ? formatCost(usage.costUsd) : rows[0]?.value }}</span>
      </button>
    </TooltipTrigger>
    <!-- Phones put the meter at the left of the composer, so the tooltip starts there. -->
    <TooltipContent side="top" :align="touch ? 'start' : 'end'" class="min-w-52">
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 py-0.5 tabular-nums">
        <template v-for="row in allRows" :key="row.label">
          <dt class="opacity-60">{{ row.label }}</dt>
          <dd class="text-right">{{ row.value }}</dd>
        </template>
      </dl>
    </TooltipContent>
  </Tooltip>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { elapsedLabel, type IntegratedUsage } from '../lib/integratedConversation';
import { contextPercent, formatCost, usageRows, usageToneClass } from '../lib/integratedUsage';

const CIRCUMFERENCE = 2 * Math.PI * 6;

// `lastRequestAt` is when the agent last sent a model request: prompt caches
// expire after a quiet period.
const props = defineProps<{ usage: IntegratedUsage; lastRequestAt?: string | null | undefined }>();
const percent = computed(() => contextPercent(props.usage));
const rows = computed(() => usageRows(props.usage));
const open = ref(false);
const touch = useMediaQuery('(hover: none)');

// The time ticks only while the tooltip shows it.
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | undefined;
watch(open, (shown) => {
  clearInterval(tick);
  tick = undefined;
  if (!shown) return;
  now.value = Date.now();
  tick = setInterval(() => { now.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => clearInterval(tick));
const allRows = computed(() => props.lastRequestAt
  ? [...rows.value, { label: 'Last request', value: `${elapsedLabel(now.value - Date.parse(props.lastRequestAt))} ago` }]
  : rows.value);

function toggle(): void {
  if (touch.value) open.value = !open.value;
}
</script>
