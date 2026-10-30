<template>
  <!-- A popover, or a bottom sheet on a phone, for content that isn't a menu.
       With keep-focus, focus stays where it was as it opens and closes. A
       terminal takes focus when the pointer enters it, so focus leaving
       doesn't close it; a click outside or Escape does. -->
  <DrawerRoot v-if="phoneLayout" v-model:open="open">
    <DrawerTrigger as-child><slot name="trigger" /></DrawerTrigger>
    <DrawerPortal>
      <DrawerOverlay class="fixed inset-0 z-50 bg-black/80" />
      <DrawerContent @open-auto-focus="keep" @close-auto-focus="keep" class="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl border border-border bg-background px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] text-foreground shadow-lg outline-none">
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
    <PopoverContent :align="align ?? 'start'" :aria-label="title" :class="cn('w-80 max-w-[calc(100vw-2rem)] p-1.5', contentClass)" @open-auto-focus="keep" @close-auto-focus="keep" @focus-outside.prevent>
      <slot />
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { DrawerContent, DrawerHandle, DrawerOverlay, DrawerPortal, DrawerRoot, DrawerTitle, DrawerTrigger } from 'vaul-vue';
import { cn } from '@/lib/utils';
import { phoneLayout } from '../lib/phoneLayout';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

const props = defineProps<{ title: string; contentClass?: string; align?: 'start' | 'center' | 'end'; keepFocus?: boolean }>();
const open = defineModel<boolean>('open', { default: false });

function keep(event: Event): void {
  if (props.keepFocus) event.preventDefault();
}
</script>
