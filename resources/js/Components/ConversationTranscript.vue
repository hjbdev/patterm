<template>
  <MessageScrollerProvider ref="scrollerRef" auto-scroll default-scroll-position="end">
    <MessageScroller>
      <!-- Overlays the top of the transcript and only shows once the reader
           reaches the start, where there is nothing left above to scroll to. -->
      <div
        v-if="showHeader"
        class="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center gap-1 bg-gradient-to-b from-background from-40% to-transparent px-4 pb-6 pt-1 text-center text-xs text-muted-foreground transition-[opacity,visibility] duration-200 group-data-[scrollable~=start]/message-scroller:invisible group-data-[scrollable~=start]/message-scroller:opacity-0"
      >
        <button v-if="hasOlder" type="button" class="pointer-events-auto rounded-md px-3 py-1.5 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" :disabled="loadingOlder" @click="emit('load-older')">
          {{ loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages' }}
        </button>
        <p v-else-if="truncated">Showing the most recent messages.</p>
        <p v-if="historyError" role="alert" class="text-destructive">{{ historyError }}</p>
        <p v-if="historyUnavailable" role="status">This Codex version cannot load earlier messages. New messages appear here live.</p>
      </div>
      <MessageScrollerViewport ref="viewportRef">
        <MessageScrollerContent class="mx-auto w-full max-w-[50rem] px-4 2xl:max-w-[1000px]">
          <div ref="sizerRef" class="relative w-full">
            <div
            v-for="{ virtualItem, row } in renderedRows"
            :key="String(virtualItem.key)"
            :ref="measureRow"
            :data-index="virtualItem.index"
            :data-row-id="row.id"
            :id="`conversation-message-${row.id}`"
            class="group/row absolute left-0 top-0 w-full"
            :class="[activeMessageId === row.id ? 'rounded-lg bg-primary/10' : '', hasFooter(row) ? 'pb-2' : 'pb-4']"
            :style="{ transform: `translateY(${virtualItem.start}px)` }"
            :data-tapped="tappedRowId === row.id || undefined"
            @click="tapRow(row.id, $event)"
            >
              <MessageScrollerItem
            :message-id="row.id"
            :class="rowFresh(row) ? ENTER_CLASS : ''"
          >
            <Message :align="row.kind === 'message' && row.message.role === 'user' && !row.origin ? 'end' : 'start'">
              <MessageContent>
                <ConversationAgentMessage v-if="row.kind === 'message' && row.origin" :message="row.message" :origin="row.origin" :open="rowOpen(row.id)" @toggle="toggleRow(row.id)" />
                <template v-else-if="row.kind === 'message' && row.message.role === 'user'">
                  <div class="flex w-full flex-col items-end gap-2" :data-delivery="row.message.delivery?.state">
                    <div class="flex w-full flex-col items-end gap-2 transition-opacity duration-200 motion-reduce:transition-none" :class="row.message.delivery?.state === 'sending' || row.message.delivery?.state === 'uncertain' ? 'opacity-50' : ''">
                    <div v-if="attachmentsOf(row.message).length" class="flex max-w-[min(82%,64ch)] flex-wrap justify-end gap-2">
                      <template v-for="(attachment, index) in attachmentsOf(row.message)" :key="`${row.id}:attachment:${index}`">
                      <TranscriptImage v-if="attachment.image && attachment.sha256" :image="{ sha256: attachment.sha256, name: attachment.name }" :gallery="attachmentImages(row.message)" :max-height="200" :max-width="320" />
                      <div
                        v-else
                        class="flex max-w-56 items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs"
                      >
                        <img v-if="attachment.image && attachment.url" :src="attachment.url" :alt="attachment.name" class="h-9 w-11 shrink-0 rounded object-cover">
                        <FileText v-else class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <div class="min-w-0">
                          <p class="truncate">{{ attachment.name }}</p>
                          <p v-if="attachment.detail" class="truncate text-[10px] text-muted-foreground">{{ attachment.detail }}</p>
                        </div>
                      </div>
                      </template>
                    </div>
                    <Bubble v-if="row.message.text || row.message.approval || row.message.redactionCount" variant="muted" align="end" class="max-w-[min(82%,64ch)]">
                      <BubbleContent>
                        <p v-if="row.message.redactionCount" class="text-xs text-muted-foreground">{{ row.message.redactionCount }} redacted</p>
                        <ApprovalDetails v-if="row.message.approval" :details="row.message.approval" />
                        <!-- Process IDs, such as agent mentions, show as chips. -->
                        <p v-else class="whitespace-pre-wrap break-words"><MentionPart v-for="(part, index) in splitProcessMentions(row.message.text)" :key="index" :part="part" /></p>
                      </BubbleContent>
                    </Bubble>
                    <div v-if="row.message.fileReferences?.length" class="flex max-w-[min(82%,64ch)] flex-wrap justify-end gap-1">
                      <span v-for="file in row.message.fileReferences" :key="file" class="max-w-full truncate rounded-md border border-border/70 bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">{{ file }}</span>
                    </div>
                    </div>
                    <div v-if="row.message.delivery && row.message.delivery.state !== 'accepted'" class="flex max-w-[min(82%,64ch)] flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs" :class="row.message.delivery.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'">
                      <span role="status" class="inline-flex items-center gap-1.5">
                        <Loader2 v-if="row.message.delivery.state === 'sending'" class="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        <AlertTriangle v-else class="h-3 w-3" aria-hidden="true" />
                        {{ row.message.delivery.state === 'sending' ? 'Sending…' : row.message.delivery.state === 'uncertain' ? 'Delivery uncertain' : 'Not sent' }}
                      </span>
                      <template v-if="row.message.delivery.state === 'failed'">
                        <span class="break-words">{{ row.message.delivery.error }}</span>
                        <button type="button" class="rounded-sm font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" :disabled="!canRetry" @click="emit('retry-message', row.message.delivery.messageId)">Retry</button>
                      </template>
                    </div>
                    <ConversationMessageFooter v-if="hasFooter(row)" :text="row.message.text" :created-at="row.message.createdAt" align="end" class="-mt-1 max-w-[min(82%,64ch)]" />
                  </div>
                </template>
                <div v-else-if="row.kind === 'tools'" class="w-full min-w-0 text-xs" data-component="transcript-tool-group">
                  <button
                    type="button"
                    class="group/tools flex max-w-full min-w-0 items-center gap-1 rounded-md py-1 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    :aria-expanded="rowOpen(row.id)"
                    @click="toggleRow(row.id)"
                  >
                    <template v-if="groupSummary(row).count">
                      <span class="shrink-0 text-muted-foreground"><ShimmerText v-if="groupRunning(row)" text="Using" /><template v-else>Used</template></span>
                      <span class="min-w-0 truncate font-[440] text-foreground" :title="groupSummary(row).label"><template v-for="(tool, index) in groupSummary(row).tools" :key="tool.title">{{ index ? ', ' : '' }}<template v-if="tool.count > 1"><OdometerNumber :value="tool.count" />{{ ' ' }}</template>{{ tool.title }}</template></span>
                    </template>
                    <template v-else>
                      <span class="shrink-0 font-[440] text-foreground"><ShimmerText v-if="groupRunning(row)" text="Thinking" /><template v-else>Thought</template></span>
                      <span v-if="!groupRunning(row) && groupThoughtTime(row)" class="shrink-0 text-muted-foreground">{{ groupThoughtTime(row) }}</span>
                    </template>
                    <ChevronDown
                      class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none"
                      :class="rowOpen(row.id) ? 'rotate-180' : ''"
                      aria-hidden="true"
                    />
                  </button>
                  <div v-if="!rowOpen(row.id) && groupImages(row).length" class="mt-1 flex flex-wrap gap-2">
                    <TranscriptImage v-for="image in groupImages(row)" :key="image.sha256" :image="image" :gallery="groupImages(row)" />
                  </div>
                  <div v-if="rowOpen(row.id)" class="mt-0.5 pl-3">
                    <template v-for="message in row.messages" :key="message.id">
                      <ConversationThoughtRow v-if="message.kind === 'reasoning'" :message="message" :process-id="processId" :duration-ms="thoughtDurations.get(message.id)" :thinking="isThinking(message)" :active="activeMessageId === message.id" :class="freshIds.has(message.id) ? ENTER_CLASS : ''" />
                      <ConversationToolRow v-else :message="message" :process-id="processId" :active="activeMessageId === message.id" :class="freshIds.has(message.id) ? ENTER_CLASS : ''" />
                    </template>
                  </div>
                </div>
                <ConversationToolRow v-else-if="row.message.kind === 'tool'" :message="row.message" :process-id="processId" :active="activeMessageId === row.message.id" />
                <div
                  v-else-if="row.message.kind === 'notice'"
                  class="flex w-full min-w-0 items-start gap-1.5 py-0.5 text-xs"
                  :class="row.message.level === 'error' ? 'text-destructive' : row.message.level === 'warning' ? 'text-warning' : 'text-muted-foreground'"
                  :role="row.message.level === 'error' ? 'alert' : 'status'"
                  data-component="transcript-notice"
                  :data-level="row.message.level ?? 'info'"
                >
                  <AlertTriangle v-if="row.message.level === 'error' || row.message.level === 'warning'" class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <Info v-else class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <p class="min-w-0 whitespace-pre-wrap break-words">{{ row.message.text }}</p>
                </div>
                <ConversationThoughtRow v-else-if="row.message.kind === 'reasoning'" :message="row.message" :process-id="processId" :duration-ms="thoughtDurations.get(row.message.id)" :thinking="isThinking(row.message)" :active="activeMessageId === row.message.id" />
                <Bubble v-else variant="ghost" align="start" class="max-w-full">
                  <BubbleContent>
                    <p v-if="row.message.redactionCount" class="mb-2 text-xs text-muted-foreground">{{ row.message.redactionCount }} redacted</p>
                    <ApprovalDetails v-if="row.message.approval" :details="row.message.approval" />
                    <Markdown v-else :source="row.message.text" :reveal-appends="Boolean(live)">
                      <template #mention="{ part }"><MentionPart :part="part" /></template>
                    </Markdown>
                    <div v-if="row.message.fileReferences?.length" class="mt-2 flex flex-wrap gap-1">
                      <span v-for="file in row.message.fileReferences" :key="file" class="max-w-full truncate rounded-md border border-border/70 bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">{{ file }}</span>
                    </div>
                  </BubbleContent>
                  <ConversationMessageFooter v-if="hasFooter(row)" :text="row.message.text" :created-at="row.message.createdAt" :duration-ms="turnDurations.get(row.message.id)" />
                </Bubble>
              </MessageContent>
            </Message>
              </MessageScrollerItem>
            </div>
          </div>
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton direction="end" />
    </MessageScroller>
  </MessageScrollerProvider>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, provide, ref, watch } from 'vue';
import { elementScroll, measureElement, observeElementOffset, useVirtualizer, type VirtualItem, type Virtualizer } from '@tanstack/vue-virtual';
import { AlertTriangle, ChevronDown, FileText, Info, Loader2 } from 'lucide-vue-next';
import { Bubble, BubbleContent } from './ui/bubble';
import { Message, MessageContent } from './ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from './ui/message-scroller';
import ConversationToolRow from './ConversationToolRow.vue';
import { figureAnsweredKey, figuresKey } from '../lib/htmlFigure';
import ConversationThoughtRow from './ConversationThoughtRow.vue';
import ConversationMessageFooter from './ConversationMessageFooter.vue';
import ShimmerText from './ShimmerText.vue';
import TranscriptImage from './TranscriptImage.vue';
import ApprovalDetails from './ConversationApprovalDetails.vue';
import Markdown from './Markdown.vue';
import OdometerNumber from './OdometerNumber.vue';
import MentionPart from './MentionPart.vue';
import ConversationAgentMessage from './ConversationAgentMessage.vue';
import { splitProcessMentions } from '../lib/agentMentions';
import {
  groupTranscriptMessages,
  isSavedFigure,
  figureId,
  figureAnswers,
  normaliseTranscriptAttachments,
  transcriptRowIndexForMessage,
  transcriptMessageKey,
  toggleTranscriptRow,
  transcriptRowOpen,
  elapsedLabel,
  transcriptThoughtDurations,
  transcriptToolGroupSummary,
  transcriptTurnDurations,
  type TranscriptImage as TranscriptImageData,
  type TranscriptMessage,
  type TranscriptRow
} from '../lib/integratedConversation';

const props = withDefaults(defineProps<{ messages: TranscriptMessage[]; truncated?: boolean; historyUnavailable?: boolean; hasOlder?: boolean; loadingOlder?: boolean; historyError?: string; processId: string; live?: boolean; working?: boolean; autoLoadOlder?: boolean; activeMessageId?: string | null; settling?: boolean; canRetry?: boolean }>(), { truncated: false, historyUnavailable: false, hasOlder: false, loadingOlder: false, historyError: '', live: false, working: false, autoLoadOlder: false, activeMessageId: null, settling: false, canRetry: false });
const emit = defineEmits<{ 'load-older': []; 'retry-message': [messageId: string] }>();

// Pages by id, drawn where a reply places [patterm_figure:<id>].
const figures = computed(() => {
  const byId = new Map<string, TranscriptMessage>();
  for (const message of props.messages) {
    if (message.kind === 'tool' && isSavedFigure(message.tool)) {
      const id = figureId(message.tool);
      if (id) byId.set(id, message);
    }
  }
  return byId;
});
const rows = computed(() => groupTranscriptMessages(props.messages));
provide(figuresKey, figures);
// A question the user already answered stays answered when the page redraws.
provide(figureAnsweredKey, computed(() => figureAnswers(props.messages)));
const thoughtDurations = computed(() => transcriptThoughtDurations(props.messages));
const turnDurations = computed(() => transcriptTurnDurations(props.messages, props.working));
const showHeader = computed(() => props.truncated || props.hasOlder || props.loadingOlder || Boolean(props.historyError) || props.historyUnavailable);
const groupState = ref<Record<string, boolean>>({});
// Touch screens have no hover, so tapping a message shows its copy button and
// time; tapping it again, or another message, moves them on.
const tappedRowId = ref<string | null>(null);
function tapRow(id: string, event: MouseEvent): void {
  if (!window.matchMedia('(hover: none)').matches) return;
  if ((event.target as Element | null)?.closest('button, a, input, textarea, summary, [role="button"]')) return;
  if (!window.getSelection()?.isCollapsed) return;
  tappedRowId.value = tappedRowId.value === id ? null : id;
}
const viewportRef = ref<InstanceType<typeof MessageScrollerViewport> | null>(null);
const virtualizer = useVirtualizer(computed(() => ({
  count: rows.value.length,
  getScrollElement: () => viewportRef.value?.viewportElement() ?? null,
  estimateSize: () => 120,
  overscan: 8,
  // Clear the overlaid header so it does not cover the first message.
  paddingStart: showHeader.value ? 56 : 24,
  paddingEnd: 24,
  anchorTo: 'end' as const,
  // Transcripts open at their end. Starting the range there, and moving the
  // viewport there before TanStack reads its offset, renders only the last
  // rows, instead of rendering the first rows and replacing them a frame later.
  initialOffset: () => props.activeMessageId ? 0 : rows.value.length * 120,
  observeElementOffset: (instance: Virtualizer<HTMLElement, Element>, callback: (offset: number, isScrolling: boolean) => void) => {
    const viewport = instance.scrollElement;
    syncSizer(instance);
    if (viewport && !props.activeMessageId) viewport.scrollTop = viewport.scrollHeight;
    return observeElementOffset(instance, callback);
  },
  // A row above the viewport that measures taller than its estimate moves
  // the viewport down by the difference, before Vue has grown the sizer. The
  // browser would clamp that to the old height and the reader would jump up,
  // so grow the sizer first.
  scrollToFn: (offset: number, options: { adjustments?: number; behavior?: ScrollBehavior }, instance: Virtualizer<HTMLElement, Element>) => {
    // Before the sizer: a shrinking sizer clamps the view, and that move is
    // part of the correction too.
    const from = instance.scrollElement?.scrollTop;
    syncSizer(instance);
    elementScroll(offset, options, instance);
    // A correction, not the reader scrolling away from the end.
    scrollerRef.value?.noteProgrammaticScroll(from);
  },
  measureElement: (element: Element, entry: ResizeObserverEntry | undefined, instance: Virtualizer<HTMLElement, Element>) => {
    rewrappedKey = rowRewrapped(element, entry) ? instance.options.getItemKey(instance.indexFromElement(element)) : null;
    return measureElement(element, entry, instance);
  },
  // TanStack would otherwise snap to the end as the last row grows; the
  // message scroller glides there instead.
  scrollEndThreshold: -1,
  getItemKey: (index: number) => rows.value[index]?.id ?? index
})));
// Rows wholly above the viewport move it by however much they resize, so the
// rows on screen stay put. The row across the top edge is being read: a reply
// streaming into it grows below the reader and leaves the view alone. Its
// first measurement replaces an estimate for the whole row, so it moves the
// view by all of it, and a narrower or wider column rewraps the whole row, so
// the view keeps the share of the row that was above the edge.
virtualizer.value.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
  const offset = instance.scrollOffset ?? 0;
  if (item.index < (instance.range?.startIndex ?? 0)) return true;
  if (item.start >= offset) return false;
  if (!instance.itemSizeCache.has(item.key)) return true;
  if (item.key === rewrappedKey && item.size > 0) {
    const shift = delta * (offset - item.start) / item.size;
    // Once resizeItem has stored the new size, so the sizer grows before the
    // view moves and the browser does not clamp the move near the end.
    queueMicrotask(() => adjustScroll(instance, shift));
  }
  return false;
};
// The row the virtualiser is measuring, when the column width changed since
// the row was last measured. Measuring and resizing a row run back to back.
let rewrappedKey: VirtualItem['key'] | null = null;
const rowWidths = new WeakMap<Element, number>();
function rowRewrapped(element: Element, entry: ResizeObserverEntry | undefined): boolean {
  // Only resize observations carry a width; render-time measurements reuse
  // the cached size without reading layout.
  const width = entry?.borderBoxSize?.[0]?.inlineSize ?? entry?.contentRect.width;
  if (width === undefined) return false;
  const previous = rowWidths.get(element);
  rowWidths.set(element, width);
  return previous !== undefined && Math.abs(previous - width) > 0.5;
}
// TanStack's own correction path, which keeps its offset and the sizer in step
// with the write; it has no public equivalent.
function adjustScroll(instance: Virtualizer<HTMLElement, Element>, delta: number): void {
  (instance as unknown as { applyScrollAdjustment?: (value: number) => void }).applyScrollAdjustment?.(delta);
}
// Messages usually arrive after the transcript mounts. Starting the range at
// the end before they render, then moving the viewport there, likewise
// renders only the last rows.
watch(() => rows.value.length, (count, previous) => {
  if (previous || !count || props.activeMessageId) return;
  const instance = virtualizer.value;
  instance.scrollOffset = Math.max(0, instance.getTotalSize() - (viewportRef.value?.viewportElement()?.clientHeight ?? 0));
  void nextTick(scrollToBottom);
});
const scrollerRef = ref<InstanceType<typeof MessageScrollerProvider> | null>(null);
const virtualItems = computed(() => virtualizer.value.getVirtualItems());
const renderedRows = computed(() => virtualItems.value.flatMap((virtualItem) => {
  const row = rows.value[virtualItem.index];
  return row ? [{ virtualItem, row }] : [];
}));
const totalSize = computed(() => virtualizer.value.getTotalSize());
// The virtualiser owns the sizer's height, so the scroll function above can
// set it ahead of Vue without Vue later skipping a patch it thinks is current.
// Resync on every virtualiser change, not only when the total changes: rows
// that grow and shrink by the same amount in one batch leave the total as it
// was but the sizer at the height written in between.
const sizerRef = ref<HTMLElement | null>(null);
function syncSizer(instance: Virtualizer<HTMLElement, Element> = virtualizer.value): void {
  if (sizerRef.value) sizerRef.value.style.height = `${instance.getTotalSize()}px`;
}
watch([virtualizer, sizerRef], () => syncSizer(), { flush: 'post' });
const readyForAutoLoad = ref(false);
// Older pages load only after the reader scrolls. The first snapshot lands
// while the viewport is still at the top, which is not a request for history.
const scrolledByUser = ref(false);

