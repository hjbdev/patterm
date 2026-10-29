<template>
  <!-- `decorative` makes it a plain tile inside something else you click. -->
  <component :is="decorative ? 'span' : 'button'" :type="decorative ? undefined : 'button'" class="block aspect-square w-full overflow-hidden rounded-md border border-border/60 bg-muted/30 outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50" :aria-label="decorative ? undefined : image.name ?? 'Image'" :aria-hidden="decorative ? 'true' : undefined" @click="decorative || emit('open')">
    <img v-if="url" :src="url" alt="" class="block h-full w-full object-cover" draggable="false">
  </component>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { transcriptImageUrl } from '../../lib/transcriptImages';
import type { PeekImage } from '../../lib/peek';

const props = defineProps<{ image: PeekImage; projectId: string; decorative?: boolean }>();
const emit = defineEmits<{ open: [] }>();
const url = ref<string | null>(null);
watch(() => props.image.sha256, (sha256) => {
  url.value = null;
  transcriptImageUrl(sha256, props.projectId).then((value) => { if (props.image.sha256 === sha256) url.value = value; }, () => { /* The tile stays empty. */ });
}, { immediate: true });
</script>
