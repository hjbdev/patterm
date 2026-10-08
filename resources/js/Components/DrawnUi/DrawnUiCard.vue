<template>
  <p v-if="!parsed.ok" class="text-xs text-muted-foreground" data-component="drawn-ui-invalid">This figure could not be drawn: {{ parsed.errors[0] }}</p>
  <section v-else class="drawn-ui group/drawn relative w-full min-w-0 py-1 text-sm" data-component="drawn-ui" :aria-label="parsed.value.title ?? 'Figure'">
    <svg width="0" height="0" class="absolute" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="drawn-ui-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--drawn-hatch)" stroke-width="2" />
        </pattern>
      </defs>
    </svg>
    <Button
      size="sm"
      variant="ghost"
      class="absolute right-0 top-0 z-10 h-6 px-2 text-xs text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/drawn:opacity-100 [@media(hover:none)]:opacity-100"
      :class="showSource ? 'opacity-100' : ''"
      :aria-pressed="showSource"
      @click="showSource = !showSource"
    >{{ showSource ? 'Figure' : 'Source' }}</Button>
    <pre v-if="showSource" class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 font-mono text-[11px] leading-5 text-muted-foreground">{{ source }}</pre>
    <template v-else>
      <h3 v-if="parsed.value.title" class="mb-3 pr-16 text-base font-semibold">{{ parsed.value.title }}</h3>
      <DrawnUiInputs v-if="parsed.value.inputs?.length" :inputs="parsed.value.inputs" :values="sharedValues" />
      <DrawnUiSection v-for="(section, index) in parsed.value.sections" :key="index" :section="section" :images="images" :shared="shared" :shared-values="sharedValues" :class="index ? 'mt-6' : ''" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { Button } from '../ui/button';
import DrawnUiSection from './DrawnUiSection.vue';
import DrawnUiInputs from './DrawnUiInputs.vue';
import { drawnUiImages, drawnUiToolInput, parseDrawnUi, type DrawnUiResult } from '../../../../app/Services/DrawnUi';
import type { TranscriptMessage } from '../../lib/integratedConversation';

const props = defineProps<{ message: TranscriptMessage }>();
const input = computed(() => props.message.tool ? drawnUiToolInput(props.message.tool) : null);
const source = computed(() => JSON.stringify(input.value, null, 2) ?? '');
// Re-reads of the conversation hand over equal but new objects; a figure is
// parsed once per content, so its chart is not rebuilt on every poll.
const parsed = computed(() => cachedParse(source.value, input.value));
const images = computed(() => props.message.tool ? drawnUiImages(props.message.tool) : {});
const shared = computed(() => parsed.value.ok ? { inputs: parsed.value.value.inputs, constants: parsed.value.value.constants } : {});
const showSource = ref(false);
// Sliders shared by every section start where the agent put them.
const sharedValues = reactive<Record<string, number>>({});
watch(parsed, (result) => {
  for (const input of result.ok ? result.value.inputs ?? [] : []) if (!(input.id in sharedValues)) sharedValues[input.id] = input.value;
}, { immediate: true });
</script>

<script lang="ts">
const parses = new Map<string, DrawnUiResult>();
function cachedParse(key: string, input: unknown): DrawnUiResult {
  let result = parses.get(key);
  if (!result) {
    result = parseDrawnUi(input);
    if (parses.size >= 64) parses.delete(parses.keys().next().value!);
    parses.set(key, result);
  }
  return result;
}
</script>

<style>
/* Drawn figures speak in meanings; these map them onto the app theme. */
.drawn-ui {
  --drawn-fg: hsl(var(--foreground));
  --drawn-text: hsl(var(--muted-foreground));
  --drawn-grid: hsl(var(--muted-foreground));
  --drawn-neutral: hsl(var(--muted-foreground) / 0.55);
  --drawn-muted: hsl(var(--muted-foreground) / 0.3);
  --drawn-accent: hsl(217 91% 64%);
  --drawn-good: hsl(var(--success));
  --drawn-warn: hsl(var(--warning));
  --drawn-bad: hsl(var(--destructive));
  --drawn-soft: hsl(var(--muted) / 0.7);
  --drawn-hatch: hsl(var(--muted-foreground) / 0.45);
  --drawn-on-fill: hsl(var(--background));
  --drawn-card: hsl(var(--card));
  --drawn-accent-wash: color-mix(in srgb, var(--drawn-accent) 14%, transparent);
  --drawn-good-wash: color-mix(in srgb, var(--drawn-good) 13%, transparent);
  --drawn-warn-wash: color-mix(in srgb, var(--drawn-warn) 13%, transparent);
  --drawn-bad-wash: color-mix(in srgb, var(--drawn-bad) 12%, transparent);
  --ts-chart-tooltip-background: hsl(var(--popover));
  --ts-chart-tooltip-color: hsl(var(--popover-foreground));
  --ts-chart-tooltip-border: 1px solid hsl(var(--border));
  --ts-chart-tooltip-border-radius: 6px;
  --ts-chart-tooltip-font: 12px/1.4 var(--patterm-ui-font-family, inherit);
  --ts-chart-focus-fill: hsl(var(--foreground) / 0.06);
}
.drawn-ui .drawn-hatch {
  background: repeating-linear-gradient(135deg, var(--drawn-hatch) 0 2px, transparent 2px 5px);
  box-shadow: inset 0 0 0 1px var(--drawn-hatch);
}
</style>
