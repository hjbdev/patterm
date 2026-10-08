<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { SelectContent, type SelectContentEmits, type SelectContentProps, SelectPortal, SelectViewport, useForwardPropsEmits } from 'reka-ui';
import { reactiveOmit } from '@vueuse/core';
import { cn } from '@/lib/utils';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<SelectContentProps & { class?: HTMLAttributes['class'] }>(), { position: 'popper', sideOffset: 4 });
const emits = defineEmits<SelectContentEmits>();
const delegated = reactiveOmit(props, 'class');
const forwarded = useForwardPropsEmits(delegated, emits);
</script>

<template>
  <SelectPortal>
    <SelectContent
      v-bind="{ ...forwarded, ...$attrs } as any"
      :class="cn(
        'relative z-50 max-h-[min(var(--reka-select-content-available-height),20rem)] min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
        position === 'popper' && 'w-full min-w-[var(--reka-select-trigger-width)]',
        props.class
      )"
    >
      <SelectViewport class="p-1">
        <slot />
      </SelectViewport>
    </SelectContent>
  </SelectPortal>
</template>
