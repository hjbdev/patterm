<template>
  <!-- A subagent count inside a 16px status ring, fitted to the UI font (see
       ringCountFit). It uses the font's default proportional digits, which
       are what the canvas measures. -->
  <span class="ring-count" aria-hidden="true">
    <svg viewBox="0 0 14 14"><text x="7" :y="fit.baseline" :font-size="fit.size">{{ count }}</text></svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ringCountFit } from '../lib/ringCount';

const props = defineProps<{ count: number }>();

const fit = computed(() => ringCountFit(String(props.count)));
</script>

<style scoped>
.ring-count {
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
</style>
