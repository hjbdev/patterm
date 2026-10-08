<template>
  <section
    ref="root"
    tabindex="-1"
    role="dialog"
    :aria-label="`Background task: ${task.label}`"
    class="absolute inset-0 z-30 flex min-h-0 flex-col bg-background shadow-[-12px_0_32px_-16px_rgb(0_0_0/0.35)] outline-none"
    data-component="integrated-task-drawer"
    @keydown.esc.stop.prevent="emit('close')"
  >
    <header class="shrink-0 border-b border-border/60">
      <div class="mx-auto flex h-11 w-full max-w-[50rem] min-w-0 items-center gap-2 px-4 2xl:max-w-[1000px]">
        <Button variant="ghost" size="sm" class="-ml-2 h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground" aria-label="Back to conversation" @click="emit('close')">
          <ArrowLeft class="h-3.5 w-3.5" aria-hidden="true" />
          Conversation
        </Button>
        <span class="text-muted-foreground/60" aria-hidden="true">/</span>
        <Loader2 v-if="active" class="h-3.5 w-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
        <X v-else-if="task.status === 'failed'" class="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
        <Check v-else-if="task.status === 'completed'" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Circle v-else class="h-2.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 class="min-w-0 truncate text-sm font-[440]">{{ task.label }}</h2>
        <span v-if="task.kind" class="shrink-0 text-xs text-muted-foreground">{{ task.kind }}</span>
        <span class="sr-only">{{ task.status }}</span>
        <Button v-if="task.stoppable" size="sm" variant="ghost" class="ml-auto h-7 shrink-0 px-2 text-xs" :disabled="!canStop || stopping" @click="emit('stop')">Stop</Button>
      </div>
    </header>
    <div class="relative flex min-h-0 flex-1 flex-col">
      <LoadingBar :active="loading" label="Loading task output" />
      <ConversationTranscript v-if="format === 'transcript'" :messages="messages" :has-older="Boolean(olderCursor)" :loading-older="loadingOlder" :history-error="olderError" :process-id="`${processId}:task:${task.id}`" :live="active" auto-load-older class="min-h-0 flex-1" @load-older="loadOlder" />
      <div v-else-if="format === 'text'" ref="textViewport" class="min-h-0 flex-1 overflow-auto overscroll-contain">
        <div class="mx-auto w-full max-w-[50rem] px-4 py-4 2xl:max-w-[1000px]">
          <p v-if="truncated" class="mb-2 text-xs text-muted-foreground">Showing the end of the output.</p>
          <pre class="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">{{ text || 'No output yet.' }}</pre>
        </div>
      </div>
      <p v-else-if="format === 'missing'" role="status" class="mx-auto w-full max-w-[50rem] px-4 py-6 text-sm text-muted-foreground 2xl:max-w-[1000px]">
        {{ active ? 'Waiting for the task to write output…' : 'No output was kept for this task.' }}
      </p>
      <p v-if="error" role="alert" class="mx-auto w-full max-w-[50rem] shrink-0 break-words px-4 pb-3 text-sm text-destructive 2xl:max-w-[1000px]">{{ error }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { ArrowLeft, Check, Circle, Loader2, X } from 'lucide-vue-next';
import { Button } from './ui/button';
import ConversationTranscript from './ConversationTranscript.vue';
import LoadingBar from './LoadingBar.vue';
import { archiveTranscript } from '../lib/historyTranscript';
import { mergeTranscriptWindows, normaliseMessages, stripAnsi, taskIsActive, type IntegratedTask, type TranscriptMessage } from '../lib/integratedConversation';
import type { ConversationMessageRecord } from '../types';

// A running task's output file grows between reads; the service skips
// unchanged files, so a short interval stays cheap.
const POLL_MS = 2_000;

const props = defineProps<{ processId: string; task: IntegratedTask; projectPath?: string | null; canStop: boolean; stopping: boolean }>();
const emit = defineEmits<{ close: []; stop: [] }>();

const root = ref<HTMLElement>();
const textViewport = ref<HTMLElement>();
const format = ref<'transcript' | 'text' | 'missing' | null>(null);
// Replaced on each read, never mutated, so no deep proxying of rows.
const messages = shallowRef<TranscriptMessage[]>([]);
const text = ref('');
const truncated = ref(false);
// The page before the oldest loaded message. Set by the first read only:
// later reads keep every row already shown, so the newest page moving on
// never leaves a gap.
const olderCursor = ref<string | null>(null);
const loadingOlder = ref(false);
const olderError = ref('');
const loading = ref(false);
const error = ref('');
const active = computed(() => taskIsActive(props.task));
let version: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

async function read(): Promise<void> {
  const current = generation;
  loading.value = format.value === null;
  try {
    const result = await window.patterm.call('patterm.integrated.task.output', { process_id: props.processId, task_id: props.task.id, since: version }) as Record<string, unknown>;
    if (current !== generation || result.format === 'unchanged') return;
    version = typeof result.version === 'string' ? result.version : null;
    truncated.value = result.truncated === true;
    error.value = '';
    const page = pageMessages(result);
    if (page) {
      if (format.value !== 'transcript') olderCursor.value = typeof result.cursor === 'string' ? result.cursor : null;
      messages.value = mergeTranscriptWindows(messages.value, page);
      format.value = 'transcript';
    } else if (result.format === 'text') {
      const viewport = textViewport.value;
      const following = !viewport || viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
      text.value = stripAnsi(String(result.text ?? ''));
      format.value = 'text';
      if (following) {
        await nextTick();
        textViewport.value?.scrollTo({ top: textViewport.value.scrollHeight });
      }
    } else {
      format.value = 'missing';
    }
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (current === generation) loading.value = false;
  }
}

async function loadOlder(): Promise<void> {
  const cursor = olderCursor.value;
  if (!cursor || loadingOlder.value) return;
  const current = generation;
  loadingOlder.value = true;
  olderError.value = '';
  try {
    const result = await window.patterm.call('patterm.integrated.task.output', { process_id: props.processId, task_id: props.task.id, cursor }) as Record<string, unknown>;
    if (current !== generation) return;
    const page = pageMessages(result) ?? [];
    messages.value = mergeTranscriptWindows(page, messages.value);
    olderCursor.value = typeof result.cursor === 'string' ? result.cursor : null;
  } catch (cause) {
    if (current === generation) olderError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (current === generation) loadingOlder.value = false;
  }
}

// Claude transcripts arrive as archived records; Codex and OpenCode subagents
// as rows in the provider's snapshot shape, which the main view reads too.
function pageMessages(result: Record<string, unknown>): TranscriptMessage[] | null {
  if (result.format === 'transcript' && Array.isArray(result.archived_messages)) {
    return archiveTranscript(result.archived_messages as ConversationMessageRecord[], { projectPath: props.projectPath ?? null, showReasoning: true });
  }
  if (result.format === 'messages' && Array.isArray(result.messages)) return normaliseMessages(result.messages);
  return null;
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!active.value) return;
  timer = setTimeout(() => void read().finally(schedule), POLL_MS);
}

function reset(): void {
  generation++;
  version = null;
  format.value = null;
  messages.value = [];
  olderCursor.value = null;
  loadingOlder.value = false;
  olderError.value = '';
  text.value = '';
  error.value = '';
  void read().finally(schedule);
}

watch(() => props.task.id, reset);
// One last read picks up the final output once the task settles.
watch(active, (running, wasRunning) => {
  if (wasRunning && !running) void read();
  schedule();
});

onMounted(() => {
  reset();
  void nextTick(() => (root.value?.querySelector<HTMLElement>('header button') ?? root.value)?.focus());
});
onBeforeUnmount(() => {
  generation++;
  if (timer) clearTimeout(timer);
});
</script>
