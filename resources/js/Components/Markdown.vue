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
    :data-breakout="breakout ? '' : undefined"
    class="markdown prose prose-zinc prose-invert prose-sm max-w-none text-foreground [overflow-wrap:anywhere] prose-a:text-primary prose-code:rounded prose-code:bg-secondary/50 prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.85em] prose-code:font-normal prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-border prose-pre:bg-background prose-pre:text-foreground prose-blockquote:border-border prose-blockquote:text-muted-foreground prose-th:border-border prose-td:border-border marker:text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
  >
    <template v-for="block in blocks" :key="block.key">
      <div v-if="block.figure" :data-mention="block.figure.text" class="markdown-figure">
        <slot name="mention" :part="block.figure" />
      </div>
      <div v-else-if="block.tail" class="markdown-text contents" v-stream-reveal="Boolean(revealAppends)" v-html="block.html" />
      <div v-else class="markdown-text contents" v-html="block.html" />
    </template>
  </div>
  <Teleport v-for="(mention, index) in mentions" :key="index" :to="mention.element">
    <slot name="mention" :part="mention.part" />
  </Teleport>
  <Teleport v-for="(block, index) in codeBlocks" :key="index" :to="block">
    <CodeCopyButton :block="block" />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useSlots, watch, type Directive } from 'vue';
import { cachedMarkdown, renderMarkdown, renderPlainMarkdown, splitStableMarkdownBlocks, type MarkdownOptions } from '../lib/markdown';
import { highlightInWorker } from '../lib/markdownHighlightWorker';
import CodeCopyButton from './CodeCopyButton.vue';
import { splitProcessMentions, type MentionPart } from '../lib/agentMentions';
import { appendedTextStart } from '../lib/streamReveal';

// With a `mention` slot, process IDs and launch tokens render through it as
// chips. Each is teleported into its placeholder in the rendered HTML, so it
// keeps the surrounding providers, and moves rather than remounts as text
// streams in. Standalone figures stay outside that replaced HTML: moving
// an iframe between Teleport targets reloads its document.
const props = withDefaults(defineProps<{ source: string; revealAppends?: boolean; breakout?: boolean }>(), { revealAppends: false, breakout: false });
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

interface StableBlockEntry {
  source: string;
  html: string;
  highlighted: boolean;
}

interface DisplayBlock {
  key: string;
  html?: string;
  figure?: MentionPart;
  tail?: boolean;
}

const stableBlocks = shallowRef<StableBlockEntry[]>([]);
const tailHtml = ref('');
const renderRevision = ref(0);

// Split only top-level figure paragraphs out of an HTML chunk so iframes never
// move or reload when surrounding text streams.
function splitFigures(html: string, prefix: string, isTail: boolean, figureCounts: Map<string, number>): DisplayBlock[] {
  if (!slots.mention || !html.includes('[patterm_figure:')) {
    return [{ key: `${prefix}:0`, html, tail: isTail }];
  }
  const template = document.createElement('template');
  template.innerHTML = html;
  const result: DisplayBlock[] = [];
  let pending = '';
  let partIndex = 0;
  for (const node of Array.from(template.content.childNodes)) {
    const element = node instanceof HTMLElement ? node : null;
    const placeholder = element?.tagName === 'P' && element.childNodes.length === 1 ? element.firstElementChild : null;
    const part = placeholder?.tagName === 'SPAN' && placeholder.hasAttribute('data-mention')
      ? splitProcessMentions(placeholder.getAttribute('data-mention') ?? '')[0] : undefined;
    if (part?.figure) {
      if (pending) {
        result.push({ key: `${prefix}:${partIndex++}`, html: pending, tail: false });
        pending = '';
      }
      const seen = figureCounts.get(part.figure) ?? 0;
      figureCounts.set(part.figure, seen + 1);
      result.push({ key: `fig:${part.figure}:${seen}`, figure: part });
    } else {
      pending += element?.outerHTML ?? node.textContent ?? '';
    }
  }
  if (pending || !result.length) {
    result.push({ key: `${prefix}:${partIndex}`, html: pending, tail: isTail });
  }
  return result;
}

const blocks = computed<DisplayBlock[]>(() => {
  const result: DisplayBlock[] = [];
  const figureCounts = new Map<string, number>();
  const stable = stableBlocks.value;
  for (let index = 0; index < stable.length; index++) {
    result.push(...splitFigures(stable[index]!.html, `s:${index}`, false, figureCounts));
  }
  const tail = tailHtml.value;
  if (tail || !result.length) {
    result.push(...splitFigures(tail, 'tail', true, figureCounts));
  }
  return result;
});

const root = ref<HTMLElement | null>(null);
const mentions = shallowRef<{ element: HTMLElement; part: MentionPart }[]>([]);
const codeBlocks = shallowRef<HTMLElement[]>([]);

