<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex min-h-0 flex-1 flex-col" :class="wide && 'md:flex-row'">
    <div class="flex shrink-0 flex-col items-center gap-4 px-6 pb-4 pt-8" :class="wide && 'md:flex-1 md:justify-center md:pb-16'">
      <AssistantOrb ref="orbRef" :phase="phase" :label="statusLabel" />
      <div class="w-full max-w-xs text-center">
        <!-- Labels cross-fade in a fixed-height stack, so nothing below shifts. -->
        <div class="relative h-5">
          <Transition name="voice-fade">
            <p :key="phase" class="absolute inset-0 text-sm text-foreground" aria-live="polite">{{ statusLabel }}</p>
          </Transition>
        </div>
        <div class="relative h-4">
          <Transition name="voice-fade">
            <p v-if="shownTool" :key="shownTool" class="absolute inset-0 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Wrench class="size-3 shrink-0" aria-hidden="true" />
              <span class="truncate">{{ shownTool }}</span>
            </p>
            <p v-else :key="`hint-${phase}`" class="absolute inset-0 truncate text-xs text-muted-foreground/70">{{ VOICE_PHASE_HINTS[phase] }}</p>
          </Transition>
        </div>
        <div v-if="failure" role="alert" class="mt-2 flex flex-col items-center gap-3">
          <p class="text-xs text-destructive">{{ failure }}</p>
          <Button v-if="status === 'failed'" variant="secondary" size="sm" @click="retry">
            <RotateCw class="mr-1.5 size-4" />
            Try again
          </Button>
        </div>
        <p v-else-if="caption" class="mt-2 line-clamp-2 text-xs text-muted-foreground">{{ caption }}</p>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto border-t border-border/60 px-4 py-3" :class="wide && 'md:w-[24rem] md:flex-none md:border-l md:border-t-0'" :aria-label="`${botName} activity`">
      <p v-if="!actions.length" class="py-6 text-center text-xs text-muted-foreground">Actions {{ botName === 'Assistant' ? 'the assistant' : botName }} takes appear here.</p>
      <ol v-else class="space-y-0.5">
        <li v-for="action in actions" :key="action.id" class="text-xs">
          <!-- Work on an agent or process opens it; the row is the target,
               taller on touch screens. -->
          <button
            v-if="action.target"
            type="button"
            class="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
            @click="open(action.target)"
          >
            <span class="flex size-3.5 shrink-0 items-center justify-center">
              <LoaderCircle v-if="action.running" class="size-3.5 animate-spin text-muted-foreground" aria-label="Running" />
              <AgentIcon v-else-if="action.target.harness" :harness="action.target.harness" class="size-3.5 text-muted-foreground group-hover:text-foreground" />
              <TerminalSquare v-else class="size-3.5 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
            </span>
            <span class="shrink-0 text-muted-foreground">{{ action.verb }}</span>
            <span class="min-w-0 flex-1 truncate text-foreground">{{ action.target.label }}</span>
            <ChevronRight class="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100" aria-hidden="true" />
          </button>
          <div v-else class="flex items-start gap-2 py-1">
            <span class="flex h-4 w-3.5 shrink-0 items-center justify-center">
              <LoaderCircle v-if="action.running" class="size-3.5 animate-spin text-muted-foreground" aria-label="Running" />
              <CircleAlert v-else-if="action.failed" class="size-3.5 text-destructive" aria-label="Failed" />
              <Dot v-else class="size-3.5 text-muted-foreground" aria-hidden="true" />
            </span>
            <span class="min-w-0 break-words" :class="action.running ? 'text-foreground' : 'text-muted-foreground'">{{ action.label }}</span>
          </div>
        </li>
      </ol>
    </div>
    </div>

    <div class="flex shrink-0 items-center justify-center gap-2 border-t border-border/60 px-4 py-3">
      <Button variant="ghost" size="sm" :disabled="status !== 'connected'" :aria-pressed="muted" @click="toggleMute">
        <MicOff v-if="muted" class="mr-1.5 size-4" />
        <Mic v-else class="mr-1.5 size-4" />
        {{ muted ? 'Unmute' : 'Mute' }}
      </Button>
      <Button variant="secondary" size="sm" @click="emit('end')">
        <PhoneOff class="mr-1.5 size-4" />
        End voice
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronRight, CircleAlert, Dot, LoaderCircle, Mic, MicOff, PhoneOff, RotateCw, TerminalSquare, Wrench } from 'lucide-vue-next';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import AssistantOrb from './AssistantOrb.vue';
import AgentIcon from '../AgentIcon.vue';
import { Button } from '../ui/button';
import { toolActivityLabel, type TranscriptMessage } from '../../lib/integratedConversation';
import { AssistantVoiceSession, type VoiceStatus } from '../../lib/assistantVoice';
import { message } from '../../lib/assistant';
import { onBotRealtime } from '../../lib/botRelay';
import { ASSISTANT_BOT_ID } from '../../../../app/Bots/BotIdentity';
import { toolProcessCall } from '../../lib/assistantFocus';
import { findProcess } from '../../lib/agentMentions';
import { agentLabel } from '../../lib/agentTabs';
import { useWorkbench } from '../../Composables/useWorkbench';
import { SettledValue } from '../../lib/settledValue';
import { VOICE_PHASE_HINTS, VOICE_PHASE_LABELS, type VoicePhase } from '../../lib/assistantVoicePhase';