// Rows appended after mount fade in once. Tracking is by message ID so
// virtualised rows that remount on scroll, prepended history pages, and a
// single tool regrouping into a tool group do not replay the animation.
const ENTER_CLASS = 'animate-in fade-in slide-in-from-bottom-1 duration-300 ease-out motion-reduce:animate-none';
const freshIds = ref<ReadonlySet<string>>(new Set());
watch(() => props.messages, (next, previous) => {
  const last = previous?.at(-1);
  const lastId = last && transcriptMessageKey(last);
  const from = lastId ? next.findIndex((message) => transcriptMessageKey(message) === lastId) + 1 : 0;
  if (!lastId || from === 0 || from >= next.length) return;
  const added = next.slice(from).map(transcriptMessageKey);
  freshIds.value = new Set([...freshIds.value, ...added]);
  window.setTimeout(() => {
    const remaining = new Set(freshIds.value);
    for (const id of added) remaining.delete(id);
    freshIds.value = remaining;
  }, 400);
});

function rowFresh(row: TranscriptRow): boolean {
  return freshIds.value.has(row.kind === 'tools' ? row.messages[0]!.id : row.id);
}

function measureRow(element: unknown): void {
  if (element instanceof HTMLElement) virtualizer.value.measureElement(element);
}

onMounted(() => {
  void nextTick(() => {
    const viewport = viewportRef.value?.viewportElement();
    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) viewport?.addEventListener(type, () => { scrolledByUser.value = true; }, { passive: true });
    // Opening a tool, group or thinking row is reading: keep the row where it
    // is rather than gliding it away to the live edge. Closing it again gives
    // the end back if it is within reach.
    viewport?.addEventListener('click', (event) => {
      const toggle = event.target instanceof Element ? event.target.closest('button[aria-expanded]') : null;
      if (!toggle) return;
      if (toggle.getAttribute('aria-expanded') === 'true') scrollerRef.value?.releaseHold();
      else scrollerRef.value?.pauseFollowing();
    }, { capture: true });
    scrollToBottom();
    readyForAutoLoad.value = true;
    if (props.activeMessageId) void scrollToMessage(props.activeMessageId);
  });
});

