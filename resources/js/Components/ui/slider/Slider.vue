<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { SliderRange, SliderRoot, SliderThumb, SliderTrack, type SliderRootEmits, type SliderRootProps, useForwardPropsEmits } from 'reka-ui';
import { reactiveOmit } from '@vueuse/core';
import { cn } from '@/lib/utils';

const props = defineProps<SliderRootProps & { class?: HTMLAttributes['class']; thumbLabel?: string }>();
const emits = defineEmits<SliderRootEmits>();

const delegated = reactiveOmit(props, 'class', 'thumbLabel');
const forwarded = useForwardPropsEmits(delegated, emits);
</script>

<template>
  <SliderRoot
    v-bind="(forwarded as any)"
    :class="cn('relative flex w-full touch-none select-none items-center', props.class)"
  >
    <SliderTrack class="relative h-1.5 w-full grow overflow-hidden rounded-full bg-white/[0.12]">
      <SliderRange class="absolute h-full bg-primary" />
    </SliderTrack>
    <SliderThumb
      :aria-label="thumbLabel"
      class="block h-4 w-4 cursor-pointer rounded-full border border-primary/50 bg-primary shadow transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
    />
  </SliderRoot>
</template>
