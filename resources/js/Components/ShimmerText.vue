<template>
  <span class="shimmer-text">
    <span>{{ text }}</span>
    <span class="shimmer-window" aria-hidden="true">
      <span class="shimmer-highlight">{{ text }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
defineProps<{ text: string }>();
</script>

<style scoped>
/*
 * The shine is a masked window that slides across the text while a bright copy
 * of the text counter-slides inside it, so the glyphs stay still. Both
 * animations only change transform, which the compositor runs without repainting.
 */
.shimmer-text {
  position: relative;
  display: inline-block;
  white-space: nowrap;
  animation: shimmer-fade-in 240ms ease-out;
}

.shimmer-window {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  mask-image: linear-gradient(90deg, transparent 20%, #000 50%, transparent 80%);
  animation: shimmer-sweep 2.2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  will-change: transform;
}

.shimmer-highlight {
  display: block;
  color: hsl(var(--foreground));
  animation: shimmer-counter-sweep 2.2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  will-change: transform;
}

@keyframes shimmer-sweep {
  0% { transform: translateX(-100%); }
  70%, 100% { transform: translateX(100%); }
}

@keyframes shimmer-counter-sweep {
  0% { transform: translateX(100%); }
  70%, 100% { transform: translateX(-100%); }
}

@keyframes shimmer-fade-in {
  from { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .shimmer-text {
    animation: none;
  }

  .shimmer-window {
    display: none;
  }
}
</style>
