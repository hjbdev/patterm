<template>
  <!-- A 16px spinner in the style of the assistant orb's working arc: a glowing
       comet circling a faint ring. Each starts at a random point in its loop,
       so spinners on neighbouring rows don't move in step. Only rotation
       animates, which the compositor runs without repainting. -->
  <span class="arc-spinner" aria-hidden="true">
    <span class="arc-spinner-track" />
    <span class="arc-spinner-sweep" :style="{ '--arc-spinner-phase': phase }"><span /></span>
  </span>
</template>

<script setup lang="ts">
const phase = Math.random();
</script>

<style scoped>
.arc-spinner {
  --arc-spinner-ring: radial-gradient(closest-side, transparent calc(100% - 2px), #000 calc(100% - 1.75px) calc(100% - 0.5px), transparent calc(100% - 0.25px));
  position: relative;
  display: block;
  width: 16px;
  height: 16px;
  color: rgb(212 212 216);
}

.arc-spinner-track,
.arc-spinner-sweep,
.arc-spinner-sweep > span {
  position: absolute;
  inset: 0;
  border-radius: 9999px;
}

.arc-spinner-track {
  background: currentColor;
  opacity: 0.2;
  mask: var(--arc-spinner-ring);
}

/* The glow sits on the rotating wrapper, so the ring mask inside doesn't clip it. */
.arc-spinner-sweep {
  --arc-spinner-period: 1.1s;
  filter: drop-shadow(0 0 1.5px currentColor);
  animation: arc-spinner-turn var(--arc-spinner-period) linear infinite;
  animation-delay: calc(var(--arc-spinner-phase) * var(--arc-spinner-period) * -1);
}

.arc-spinner-sweep > span {
  background: conic-gradient(from 0deg, transparent 0deg 60deg, currentColor 300deg, transparent 300.5deg);
  mask: var(--arc-spinner-ring);
}

@keyframes arc-spinner-turn {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .arc-spinner-sweep {
    animation: none;
  }
}
</style>
