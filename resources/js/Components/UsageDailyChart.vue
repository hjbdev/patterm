<template>
  <!-- Processed tokens or API cost per day, stacked by harness. Each day column is one
       hover target that lists its figures. -->
  <div ref="root" class="usage-chart relative" data-component="usage-daily-chart">
    <div v-if="series.length > 1" class="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span v-for="harness in series" :key="harness" class="inline-flex items-center gap-1.5">
        <span class="h-2 w-2 rounded-[2px]" :style="{ background: `var(--series-${harness})` }" />{{ harnessLabel(harness) }}
      </span>
    </div>
    <svg v-if="width > 0" :width="width" :height="HEIGHT" class="block overflow-visible" role="img" :aria-label="ariaLabel">
      <g v-for="tick in ticks" :key="tick">
        <line :x1="AXIS" :x2="width" :y1="y(tick)" :y2="y(tick)" stroke="currentColor" class="text-white/[0.06]" />
        <text :x="AXIS - 6" :y="y(tick)" dy="0.32em" text-anchor="end" class="fill-muted-foreground text-[10px] tabular-nums">{{ formatTick(tick) }}</text>
      </g>
      <g v-for="(column, index) in columns" :key="column.day" :opacity="hovered === null || hovered === index ? 1 : 0.45">
        <rect
          v-for="segment in column.segments"
          :key="segment.harness"
          :x="x(index)"
          :y="segment.y"
          :width="barWidth"
          :height="segment.height"
          :rx="segment.top ? Math.min(4, barWidth / 2, segment.height / 2) : 0"
          :fill="`var(--series-${segment.harness})`"
        />
        <!-- Square off the rounded top's lower corners so only the data end is rounded. -->
        <rect
          v-for="segment in column.segments.filter((item) => item.top && item.height > 4)"
          :key="`${segment.harness}-base`"
          :x="x(index)"
          :y="segment.y + segment.height - Math.min(4, segment.height / 2)"
          :width="barWidth"
          :height="Math.min(4, segment.height / 2)"
          :fill="`var(--series-${segment.harness})`"
        />
        <rect :x="x(index) - gap / 2" :y="0" :width="barWidth + gap" :height="PLOT" fill="transparent" @pointerenter="hovered = index" @pointerleave="hovered = null" />
      </g>
      <text v-for="label in xLabels" :key="label.index" :x="x(label.index) + barWidth / 2" :y="HEIGHT - 2" :text-anchor="label.anchor" class="fill-muted-foreground text-[10px]">{{ label.text }}</text>
    </svg>
    <div
      v-if="hoveredColumn"
      class="pointer-events-none absolute z-10 min-w-40 rounded-md border border-white/10 bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-lg"
      :style="tooltipStyle"
    >
      <p class="mb-1 font-medium">{{ longDate(hoveredColumn.day) }}</p>
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 tabular-nums">
        <template v-for="segment in [...hoveredColumn.segments].reverse()" :key="segment.harness">
          <dt class="inline-flex items-center gap-1.5 text-muted-foreground"><span class="h-2 w-2 rounded-[2px]" :style="{ background: `var(--series-${segment.harness})` }" />{{ harnessLabel(segment.harness) }}</dt>
          <dd class="text-right">{{ format(segment.value) }}</dd>
        </template>
        <dt class="text-muted-foreground">Total</dt>
        <dd class="text-right">{{ format(hoveredColumn.total) }}</dd>
      </dl>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { compactTokens } from '../lib/integratedUsage';
import { HARNESSES, formatUsd, harnessLabel, metricValue, type UsageMetric, type UsageSummary } from '../lib/usage';

const HEIGHT = 180;
const PLOT = HEIGHT - 18;
const AXIS = 40;

const props = defineProps<{ summary: UsageSummary; metric: UsageMetric }>();
function format(value: number): string {
  return props.metric === 'tokens' ? compactTokens(value) : formatUsd(value);
}
// Axis ticks drop the cents.
function formatTick(value: number): string {
  if (props.metric === 'tokens') return compactTokens(value);
  return value >= 1_000 ? `$${compactTokens(value)}` : `$${Number(value.toPrecision(3))}`;
}

