<template>
  <iframe
    ref="frame"
    :key="generation"
    :src="src"
    :title="title"
    sandbox="allow-scripts allow-forms"
    loading="lazy"
    class="block w-full border-0 bg-transparent"
    :style="{ height: `${height}px` }"
    data-component="html-figure-frame"
  />
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { FIGURE_HEIGHT } from '../../../app/Services/HtmlFigure';
import { FIGURE_ID, figureAnswerText } from '../../../app/Services/TranscriptProjection';
import { figureAnswerKey, figureAnsweredKey, figureFrameUrl } from '../lib/htmlFigure';

// One agent page in its sandboxed frame. The page reaches Patterm only by
// messages: its height, links to open, and answers, which go through the
// conversation's own send path.
// measureKey names the page for the height cache; the prepared html carries
// inline fonts, too large to keep as keys. Without one, nothing is cached.
const props = defineProps<{ html: string; measureKey?: string; title: string; initialHeight: number }>();
const channel = inject(figureAnswerKey, null);
const answered = inject(figureAnsweredKey, null);
const frame = ref<HTMLIFrameElement | null>(null);
const src = figureFrameUrl();
const generation = ref(0);
const height = ref(remembered() ?? props.initialHeight);
const sending = new Set<string>();

// A frame draws one page; a changed page gets a fresh frame.
watch(() => props.html, () => {
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
    height.value = Math.min(FIGURE_HEIGHT.max, Math.max(16, Math.ceil(data.height)));
    if (props.measureKey) remember(props.measureKey, height.value);
  } else if (data.type === 'open-link' && typeof data.url === 'string' && /^https?:\/\//i.test(data.url) && navigator.userActivation?.isActive) {
    window.open(data.url, '_blank', 'noopener,noreferrer');
  } else if (data.type === 'answer') {
    void answer(data);
  }
}

async function answer(data: Record<string, unknown>): Promise<void> {
  const reply = (ok: boolean, error?: string) => post({ type: 'answer-result', requestId: data.requestId, ok, ...(error ? { error } : {}) });
  const id = typeof data.id === 'string' && ID.test(data.id) ? data.id : null;
  const picks = readPicks(data.picks);
  if (!id || !picks) { reply(false, 'patterm.answer needs an id and { label, value } picks'); return; }
  if (!channel) { reply(false, 'Answer this in the live conversation.'); return; }
  if (!channel.canSend.value) { reply(false, 'Only the window in control of this agent can answer.'); return; }
  if (answers.value.has(id) || sending.has(id)) { reply(false, 'Already answered.'); return; }
  // A page cannot answer for the user on its own; the pick follows a click.
  if (!navigator.userActivation?.isActive) { reply(false, 'Answers must come from a click or key press.'); return; }
  sending.add(id);
  try {
    await channel.send(figureAnswerText(id, picks));
    reply(true);
  } catch (cause) {
    reply(false, cause instanceof Error ? cause.message : String(cause));
  } finally {
    sending.delete(id);
  }
}

onMounted(() => window.addEventListener('message', onMessage));
onBeforeUnmount(() => window.removeEventListener('message', onMessage));
</script>

<script lang="ts">
const ID = new RegExp(`^${FIGURE_ID}$`);

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
