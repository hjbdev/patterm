<template>
  <div class="min-w-0">
    <p v-if="error" class="text-xs text-muted-foreground">This chart could not be drawn: {{ error }}</p>
    <template v-else-if="compiled">
      <Chart :definition="compiled.definition" :aria-label="chart.title ?? 'Chart'" :height="compiled.height" class="drawn-chart w-full" @select="select" />
      <div v-if="compiled.legend.length" class="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
        <span v-for="item in compiled.legend" :key="item.label" class="inline-flex items-center gap-1.5">
          <i class="inline-block h-2.5 w-2.5 rounded-sm" :class="item.state === 'unknown' ? 'drawn-hatch' : ''" :style="item.state === 'unknown' ? undefined : item.state === 'projected' ? { outline: `1.5px dashed ${item.color}`, outlineOffset: '-1.5px' } : { background: item.color }" />
          {{ item.label }}
        </span>
      </div>
      <p v-if="chart.mark === 'cell'" class="mt-1.5 min-h-5 text-xs text-muted-foreground" aria-live="polite">{{ picked ?? 'Select a cell for detail.' }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watchEffect } from 'vue';
import { Chart } from '@tanstack/charts/vue';
import { compileChart, type CompiledChart } from '../../lib/drawnChart';
import type { DrawnChart } from '../../../../app/Services/DrawnUi';

const props = defineProps<{ chart: DrawnChart }>();
const compiled = shallowRef<CompiledChart | null>(null);
const error = ref('');
const picked = ref<string | null>(null);

// A new definition object redraws the chart, so it is rebuilt only when the
// spec (or a slider feeding it) changes.
watchEffect(() => {
  try {
    compiled.value = compileChart(props.chart);
    error.value = '';
  } catch (cause) {
    compiled.value = null;
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
});

const colorLabel = computed(() => {
  const labels = new Map<string, string>();
  for (const [key, value] of Object.entries(props.chart.colors ?? {})) labels.set(key, typeof value === 'string' ? key : value.label ?? key);
  return labels;
});

function select(point: { datum?: unknown } | null): void {
  if (props.chart.mark !== 'cell' || !point?.datum || typeof point.datum !== 'object') return;
  const row = point.datum as Record<string, unknown>;
  const state = props.chart.color ? String(row[props.chart.color] ?? '') : '';
  picked.value = `${String(row[props.chart.y] ?? '')} · ${String(row[props.chart.x] ?? '')}: ${colorLabel.value.get(state) ?? state}${typeof row.note === 'string' ? `. ${row.note}` : ''}`;
}
</script>

<style>
.drawn-chart { color: hsl(var(--muted-foreground)); font-size: 11px; }
.drawn-chart .ts-chart__axes text { fill: hsl(var(--muted-foreground)); fill-opacity: 0.85; }
.drawn-chart .ts-chart__text { font-family: inherit; }
</style>