// `wide` lays the orb and the activity log side by side on a page. `botId`
// and `botName` name the bot the call is with; the assistant by default.
const props = withDefaults(defineProps<{ transcript: TranscriptMessage[]; streamStatus: string; wide?: boolean; botId?: string; botName?: string }>(), { botId: ASSISTANT_BOT_ID, botName: 'Assistant' });
const emit = defineEmits<{ end: [] }>();

const ACTION_LIMIT = 12;
// Speech starts above one level and ends only after a quiet tail below a lower
// one, so pauses between words do not read as the end of speech.
const SPEECH_START_LEVEL = 0.08;
const SPEECH_END_LEVEL = 0.03;
const SPEECH_TAIL_MS = 700;

const status = ref<VoiceStatus>('connecting');
const failure = ref('');
const muted = ref(false);
const speaking = ref(false);
const caption = ref('');
const orbRef = ref<InstanceType<typeof AssistantOrb> | null>(null);
let startedAt = Date.now();
// Rows already in the transcript when voice began are not this call's actions.
const knownIds = new Set(props.transcript.map((row) => row.id));

type Phase = VoicePhase;
const rawPhase = computed<Phase>(() => {
  if (status.value !== 'connected') return status.value;
  if (muted.value) return 'muted';
  if (speaking.value) return 'speaking';
  return props.streamStatus === 'working' ? 'working' : 'listening';
});
// Connection changes and the user's own mute show at once. Settling back to
// Listening waits longest, because work and speech pause between steps.
const phase = ref<Phase>(rawPhase.value);
const phaseSettler = new SettledValue<Phase>(phase.value, (value) => { phase.value = value; }, {
  minimumMs: 800,
  immediate: (next, shown) => ['connecting', 'failed', 'ended', 'muted'].includes(next) || shown === 'muted' || shown === 'connecting',
  delayFor: (next) => next === 'listening' ? 900 : 200
});
watch(rawPhase, (value) => phaseSettler.set(value));
const statusLabel = computed(() => VOICE_PHASE_LABELS[phase.value]);

interface VoiceTarget { label: string; harness: string | null; location: RouteLocationRaw }
interface VoiceAction { id: string; label: string; running: boolean; failed: boolean; verb: string; target: VoiceTarget | null }

// What the assistant did to an agent or process, by the Patterm tool it used.
const TOOL_VERBS: Record<string, string> = {
  get_process_output: 'Read',
  get_conversation_output: 'Read',
  search_output: 'Searched',
  get_process_status: 'Checked',
  get_process_ports: 'Checked',
  wait_for_pattern: 'Watching',
  send_message: 'Messaged',
  send_input: 'Typed into',
  restart_process: 'Restarted',
  spawn_agent: 'Started'
};

const router = useRouter();
const { projects } = useWorkbench();

function target(processId: string): VoiceTarget | null {
  const found = findProcess(projects.value, processId);
  if (found?.session) return { label: agentLabel(found.session), harness: found.session.harness, location: { name: 'agent', params: { projectId: found.projectId, sessionId: found.session.id } } };
  if (found?.process) return { label: found.process.name, harness: null, location: { name: 'process', params: { projectId: found.projectId, processId: found.process.id } } };
  return null;
}

function open(value: VoiceTarget): void {
  void router.push(value.location);
}

