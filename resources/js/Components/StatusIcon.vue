<template>
  <span
    v-if="spec.spinner"
    :class="cn('inline-flex h-4 w-4 shrink-0 items-center justify-center', spec.class, props.class)"
    :aria-label="spec.label"
    :title="spec.label"
    role="img"
  >
    <svg class="status-spinner h-full w-full" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M0 0h24v24H0z" fill="none" />
      <path fill="currentColor" d="M12,1A11,11,0,1,0,23,12,11,11,0,0,0,12,1Zm0,19a8,8,0,1,1,8-8A8,8,0,0,1,12,20Z" opacity=".25" />
      <path fill="currentColor" d="M12,4a8,8,0,0,1,7.89,6.7A1.53,1.53,0,0,0,21.38,12h0a1.5,1.5,0,0,0,1.48-1.75,11,11,0,0,0-21.72,0A1.5,1.5,0,0,0,2.62,12h0a1.53,1.53,0,0,0,1.49-1.3A8,8,0,0,1,12,4Z" />
    </svg>
  </span>
  <span
    v-else-if="spec.ring"
    :class="cn('inline-flex h-4 w-4 shrink-0 items-center justify-center', spec.class, props.class)"
    :aria-label="spec.label"
    :title="spec.label"
    role="img"
  >
    <svg class="h-full w-full" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M0 0h24v24H0z" fill="none" />
      <path fill="currentColor" d="M12,1A11,11,0,1,0,23,12,11,11,0,0,0,12,1Zm0,19a8,8,0,1,1,8-8A8,8,0,0,1,12,20Z" opacity=".55" />
    </svg>
  </span>
  <span
    v-else-if="spec.dot"
    :class="cn('inline-flex h-4 w-4 shrink-0 items-center justify-center', spec.class, props.class)"
    :aria-label="spec.label"
    :title="spec.label"
    role="img"
  >
    <span class="h-2 w-2 rounded-full bg-current" />
  </span>
  <span
    v-else-if="spec.glyph"
    :class="cn('inline-flex h-4 w-4 shrink-0 items-center justify-center font-mono text-sm leading-none', spec.class, props.class)"
    :aria-label="spec.label"
    :title="spec.label"
    role="img"
  >
    {{ spec.glyph }}
  </span>
  <component
    :is="spec.icon"
    v-else
    :class="cn('h-4 w-4 shrink-0', spec.class, spec.spin && 'animate-spin', props.class)"
    :aria-label="spec.label"
    :title="spec.label"
    role="img"
  />
</template>

<script setup lang="ts">
import { cn } from '@/lib/utils';
import type { IconSpec } from '@/lib/statusIcons';

const props = withDefaults(
  defineProps<{
    spec: IconSpec;
    class?: string;
  }>(),
  {
    class: ''
  }
);
</script>

<style scoped>
.status-spinner {
  animation: status-spin 0.75s linear infinite;
  transform-origin: center;
  will-change: transform;
}

@keyframes status-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .status-spinner {
    animation: none;
    will-change: auto;
  }
}
</style>
