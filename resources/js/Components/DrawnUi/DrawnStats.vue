<template>
  <!-- With detail lines the tiles become a worked example: inputs, sum, result. -->
  <div class="grid min-w-0 gap-y-4" :class="worked ? 'grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))]' : 'grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-x-5'">
    <div v-for="(item, index) in stats.items" :key="index" class="flex min-w-0 flex-col" :class="worked ? ['pr-4', index ? 'border-l border-border pl-4' : ''] : ''" :title="item.note">
      <p v-if="worked" class="text-sm font-medium">{{ item.label }}</p>
      <div v-if="worked && item.detail" class="mb-1.5 mt-0.5 text-xs text-muted-foreground">
        <p v-for="(line, lineIndex) in item.detail" :key="lineIndex" :class="lineIndex === item.detail.length - 1 ? 'font-mono text-[11px]' : ''">{{ line }}</p>
      </div>
      <p class="text-2xl font-semibold leading-tight tracking-tight tabular-nums" :class="item.state === 'unknown' ? 'text-muted-foreground/60' : item.state === 'projected' ? 'underline decoration-muted-foreground/60 decoration-dashed decoration-[1.5px] underline-offset-[6px]' : ''" :style="item.tone ? { color: toneColor(item.tone) } : undefined">
        {{ valueText(item) }}<span v-if="item.unit && item.of === undefined" class="ml-1 text-sm font-medium text-muted-foreground">{{ item.unit }}</span>
      </p>
      <p v-if="!worked" class="text-xs text-muted-foreground">{{ item.label }}{{ item.state === 'unknown' ? ' · unknown' : item.state === 'projected' ? ' · projected' : '' }}</p>
      <p v-if="item.delta" class="mt-0.5 text-xs" :style="{ color: toneColor(item.delta.tone ?? 'muted') }">{{ item.delta.text }}</p>
      <template v-if="typeof item.of === 'number' && typeof item.value === 'number' && item.of > 0">
        <div class="relative mt-2 h-2.5 overflow-hidden rounded bg-muted">
          <i class="absolute inset-y-0 left-0 min-w-[3px] rounded" :style="{ width: `${Math.min(100, item.value / item.of * 100)}%`, background: toneColor(item.tone ?? 'accent') }" />
        </div>
        <p class="mt-1 text-xs text-muted-foreground">{{ share(item.value, item.of) }} of {{ formatDrawnNumber(item.of) }}{{ item.unit ? ` ${item.unit}` : '' }}</p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatDrawnNumber, type DrawnStats } from '../../../../app/Services/DrawnUi';
import { toneColor } from '../../lib/drawnUi';

const props = defineProps<{ stats: DrawnStats }>();
const worked = computed(() => props.stats.items.some((item) => item.detail?.length));

function valueText(item: DrawnStats['items'][number]): string {
  if (item.state === 'unknown') return '—';
  return `${item.state === 'projected' ? '~' : ''}${formatDrawnNumber(item.value, item.format)}`;
}
function share(value: number, total: number): string {
  const ratio = value / total * 100;
  return `${ratio < 1 ? ratio.toFixed(2) : ratio.toFixed(1)}%`;
}
</script>
