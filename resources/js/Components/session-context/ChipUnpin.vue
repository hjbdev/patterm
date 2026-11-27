<template>
  <!-- The pin on a pinned chip, which unpins it. It sits inside the chip's own
       button, so it's a span that keeps its pointer from the chip. -->
  <span
    role="button"
    tabindex="0"
    :aria-label="`Unpin ${title}`"
    :title="`Unpin ${title}`"
    class="group/unpin -mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-foreground/70 outline-none transition-colors hover:bg-white/10 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
    @pointerdown.stop
    @click.stop.prevent="emit('unpin')"
    @keydown.enter.stop.prevent="emit('unpin')"
    @keydown.space.stop.prevent="emit('unpin')"
  >
    <Pin class="h-3 w-3 fill-current group-hover/unpin:hidden group-focus-visible/unpin:hidden" aria-hidden="true" />
    <PinOff class="hidden h-3 w-3 group-hover/unpin:block group-focus-visible/unpin:block" aria-hidden="true" />
  </span>
</template>

<script setup lang="ts">
import { Pin, PinOff } from 'lucide-vue-next';

defineProps<{ title: string }>();
const emit = defineEmits<{ unpin: [] }>();
</script>