function sameMentionNodes(left: { element: HTMLElement; part: MentionPart }[], right: { element: HTMLElement; part: MentionPart }[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i]!.element !== right[i]!.element || left[i]!.part.text !== right[i]!.part.text) return false;
  }
  return true;
}

function sameElements(left: HTMLElement[], right: HTMLElement[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

watch([renderRevision, root], () => {
  const found = root.value && slots.mention
    ? Array.from(root.value.querySelectorAll<HTMLElement>('.markdown-text [data-mention]'), (element) => ({ element, part: splitProcessMentions(element.dataset.mention ?? '')[0]! }))
    : [];
  // Stable blocks keep their DOM elements across streaming tail updates, so
  // unchanged mentions and code blocks never trigger Teleport remounts.
  if (!sameMentionNodes(found, mentions.value)) mentions.value = found;
  const foundBlocks = root.value ? Array.from(root.value.querySelectorAll<HTMLElement>('.code-block')) : [];
  if (!sameElements(foundBlocks, codeBlocks.value)) codeBlocks.value = foundBlocks;
}, { flush: 'post' });

const rendering = ref(false);
const renderRequested = ref(false);
let renderToken = 0;
let tailToken = 0;
let lastSource = '';
let streamingActive = false;
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
  tailToken += 1;
  cancelScheduledRender();
});

function renderFull(): void {
  renderRequested.value = true;
  scheduleRender(true);
}

function hasFence(text: string): boolean {
  return text.includes('```') || text.includes('~~~');
}

