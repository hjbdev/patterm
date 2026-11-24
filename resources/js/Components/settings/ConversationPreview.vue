<template>
  <div
    class="overflow-hidden rounded-lg border border-white/[0.06] bg-[#080808]"
    :style="{ fontFamily }"
    data-component="conversation-preview"
  >
    <div class="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-1.5 text-[11px] text-muted-foreground">
      <span>Preview</span>
      <span class="truncate tabular-nums">{{ specLabel }}</span>
    </div>
    <div class="bg-background px-3 py-4 sm:px-4" :style="{ fontSize: `${fontSizePx}px` }">
      <div class="mx-auto transition-[width] duration-200 ease-out motion-reduce:transition-none" :style="{ width: proseWidth }">
        <div class="mb-[1.25em] flex justify-end">
          <div class="max-w-[85%] rounded-xl bg-muted px-[0.95em] py-[0.65em] leading-relaxed text-foreground">
            Compare the layout presets
          </div>
        </div>
        <p class="font-semibold leading-snug text-foreground" style="font-size: 1.1429em">Layout summary</p>
        <p class="mt-[0.75em] leading-[1.7] text-foreground/90">
          Prose stays easy to scan, while <code class="rounded bg-secondary/50 px-1 py-0.5 font-mono text-[0.85em] text-foreground">tables</code>, figures, and images can use extra room.
        </p>
      </div>
      <div class="mx-auto mt-[1.4em] overflow-x-auto transition-[width] duration-200 ease-out motion-reduce:transition-none" :style="{ width: breakoutWidth }">
        <table class="w-full border-collapse text-left leading-[1.58]" style="font-size: 0.9286em">
          <thead>
            <tr class="border-b border-border text-muted-foreground">
              <th class="py-[0.7em] pr-[1.25em] font-medium">Element</th>
              <th class="py-[0.7em] pr-[1.25em] font-medium">Measure</th>
              <th class="py-[0.7em] text-right font-medium">Behaviour</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/70 text-foreground/90">
            <tr>
              <td class="py-[0.85em] pr-[1.25em] font-medium text-foreground">Prose</td>
              <td class="py-[0.85em] pr-[1.25em] text-muted-foreground">{{ widthShort }}</td>
              <td class="py-[0.85em] text-right text-muted-foreground">Column width</td>
            </tr>
            <tr>
              <td class="py-[0.85em] pr-[1.25em] font-medium text-foreground">Tables &amp; figures</td>
              <td class="py-[0.85em] pr-[1.25em] text-muted-foreground">{{ effectiveBreakoutLabel }}</td>
              <td class="py-[0.85em] text-right text-muted-foreground">{{ breaksOut ? 'Breaks out' : 'Matches prose' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mx-auto mt-[1.4em] transition-[width] duration-200 ease-out motion-reduce:transition-none" :style="{ width: breakoutWidth }">
        <div class="rounded-lg border border-border/70 bg-white/[0.02] px-3 py-2">
          <div class="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span class="font-medium text-foreground/85">HTML figure</span>
            <span class="tabular-nums">{{ breaksOut ? 'Wide frame' : 'Column width' }}</span>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <div class="h-2 rounded-full bg-white/20" />
            <div class="h-2 rounded-full bg-white/12" />
            <div class="h-2 rounded-full bg-white/8" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ConversationBreakout, ConversationWidth } from '../../appearance/AppearanceSettings';

const props = defineProps<{
  fontSizePx: number;
  width: ConversationWidth;
  breakout: ConversationBreakout;
  fontFamily: string;
}>();

const PROSE_PERCENT: Record<ConversationWidth, number> = {
  narrow: 64,
  default: 74,
  wide: 86,
  full: 100
};

const WIDTH_LABELS: Record<ConversationWidth, string> = {
  narrow: 'Narrow (680 px)',
  default: 'Default (800 px)',
  wide: 'Wide (1040 px)',
  full: 'Full width'
};

const WIDTH_SHORT: Record<ConversationWidth, string> = {
  narrow: '680 px',
  default: '800 px',
  wide: '1040 px',
  full: 'Full'
};

const prosePercent = computed(() => PROSE_PERCENT[props.width]);
const proseWidth = computed(() => `${prosePercent.value}%`);
const breaksOut = computed(() => props.width !== 'full' && props.breakout !== 'off');
const breakoutWidth = computed(() => {
  if (!breaksOut.value) return proseWidth.value;
  if (props.breakout === 'full') return '100%';
  return `${Math.min(96, prosePercent.value + 18)}%`;
});

const widthShort = computed(() => WIDTH_SHORT[props.width]);
const effectiveBreakoutLabel = computed(() => {
  if (props.width === 'full') return 'Full';
  if (props.breakout === 'full') return 'Full pane';
  if (props.breakout === 'wider') return 'Wider';
  return WIDTH_SHORT[props.width];
});

const specLabel = computed(() => {
  const parts = [`${props.fontSizePx} px`, WIDTH_LABELS[props.width]];
  if (props.width !== 'full' && props.breakout !== 'off') {
    parts.push(props.breakout === 'full' ? 'Full breakout' : 'Wider breakout');
  }
  return parts.join(' · ');
});
</script>