const root = ref<HTMLElement | null>(null);
const width = ref(0);
const hovered = ref<number | null>(null);
let observer: ResizeObserver | null = null;
onMounted(() => {
  observer = new ResizeObserver(([entry]) => { width.value = Math.floor(entry?.contentRect.width ?? 0); });
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());

// Every day in the range, so quiet days show as gaps. The server lists them
// on its own calendar, which can differ from the browser's.
const days = computed(() => props.summary.dayKeys);

// Colour follows the harness, so a filtered range never repaints survivors.
const series = computed(() => HARNESSES.filter((harness) => props.summary.daily.some((row) => row.provider === harness && metricValue(row, props.metric) > 0)));

const totals = computed(() => {
  const byDay = new Map<string, Map<string, number>>();
  for (const row of props.summary.daily) {
    const day = byDay.get(row.day) ?? new Map<string, number>();
    day.set(row.provider, (day.get(row.provider) ?? 0) + metricValue(row, props.metric));
    byDay.set(row.day, day);
  }
  return byDay;
});

const max = computed(() => Math.max(1, ...days.value.map((day) => [...(totals.value.get(day)?.values() ?? [])].reduce((sum, value) => sum + value, 0))));
const ticks = computed(() => niceTicks(max.value));
const scaleMax = computed(() => ticks.value[ticks.value.length - 1] ?? max.value);

const gap = computed(() => (days.value.length > 45 ? 1 : 2));
const step = computed(() => Math.max(1, (width.value - AXIS) / days.value.length));
const barWidth = computed(() => Math.max(1, Math.min(28, step.value - gap.value)));
function x(index: number): number {
  return AXIS + index * step.value + (step.value - barWidth.value) / 2;
}
function y(value: number): number {
  return PLOT - (value / scaleMax.value) * PLOT;
}

const columns = computed(() => days.value.map((day) => {
  const values = totals.value.get(day);
  let base = PLOT;
  const present = series.value.filter((harness) => (values?.get(harness) ?? 0) > 0);
  const segments = present.map((harness, index) => {
    const value = values!.get(harness)!;
    const full = (value / scaleMax.value) * PLOT;
    // A 2px surface gap separates stacked segments.
    const height = Math.max(1, full - (index > 0 ? 2 : 0));
    base -= full;
    return { harness, value, y: base, height, top: index === present.length - 1 };
  });
  return { day, segments, total: segments.reduce((sum, segment) => sum + segment.value, 0) };
}));

const hoveredColumn = computed(() => hovered.value === null ? null : columns.value[hovered.value] ?? null);

const xLabels = computed(() => {
  const count = days.value.length;
  const indexes = count <= 7 ? days.value.map((_, index) => index) : [0, Math.floor((count - 1) / 2), count - 1];
  return indexes.map((index) => ({ index, text: shortDate(days.value[index]!), anchor: count <= 7 ? 'middle' : index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle' }));
});

const tooltipStyle = computed(() => {
  if (hovered.value === null) return {};
  const left = x(hovered.value) + barWidth.value / 2;
  const flip = left > width.value / 2;
  return flip ? { right: `${width.value - left + 10}px`, top: '24px' } : { left: `${left + 10}px`, top: '24px' };
});

const ariaLabel = computed(() => `${props.metric === 'cost' ? 'API cost' : 'Processed tokens'} per day: ${columns.value.filter((column) => column.total > 0).map((column) => `${shortDate(column.day)} ${format(column.total)}`).join(', ') || 'none'}`);

function niceTicks(value: number): number[] {
  const rough = value / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const stepSize = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? rough;
  return [0, stepSize, stepSize * 2, stepSize * 3].filter((tick, index) => index < 3 || tick - stepSize < value);
}

function parseDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year!, month! - 1, date!);
}
function shortDate(day: string): string {
  return parseDay(day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function longDate(day: string): string {
  return parseDay(day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
</script>

<style scoped>
/* Categorical slots 1–4 of the dark reference palette, fixed per harness. */
.usage-chart {
  --series-claude: #3987e5;
  --series-codex: #d95926;
  --series-opencode: #199e70;
  --series-amp: #c98500;
}
</style>
