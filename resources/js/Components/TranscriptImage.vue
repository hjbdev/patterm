<template>
  <div
    v-if="failed && fill"
    class="flex aspect-square w-full items-center justify-center rounded-md border border-border/60 bg-muted/30 text-muted-foreground/60"
    :title="`${label} is no longer stored`"
    data-component="transcript-image"
    data-state="unavailable"
  >
    <ImageOff class="h-4 w-4" aria-hidden="true" />
    <span class="sr-only">{{ label }} is no longer stored</span>
  </div>
  <div
    v-else-if="failed"
    class="flex max-w-56 items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
    data-component="transcript-image"
    data-state="unavailable"
  >
    <ImageOff class="h-4 w-4 shrink-0" aria-hidden="true" />
    <div class="min-w-0">
      <p class="truncate text-foreground">{{ label }}</p>
      <p class="truncate text-[10px]">No longer stored</p>
    </div>
  </div>
  <Dialog v-else v-model:open="expanded">
    <button
      ref="frame"
      type="button"
      class="block shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted/30 outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50"
      :class="fill && 'aspect-square w-full'"
      :style="fill ? undefined : frameStyle"
      :aria-label="`View ${image.name ?? 'image'}`"
      :title="fill ? label : undefined"
      data-component="transcript-image"
      :data-state="url ? 'loaded' : 'loading'"
      @click="expanded = true"
    >
      <img v-if="url" :src="url" :alt="image.name ?? 'Image'" class="block h-full w-full" :class="fill ? 'object-cover' : 'object-contain'" draggable="false" @load="measure">
    </button>
    <DialogContent
      :hide-close="mobile"
      :class="mobile ? 'h-dvh w-screen max-w-none gap-0 overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none' : 'flex max-h-[92vh] w-auto max-w-[92vw] flex-col gap-3 p-3 sm:max-w-[92vw]'"
      @keydown.left.prevent="step(-1)"
      @keydown.right.prevent="step(1)"
    >
      <template v-if="mobile">
        <div class="absolute inset-0 bg-black" :style="{ opacity: gestures.backdropOpacity.value }" />
        <div ref="stage" class="relative flex h-full w-full touch-none select-none items-center justify-center overflow-hidden" v-on="gestures.handlers">
          <img v-if="shownUrl" ref="stageImage" :src="shownUrl" :alt="shown.name ?? 'Image'" class="max-h-full max-w-full object-contain will-change-transform" :style="gestures.imageStyle.value" draggable="false">
          <p v-else-if="shownFailed" class="text-sm text-white/60">No longer stored</p>
        </div>
        <div :class="chrome ? 'opacity-100' : 'pointer-events-none opacity-0'" class="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent pl-4 pr-1 pt-[env(safe-area-inset-top)] transition-opacity">
          <DialogTitle class="min-w-0 flex-1 truncate text-sm font-normal text-white/80">
            <span v-if="items.length > 1" class="mr-2 tabular-nums">{{ index + 1 }} / {{ items.length }}</span>{{ shown.name ?? 'Image' }}
          </DialogTitle>
          <RouterLink v-if="shown.to" :to="shown.to" class="flex h-11 shrink-0 items-center px-2 text-xs text-white/80 outline-none focus-visible:underline" @click="expanded = false">Open conversation</RouterLink>
          <DialogClose class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/80 outline-none focus-visible:ring-2 focus-visible:ring-white/50">
            <X class="h-5 w-5" aria-hidden="true" />
            <span class="sr-only">Close</span>
          </DialogClose>
        </div>
        <div v-if="items.length > 1 && items.length <= MAX_DOTS" :class="chrome ? 'opacity-100' : 'opacity-0'" class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center gap-1.5 pb-[calc(1rem+env(safe-area-inset-bottom))] transition-opacity" aria-hidden="true">
          <span v-for="(item, position) in items" :key="item.sha256" :class="position === index ? 'bg-white' : 'bg-white/35'" class="h-1.5 w-1.5 rounded-full transition-colors" />
        </div>
      </template>
      <template v-else>
        <div class="flex min-w-0 items-baseline gap-3 pr-8">
          <DialogTitle class="min-w-0 flex-1 truncate text-sm font-normal text-muted-foreground">
            <span v-if="items.length > 1" class="mr-2 tabular-nums">{{ index + 1 }} / {{ items.length }}</span>{{ shown.name ?? 'Image' }}
          </DialogTitle>
          <RouterLink v-if="shown.to" :to="shown.to" class="shrink-0 text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline" @click="expanded = false">Open conversation</RouterLink>
        </div>
        <div class="relative flex min-h-0 items-center justify-center">
          <img v-if="shownUrl" :src="shownUrl" :alt="shown.name ?? 'Image'" class="min-h-0 max-h-[calc(92vh-4rem)] max-w-full rounded object-contain">
          <p v-else-if="shownFailed" class="px-16 py-12 text-sm text-muted-foreground">No longer stored</p>
          <div v-else class="h-40 w-56" />
          <template v-if="items.length > 1">
            <button type="button" :class="NAV_CLASS" class="left-2" aria-label="Previous image" @click="step(-1)">
              <ChevronLeft class="h-5 w-5" aria-hidden="true" />
            </button>
            <button type="button" :class="NAV_CLASS" class="right-2" aria-label="Next image" @click="step(1)">
              <ChevronRight class="h-5 w-5" aria-hidden="true" />
            </button>
          </template>
        </div>
      </template>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import { useIntersectionObserver, useMediaQuery } from '@vueuse/core';
