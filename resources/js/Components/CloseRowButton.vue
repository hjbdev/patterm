<template>
  <!-- Closes a tab or sidebar row, after the confirmation dialog. -->
  <button
    type="button"
    tabindex="-1"
    :aria-label="`Close ${label}`"
    :title="`Close ${label}`"
    :class="cn('flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', props.class)"
    @pointerdown.stop
    @click.stop="emit('close')"
  >
    <X class="h-3.5 w-3.5" />
  </button>
</template>

<script setup lang="ts">
import { X } from 'lucide-vue-next';
import { cn } from '@/lib/utils';

const props = defineProps<{ label: string; class?: string | undefined }>();
const emit = defineEmits<{ close: [] }>();
</script>
