<template>
  <div class="min-w-0">
    <iframe
      ref="frame"
      :key="generation"
      :src="src"
      :title="title"
      :sandbox="FIGURE_FRAME_SANDBOX"
      loading="lazy"
      class="block w-full border-0 bg-transparent"
      :style="{ height: `${height}px` }"
      data-component="html-figure-frame"
    />
    <!-- Patterm's own controls: page script cannot press them, so a link
         opens only once the user confirms it here. The key rebuilds them when
         the link changes, so a press that began on an older one cannot finish
         on this one. -->
    <div v-if="request" ref="bar" :key="request.revision" class="mt-1.5 flex items-start gap-2 text-xs text-muted-foreground" role="group" aria-label="Link from this page" data-component="html-figure-request">
      <ExternalLink class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <p class="min-w-0 flex-1 truncate" :title="request.url"><span class="text-foreground">{{ linkParts(request.url).host }}</span>{{ linkParts(request.url).rest }}</p>
      <button type="button" class="shrink-0 font-medium text-foreground hover:underline" @pointerdown="arm" @keydown.enter="arm" @keydown.space="arm" @click="confirm">Open</button>
      <button type="button" class="shrink-0 hover:text-foreground" aria-label="Cancel" @click="settle(false, 'Cancelled.')"><X class="size-3.5" /></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ExternalLink, X } from 'lucide-vue-next';
import { FIGURE_FRAME_SANDBOX, FIGURE_HEIGHT } from '../../../app/Services/HtmlFigure';
import { FIGURE_ID, figureAnswerText } from '../../../app/Services/TranscriptProjection';
import { figureAnswerKey, figureAnsweredKey, figureFrameUrl, guardFigureFocus } from '../lib/htmlFigure';

// One agent page in its sandboxed frame. The page reaches Patterm only by
// messages: its height, answers the user picked in it, which go through the
// conversation's send path, and links, which wait in Patterm's own bar until
// the user confirms them.
// measureKey names the page for the height cache; the prepared html carries
// inline fonts, too large to keep as keys. Without one, nothing is cached.
const props = defineProps<{ html: string; measureKey?: string; title: string; initialHeight: number }>();
const channel = inject(figureAnswerKey, null);
const answered = inject(figureAnsweredKey, null);
const frame = ref<HTMLIFrameElement | null>(null);
const src = figureFrameUrl();
const generation = ref(0);
const height = ref(remembered() ?? props.initialHeight);
// The link the page asked to open, waiting for the user. A newer one replaces
// it. The revision and time are Patterm's own, so the page cannot reuse them.
interface PageRequest { url: string; requestId: unknown; revision: number; shownAt: number }
const request = ref<PageRequest | null>(null);
const sending = ref(false);
let revision = 0;
// The bar on screen. Anything can move it, including pages resizing or other
// bars changing, so its position is watched while it is shown.
const bar = ref<HTMLElement | null>(null);
let place: string | null = null;
let stillSince = 0;
let watching = 0;
// The request a press of the confirm button began on, and where the bar was.
let armed: { revision: number; place: string } | null = null;

// A frame draws one page; a changed page gets a fresh frame.
watch(() => props.html, () => {
  settle(false, 'The page changed.');
  generation.value++;
  height.value = remembered() ?? props.initialHeight;
});

const answers = computed(() => {
  const all = new Map(answered?.value ?? []);
  for (const [id, text] of channel?.queued.value ?? []) if (!all.has(id)) all.set(id, text);
  return all;
});
const canAnswer = computed(() => Boolean(channel?.canSend.value));
watch([answers, canAnswer], () => pushState());

function remembered(): number | undefined {
  return props.measureKey ? measured.get(props.measureKey) : undefined;
}

function post(message: Record<string, unknown>): void {
  frame.value?.contentWindow?.postMessage({ source: 'patterm-host', ...message }, '*');
}

function pushState(): void {
  post({ type: 'state', answers: Object.fromEntries(answers.value), canAnswer: canAnswer.value });
}

function onMessage(event: MessageEvent): void {
  if (!frame.value || event.source !== frame.value.contentWindow) return;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || data.source !== 'patterm-figure') return;
  if (data.type === 'ready') {
    post({ type: 'render', html: props.html });
    pushState();
  } else if (data.type === 'size' && typeof data.height === 'number' && Number.isFinite(data.height)) {
    const next = Math.min(FIGURE_HEIGHT.max, Math.max(16, Math.ceil(data.height)));
    height.value = next;
    if (props.measureKey) remember(props.measureKey, height.value);
  } else if (data.type === 'answer') {
    void answer(data);
  } else if (data.type === 'open-link' && typeof data.url === 'string' && /^https?:\/\//i.test(data.url) && data.url.length <= 2048) {
    show({ url: data.url, requestId: data.requestId });
  }
}