function scrollToBottom(): void {
  const viewport = viewportRef.value?.viewportElement();
  if (viewport) viewport.scrollTop = viewport.scrollHeight;
}

// A cached transcript paints at its end before the first snapshot replaces
// it. Until that snapshot settles, hold the end after every render, before
// paint, so the new rows land in place rather than showing the cached end and
// then gliding to the new one. The snapshot lands in the same tick that
// settling ends, and its rows measure over the next frames, so the hold lasts
// two frames longer. A click does not end it; scrolling up does.
const holdingEnd = ref(props.settling);
watch(() => props.settling, (settling) => {
  if (settling) holdingEnd.value = true;
  else void nextTick(() => requestAnimationFrame(() => requestAnimationFrame(() => { if (!props.settling) holdingEnd.value = false; })));
});
watch([totalSize, holdingEnd], ([, holding]) => {
  if (holding && !props.activeMessageId && scrollerRef.value?.isFollowing() !== false) scrollToBottom();
}, { flush: 'post' });

// Post-flush so scrollTop reflects the rows just rendered.
watch([virtualItems, () => props.hasOlder, () => props.autoLoadOlder, readyForAutoLoad, scrolledByUser], ([items, hasOlder, autoLoad, ready, scrolled]) => {
  const viewport = viewportRef.value?.viewportElement();
  if (autoLoad && ready && scrolled && hasOlder && !props.loadingOlder && viewport && viewport.scrollTop <= 200 && items[0] && items[0].index <= 3) emit('load-older');
}, { flush: 'post' });

