<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { Check } from 'lucide-vue-next';
import { SelectItem, SelectItemIndicator, type SelectItemProps, SelectItemText, useForwardProps } from 'reka-ui';
import { reactiveOmit } from '@vueuse/core';
import { cn } from '@/lib/utils';

const props = defineProps<SelectItemProps & { class?: HTMLAttributes['class'] }>();
const delegated = reactiveOmit(props, 'class');
const forwarded = useForwardProps(delegated);
</script>

<template>
  <SelectItem
    v-bind="(forwarded as any)"
    :class="cn(
      'relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-xs outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:opacity-50',
      props.class
    )"
  >
    <span class="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectItemIndicator>
        <Check class="h-3.5 w-3.5" aria-hidden="true" />
      </SelectItemIndicator>
    </span>
    <SelectItemText>
      <slot />
    </SelectItemText>
  </SelectItem>
</template>
