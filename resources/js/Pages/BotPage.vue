<template>
  <div ref="root" class="flex h-full min-h-0 flex-col">
    <div v-if="!row" class="p-5 text-sm text-muted-foreground">This bot no longer exists. Manage bots in Settings › Bots.</div>
    <template v-else>
      <header class="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.06] px-4">
        <BotAvatar :avatar="row.bot.avatar" :size="28" :activity="row.activity" motion />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium">{{ row.bot.name }}</div>
          <div class="truncate text-xs text-muted-foreground">{{ purviewLabel }}</div>
        </div>
        <button v-if="browser?.running" type="button" :class="CHIP" @click="peek = { kind: 'browser' }"><Globe :class="CHIP_ICON" /><span :class="CHIP_LABEL">Browser</span><span v-if="browser.help" class="h-1.5 w-1.5 rounded-full bg-foreground" aria-label="needs you" /></button>
        <SecretsChip v-if="row.session && hasSecrets(row.session.processId)" :process-id="row.session.processId" />
        <Button v-if="row.waitingHelper && row.waitingHelperProjectId" variant="ghost" size="sm" class="h-7 text-xs text-warning hover:text-warning" @click="openHelper">Open waiting helper</Button>
        <Button v-if="relay?.voice.available || mode === 'voice'" variant="ghost" size="icon" class="h-8 w-8 rounded-tab" :disabled="!live" :aria-pressed="mode === 'voice'" :aria-label="mode === 'voice' ? 'Back to chat' : 'Voice call'" :title="mode === 'voice' ? 'Back to chat' : 'Voice call'" @click="mode = mode === 'voice' ? 'chat' : 'voice'">
          <MessageSquare v-if="mode === 'voice'" class="h-4 w-4" />
          <AudioLines v-else class="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon" class="h-8 w-8 rounded-tab text-muted-foreground" aria-label="Bot actions"><MoreHorizontal class="h-4 w-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-48">
            <template v-if="relay?.focus.allowed">
              <DropdownMenuItem role="menuitemcheckbox" :aria-checked="relay.focus.enabled" @select="toggleFocus(!relay.focus.enabled)">
                <span class="flex-1">Focus mode</span>
                <Check v-if="relay.focus.enabled" class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </template>
            <DropdownMenuItem :disabled="busy" @select="restart(false)">Restart</DropdownMenuItem>
            <DropdownMenuItem :disabled="busy" @select="restart(true)">New conversation</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem :disabled="!projectId" @select="peek = { kind: 'context' }">Session context</DropdownMenuItem>
            <DropdownMenuItem @select="openSettings">Bot settings</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <!-- Held items show while focused, and after a delivery that failed. -->
      <div v-if="relay && (relay.focus.enabled || relay.focus.pending)" class="flex shrink-0 items-center gap-2 border-b border-white/[0.06] py-1.5 pl-4 pr-2 text-xs text-muted-foreground" role="status">
        <span class="min-w-0 flex-1 truncate">
          <span class="text-foreground">{{ relay.focus.enabled ? 'Focus' : 'Not delivered' }}</span>
          · {{ relay.focus.pending ? `${relay.focus.pending} held` : 'Nothing held yet' }}
        </span>
        <Button variant="ghost" size="sm" class="h-6 shrink-0 px-2 text-xs" @click="toggleFocus(false)">{{ relay.focus.enabled ? 'End focus' : 'Deliver' }}</Button>
      </div>
      <p v-if="error && live" role="alert" class="shrink-0 border-b border-white/[0.06] px-4 py-1.5 text-xs text-destructive">{{ error }}</p>
      <div class="flex min-h-0 flex-1">
        <div class="relative min-h-0 min-w-0 flex-1">
          <!-- Helpers' reports and Patterm's notes to the bot stay out of view.
               The chat stays mounted during a voice call, so its draft survives. -->
          <div v-if="live && row.session?.processId" v-show="mode === 'chat'" class="h-full">
            <IntegratedConversation
              :key="row.session.processId"
              :process-id="row.session.processId"
              hide-background
              compact-composer
              :addressee="row.bot.name"
              :restartable="true"
              :on-new-session="() => restart(true)"
              :on-restart-session="() => restart(false)"
              class="h-full"
              @transcript="onTranscript"
            />
          </div>
          <AssistantVoice v-if="live && mode === 'voice'" :key="`voice-${row.bot.id}`" :transcript="transcript" :stream-status="streamStatus" :bot-id="row.bot.id" :bot-name="row.bot.name" wide @end="mode = 'chat'" />
          <div v-if="!live || !row.session?.processId" class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <BotAvatar :avatar="row.bot.avatar" :size="72" motion />
            <p class="text-sm text-muted-foreground">{{ busy || !row.session ? `Starting ${row.bot.name}…` : `${row.bot.name} has stopped.` }}</p>
            <Button v-if="(row.session || error) && !busy" size="sm" @click="restart(false)">Start again</Button>
            <p v-if="error" role="alert" class="max-w-sm text-xs text-destructive">{{ error }}</p>
          </div>
        </div>
        <!-- The bot's browser or session context, beside its conversation while
             there's room and a sheet otherwise, as on an agent's page. -->
        <aside v-if="docked && peek && projectId && row.session" role="complementary" :aria-label="peekLabel" class="flex shrink-0 flex-col border-l border-border/30 bg-background" :style="{ width: `${paneWidth}px`, maxWidth: '100%' }" @keydown.esc.stop.prevent="peek = null">
          <PeekPane v-model:peek="peek" :project-id="projectId" :session-id="row.session.id" :process-id="row.session.processId" :summary="row.session.summary" @close="peek = null" />
        </aside>
      </div>
      <Sheet :open="Boolean(peek && projectId && !docked)" @update:open="open => { if (!open) peek = null }">
        <SheetContent side="right" hide-close aria-describedby="" class="flex w-[85vw] flex-col gap-0 border-border/30 p-0 pt-[env(safe-area-inset-top)] max-sm:w-full max-sm:max-w-none" :class="peek?.kind === 'browser' ? 'max-w-4xl' : 'max-w-sm'">
          <SheetTitle class="sr-only">{{ peekLabel }}</SheetTitle>
          <PeekPane v-if="peek && projectId && row.session" v-model:peek="peek" :project-id="projectId" :session-id="row.session.id" :process-id="row.session.processId" :summary="row.session.summary" @close="peek = null" />
        </SheetContent>
      </Sheet>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useElementSize } from '@vueuse/core';
