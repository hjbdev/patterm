<template>
  <!-- A subagent count inside a 16px status ring, fitted to the UI font (see
       ringCountFit). It uses the font's default proportional digits, which
       are what the canvas measures. While subagents work, a foreground copy shows through a
       sweeping band, like WorkingShimmer. -->
  <span class="ring-count" aria-hidden="true">
    <svg viewBox="0 0 14 14"><text x="7" :y="fit.baseline" :font-size="fit.size">{{ count }}</text></svg>
    <span v-if="shimmer" class="ring-count-shine">
      <svg viewBox="0 0 14 14"><text x="7" :y="fit.baseline" :font-size="fit.size">{{ count }}</text></svg>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ringCountFit } from '../lib/ringCount';

const props = defineProps<{ count: number; shimmer?: boolean | undefined }>();

const fit = computed(() => ringCountFit(String(props.count)));
</script>

<style scoped>
.ring-count,
.ring-count-shine {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

text {
  fill: currentColor;
  font-family: var(--patterm-ui-font-family);
  font-weight: 600;
  text-anchor: middle;
}

.ring-count-shine {
  color: hsl(var(--foreground));
  mask-image: linear-gradient(90deg, transparent 35%, #000 50%, transparent 65%);
  mask-size: 300% 100%;
  mask-repeat: no-repeat;
  animation: loader-ring-count-shimmer 1.2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes loader-ring-count-shimmer {
  0% { mask-position: 100% 0; }
  85%, 100% { mask-position: 0% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .ring-count-shine {
    display: none;
  }
}
</style>
