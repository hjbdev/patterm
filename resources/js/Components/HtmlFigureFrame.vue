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
    <!-- Patterm's own controls: page script cannot press them, so nothing a
         page asks for happens until the user confirms it here. The key
         rebuilds them when the request changes, so a press that began on an
         older request cannot finish on this one. -->
    <div v-if="request" ref="bar" :key="request.revision" class="mt-2 flex items-start gap-3 rounded-md bg-muted/30 px-3 py-2 text-xs" role="group" :aria-label="request.kind === 'link' ? 'Link from this page' : 'Answer from this page'" data-component="html-figure-request">
      <p class="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted-foreground"><span class="text-foreground">{{ request.kind === 'link' ? 'Open in your browser:' : 'Send to the agent:' }}</span> {{ request.text }}</p>
      <div class="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" class="h-6 px-2 text-xs text-muted-foreground" :disabled="sending" @click="settle(false, 'Cancelled.')">Cancel</Button>
        <Button size="sm" class="h-6 px-2 text-xs" :disabled="sending" @pointerdown="arm" @keydown.enter="arm" @keydown.space="arm" @click="confirm">{{ request.kind === 'link' ? 'Open' : 'Send' }}</Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Button } from './ui/button';
import { FIGURE_FRAME_SANDBOX, FIGURE_HEIGHT } from '../../../app/Services/HtmlFigure';
import { FIGURE_ID, figureAnswerText } from '../../../app/Services/TranscriptProjection';
import { figureAnswerKey, figureAnsweredKey, figureFrameUrl } from '../lib/htmlFigure';

// One agent page in its sandboxed frame. The page reaches Patterm only by
// messages: its height, and requests to answer or open a link, which wait in
// Patterm's own bar until the user confirms them. Answers go through the
// conversation's send path.
// measureKey names the page for the height cache; the prepared html carries
// inline fonts, too large to keep as keys. Without one, nothing is cached.
const props = defineProps<{ html: string; measureKey?: string; title: string; initialHeight: number }>();
const channel = inject(figureAnswerKey, null);
const answered = inject(figureAnsweredKey, null);
const frame = ref<HTMLIFrameElement | null>(null);
const src = figureFrameUrl();
const generation = ref(0);
const height = ref(remembered() ?? props.initialHeight);
// What the page asked for, waiting for the user. A newer request replaces it.
// The revision and time are Patterm's own, so the page cannot reuse them.
interface PageRequest { kind: 'answer' | 'link'; text: string; id?: string; url?: string; requestId: unknown; revision: number; shownAt: number }
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
    proposeAnswer(data);
  } else if (data.type === 'open-link' && typeof data.url === 'string' && /^https?:\/\//i.test(data.url) && data.url.length <= 2048) {
    show({ kind: 'link', text: data.url, url: data.url, requestId: data.requestId });
  }
}

function proposeAnswer(data: Record<string, unknown>): void {
  const reply = (error: string) => post({ type: 'answer-result', requestId: data.requestId, ok: false, error });
  const id = typeof data.id === 'string' && ID.test(data.id) ? data.id : null;
  const picks = readPicks(data.picks);
  if (!id || !picks) { reply('patterm.answer needs an id and { label, value } picks'); return; }
  if (!channel) { reply('Answer this in the live conversation.'); return; }
  if (!channel.canSend.value) { reply('Only the window in control of this agent can answer.'); return; }
  if (answers.value.has(id)) { reply('Already answered.'); return; }
  show({ kind: 'answer', id, text: figureAnswerText(id, picks), requestId: data.requestId });
}

function show(next: Omit<PageRequest, 'revision' | 'shownAt'>): void {
  if (sending.value) { post({ type: 'answer-result', requestId: next.requestId, ok: false, error: 'Patterm is still sending the last answer.' }); return; }
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

async function confirm(event: MouseEvent): Promise<void> {
  const current = request.value;
  const pressed = armed;
  armed = null;
  measure();
  // A press counts only on the request it began on, with the bar where it was.
  if (!event.isTrusted || !current || pressed?.revision !== current.revision || pressed.place !== place || sending.value) return;
  if (current.kind === 'link') {
    window.open(current.url, '_blank', 'noopener,noreferrer');
    settle(true);
    return;
  }
  if (!channel || !channel.canSend.value || answers.value.has(current.id!)) { settle(false, channel && answers.value.has(current.id!) ? 'Already answered.' : 'Only the window in control of this agent can answer.'); return; }
  sending.value = true;
  try {
    await channel.send(current.text);
    settle(true);
  } catch (cause) {
    settle(false, cause instanceof Error ? cause.message : String(cause));
  } finally {
    sending.value = false;
  }
}

onMounted(() => window.addEventListener('message', onMessage));
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

// Heights pages reported, so a row that scrolls back into view opens at its
// size instead of growing again.
const measured = new Map<string, number>();
function remember(key: string, height: number): void {
  measured.delete(key);
  measured.set(key, height);
  if (measured.size > 64) measured.delete(measured.keys().next().value!);
}
</script>
