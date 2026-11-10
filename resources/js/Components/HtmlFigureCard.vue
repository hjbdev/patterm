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
    <pre v-if="showSource" class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 font-mono text-[11px] leading-5 text-muted-foreground">{{ source }}</pre>
    <HtmlFigureFrame v-else-if="prepared" :html="prepared" :media="media" :measure-key="source" :title="page.title" :initial-height="initialHeight" />
    <p v-else-if="missingTemplate" class="text-xs text-muted-foreground" data-component="html-figure-missing-template">{{ missingTemplate }}</p>
    <div v-else class="rounded-md bg-muted/20" :style="{ height: `${initialHeight}px` }" />
    <p v-if="missingVideos && !showSource" class="mt-1 text-xs text-muted-foreground" data-component="html-figure-missing-video">{{ missingVideos === 1 ? 'A video in this page is' : `${missingVideos} videos in this page are` }} no longer available here.</p>
    <Dialog v-model:open="expanded">
      <DialogContent class="flex h-dvh w-screen max-w-none flex-col gap-3 rounded-none border-0 p-4 outline-none sm:rounded-none" @open-auto-focus="keepFocus">
        <DialogTitle class="pr-8 text-sm font-medium">{{ page.title }}</DialogTitle>
        <DialogDescription class="sr-only">The agent's page, full screen.</DialogDescription>
        <div class="min-h-0 flex-1 overflow-auto">
          <HtmlFigureFrame v-if="expanded && prepared" :html="prepared" :media="media" :title="page.title" :initial-height="initialHeight" fill />
        </div>
      </DialogContent>
    </Dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { Maximize2 } from 'lucide-vue-next';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import HtmlFigureFrame from './HtmlFigureFrame.vue';
import { clampFigureHeight, fillFigureTemplate, figureImages, figurePage, figureTemplate, figureToolInput, figureVideos, prepareFigureHtml, replaceFigureImages, replaceFigureVideos, type FigurePage } from '../../../app/Services/HtmlFigure';
import { figureFontCss, figureFontVersion, figureImageUrls, figureTemplatePage, figureVideoBlobs } from '../lib/htmlFigure';
import type { TranscriptMessage } from '../lib/integratedConversation';

// A rendered page from the transcript, or one given directly, such as the
// examples in Settings.
const props = defineProps<{ message?: TranscriptMessage; page?: FigurePage }>();
const page = computed(() => props.page ?? (props.message?.tool ? figurePage(figureToolInput(props.message.tool)) : null));
// A template figure draws the version its reply recorded, never a later one.
const template = computed(() => page.value && 'template' in page.value && props.message?.tool ? figureTemplate(props.message.tool) : null);
const source = computed(() => {
  const current = page.value;
  if (!current) return '';
  if ('html' in current) return current.html;
  return `${template.value ? `${template.value.name} version ${template.value.version}` : current.template}\n\n${JSON.stringify(current.data, null, 2)}`;
});
const missingTemplate = ref('');
const images = computed(() => props.message?.tool ? figureImages(props.message.tool) : {});
const videos = computed(() => props.message?.tool ? figureVideos(props.message.tool) : {});
const initialHeight = computed(() => clampFigureHeight(page.value?.height));
const showSource = ref(false);
const expanded = ref(false);
const prepared = ref<string | null>(null);
const media = shallowRef<Map<string, Blob>>(new Map());
const missingVideos = ref(0);

// Focus inside the page's frame would swallow Escape, so the dialog keeps it.
function keepFocus(event: Event): void {
  event.preventDefault();
  (event.target as HTMLElement | null)?.focus();
}

// Local images are swapped for their stored copies, videos for placeholders
// the frame fills, and the user's typefaces added, before the page is sent.
let preparing = 0;
// Watched by its text, so a row that re-projects the same page keeps it.
watch([source, images, videos, figureFontVersion], async ([, storedImages, storedVideos]) => {
  const run = ++preparing;
  const current = page.value;
  const version = template.value;
  missingTemplate.value = '';
  if (!current) { prepared.value = null; return; }
  if ('template' in current) {
    if (!version) { prepared.value = null; missingTemplate.value = 'This page\'s template version was not recorded, so it cannot be shown.'; return; }
    const [html, fonts] = await Promise.all([figureTemplatePage(version.name, version.version).catch(() => null), figureFontCss()]);
    if (run !== preparing) return;
    if (html === null) { prepared.value = null; missingTemplate.value = `Template ${version.name} version ${version.version} is not saved on this host.`; return; }
    media.value = new Map();
    missingVideos.value = 0;
    prepared.value = prepareFigureHtml(fillFigureTemplate(html, current.data), fonts, current.data);
    return;
  }
  const html = current.html;
  const [urls, played, fonts] = await Promise.all([
    Object.keys(storedImages).length ? figureImageUrls(storedImages) : new Map<string, string>(),
    Object.keys(storedVideos).length ? figureVideoBlobs(storedVideos) : { placeholders: new Map<string, string>(), media: new Map<string, Blob>(), missing: 0 },
    figureFontCss()
  ]);
  if (run !== preparing) return;
  media.value = played.media;
  missingVideos.value = played.missing;
  prepared.value = prepareFigureHtml(replaceFigureVideos(replaceFigureImages(html, urls), played.placeholders), fonts);
}, { immediate: true });
</script>