// A pick sends at once, but only right after a click or key press, while
// focus is on this frame, so a page cannot answer from a timer or on load.
// The browser does not say where the click was: a page written to keep
// taking focus back could catch a click elsewhere in the app. Answers reach
// only the agent that wrote the page and never approve permissions, so that
// is accepted rather than asking the user to confirm every pick.
async function answer(data: Record<string, unknown>): Promise<void> {
  const reply = (ok: boolean, error?: string) => post({ type: 'answer-result', requestId: data.requestId, ok, ...(error ? { error } : {}) });
  const id = typeof data.id === 'string' && ID.test(data.id) ? data.id : null;
  const picks = readPicks(data.picks);
  if (!id || !picks) { reply(false, 'patterm.answer needs an id and { label, value } picks'); return; }
  if (!channel) { reply(false, 'Answer this in the live conversation.'); return; }
  if (!channel.canSend.value) { reply(false, 'Only the window in control of this agent can answer.'); return; }
  if (answers.value.has(id)) { reply(false, 'Already answered.'); return; }
  if (!navigator.userActivation?.isActive || document.activeElement !== frame.value) { reply(false, 'patterm.answer sends only as the user clicks or types in the page.'); return; }
  if (sending.value) { reply(false, 'Patterm is still sending the last answer.'); return; }
  sending.value = true;
  try {
    await channel.send(figureAnswerText(id, picks));
    reply(true);
  } catch (cause) {
    reply(false, cause instanceof Error ? cause.message : String(cause));
  } finally {
    sending.value = false;
  }
}

function show(next: Omit<PageRequest, 'revision' | 'shownAt'>): void {
  settle(false, 'Replaced by a newer request.');
  request.value = { ...next, revision: ++revision, shownAt: performance.now() };
  watchPlace();
}

// Tells the page how its request ended and clears the bar.
function settle(ok: boolean, error?: string): void {
  const current = request.value;
  if (!current) return;
  request.value = null;
  armed = null;
  post({ type: 'answer-result', requestId: current.requestId, ok, ...(error ? { error } : {}) });
}

// A press counts only once the request has stood unchanged, and its bar
// unmoved, long enough to read, so a page cannot swap it in or slide it under
// the pointer just as the user reaches for something else.
function arm(event: Event): void {
  const current = request.value;
  const now = performance.now();
  measure();
  armed = event.isTrusted && current && place !== null && now - current.shownAt >= STEADY_MS && now - stillSince >= STEADY_MS ? { revision: current.revision, place } : null;
}

// Notes where the bar is; a move restarts the wait and drops any press.
function measure(): void {
  const rect = bar.value?.getBoundingClientRect();
  const next = rect ? `${rect.left},${rect.top},${rect.width},${rect.height}` : null;
  if (next === place) return;
  place = next;
  stillSince = performance.now();
  armed = null;
}

function watchPlace(): void {
  const run = ++watching;
  place = null;
  const step = () => {
    if (run !== watching || !request.value) return;
    measure();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function confirm(event: MouseEvent): void {
  const current = request.value;
  const pressed = armed;
  armed = null;
  measure();
  // A press counts only on the request it began on, with the bar where it was.
  if (!event.isTrusted || !current || pressed?.revision !== current.revision || pressed.place !== place) return;
  window.open(current.url, '_blank', 'noopener,noreferrer');
  settle(true);
}

onMounted(() => {
  guardFigureFocus();
  window.addEventListener('message', onMessage);
});
onBeforeUnmount(() => {
  watching++;
  window.removeEventListener('message', onMessage);
  settle(false, 'The page closed.');
});
</script>

<script lang="ts">
const ID = new RegExp(`^${FIGURE_ID}$`);
const STEADY_MS = 500;

// Picks become one line each in the user's message.
function readPicks(raw: unknown): Array<{ item?: string; label: string; value: string }> | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 50) return null;
  const line = (value: unknown, max: number) => (typeof value === 'string' || typeof value === 'number') && String(value).trim() ? String(value).replace(/\s+/g, ' ').trim().slice(0, max) : null;
  const picks = raw.map((pick) => {
    if (!pick || typeof pick !== 'object') return null;
    const record = pick as Record<string, unknown>;
    const label = line(record.label, 200);
    const value = line(record.value, 200);
    const item = record.item === undefined ? undefined : line(record.item, 120);
    return label && value && item !== null ? { label, value, ...(item ? { item } : {}) } : null;
  });
  return picks.every((pick) => pick !== null) ? picks as Array<{ item?: string; label: string; value: string }> : null;
}

// The host stands out, so a look-alike path cannot pass for another site.
function linkParts(url: string): { host: string; rest: string } {
  if (!URL.canParse(url)) return { host: url, rest: '' };
  const { host, pathname, search, hash } = new URL(url);
  return { host, rest: `${pathname === '/' ? '' : pathname}${search}${hash}` };
}

// Heights pages reported, so a row that scrolls back into view opens at its
// size instead of growing again.
const measured = new Map<string, number>();
function remember(key: string, height: number): void {
  measured.delete(key);
  measured.set(key, height);
  if (measured.size > 64) measured.delete(measured.keys().next().value!);
}
</script>
