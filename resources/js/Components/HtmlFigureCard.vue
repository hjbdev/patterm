<template>
  <p v-if="!page" class="text-xs text-muted-foreground" data-component="html-figure-invalid">This page could not be shown.</p>
  <section v-else class="group/figure relative w-full min-w-0 py-1" data-component="html-figure" :aria-label="page.title">
    <div class="mb-1.5 flex min-w-0 items-center gap-1">
      <h3 class="min-w-0 flex-1 truncate text-sm font-medium">{{ page.title }}</h3>
      <div
        class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/figure:opacity-100 [@media(hover:none)]:opacity-100"
        :class="showSource ? 'opacity-100' : ''"
      >
        <Button size="sm" variant="ghost" class="h-6 px-2 text-xs text-muted-foreground" :aria-pressed="showSource" @click="showSource = !showSource">{{ showSource ? 'Page' : 'Source' }}</Button>
        <Button size="icon" variant="ghost" class="h-6 w-6 text-muted-foreground" aria-label="Full screen" @click="expanded = true"><Maximize2 class="h-3.5 w-3.5" /></Button>
      </div>
    </div>
    <pre v-if="showSource" class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 font-mono text-[11px] leading-5 text-muted-foreground">{{ page.html }}</pre>
    <HtmlFigureFrame v-else-if="prepared" :html="prepared" :measure-key="page.html" :title="page.title" :initial-height="initialHeight" />
    <div v-else class="rounded-md bg-muted/20" :style="{ height: `${initialHeight}px` }" />
    <Dialog v-model:open="expanded">
      <DialogContent class="flex h-dvh w-screen max-w-none flex-col gap-3 rounded-none border-0 p-4 outline-none sm:rounded-none" @open-auto-focus="keepFocus">
        <DialogTitle class="pr-8 text-sm font-medium">{{ page.title }}</DialogTitle>
        <DialogDescription class="sr-only">The agent's page, full screen.</DialogDescription>
        <div class="min-h-0 flex-1 overflow-auto">
          <HtmlFigureFrame v-if="expanded && prepared" :html="prepared" :title="page.title" :initial-height="initialHeight" fill />
        </div>
      </DialogContent>
    </Dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Maximize2 } from 'lucide-vue-next';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import HtmlFigureFrame from './HtmlFigureFrame.vue';
import { clampFigureHeight, figureImages, figurePage, figureToolInput, prepareFigureHtml, replaceFigureImages } from '../../../app/Services/HtmlFigure';
import { figureFontCss, figureFontVersion, figureImageUrls } from '../lib/htmlFigure';
import type { TranscriptMessage } from '../lib/integratedConversation';

// A rendered page from the transcript, or one given directly, such as the
// examples in Settings.
const props = defineProps<{ message?: TranscriptMessage; page?: { title: string; html: string; height?: number } }>();
const page = computed(() => props.page ?? (props.message?.tool ? figurePage(figureToolInput(props.message.tool)) : null));
const images = computed(() => props.message?.tool ? figureImages(props.message.tool) : {});
const initialHeight = computed(() => clampFigureHeight(page.value?.height));
const showSource = ref(false);
const expanded = ref(false);
const prepared = ref<string | null>(null);

// Focus inside the page's frame would swallow Escape, so the dialog keeps it.
function keepFocus(event: Event): void {
  event.preventDefault();
  (event.target as HTMLElement | null)?.focus();
}

// Local images are swapped for their stored copies, and the user's typefaces
// added, before the page is sent.
let preparing = 0;
watch([() => page.value?.html, images, figureFontVersion], async ([html, stored]) => {
  const run = ++preparing;
  if (!html) { prepared.value = null; return; }
  const [urls, fonts] = await Promise.all([Object.keys(stored).length ? figureImageUrls(stored) : new Map<string, string>(), figureFontCss()]);
  if (run === preparing) prepared.value = prepareFigureHtml(replaceFigureImages(html, urls), fonts);
}, { immediate: true });
</script>
