<template>
  <!-- Content that shimmers while work runs, like ShimmerText but for any
       content, icons included: it keeps its own colour, and a foreground copy
       on top shows through a band that sweeps across it. -->
  <span class="working-shimmer-host">
    <slot />
    <span v-if="active" class="working-shimmer-shine" aria-hidden="true"><slot /></span>
  </span>
</template>

<script setup lang="ts">
defineProps<{ active: boolean }>();
</script>

<style scoped>
.working-shimmer-host {
  position: relative;
  display: inline-flex;
}

/* Laid out like the host, so the copy sits exactly over the original. */
.working-shimmer-shine {
  position: absolute;
  inset: 0;
  display: inherit;
  align-items: inherit;
  justify-content: inherit;
  gap: inherit;
  color: hsl(var(--foreground));
  pointer-events: none;
  mask-image: linear-gradient(90deg, transparent 35%, #000 50%, transparent 65%);
  mask-size: 300% 100%;
  mask-repeat: no-repeat;
  animation: loader-working-shimmer 1.2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes loader-working-shimmer {
  0% { mask-position: 100% 0; }
  85%, 100% { mask-position: 0% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .working-shimmer-shine {
    display: none;
  }
}
</style>
