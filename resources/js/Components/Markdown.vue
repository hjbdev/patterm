<template>
  <div v-if="showPreview" class="space-y-2 rounded-md border border-border/60 bg-background/60 p-3 text-sm text-muted-foreground">
    <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans">{{ previewText }}</pre>
    <button type="button" class="rounded-md border border-border/70 px-2 py-1 text-xs text-foreground hover:bg-muted/50" @click="renderFull">
      Render full Markdown
    </button>
  </div>
  <p v-else-if="rendering" class="text-sm text-muted-foreground">Rendering Markdown...</p>
  <div
    v-else
    ref="root"
    class="markdown prose prose-zinc prose-invert prose-sm max-w-none text-foreground [font-size:0.875rem] [overflow-wrap:anywhere] prose-p:my-2 prose-a:text-primary prose-code:rounded prose-code:bg-secondary/50 prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.85em] prose-code:font-normal prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-border prose-pre:bg-background prose-pre:text-foreground prose-blockquote:border-border prose-blockquote:text-muted-foreground prose-th:border-border prose-td:border-border marker:text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
    v-html="rendered"
    v-stream-reveal="Boolean(revealAppends)"
  />
  <Teleport v-for="(mention, index) in mentions" :key="index" :to="mention.element">
    <slot name="mention" :part="mention.part" />
  </Teleport>
  <Teleport v-for="(block, index) in codeBlocks" :key="index" :to="block">
    <CodeCopyButton :block="block" />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useSlots, watch, type Directive } from 'vue';
import { cachedMarkdown, renderMarkdown, renderPlainMarkdown, type MarkdownOptions } from '../lib/markdown';
import { highlightInWorker } from '../lib/markdownHighlightWorker';
import CodeCopyButton from './CodeCopyButton.vue';
import { splitProcessMentions, type MentionPart } from '../lib/agentMentions';
import { appendedTextStart } from '../lib/streamReveal';

// With a `mention` slot, process IDs and launch tokens render through it as
// chips. Each is teleported into its placeholder in the rendered HTML, so it
// keeps the surrounding providers, and moves rather than remounts as text
// streams in.
const props = withDefaults(defineProps<{ source: string; revealAppends?: boolean }>(), { revealAppends: false });
const slots = useSlots();

const shownText = new WeakMap<HTMLElement, string>();
const vStreamReveal: Directive<HTMLElement, boolean> = {
  mounted(element, binding) { if (binding.value) shownText.set(element, renderedText(element)); },
  updated(element, binding) {
    if (!binding.value) return void shownText.delete(element);
    const previous = shownText.get(element) ?? '';
    const current = renderedText(element);
    shownText.set(element, current);
    const start = appendedTextStart(previous, current, binding.value);
    if (start !== null) fadeAppendedText(element, start);
  },
  unmounted(element) { shownText.delete(element); }
};

// The rendered Markdown's text nodes, leaving out mention chips, which arrive
// after the HTML and would otherwise read as edits to the text.
function textNodes(element: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node instanceof HTMLElement && node.dataset.mention !== undefined ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  while (walker.nextNode()) if (walker.currentNode.nodeType === Node.TEXT_NODE) nodes.push(walker.currentNode as Text);
  return nodes;
}

function renderedText(element: HTMLElement): string {
  return textNodes(element).map((node) => node.data).join('');
}

function fadeAppendedText(element: HTMLElement, start: number): void {
  const nodes = textNodes(element);
  const end = nodes.map((node) => node.data).join('').trimEnd().length;
  let offset = 0;
  for (const node of nodes) {
    const length = node.data.length;
    const from = Math.max(0, start - offset);
    const to = Math.min(length, end - offset);
    if (from < to) {
      const appended = from === 0 ? node : node.splitText(from);
      if (to < length) appended.splitText(to - from);
      const span = document.createElement('span');
      span.className = 'stream-append';
      appended.parentNode?.replaceChild(span, appended);
      span.appendChild(appended);
    }
    offset += length;
  }
}

const EAGER_MARKDOWN_LIMIT = 80 * 1024;
const PREVIEW_LIMIT = 40 * 1024;

const rendered = ref('');

const root = ref<HTMLElement | null>(null);
const mentions = shallowRef<{ element: HTMLElement; part: MentionPart }[]>([]);
const codeBlocks = shallowRef<HTMLElement[]>([]);
watch([() => rendered.value, root], () => {
  const found = root.value && slots.mention
    ? Array.from(root.value.querySelectorAll<HTMLElement>('[data-mention]'), (element) => ({ element, part: splitProcessMentions(element.dataset.mention ?? '')[0]! }))
    : [];
  // A new empty list would still render the component again.
  if (found.length || mentions.value.length) mentions.value = found;
  // Each render replaces the HTML, so the copy buttons follow the new blocks.
  const blocks = root.value ? Array.from(root.value.querySelectorAll<HTMLElement>('.code-block')) : [];
  if (blocks.length || codeBlocks.value.length) codeBlocks.value = blocks;
}, { flush: 'post' });

const rendering = ref(false);
const renderRequested = ref(false);
let renderToken = 0;
let idleHandle: number | null = null;
let timeoutHandle: number | null = null;
let highlightHandle: ReturnType<typeof setTimeout> | null = null;
let settleHandle: ReturnType<typeof setTimeout> | null = null;

type IdleWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const showPreview = computed(() => sourceText().length > EAGER_MARKDOWN_LIMIT && !renderRequested.value);
const previewText = computed(() => capText(sourceText(), PREVIEW_LIMIT));