import { ChevronLeft, ChevronRight, ImageOff, X } from 'lucide-vue-next';
import { Dialog, DialogClose, DialogContent, DialogTitle } from './ui/dialog';
import { useLightboxGestures } from '../Composables/useLightboxGestures';
import type { TranscriptImage } from '../lib/integratedConversation';
import { transcriptImageUrl } from '../lib/transcriptImages';

type GalleryImage = TranscriptImage & { to?: RouteLocationRaw };

// Images shown together pass the whole group as the gallery so the lightbox
// can step between them. A project reads images indexed from its history; a
// filled tile is a square thumbnail that loads once it scrolls into view.
const props = withDefaults(defineProps<{ image: GalleryImage; gallery?: GalleryImage[]; maxHeight?: number; maxWidth?: number; projectId?: string; fill?: boolean }>(), { maxHeight: 160, maxWidth: 280 });

const MAX_DOTS = 12;
const NAV_CLASS = 'absolute top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 text-foreground shadow outline-none backdrop-blur transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/50';

const url = ref<string | null>(null);
const failed = ref(false);
const expanded = ref(false);
const natural = ref<{ width: number; height: number } | null>(null);
const label = computed(() => props.image.name?.split('/').pop() || 'Image');
const index = ref(0);
const shownUrl = ref<string | null>(null);
const shownFailed = ref(false);
const items = computed(() => props.gallery?.length ? props.gallery : [props.image]);
const shown = computed(() => items.value[index.value] ?? props.image);
let disposed = false;

// Phones get a full-screen viewer driven by touch gestures; tapping the image
// hides the controls.
const mobile = useMediaQuery('(max-width: 639px)');
const chrome = ref(true);
const stage = ref<HTMLElement | null>(null);
const stageImage = ref<HTMLElement | null>(null);
const gestures = useLightboxGestures(stage, stageImage, {
  canStep: () => items.value.length > 1,
  onStep: step,
  onDismiss: () => { expanded.value = false; },
  onTap: () => { chrome.value = !chrome.value; },
});

watch(expanded, (open) => {
  gestures.reset();
  chrome.value = true;
  if (open) index.value = Math.max(0, items.value.findIndex((item) => item.sha256 === props.image.sha256));
});

function step(delta: number): void {
  const count = items.value.length;
  if (count > 1) index.value = (index.value + delta + count) % count;
}

watch([expanded, () => shown.value.sha256], ([open, sha256]) => {
  shownUrl.value = null;
  shownFailed.value = false;
  if (!open) return;
  // Warm the neighbours so a swipe lands on a loaded image.
  const count = items.value.length;
  for (const delta of count > 1 ? [-1, 1] : []) {
    const neighbour = items.value[(index.value + delta + count) % count];
    if (neighbour) transcriptImageUrl(neighbour.sha256, props.projectId).catch(() => {});
  }
  transcriptImageUrl(sha256, props.projectId).then(
    (value) => { if (!disposed && expanded.value && shown.value.sha256 === sha256) shownUrl.value = value; },
    () => { if (!disposed && expanded.value && shown.value.sha256 === sha256) shownFailed.value = true; }
  );
});

// Known dimensions reserve the final size so the virtualised transcript does
// not jump when the image arrives; otherwise the frame fits once it loads.
const frameStyle = computed(() => {
  const width = props.image.width ?? natural.value?.width;
  const height = props.image.height ?? natural.value?.height;
  if (!width || !height) return { height: `${props.maxHeight}px`, width: `${Math.round(props.maxHeight * 4 / 3)}px`, maxWidth: '100%' };
  const scale = Math.min(1, props.maxHeight / height, props.maxWidth / width);
  return { height: `${Math.round(height * scale)}px`, width: `${Math.round(width * scale)}px`, maxWidth: '100%' };
});

function measure(event: Event): void {
  const element = event.target as HTMLImageElement;
  if (element.naturalWidth && element.naturalHeight) natural.value = { width: element.naturalWidth, height: element.naturalHeight };
}

const frame = ref<HTMLElement | null>(null);
const visible = ref(!props.fill);
const { stop: stopObserving } = useIntersectionObserver(() => props.fill ? frame.value : null, ([entry]) => {
  if (!entry?.isIntersecting) return;
  visible.value = true;
  stopObserving();
}, { rootMargin: '200px' });

watch([() => props.image.sha256, visible], ([sha256, shown]) => {
  url.value = null;
  natural.value = null;
  failed.value = false;
  if (!shown) return;
  transcriptImageUrl(sha256, props.projectId).then(
    (value) => { if (!disposed && props.image.sha256 === sha256) url.value = value; },
    () => { if (!disposed && props.image.sha256 === sha256) failed.value = true; }
  );
}, { immediate: true });

onBeforeUnmount(() => {
  disposed = true;
  gestures.reset();
});
</script>
