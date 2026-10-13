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
    <!-- Patterm's own controls: page script cannot press them, so an answer
         reaches the agent only when the user sends it here. -->
    <div v-if="proposal" class="mt-2 flex items-start gap-3 rounded-md bg-muted/30 px-3 py-2 text-xs" role="group" aria-label="Answer from this page" data-component="html-figure-answer">
      <p class="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted-foreground"><span class="text-foreground">Send to the agent:</span> {{ proposal.text }}</p>
      <div class="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" class="h-6 px-2 text-xs text-muted-foreground" :disabled="sendingProposal" @click="settle(false, 'Cancelled.')">Cancel</Button>
        <Button size="sm" class="h-6 px-2 text-xs" :disabled="sendingProposal" @click="confirm">Send</Button>
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
// messages: its height, and answers it proposes, which the user sends from
// Patterm's own bar through the conversation's send path. Links open as
// popups, which the browser allows only after a click inside the frame.
// measureKey names the page for the height cache; the prepared html carries
// inline fonts, too large to keep as keys. Without one, nothing is cached.
const props = defineProps<{ html: string; measureKey?: string; title: string; initialHeight: number }>();
const channel = inject(figureAnswerKey, null);
const answered = inject(figureAnsweredKey, null);
const frame = ref<HTMLIFrameElement | null>(null);
const src = figureFrameUrl();
const generation = ref(0);
const height = ref(remembered() ?? props.initialHeight);
// The answer the page proposed, waiting for the user. A new proposal replaces it.
const proposal = ref<{ id: string; text: string; requestId: unknown } | null>(null);
const sendingProposal = ref(false);

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
    height.value = Math.min(FIGURE_HEIGHT.max, Math.max(16, Math.ceil(data.height)));
    if (props.measureKey) remember(props.measureKey, height.value);
  } else if (data.type === 'answer') {
    propose(data);
  }
}

function propose(data: Record<string, unknown>): void {
  const reply = (error: string) => post({ type: 'answer-result', requestId: data.requestId, ok: false, error });
  const id = typeof data.id === 'string' && ID.test(data.id) ? data.id : null;
  const picks = readPicks(data.picks);
  if (!id || !picks) { reply('patterm.answer needs an id and { label, value } picks'); return; }
  if (!channel) { reply('Answer this in the live conversation.'); return; }
  if (!channel.canSend.value) { reply('Only the window in control of this agent can answer.'); return; }
  if (answers.value.has(id)) { reply('Already answered.'); return; }
  if (sendingProposal.value) { reply('An answer is being sent.'); return; }
  settle(false, 'Replaced by a newer answer.');
  proposal.value = { id, text: figureAnswerText(id, picks), requestId: data.requestId };
}

// Tells the page how its proposal ended and clears the bar.
function settle(ok: boolean, error?: string): void {
  const current = proposal.value;
  if (!current) return;
  proposal.value = null;
  post({ type: 'answer-result', requestId: current.requestId, ok, ...(error ? { error } : {}) });
}

async function confirm(event: MouseEvent): Promise<void> {
  const current = proposal.value;
  if (!event.isTrusted || !current || !channel || sendingProposal.value) return;
  if (!channel.canSend.value || answers.value.has(current.id)) { settle(false, answers.value.has(current.id) ? 'Already answered.' : 'Only the window in control of this agent can answer.'); return; }
  sendingProposal.value = true;
  try {
    await channel.send(current.text);
    settle(true);
  } catch (cause) {
    settle(false, cause instanceof Error ? cause.message : String(cause));
  } finally {
    sendingProposal.value = false;
  }
}

onMounted(() => window.addEventListener('message', onMessage));
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
  settle(false, 'The page closed.');
});
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
