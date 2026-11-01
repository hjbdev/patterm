<template>
  <!-- One element in every layout, so the conversation and a live voice call
       carry over when the panel docks or expands to a page. The page and the
       docked column slide in like the diff drawer; the panel drops from the
       assistant button in the bar. -->
  <template v-if="assistant.enabled">
  <Transition
    :enter-active-class="page || docked ? 'transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none' : 'origin-top-right transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none'"
    :enter-from-class="page || docked ? 'translate-x-6 opacity-0' : '-translate-y-2 scale-[0.97] opacity-0'"
    :leave-active-class="page || docked ? 'transition-[transform,opacity] duration-150 ease-in motion-reduce:transition-none' : 'origin-top-right transition-[transform,opacity] duration-150 ease-in motion-reduce:transition-none'"
    :leave-to-class="page || docked ? 'translate-x-6 opacity-0' : '-translate-y-2 scale-[0.97] opacity-0'"
  >
  <section
    v-show="open"
    ref="root"
    tabindex="-1"
    :role="page ? 'dialog' : undefined"
    data-assistant-dock
    class="fixed flex flex-col overflow-hidden bg-background outline-none"
    :class="page
      ? 'inset-x-1.5 bottom-1.5 top-12 z-40 rounded-xl border-t border-white/5 max-sm:bottom-[calc(0.375rem+env(safe-area-inset-bottom))] max-sm:top-[calc(0.375rem+env(safe-area-inset-top))]'
      : docked
        ? 'bottom-1.5 right-1.5 top-1.5 z-40 w-[var(--assistant-dock-width)] rounded-xl border-t border-white/5'
        : 'right-2 top-12 z-50 h-[min(40rem,calc(100dvh-3.5rem))] w-[26rem] rounded-xl border border-border shadow-2xl'"
    :aria-label="name"
    @keydown.esc="onEscape"
  >
    <header class="flex shrink-0 items-center gap-2 border-b border-border/60" :class="page ? 'h-11 px-3' : docked ? 'h-12 pl-4 pr-2' : 'py-2 pl-4 pr-2'">
      <template v-if="page">
        <Button variant="ghost" size="sm" class="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground" :aria-label="mobile ? 'Close assistant' : 'Back to panel'" @click="back">
          <ArrowLeft class="h-3.5 w-3.5" aria-hidden="true" />
          <span class="hidden sm:inline">Back</span>
        </Button>
        <span class="text-muted-foreground/60" aria-hidden="true">/</span>
      </template>
      <span class="size-1.5 shrink-0 rounded-full" :class="restarting ? 'animate-pulse bg-muted-foreground' : assistant.voiceActive ? 'bg-emerald-400' : assistant.processId ? 'bg-muted-foreground' : 'bg-muted-foreground/40'" aria-hidden="true" />
      <h2 class="min-w-0 flex-1 truncate text-sm" :class="page ? 'font-[440]' : 'font-medium'">{{ name }}</h2>
      <Tooltip v-if="assistant.voiceAvailable || mode === 'voice'">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="size-8" :disabled="!assistant.processId || restarting" :aria-pressed="mode === 'voice'" :aria-label="mode === 'voice' ? 'Back to chat' : 'Voice mode'" @click="toggleMode">
            <MessageSquare v-if="mode === 'voice'" class="size-4" />
            <AudioLines v-else class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ mode === 'voice' ? 'Back to chat' : 'Voice mode' }}</TooltipContent>
      </Tooltip>
      <DropdownMenu @update:open="restartArmed = false">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="size-8 text-muted-foreground" aria-label="More assistant actions">
            <Ellipsis class="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-64">
          <DropdownMenuItem v-if="assistant.focusAllowed" role="menuitemcheckbox" :aria-checked="assistant.focus" @select="setAssistantFocus(!assistant.focus)">
            <Focus class="size-4" />
            <span class="flex-1">Focus mode</span>
            <Check v-if="assistant.focus" class="size-4 text-muted-foreground" aria-hidden="true" />
          </DropdownMenuItem>
          <!-- Follow needs the workspace in view, so a page has no toggle. -->
          <DropdownMenuItem v-if="!page" role="menuitemcheckbox" :aria-checked="assistantLayout.follow" @select="setFollow(!assistantLayout.follow)">
            <LocateFixed v-if="assistantLayout.follow" class="size-4" />
            <Locate v-else class="size-4" />
            <span class="flex-1">Follow the conversation</span>
            <Check v-if="assistantLayout.follow" class="size-4 text-muted-foreground" aria-hidden="true" />
          </DropdownMenuItem>
          <template v-if="assistant.processId">
            <DropdownMenuSeparator />
            <DropdownMenuItem :disabled="restarting" @select="onRestartSelect">
              <RotateCcw class="size-4" />
              <span>{{ restartArmed ? 'Stop the response and restart' : `Restart ${name === 'Assistant' ? 'assistant' : name}` }}</span>
            </DropdownMenuItem>
          </template>
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="openSettings">
            <Settings class="size-4" />
            <span>Settings</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip v-if="!page">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="size-8" :aria-pressed="docked" :aria-label="docked ? 'Float the panel' : 'Dock beside the workspace'" @click="setDocked(!docked)">
            <PanelRightClose v-if="docked" class="size-4" />
            <PanelRight v-else class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ docked ? 'Float the panel' : 'Dock beside the workspace' }}</TooltipContent>
      </Tooltip>
      <Tooltip v-if="!mobile">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="size-8" :aria-label="expanded ? 'Show as panel' : 'Open as page'" @click="setExpanded(!expanded)">
            <Minimize2 v-if="expanded" class="size-4" />
            <Maximize2 v-else class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ expanded ? 'Show as panel' : 'Open as page' }}</TooltipContent>
      </Tooltip>
      <Tooltip v-if="!page">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="size-8" aria-label="Minimise" @click="setOpen(false)">
            <Minus class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Minimise</TooltipContent>
      </Tooltip>
    </header>

    <div v-if="restarting || restartError" class="flex shrink-0 items-center gap-2 border-b border-border/60 py-1.5 pl-4 pr-2 text-xs" :class="restartError ? 'text-destructive' : 'text-muted-foreground'" :role="restartError ? 'alert' : 'status'">
      <span class="min-w-0 flex-1 truncate">{{ restartError ? `Restart failed: ${restartError}` : `Restarting ${name === 'Assistant' ? 'the assistant' : name}…` }}</span>
      <Button v-if="restartError" variant="ghost" size="sm" class="h-6 shrink-0 px-2 text-xs" @click="restartError = ''">Dismiss</Button>
    </div>

    <!-- Held items show while focused, and after a delivery that failed. -->
    <div v-if="assistant.focus || assistant.focusPending" class="flex shrink-0 items-center gap-2 border-b border-border/60 py-1.5 pl-4 pr-2 text-xs text-muted-foreground" role="status" data-assistant-focus>
      <span class="min-w-0 flex-1 truncate">
        <span class="text-foreground">{{ assistant.focus ? 'Focus' : 'Not delivered' }}</span>
        · {{ assistant.focusPending ? `${assistant.focusPending} held` : 'Nothing held yet' }}
      </span>
      <Button variant="ghost" size="sm" class="h-6 shrink-0 px-2 text-xs" @click="setAssistantFocus(false)">{{ assistant.focus ? 'End focus' : 'Deliver' }}</Button>
    </div>

    <div v-if="followPending" class="flex shrink-0 items-center gap-2 border-b border-border/60 py-1.5 pl-4 pr-2 text-xs text-muted-foreground" role="status">
      <span class="min-w-0 flex-1 truncate">
        <template v-if="followPending.paused">Paused · </template>
        <span class="text-foreground">{{ followPending.target.label }}</span>
      </span>
      <Button variant="ghost" size="sm" class="h-6 shrink-0 px-2 text-xs" @click="showPending">Show</Button>
    </div>

    <div class="relative min-h-0 flex-1">
      <div v-if="!assistant.processId" class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p class="text-sm text-muted-foreground">{{ starting ? `Starting ${name === 'Assistant' ? 'the assistant' : name}…` : `${name} oversees agents across your projects.` }}</p>
        <p v-if="assistant.error" role="alert" class="text-xs text-destructive">{{ assistant.error }}</p>
        <Button v-if="!starting" size="sm" @click="start">Start {{ name === 'Assistant' ? 'assistant' : name }}</Button>
      </div>
      <template v-else>
        <!-- Chat stays mounted in voice mode so the conversation subscription
             and composer draft survive the switch. -->
        <div v-show="mode === 'chat'" class="h-full">
          <IntegratedConversation :key="assistant.processId" :process-id="assistant.processId" :on-new-session="newAssistantSession" :on-restart-session="restartAssistant" embedded @transcript="onTranscript" />
        </div>
        <AssistantVoice v-if="mode === 'voice'" :transcript="transcript" :stream-status="streamStatus" :wide="page" :bot-name="name" @end="mode = 'chat'" />
      </template>
    </div>
  </section>
  </Transition>

  </template>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, ref, shallowRef, watch } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { useRouter } from 'vue-router';
