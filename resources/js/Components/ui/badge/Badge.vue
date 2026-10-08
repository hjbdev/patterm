<template>
  <div :class="cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors', variantClass, props.class)">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { cn } from '@/lib/utils';

const props = withDefaults(
  defineProps<{
    variant?: 'default' | 'secondary' | 'outline';
    class?: string;
  }>(),
  {
    variant: 'default',
    class: ''
  }
);

const variantClass = computed(() => {
  switch (props.variant) {
    case 'secondary':
      return 'border-transparent bg-secondary text-secondary-foreground';
    case 'outline':
      return 'text-foreground';
    default:
      return 'border-transparent bg-primary text-primary-foreground';
  }
});
</script>
