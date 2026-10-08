<template>
  <DrawerRoot v-if="mobile" v-model:open="open" :nested="nested ?? false">
    <DrawerTrigger as-child><slot name="trigger" /></DrawerTrigger>
    <DrawerPortal v-if="open">
      <DrawerOverlay class="fixed inset-0 z-50 bg-black/80" />
      <DrawerContent class="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl border border-border bg-background px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-foreground shadow-lg outline-none">
        <DrawerHandle class="mx-auto my-3 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/40" />
        <div class="mb-3 flex items-center justify-between gap-3">
          <DrawerTitle class="text-lg font-semibold">{{ title }}</DrawerTitle>
          <slot name="header-actions" />
        </div>
        <div class="min-h-0 overflow-y-auto overscroll-contain">
          <slot name="mobile" />
        </div>
      </DrawerContent>
    </DrawerPortal>
  </DrawerRoot>
  <DropdownMenu v-else-if="!mobileOnly" v-model:open="open" :modal="false">
    <DropdownMenuTrigger as-child><slot name="trigger" /></DropdownMenuTrigger>
    <DropdownMenuContent :align="align ?? 'start'" :class="desktopClass" @pointerenter="emit('contentPointerEnter')" @pointerleave="emit('contentPointerLeave')" @open-auto-focus="emit('openAutoFocus', $event)" @close-auto-focus="emit('closeAutoFocus', $event)" @keydown="emit('contentKeydown')">
      <slot name="desktop" />
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { watch } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { DrawerContent, DrawerHandle, DrawerOverlay, DrawerPortal, DrawerRoot, DrawerTitle, DrawerTrigger } from 'vaul-vue';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './ui/dropdown-menu';

withDefaults(defineProps<{
  title: string;
  align?: 'start' | 'center' | 'end';
  desktopClass?: string;
  mobileOnly?: boolean;
  nested?: boolean;
}>(), { align: 'start', desktopClass: '' });

const emit = defineEmits<{
  contentPointerEnter: [];
  contentPointerLeave: [];
  contentKeydown: [];
  openAutoFocus: [event: Event];
  closeAutoFocus: [event: Event];
}>();

const open = defineModel<boolean>('open', { default: false });
const mobile = useMediaQuery('(max-width: 639px)');
watch(mobile, () => { open.value = false; });
</script>
