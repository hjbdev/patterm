<template>
  <section v-if="total" aria-labelledby="context-media">
    <div class="flex h-7 items-center gap-2">
      <h3 id="context-media" class="text-xs font-medium text-muted-foreground">Media</h3>
      <span class="text-[11px] tabular-nums text-muted-foreground/50">{{ total }}</span>
      <RouterLink v-if="total > items.length" :to="{ name: 'media', params: { projectId }, query: { session: sessionId } }" class="ml-auto rounded-sm text-[11px] text-muted-foreground/70 outline-none hover:text-foreground focus-visible:underline">Show all</RouterLink>
    </div>
    <div class="grid grid-cols-3 gap-1.5 pt-1">
      <TranscriptImage v-for="(image, index) in gallery" :key="`${image.sha256}:${index}`" :image="image" :gallery="gallery" :project-id="projectId" fill />
    </div>
  </section>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import TranscriptImage from '../TranscriptImage.vue';
import { useMedia } from '../../Composables/useMedia';

// The newest images pasted into or viewed in the session, three rows deep;
// the project's Media page lists the rest.
const props = defineProps<{ projectId: string; sessionId: string }>();
const { items, gallery, total } = useMedia(props, { pageSize: 9 });
</script>