function scheduleRender(force: boolean): void {
  const source = sourceText();
  const isAppend = lastSource.length > 0 && source.length > lastSource.length && source.startsWith(lastSource);
  const replaced = !isAppend && source !== lastSource;
  lastSource = source;
  if (replaced) {
    streamingActive = Boolean(props.revealAppends);
    renderToken += 1;
    stableBlocks.value = [];
  } else if (isAppend || props.revealAppends) {
    streamingActive = true;
  }
  tailToken += 1;
  cancelScheduledRender();
  rendering.value = false;
  if (!source) {
    stableBlocks.value = [];
    tailHtml.value = '';
    renderRevision.value += 1;
    return;
  }
  if (!force && source.length > EAGER_MARKDOWN_LIMIT) return;

  const docToken = renderToken;
  const currentTailToken = tailToken;

  const renderTail = (tailSource: string, hadTail: boolean) => {
    const options = markdownOptions(tailSource);
    const fenced = hasFence(tailSource);
    const cached = fenced ? cachedMarkdown(tailSource, options) : undefined;
    const quietGap = hadTail ? 120 : 0;
    tailHtml.value = cached ?? renderPlainMarkdown(tailSource, options);
    renderRevision.value += 1;

    const highlightTail = (token: number, opts: MarkdownOptions) => {
      void renderMarkdown(tailSource, opts, highlightInWorker).then((html) => {
        if (docToken !== renderToken || token !== tailToken) return;
        tailHtml.value = html;
        renderRevision.value += 1;
      });
    };

    if (fenced && cached === undefined) {
      highlightHandle = globalThis.setTimeout(() => {
        highlightHandle = null;
        highlightTail(currentTailToken, options);
      }, quietGap);
    }
    // A process ID held back at the end of a streaming reply becomes a chip
    // once the reply stops changing. The new token drops a pending
    // highlight of the held text.
    if (options.holdTrailing) {
      settleHandle = globalThis.setTimeout(() => {
        settleHandle = null;
        if (docToken !== renderToken || currentTailToken !== tailToken) return;
        const settled = { ...options, holdTrailing: false };
        const nextToken = ++tailToken;
        if (highlightHandle !== null) globalThis.clearTimeout(highlightHandle);
        highlightHandle = null;
        if (fenced) highlightTail(nextToken, settled);
        else {
          tailHtml.value = renderPlainMarkdown(tailSource, settled);
          renderRevision.value += 1;
        }
      }, 400);
    }
  };

  const render = () => {
    if (docToken !== renderToken || currentTailToken !== tailToken) return;
    rendering.value = false;
    const hadTail = Boolean(tailHtml.value);

    // Split completed leading blocks during live streaming so new tokens only
    // re-parse the tail block and completed highlighted code never flashes.
    if (streamingActive) {
      const { stable, tail } = splitStableMarkdownBlocks(source);
      const previous = stableBlocks.value;
      const stableOptions: MarkdownOptions = { mentions: Boolean(slots.mention), holdTrailing: false };
      let stableChanged = stable.length !== previous.length;
      const nextStable: StableBlockEntry[] = new Array(stable.length);
      const pendingHighlights: Array<{ index: number; blockSource: string }> = [];

      for (let i = 0; i < stable.length; i++) {
        const blockSource = stable[i]!;
        const existing = previous[i];
        if (existing && existing.source === blockSource) {
          nextStable[i] = existing;
          continue;
        }
        stableChanged = true;
        const fenced = hasFence(blockSource);
        const cached = fenced ? cachedMarkdown(blockSource, stableOptions) : undefined;
        nextStable[i] = {
          source: blockSource,
          html: cached ?? renderPlainMarkdown(blockSource, stableOptions),
          highlighted: !fenced || cached !== undefined
        };
        if (fenced && cached === undefined) {
          pendingHighlights.push({ index: i, blockSource });
        }
      }

      if (stableChanged) stableBlocks.value = nextStable;

      for (const { index, blockSource } of pendingHighlights) {
        void renderMarkdown(blockSource, stableOptions, highlightInWorker).then((html) => {
          if (docToken !== renderToken) return;
          const current = stableBlocks.value;
          if (current[index]?.source !== blockSource) return;
          const updated = current.slice();
          updated[index] = { source: blockSource, html, highlighted: true };
          stableBlocks.value = updated;
          renderRevision.value += 1;
        });
      }

      renderTail(tail, hadTail);
      return;
    }

    if (stableBlocks.value.length) stableBlocks.value = [];
    renderTail(source, hadTail);
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
.markdown {
  font-size: var(--markdown-font-size, 0.875rem);
  line-height: 1.7;
}

.markdown :deep(> .markdown-text:last-child > :last-child) {
  margin-bottom: 0;
}

.markdown :deep(p) {
  margin-top: 0.85em;
  margin-bottom: 0.85em;
}

.markdown :deep(:is(ul, ol)) {
  margin-top: 0.9em;
  margin-bottom: 0.9em;
}

.markdown :deep(li) {
  margin-top: 0.35em;
  margin-bottom: 0.35em;
}

.markdown :deep(h1) {
  font-size: 1.2857em;
}

.markdown :deep(h2) {
  font-size: 1.1429em;
}

.markdown :deep(h3),
.markdown :deep(h4),
.markdown :deep(h5),
.markdown :deep(h6) {
  font-size: 1em;
}

.markdown :deep(:is(h1, h2, h3, h4, h5, h6)) {
  margin-top: 1.75em;
  margin-bottom: 0.75em;
  font-weight: 600;
  line-height: 1.45;
}

.markdown :deep(blockquote) {
  margin-top: 1.25em;
  margin-bottom: 1.25em;
  border-left-width: 1px;
  padding-left: 0.9em;
  padding-top: 0.15em;
  padding-bottom: 0.15em;
  font-style: normal;
  font-weight: 400;
  quotes: none;
}

.markdown :deep(pre) {
  margin-top: 0;
  margin-bottom: 0;
  padding: 0.85em 1em;
  font-size: 0.9286em;
  line-height: 1.6;
}

.markdown :deep(.code-block) {
  position: relative;
  margin-top: 1.25em;
  margin-bottom: 1.25em;
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
.markdown :deep(.markdown-table) {
  overflow-x: auto;
  margin-top: 1.5em;
  margin-bottom: 1.5em;
}

.markdown :deep(.markdown-table > table) {
  display: table;
  width: 100%;
  margin-top: 0;
  margin-bottom: 0;
  font-size: 0.9286em;
  line-height: 1.58;
}

.markdown :deep(th) {
  padding: 0.75em 1.25em 0.75em 0;
  font-weight: 500;
  color: hsl(var(--muted-foreground));
  vertical-align: bottom;
}

.markdown :deep(td) {
  padding: 0.95em 1.25em 0.95em 0;
  vertical-align: top;
}

.markdown :deep(:is(th, td)) {
  min-width: 7rem;
  overflow-wrap: normal;
}

.markdown :deep(:is(th, td):last-child) {
  padding-right: 0;
}

.markdown :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 0.5rem;
}

.markdown > .markdown-figure,
.markdown :deep(.markdown-image) {
  margin-top: 1.4em;
  margin-bottom: 1.4em;
}

/* Top-level HTML figures, tables, and standalone images can extend symmetrically
   past a narrower prose column, bounded by the conversation viewport (100cqi). */
.markdown[data-breakout] > .markdown-text > :deep(.markdown-table),
.markdown[data-breakout] > .markdown-figure,
.markdown[data-breakout] > .markdown-text > :deep(.markdown-image) {
  --breakout-width: max(100%, min(calc(100cqi - 2rem), var(--patterm-conversation-breakout-max-width, 0px)));
  width: var(--breakout-width);
  max-width: none;
  margin-inline: calc((100% - var(--breakout-width)) / 2);
}

.markdown[data-breakout] > .markdown-text > :deep(.markdown-image img) {
  display: block;
  margin-inline: auto;
}

.markdown :deep(> :first-child),
.markdown :deep(> .markdown-text:first-child > :first-child) {
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