const actions = computed<VoiceAction[]>(() => props.transcript
  .filter((row) => !knownIds.has(row.id) && !row.parentId && (row.kind === 'tool' || (row.kind === 'text' && row.role === 'assistant' && row.text.trim())))
  .slice(-ACTION_LIMIT)
  .reverse()
  .map((row) => {
    const call = row.kind === 'tool' && row.tool ? toolProcessCall(row.tool, row.text) : null;
    const verb = call ? TOOL_VERBS[call.tool] : undefined;
    const found = call && verb ? target(call.processId) : null;
    return {
      id: row.id,
      label: found ? `${verb} ${found.label}` : row.kind === 'tool' ? (row.tool ? toolActivityLabel(row.tool) : row.title || 'Tool call') : firstLine(row.text),
      running: row.kind === 'tool' && (row.tool?.status === 'running' || row.tool?.status === 'pending'),
      failed: row.kind === 'tool' && row.tool?.status === 'failed',
      verb: verb ?? '',
      target: found
    };
  }));
const current = computed(() => actions.value.find((action) => action.running)?.label ?? '');
// Quick tools would otherwise flash past; each stays readable for a moment.
const shownTool = ref('');
const toolSettler = new SettledValue<string>('', (value) => { shownTool.value = value; }, {
  minimumMs: 1_200,
  delayFor: (next) => next ? 0 : 1_000
});
watch(current, (value) => toolSettler.set(value));

// A session is single use, so trying again starts a fresh one.
function createSession(): AssistantVoiceSession {
  return new AssistantVoiceSession({ id: props.botId, name: props.botName }, (next, detail) => {
    status.value = next;
    if (detail) failure.value = detail;
  }, {
    // Lock screen and notification controls while the app is in the background.
    hangUp: () => emit('end'),
    toggleMute: () => toggleMute()
  });
}
let session = createSession();
let frame = 0;
let releaseRealtime: (() => void) | null = null;
let quietSince = 0;

function animate(): void {
  const { output, input } = session.levels();
  const now = performance.now();
  if (output > SPEECH_START_LEVEL) {
    speaking.value = true;
    quietSince = 0;
  } else if (speaking.value && output < SPEECH_END_LEVEL) {
    quietSince ||= now;
    if (now - quietSince >= SPEECH_TAIL_MS) speaking.value = false;
  } else {
    quietSince = 0;
  }
  // Per-frame loudness drives CSS directly, never reactive state. A muted
  // microphone still measures sound, so it does not move the orb.
  orbRef.value?.setLevels(output, muted.value ? 0 : input);
  frame = requestAnimationFrame(animate);
}

function toggleMute(): void {
  muted.value = !muted.value;
  session.setMuted(muted.value);
}

// Spoken replies are Markdown; the log shows their first line as plain text.
function firstLine(text: string): string {
  const line = (text.trim().split('\n')[0] ?? '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

onMounted(async () => {
  releaseRealtime = onBotRealtime(props.botId, ({ method, params }) => {
    if (method === 'thread/realtime/transcript/done' && typeof params.text === 'string') caption.value = params.text.trim();
    else if (method === 'thread/realtime/error' && typeof params.message === 'string') failure.value = params.message;
    else if (method === 'thread/realtime/closed' && Date.now() - startedAt > 1_000) status.value = 'ended';
  });
  frame = requestAnimationFrame(animate);
  await connect();
});

async function connect(): Promise<void> {
  const current = session;
  try {
    await current.start();
  } catch (error) {
    await current.stop();
    if (current !== session) return;
    status.value = 'failed';
    failure.value = message(error);
  }
}

async function retry(): Promise<void> {
  failure.value = '';
  caption.value = '';
  muted.value = false;
  await session.stop();
  session = createSession();
  startedAt = Date.now();
  await connect();
}

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  phaseSettler.dispose();
  toolSettler.dispose();
  releaseRealtime?.();
  void session.stop();
});
</script>

<style scoped>
.voice-fade-enter-active, .voice-fade-leave-active { transition: opacity 220ms ease, transform 220ms ease; }
.voice-fade-enter-from { opacity: 0; transform: translateY(3px); }
.voice-fade-leave-to { opacity: 0; transform: translateY(-3px); }
@media (prefers-reduced-motion: reduce) {
  .voice-fade-enter-from, .voice-fade-leave-to { transform: none; }
}
</style>
