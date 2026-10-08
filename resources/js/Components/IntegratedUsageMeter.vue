<template>
  <!-- Context fill as a ring and percentage, with the session cost. The
       tooltip lists every figure the provider reported. -->
  <Tooltip>
    <TooltipTrigger as-child>
      <button
        type="button"
        class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs tabular-nums text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        :aria-label="`Session usage: ${rows.map((row) => `${row.label} ${row.value}`).join(', ')}`"
        data-component="integrated-usage"
      >
        <template v-if="percent !== null">
          <svg viewBox="0 0 16 16" class="h-4 w-4 -rotate-90" :class="usageToneClass(percent)" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" opacity="0.2" />
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" :stroke-dasharray="`${(percent / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`" />
          </svg>
          <span>{{ percent }}%</span>
        </template>
        <!-- Narrow screens keep the ring and drop the cost beside it. -->
        <span v-if="usage.costUsd !== undefined" :class="percent !== null ? 'hidden text-muted-foreground/70 sm:inline' : ''">{{ percent !== null ? '· ' : '' }}{{ formatCost(usage.costUsd) }}</span>
        <span v-else-if="percent === null">{{ rows[0]?.value }}</span>
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" align="end" class="min-w-52">
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 py-0.5 tabular-nums">
        <template v-for="row in rows" :key="row.label">
          <dt class="opacity-60">{{ row.label }}</dt>
          <dd class="text-right">{{ row.value }}</dd>
        </template>
      </dl>
    </TooltipContent>
  </Tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import type { IntegratedUsage } from '../lib/integratedConversation';
import { contextPercent, formatCost, usageRows, usageToneClass } from '../lib/integratedUsage';

const CIRCUMFERENCE = 2 * Math.PI * 6;

const props = defineProps<{ usage: IntegratedUsage }>();
const percent = computed(() => contextPercent(props.usage));
const rows = computed(() => usageRows(props.usage));
</script>
