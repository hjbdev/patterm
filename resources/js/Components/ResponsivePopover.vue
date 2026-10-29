<template>
  <!-- A popover, or a bottom sheet on a phone, for content that isn't a menu. -->
  <DrawerRoot v-if="phoneLayout" v-model:open="open">
    <DrawerTrigger as-child><slot name="trigger" /></DrawerTrigger>
    <DrawerPortal>
      <DrawerOverlay class="fixed inset-0 z-50 bg-black/80" />
      <DrawerContent class="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl border border-border bg-background px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] text-foreground shadow-lg outline-none">
        <DrawerHandle class="mx-auto my-3 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/40" />
        <DrawerTitle class="mb-2 px-1 text-lg font-semibold">{{ title }}</DrawerTitle>
        <div class="min-h-0 overflow-y-auto overscroll-contain">
          <slot />
        </div>
      </DrawerContent>
    </DrawerPortal>
  </DrawerRoot>
  <Popover v-else v-model:open="open">
    <PopoverTrigger as-child><slot name="trigger" /></PopoverTrigger>
    <PopoverContent align="start" :aria-label="title" :class="cn('w-80 max-w-[calc(100vw-2rem)] p-1.5', contentClass)">
      <slot />
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { DrawerContent, DrawerHandle, DrawerOverlay, DrawerPortal, DrawerRoot, DrawerTitle, DrawerTrigger } from 'vaul-vue';
import { cn } from '@/lib/utils';
import { phoneLayout } from '../lib/phoneLayout';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

defineProps<{ title: string; contentClass?: string }>();
const open = defineModel<boolean>('open', { default: false });
</script>