import { AudioLines, Check, Globe, MessageSquare, MoreHorizontal } from 'lucide-vue-next';
import AssistantVoice from '../Components/Assistant/AssistantVoice.vue';
import BotAvatar from '../Components/BotAvatar.vue';
import IntegratedConversation from '../Components/IntegratedConversation.vue';
import PeekPane from '../Components/peek/PeekPane.vue';
import { CHIP, CHIP_ICON, CHIP_LABEL } from '../Components/session-context/rowAction';
import SecretsChip from '../Components/session-context/SecretsChip.vue';
import { Button } from '../Components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '../Components/ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../Components/ui/dropdown-menu';
import { useBots } from '../Composables/useBots';
import { useWorkbench } from '../Composables/useWorkbench';
import { restartBot, startBot } from '../lib/bots';
import { botStates, setBotFocus, startBotEvents } from '../lib/botRelay';
import type { TranscriptMessage } from '../lib/integratedConversation';
import { useBrowserState } from '../lib/browser';
import type { Peek } from '../lib/peek';
import { phoneLayout } from '../lib/phoneLayout';
import { hasSecrets } from '../lib/secrets';

const route = useRoute();
const router = useRouter();
const { rows } = useBots();
const { projects, botProjects, assistantProject } = useWorkbench();
const row = computed(() => rows.value.find((candidate) => candidate.bot.id === route.params.botId) ?? null);
const live = computed(() => Boolean(row.value?.session && !row.value.session.exitedAt));
const busy = ref(false);
const error = ref('');