watch(() => props.activeMessageId, (id) => { if (id) void scrollToMessage(id); });

async function scrollToMessage(id: string): Promise<void> {
  const index = transcriptRowIndexForMessage(rows.value, id);
  const row = rows.value[index];
  if (!row) return;
  if (row.kind === 'tools' && !rowOpen(row.id)) toggleRow(row.id);
  // The message is being read, so new rows below must not follow it away.
  scrollerRef.value?.pauseFollowing();
  await nextTick();
  if (index >= 0) virtualizer.value.scrollToIndex(index, { align: 'center' });
}

// Sending returns to the live edge so the reply is followed.
function followEnd(): void {
  scrollerRef.value?.scrollToEnd({ behavior: 'auto' });
}

defineExpose({ scrollToMessage, scrollToBottom, followEnd });

// A collapsed group still shows the images its tools returned.
function groupImages(row: { messages: TranscriptMessage[] }): TranscriptImageData[] {
  const seen = new Set<string>();
  return row.messages.flatMap((message) => (message.tool?.images ?? []).map((image) => ({ ...image, name: image.name ?? message.tool?.target })))
    .filter((image) => !seen.has(image.sha256) && Boolean(seen.add(image.sha256))).slice(0, 8);
}

function attachmentImages(message: TranscriptMessage): TranscriptImageData[] {
  return attachmentsOf(message).flatMap((attachment) => attachment.image && attachment.sha256 ? [{ sha256: attachment.sha256, name: attachment.name }] : []);
}