watch(() => props.source, () => {
  renderRequested.value = false;
  scheduleRender(false);
}, { immediate: true });

onBeforeUnmount(() => {
  renderToken += 1;
  cancelScheduledRender();
});

function renderFull(): void {
  renderRequested.value = true;
  scheduleRender(true);
}

function scheduleRender(force: boolean): void {
  const source = sourceText();
  renderToken += 1;
  cancelScheduledRender();
  rendering.value = false;
  if (!source) {
    rendered.value = '';
    return;
  }
  if (!force && source.length > EAGER_MARKDOWN_LIMIT) return;

  const token = renderToken;
  const fenced = source.includes('```') || source.includes('~~~');
  const highlight = (current: number, options: MarkdownOptions) => {
    void renderMarkdown(source, options, highlightInWorker).then((html) => {
      if (current !== renderToken) return;
      rendered.value = html;
    });
  };
  const render = () => {
    if (token !== renderToken) return;
    const options = markdownOptions(source);
    const cached = fenced ? cachedMarkdown(source, options) : undefined;
    // Native deltas can arrive faster than highlighting. Keep plain Markdown
    // visible and wait for a short quiet gap before highlighting a change. A
    // message that has just mounted highlights straight away.
    const quietGap = rendered.value ? 120 : 0;
    rendered.value = cached ?? renderPlainMarkdown(source, options);
    rendering.value = false;
    if (fenced && cached === undefined) {
      highlightHandle = globalThis.setTimeout(() => {
        highlightHandle = null;
        highlight(token, options);
      }, quietGap);
    }
    // A process ID held back at the end of a streaming reply becomes a chip
    // once the reply stops changing. The new token drops a pending
    // highlight of the held text.
    if (options.holdTrailing) {
      settleHandle = globalThis.setTimeout(() => {
        settleHandle = null;
        if (token !== renderToken) return;
        const settled = { ...options, holdTrailing: false };
        const current = ++renderToken;
        if (highlightHandle !== null) globalThis.clearTimeout(highlightHandle);
        highlightHandle = null;
        if (fenced) highlight(current, settled);
        else rendered.value = renderPlainMarkdown(source, settled);
      }, 400);
    }
  };
  if (source.length > EAGER_MARKDOWN_LIMIT) {
    rendering.value = true;
    scheduleIdle(render);
  } else {
    render();
  }
}

function scheduleIdle(callback: () => void): void {
  const idleWindow = window as IdleWindow;
  if (idleWindow.requestIdleCallback) {
    idleHandle = idleWindow.requestIdleCallback(callback, { timeout: 500 });
    return;
  }
  timeoutHandle = globalThis.setTimeout(callback, 0);
}

function cancelScheduledRender(): void {
  const idleWindow = window as IdleWindow;
  if (idleHandle !== null && idleWindow.cancelIdleCallback) {
    idleWindow.cancelIdleCallback(idleHandle);
  }
  if (timeoutHandle !== null) {
    globalThis.clearTimeout(timeoutHandle);
  }
  if (highlightHandle !== null) globalThis.clearTimeout(highlightHandle);
  if (settleHandle !== null) globalThis.clearTimeout(settleHandle);
  idleHandle = null;
  timeoutHandle = null;
  highlightHandle = null;
  settleHandle = null;
}

function markdownOptions(source: string): MarkdownOptions {
  return { mentions: Boolean(slots.mention), holdTrailing: props.revealAppends && /\bprocess_\d+$/.test(source) };
}

function sourceText(): string {
  return props.source ?? '';
}

function capText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars; render full Markdown to view all]`;
}
</script>

<style scoped>
.markdown :deep(h1) {
  font-size: 1.125rem;
}

.markdown :deep(h2) {
  font-size: 1rem;
}

.markdown :deep(h3),
.markdown :deep(h4),
.markdown :deep(h5),
.markdown :deep(h6) {
  font-size: 0.875rem;
}

.markdown :deep(:is(h1, h2, h3, h4, h5, h6)) {
  margin-top: 1.5rem;
  margin-bottom: 0.5rem;
  font-weight: 600;
  line-height: 1.5;
}

.markdown :deep(blockquote) {
  border-left-width: 1px;
  padding-left: 0.5rem;
  font-style: normal;
  font-weight: 400;
  quotes: none;
}

.markdown :deep(pre) {
  padding: 0.75rem;
  font-size: 0.8125rem;
}

.markdown :deep(.code-block) {
  position: relative;
}

.markdown :deep(.code-copy) {
  position: absolute;
  top: 0.375rem;
  right: 0.375rem;
  opacity: 0;
  transition: opacity 120ms ease-out;
}

.markdown :deep(.code-block:hover .code-copy),
.markdown :deep(.code-copy:focus-visible) {
  opacity: 1;
}

/* Touch screens have no hover, so the button stays visible. */
@media (hover: none) {
  .markdown :deep(.code-copy) { opacity: 1; }
}

.markdown :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: inherit;
}

/* Wide tables scroll sideways instead of squeezing cells to a letter wide,
   which overflow-wrap: anywhere would otherwise allow on narrow screens. */
.markdown :deep(table) {
  display: block;
  overflow-x: auto;
}

.markdown :deep(:is(th, td)) {
  min-width: 7rem;
  overflow-wrap: normal;
}

.markdown :deep(> :first-child) {
  margin-top: 0;
}

.markdown :deep(.stream-append) {
  animation: stream-append 180ms ease-out both;
}

@keyframes stream-append {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .markdown :deep(.stream-append) { animation: none; }
}
</style>
