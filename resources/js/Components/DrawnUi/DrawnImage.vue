<template>
  <figure class="m-0 min-w-0">
    <TranscriptImage v-if="sha256" :image="{ sha256, name: image.alt ?? image.title ?? image.path }" :gallery="[{ sha256, name: image.alt ?? image.title ?? image.path }]" :max-height="420" :max-width="760" />
    <p v-else class="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">Image not available: {{ image.path }}</p>
    <figcaption v-if="image.title || image.caption" class="mt-1.5 text-xs text-muted-foreground">
      <span v-if="image.title" class="font-medium text-foreground">{{ image.title }}</span><template v-if="image.title && image.caption"> — </template>{{ image.caption }}
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
import TranscriptImage from '../TranscriptImage.vue';
import type { DrawnImage } from '../../../../app/Services/DrawnUi';

defineProps<{ image: DrawnImage; sha256?: string | undefined }>();
</script>