function attachmentsOf(message: TranscriptMessage): ReturnType<typeof normaliseTranscriptAttachments> {
  return normaliseTranscriptAttachments(message.attachments);
}

function rowOpen(id: string): boolean {
  return groupState.value[id] ?? transcriptRowOpen(props.processId, id);
}

function toggleRow(id: string): void {
  groupState.value = { ...groupState.value, [id]: toggleTranscriptRow(props.processId, id) };
}

type ToolGroupRow = Extract<TranscriptRow, { kind: 'tools' }>;

// Prompts and replies get a hover footer with their time and a copy button.
function hasFooter(row: TranscriptRow): boolean {
  if (row.kind !== 'message' || row.origin?.kind === 'patterm' || row.message.kind !== 'text' || row.message.approval || !row.message.text.trim()) return false;
  return row.message.role === 'assistant' || !row.message.delivery || row.message.delivery.state === 'accepted';
}

// The newest thought is still being written while the agent works.
function isThinking(message: TranscriptMessage): boolean {
  return props.working && !message.completedAt && props.messages.at(-1)?.id === message.id;
}

function groupSummary(row: ToolGroupRow): ReturnType<typeof transcriptToolGroupSummary> {
  return transcriptToolGroupSummary(row.messages);
}

function groupRunning(row: ToolGroupRow): boolean {
  return row.messages.some((message) => message.tool?.status === 'running' || isThinking(message));
}

function groupThoughtTime(row: ToolGroupRow): string {
  const total = row.messages.reduce((sum, message) => sum + (thoughtDurations.value.get(message.id) ?? 0), 0);
  return total >= 1_000 ? elapsedLabel(total) : '';
}
</script>
