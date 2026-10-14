<template>
  <!-- A 16px status ring: faint and still when the agent rests, and a comet
       circling it while the agent works, its tail fading up to a bright head.
       The ring is an SVG mask, so its edges are anti-aliased; a radial-gradient
       ring has hard pixel steps that a fading tail shows as chunks. -->
  <span class="status-ring" :data-moving="moving ? '' : undefined" aria-hidden="true">
    <span v-if="moving" class="status-ring-sweep"><span /></span>
  </span>
</template>

<script setup lang="ts">
defineProps<{ moving: boolean }>();
</script>

<style scoped>
.status-ring {
  --status-ring-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6.875' fill='none' stroke='%23000' stroke-width='1.25'/%3E%3C/svg%3E") center / 100% 100% no-repeat;
  position: relative;
  display: block;
  width: 16px;
  height: 16px;
  color: rgb(212 212 216);
}

.status-ring:not([data-moving]) {
  background: rgb(212 212 216 / 0.22);
  mask: var(--status-ring-mask);
}

.status-ring-sweep,
.status-ring-sweep > span {
  position: absolute;
  inset: 0;
  border-radius: 9999px;
}

/* The glow sits on the rotating wrapper, so the ring mask inside doesn't clip it. */
.status-ring-sweep {
  filter: drop-shadow(0 0 1px currentColor);
  animation: loader-status-ring 1.1s linear infinite;
}

.status-ring-sweep > span {
  background: conic-gradient(from 0deg, transparent 0deg 90deg, currentColor 330deg, transparent 330.5deg);
  mask: var(--status-ring-mask);
}

@keyframes loader-status-ring {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .status-ring-sweep {
    animation: none;
  }
}
</style>
