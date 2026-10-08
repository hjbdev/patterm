<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { ChevronDown } from 'lucide-vue-next';
import { SelectIcon, SelectTrigger, type SelectTriggerProps, useForwardProps } from 'reka-ui';
import { reactiveOmit } from '@vueuse/core';
import { cn } from '@/lib/utils';

const props = defineProps<SelectTriggerProps & { class?: HTMLAttributes['class'] }>();
const delegated = reactiveOmit(props, 'class');
const forwarded = useForwardProps(delegated);
</script>

<template>
  <SelectTrigger
    v-bind="(forwarded as any)"
    :class="cn(
      'flex h-8 w-full min-w-0 items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-2.5 text-left text-xs shadow-sm transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground [&>span]:truncate',
      props.class
    )"
  >
    <slot />
    <SelectIcon as-child>
      <ChevronDown class="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden="true" />
    </SelectIcon>
  </SelectTrigger>
</template>
