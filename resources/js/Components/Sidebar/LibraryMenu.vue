<template>
  <!-- The project's pages and the canvas, opening above the sidebar's footer.
       It reads what's new on each only while open. -->
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="flex h-[30px] items-center gap-2 rounded-tab px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted/50 data-[state=open]:text-foreground"
        :class="onPage && 'bg-primary/10 text-foreground'"
      >
        <Library class="h-4 w-4" aria-hidden="true" />Library
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" :side-offset="6" class="w-80 p-1.5">
      <LibraryRows compact @navigate="open = false" />
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Library } from 'lucide-vue-next';
import LibraryRows from '../LibraryRows.vue';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { useSidebar } from './sidebarContext';

const sidebar = useSidebar();
const open = ref(false);
// Marked while one of its pages is showing.
const onPage = computed(() => sidebar.page.value !== null);
</script>
