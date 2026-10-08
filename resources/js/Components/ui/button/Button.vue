<template>
  <button :class="cn(buttonVariants({ variant, size }), props.class)">
    <slot />
  </button>
</template>

<script setup lang="ts">
import { cn } from '@/lib/utils';
import { buttonVariants, type ButtonSize, type ButtonVariant } from './buttonVariants';

const props = withDefaults(
  defineProps<{
    variant?: ButtonVariant;
    size?: ButtonSize;
    class?: string;
  }>(),
  {
    variant: 'default',
    size: 'default',
    class: ''
  }
);
</script>