// Voice and Focus mode, for bots that have them turned on.
const relay = computed(() => row.value ? botStates[row.value.bot.id] ?? null : null);
const mode = ref<'chat' | 'voice'>('chat');
const transcript = shallowRef<TranscriptMessage[]>([]);
const streamStatus = ref('');
onMounted(startBotEvents);
watch(() => row.value?.bot.id, () => { mode.value = 'chat'; });
// A call ends with voice turned off, a non-Codex profile, or a stopped bot.
watch(() => !live.value || relay.value?.voice.available === false, (unavailable) => { if (unavailable) mode.value = 'chat'; });

function onTranscript(rows: TranscriptMessage[], status: string): void {
  transcript.value = rows;
  streamStatus.value = status;
}

async function toggleFocus(enabled: boolean): Promise<void> {
  const bot = row.value?.bot;
  if (!bot) return;
  error.value = '';
  try { await setBotFocus(bot.id, enabled); } catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); }
}

// The bot's own hidden project, where its session context lives.
const projectId = computed(() => {
  const sessionId = row.value?.session?.id;
  const own = assistantProject.value ? [assistantProject.value, ...botProjects.value] : botProjects.value;
  return sessionId ? own.find((project) => project.projectSessions.some((session) => session.id === sessionId))?.project.id ?? null : null;
});

const peek = ref<Peek | null>(null);
const peekLabel = computed(() => peek.value?.kind === 'browser' ? 'Peek: browser' : 'Session context');
const root = ref<HTMLElement | null>(null);
const { width: rootWidth } = useElementSize(root);
const paneWidth = computed(() => peek.value?.kind === 'browser' ? 720 : 420);
// Docks while the conversation keeps 560 px beside it.
const docked = computed(() => !phoneLayout.value && rootWidth.value >= paneWidth.value + 560);
watch(() => row.value?.bot.id, () => { peek.value = null; });

// A request for help in the bot's browser opens it, once per request, so
// closing it sticks.
const browser = useBrowserState(() => row.value?.session?.processId);
const shownHelp = new Set<string>();
watch(() => browser.value?.help?.requestedAt, (requestedAt) => {
  const processId = row.value?.session?.processId;
  if (!requestedAt || !processId || shownHelp.has(`${processId}:${requestedAt}`)) return;
  shownHelp.add(`${processId}:${requestedAt}`);
  if (peek.value?.kind !== 'browser') peek.value = { kind: 'browser' };
}, { immediate: true });

const purviewLabel = computed(() => {
  const purview = row.value?.bot.purview;
  if (!purview || purview.kind === 'none') return 'No projects';
  if (purview.kind === 'all') return 'All projects';
  const names = purview.projectIds.map((id) => projects.value.find((project) => project.project.id === id)?.project.name).filter(Boolean);
  return names.length ? names.join(', ') : 'Its projects are gone';
});

// A bot that has never run starts when it's opened: the assistant waits for
// that on a fresh install, while other bots start as soon as they're added.
// Once per bot, so a failed start shows its error rather than retrying.
const opened = new Set<string>();
watch(row, (current) => {
  if (!current || current.session || opened.has(current.bot.id)) return;
  opened.add(current.bot.id);
  void restart(false);
}, { immediate: true });

async function restart(fresh: boolean): Promise<void> {
  const bot = row.value?.bot;
  if (!bot || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const processId = live.value ? row.value?.session?.processId : null;
    if (processId) await restartBot(processId, fresh);
    else await startBot(bot.id, fresh);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}

function openHelper(): void {
  const current = row.value;
  if (current?.waitingHelper && current.waitingHelperProjectId) void router.push({ name: 'agent', params: { projectId: current.waitingHelperProjectId, sessionId: current.waitingHelper.id } });
}

function openSettings(): void {
  void router.push({ name: 'settings', query: { tab: 'bots', bot: row.value?.bot.id ?? '' } });
}
</script>