import { ArrowLeft, AudioLines, Check, Ellipsis, Focus, Locate, LocateFixed, Maximize2, MessageSquare, Minimize2, Minus, PanelRight, PanelRightClose, RotateCcw, Settings } from 'lucide-vue-next';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import AssistantVoice from './AssistantVoice.vue';
import type { TranscriptMessage } from '../../lib/integratedConversation';
import { assistant, ensureAssistant, message, newAssistantSession, restartAssistant, setAssistantFocus, startAssistantEvents } from '../../lib/assistant';
import { assistantLayout, setAssistantLayout } from '../../lib/assistantLayout';
import { useAssistantFollow } from '../../Composables/useAssistantFollow';
import { useBots } from '../../Composables/useBots';
import { ASSISTANT_BOT_ID } from '../../lib/bots';

// The conversation and its editor load when the assistant first opens, not with the app.
const IntegratedConversation = defineAsyncComponent(() => import('../IntegratedConversation.vue'));

const router = useRouter();
const { settings: botSettings } = useBots();
// The assistant's name, as set in Settings › Bots.
const name = computed(() => botSettings.value.bots.find((bot) => bot.id === ASSISTANT_BOT_ID)?.name ?? 'Assistant');

function openSettings(): void {
  void router.push({ name: 'settings', query: { tab: 'bots', bot: ASSISTANT_BOT_ID } });
}

