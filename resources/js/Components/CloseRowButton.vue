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
    <!-- Lucide's X fills only half its box, and its open corners make it look
         smaller than a closed shape of the same size. At 18px it sits about a
         pixel larger than the 13px timer, which reads as the same size. The
         strokes are all 1.25px. -->
    <X class="h-[18px] w-[18px]" :stroke-width="1.667" />
  </button>
</template>

<script setup lang="ts">
import { X } from 'lucide-vue-next';
import { cn } from '@/lib/utils';

const props = defineProps<{ label: string; class?: string | undefined }>();
const emit = defineEmits<{ close: [] }>();
</script>
