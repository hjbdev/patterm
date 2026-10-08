<template>
  <Transition
    enter-active-class="transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none"
    enter-from-class="-translate-x-4 opacity-0"
    leave-active-class="transition-[transform,opacity] duration-150 ease-in motion-reduce:transition-none"
    leave-to-class="-translate-x-4 opacity-0"
  >
    <aside
      v-if="open"
      ref="panel"
      aria-label="Agents"
      class="fixed bottom-1.5 left-1.5 top-11 z-40 flex w-72 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
      :style="{ left: `${offset}px`, ...(width ? { width: `${width}px` } : {}) }"
      @keydown.esc.stop="emit('close')"
    >
      <div class="min-h-0 flex-1 pt-1"><slot /></div>
      <div class="flex h-9 shrink-0 items-center justify-end gap-1 border-t border-white/5 px-1.5">
        <Tooltip v-if="dockable">
          <TooltipTrigger as-child>
            <button type="button" aria-label="Keep open" class="flex h-7 w-7 items-center justify-center rounded-tab text-muted-foreground hover:bg-muted/50 hover:text-foreground" @click="emit('dock')"><Pin class="h-3.5 w-3.5" /></button>
          </TooltipTrigger>
          <TooltipContent class="bg-popover text-popover-foreground">Keep open</TooltipContent>
        </Tooltip>
        <button type="button" aria-label="Close" class="flex h-7 w-7 items-center justify-center rounded-tab text-muted-foreground hover:bg-muted/50 hover:text-foreground" @click="emit('close')"><X class="h-3.5 w-3.5" /></button>
      </div>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { Pin, X } from 'lucide-vue-next';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

defineProps<{ open: boolean; dockable?: boolean; offset?: number; width?: number | undefined }>();
const emit = defineEmits<{ close: []; dock: [] }>();
const panel = ref<HTMLElement>();
// Menus and dialogs opened from the drawer render outside it.
onClickOutside(panel, () => emit('close'), { ignore: ['[role="menu"]', '[role="dialog"]', '[data-reka-popper-content-wrapper]', '[data-sidebar-drawer-toggle]'] });
</script>