const open = computed(() => assistantLayout.open);
const expanded = computed(() => assistantLayout.expanded);
const root = ref<HTMLElement | null>(null);
// A floating panel is cramped on phones, so there the assistant is always a page.
const mobile = useMediaQuery('(max-width: 639px)');
const page = computed(() => expanded.value || mobile.value);
const docked = computed(() => assistantLayout.docked && !page.value);
const mode = ref<'chat' | 'voice'>('chat');
const starting = ref(false);
// Replaced wholesale by the conversation component, so a shallow ref is enough.
const transcript = shallowRef<TranscriptMessage[]>([]);
const streamStatus = ref('');
const transcriptLoaded = ref(false);
// Follow moves the workspace only while it is in view: beside the open panel,
// or behind a minimised voice call.
const workspaceVisible = computed(() => !page.value && (open.value || mode.value === 'voice'));
const { pending: followPending, showPending, setFollow } = useAssistantFollow(transcript, transcriptLoaded, computed(() => streamStatus.value === 'working'), workspaceVisible, root);

function onTranscript(rows: TranscriptMessage[], status: string, loaded: boolean): void {
  transcript.value = rows;
  streamStatus.value = status;
  transcriptLoaded.value = loaded;
}

function setOpen(value: boolean): void {
  setAssistantLayout({ open: value });
}

// The button in the bar opens the assistant too, so opening is handled here.
watch(open, (value) => {
  if (!value) return;
  if (assistant.loaded && !assistant.processId) void start();
  if (page.value) void nextTick(() => root.value?.focus());
});

// On a phone there is no panel to go back to, so Back closes the page.
function back(): void {
  if (mobile.value) setOpen(false);
  else setExpanded(false);
}

async function start(): Promise<void> {
  if (starting.value) return;
  starting.value = true;
  try { await ensureAssistant(); } finally { starting.value = false; }
}

const restarting = computed(() => assistant.restarting);
const restartError = ref('');
// A restart stops a response in progress, so the first choice then only arms it.
const restartArmed = ref(false);

function onRestartSelect(event: Event): void {
  if (streamStatus.value === 'working' && !restartArmed.value) {
    event.preventDefault();
    restartArmed.value = true;
    return;
  }
  void restart();
}

// Resumes the same thread in a new Codex process, for example after an MCP
// login changed. The old conversation stays on screen until the new one loads.
async function restart(): Promise<void> {
  if (!assistant.processId) return;
  restartError.value = '';
  if (mode.value === 'voice') mode.value = 'chat';
  try { await restartAssistant(assistant.processId); } catch (error) { restartError.value = message(error); }
}

const RESIZE_MS = 220;

function setExpanded(value: boolean): void {
  const before = open.value ? root.value?.getBoundingClientRect() : undefined;
  setAssistantLayout({ expanded: value });
  void nextTick(() => {
    if (before) resizeFrom(before);
    // Keep Escape and keyboard focus with the page while it covers the workspace.
    if (value) root.value?.focus();
  });
}

function setDocked(value: boolean): void {
  const before = open.value ? root.value?.getBoundingClientRect() : undefined;
  setAssistantLayout({ docked: value });
  void nextTick(() => { if (before) resizeFrom(before); });
}

// Grows or shrinks the box from its old bounds to its new ones, so switching
// between panel and page reads as one surface changing shape.
function resizeFrom(before: DOMRect): void {
  const element = root.value;
  if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const after = element.getBoundingClientRect();
  if (before.width === after.width && before.height === after.height && before.top === after.top) return;
  const frame = (rect: DOMRect) => ({ top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px`, right: 'auto', bottom: 'auto' });
  element.animate([frame(before), frame(after)], { duration: RESIZE_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
}

// Escape leaves the page view unless the composer or a menu used it.
function onEscape(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (!page.value || event.defaultPrevented || target?.closest('input, textarea, [contenteditable="true"], [role="listbox"], [role="menu"]')) return;
  back();
}

function toggleMode(): void {
  mode.value = mode.value === 'voice' ? 'chat' : 'voice';
}

onMounted(() => {
  startAssistantEvents();
});

// Turning the assistant off closes it, so turning it back on shows only the
// button. A voice call ends with it, so it comes back in chat, as it does
// when voice is turned off or the profile changes from Codex.
watch(() => assistant.loaded && !assistant.enabled, (off) => {
  if (!off) return;
  mode.value = 'chat';
  if (assistantLayout.open) setAssistantLayout({ open: false });
});
watch(() => assistant.loaded && !assistant.voiceAvailable, (unavailable) => {
  if (unavailable) mode.value = 'chat';
});
</script>
