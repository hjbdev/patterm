<template>
  <form class="mx-auto w-full max-w-[50rem] shrink-0 p-4 2xl:max-w-[1000px]" @submit.prevent="submit">
    <div
      class="relative rounded-xl border bg-background shadow-sm transition-colors"
      :class="dragging ? 'border-dashed border-primary/70' : 'border-border'"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <ComposerWorkingBorder v-if="working" />
      <div
        v-if="menuOpen"
        :id="listboxId"
        ref="menu"
        role="listbox"
        :aria-label="mode === 'mention' ? 'Agents, bots, and processes' : 'Slash commands'"
        class="absolute inset-x-2 bottom-full z-40 mb-2 max-h-80 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
      >
        <template v-if="mode === 'mention'">
          <div v-if="agentMatches.length" role="group" aria-label="Agents">
            <button
              v-for="(agent, index) in agentMatches"
              :id="optionId(index)"
              :key="agent.processId"
              type="button"
              role="option"
              tabindex="-1"
              :aria-selected="index === menuIndex"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm"
              :class="index === menuIndex && 'bg-muted'"
              @mouseenter="menuIndex = index"
              @mousedown.prevent="chooseAgent(agent)"
            >
              <TabActivity :spec="sessionStatusIcon(agent.session)"><AgentIcon :harness="agent.session.harness" class="h-3.5 w-3.5" /></TabActivity>
              <span class="min-w-0 truncate"><span v-for="(run, runIndex) in mentionRuns(agent)" :key="runIndex" :class="run.match && 'font-semibold text-primary'">{{ run.text }}</span></span>
              <HostBadge v-if="agent.session.host" :host="agent.session.host" />
              <span v-if="agent.parent" class="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{{ agent.parent }}</span>
            </button>
          </div>
          <div v-if="agentMatches.length && botMatches.length" aria-hidden="true" class="mx-2 my-1 border-t border-border/60" />
          <!-- Bots that work in this project; the agent messages them with send_message. -->
          <div v-if="botMatches.length" role="group" aria-label="Bots">
            <button
              v-for="(bot, index) in botMatches"
              :id="optionId(botOffset + index)"
              :key="bot.botId"
              type="button"
              role="option"
              tabindex="-1"
              :aria-selected="botOffset + index === menuIndex"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm"
              :class="botOffset + index === menuIndex && 'bg-muted'"
              @mouseenter="menuIndex = botOffset + index"
              @mousedown.prevent="chooseBot(bot)"
            >
              <AgentIcon :harness="bot.harness" class="h-3.5 w-3.5" />
              <span class="min-w-0 truncate"><span v-for="(run, runIndex) in mentionRuns(bot)" :key="runIndex" :class="run.match && 'font-semibold text-primary'">{{ run.text }}</span></span>
              <span class="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">Bot</span>
            </button>
          </div>
          <div v-if="(agentMatches.length || botMatches.length) && processMatches.length" aria-hidden="true" class="mx-2 my-1 border-t border-border/60" />
          <div v-if="processMatches.length" role="group" aria-label="Processes">
            <button
              v-for="(process, index) in processMatches"
              :id="optionId(processOffset + index)"
              :key="process.processId"
              type="button"
              role="option"
              tabindex="-1"
              :aria-selected="processOffset + index === menuIndex"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm"
              :class="processOffset + index === menuIndex && 'bg-muted'"
              @mouseenter="menuIndex = processOffset + index"
              @mousedown.prevent="chooseProcess(process)"
            >
              <TabActivity :spec="processStatusIcon(process.process)"><TerminalSquare class="h-3.5 w-3.5" aria-hidden="true" /></TabActivity>
              <span class="min-w-0 truncate"><span v-for="(run, runIndex) in mentionRuns(process)" :key="runIndex" :class="run.match && 'font-semibold text-primary'">{{ run.text }}</span></span>
              <HostBadge v-if="process.process.host" :host="process.process.host" />
              <span v-if="process.owner" class="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{{ process.owner }}</span>
            </button>
          </div>
          <div v-if="launcherOffset && launcherMatches.length" aria-hidden="true" class="mx-2 my-1 border-t border-border/60" />
          <!-- Presets and harnesses ask the agent to launch a new one. -->
          <div v-if="launcherMatches.length" role="group" aria-label="New agents">
            <button
              v-for="(launcher, index) in launcherMatches"
              :id="optionId(launcherOffset + index)"
              :key="launcher.token"
              type="button"
              role="option"
              tabindex="-1"
              :aria-selected="launcherOffset + index === menuIndex"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm"
              :class="launcherOffset + index === menuIndex && 'bg-muted'"
              @mouseenter="menuIndex = launcherOffset + index"
              @mousedown.prevent="chooseLauncher(launcher)"
            >
              <AgentIcon :harness="launcher.harness" class="h-3.5 w-3.5 text-orange-300" />
              <span class="min-w-0 truncate"><span v-for="(run, runIndex) in mentionRuns(launcher)" :key="runIndex" :class="run.match && 'font-semibold text-primary'">{{ run.text }}</span></span>
              <span class="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{{ launcher.kind === 'preset' ? `${harnessLabel(launcher.harness)} preset` : 'New agent' }}</span>
            </button>
          </div>
          <p v-if="!menuItems.length" class="px-2 py-1.5 text-xs text-muted-foreground" role="status">No matching agents, bots, or processes</p>
        </template>
        <template v-else>
          <button
            v-for="(command, index) in commandMatches"
            :id="optionId(index)"
            :key="command.name"
            type="button"
            role="option"
            tabindex="-1"
            :aria-selected="index === menuIndex"
            class="flex w-full items-start gap-3 rounded-md px-2 py-1 text-left text-sm"
            :class="index === menuIndex && 'bg-muted'"
            @mouseenter="menuIndex = index"
            @mousedown.prevent="chooseCommand(command)"
          >
            <span class="font-medium">/{{ command.name }}</span>
            <span v-if="command.description" class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ command.description }}</span>
          </button>
          <p v-if="!commandMatches.length" class="px-2 py-1.5 text-xs text-muted-foreground">No matching commands</p>
        </template>
      </div>

      <div v-if="draft.attachments.length && !goalMode" class="flex flex-wrap items-center gap-2 px-2 pt-2">
        <div
          v-for="attachment in draft.attachments"
          :key="attachment.id"
          class="flex max-w-72 items-center gap-2 rounded-md border px-2 py-1 text-xs"
          :class="attachment.status === 'error' ? 'border-destructive/50 text-destructive' : 'border-border/60 bg-muted/30'"
        >
          <img v-if="attachment.image && attachment.previewUrl" :src="attachment.previewUrl" :alt="attachment.name" class="h-9 w-11 shrink-0 rounded object-cover">
          <div class="min-w-0">
            <p class="truncate">{{ attachment.name }}</p>
            <p class="truncate text-[10px] text-muted-foreground">
              {{ attachment.status === 'uploading' ? 'Uploading…' : attachment.status === 'error' ? attachment.error : formatBytes(attachment.size) }}
            </p>
          </div>
          <button v-if="attachment.status === 'error'" type="button" class="shrink-0 text-muted-foreground hover:text-foreground" :aria-label="`Retry ${attachment.name}`" title="Retry upload" @click="retryUpload(processId, attachment.id)">↻</button>
          <button type="button" class="shrink-0 text-muted-foreground hover:text-foreground" :aria-label="`Remove ${attachment.name}`" @click="removeAttachment(processId, attachment.id)">×</button>
        </div>
      </div>

      <!-- Tiptap's editable element takes its role, classes and ARIA state from editorAttributes. -->
      <!-- A compact composer, as in a bot's chat, is one row: the text, attach and send. -->
      <div :class="compact ? 'flex items-end gap-1 p-1.5' : ''">
        <EditorContent v-if="editor" :editor="editor.tiptap" :class="cn('composer-editor', compact && 'min-w-0 flex-1')" />
        <template v-if="compact">
          <Button type="button" size="icon" variant="ghost" class="h-8 w-8 shrink-0 text-muted-foreground" :disabled="!controlling || ended || goalMode" aria-label="Attach files" title="Attach files" @click="picker?.click()">
            <Paperclip class="h-4 w-4" />
          </Button>
          <Button v-if="!controlling && (!ended || restartable)" type="button" size="sm" @click="emit('takeControl')">Take control</Button>
          <Button v-else-if="stoppable" type="button" size="icon" class="h-8 w-8 shrink-0" aria-label="Stop response" title="Stop response" @click="emit('interrupt')">
            <Square class="h-3.5 w-3.5 fill-current" />
          </Button>
          <Button v-else type="submit" size="icon" class="h-8 w-8 shrink-0" :disabled="!canSend" :aria-label="sending ? 'Sending' : 'Send message'" :title="sendTitle">
            <ArrowUp class="h-4 w-4" />
          </Button>
        </template>
      </div>

      <!-- Phones keep one row: status on the left, then attach, the drawer
           that holds the pickers, and send (order 1, 2 and 4). Send turns into
           Stop while the agent works and the box is empty; with something
           typed it sends, to the queue. -->
      <div v-if="!compact" class="flex min-h-11 items-center gap-2 px-2 pb-1 sm:flex-wrap">
        <div v-if="controls.selectors.length" class="hidden flex-wrap items-center gap-2 sm:flex">
          <IntegratedControlPicker v-for="selector in controls.selectors" :key="selector.id" :selector="selector" :disabled="!controlling || sending || ended" @select="emit('configure', selector.id, $event)" />
        </div>
        <!-- Goal mode turns the next submission into the agent's goal; the
             chip shows the goal it is working toward. It takes the free
             space, so a long objective truncates rather than wrap the row. -->
        <div v-if="goalSupport && !ended" class="flex min-w-0 flex-1 items-center gap-1 max-sm:order-first">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            class="h-8 shrink-0 gap-1.5 px-2 text-xs font-[440]"
            :class="goalMode ? 'bg-muted text-foreground hover:bg-muted' : 'text-muted-foreground'"
            :disabled="!controlling"
            :aria-pressed="goalMode"
            :aria-label="goalMode ? 'Goal mode: describe when the work is done. Turn off' : 'Set a goal'"
            :title="goalMode ? 'Back to messages (Esc)' : 'Set a goal the agent works toward until it is met'"
            data-component="integrated-goal-toggle"
            @click="toggleGoalMode()"
          >
            <Target class="h-3.5 w-3.5" aria-hidden="true" />
            <span v-if="goalMode">Goal</span>
          </Button>
          <IntegratedGoalChip v-if="goal && !goalMode" :goal="goal" :support="goalSupport" :actions="controlling" :disabled="goalBusy" @action="goalAction" />
        </div>
        <span v-if="!goalSupport || ended" class="flex-1" />
        <!-- The agent's state and usage, from the conversation. -->
        <!-- On narrow phones it clips rather than run under the buttons. -->
        <div class="flex min-w-0 items-center gap-2 overflow-hidden max-sm:order-first">
          <slot name="status" />
        </div>
        <span v-if="sending" class="text-xs text-muted-foreground" role="status">Sending…</span>
        <Button type="button" size="icon" variant="ghost" class="h-8 w-8 shrink-0 text-muted-foreground max-sm:order-1" :disabled="!controlling || ended || goalMode" aria-label="Attach files" title="Attach files" @click="picker?.click()">
          <Paperclip class="h-4 w-4" />
        </Button>
        <Button v-if="!controlling && (!ended || restartable)" type="button" size="sm" class="max-sm:order-4" @click="emit('takeControl')">Take control</Button>
        <Button v-else-if="stoppable" type="button" size="icon" class="h-8 w-8 shrink-0 max-sm:order-4" aria-label="Stop response" title="Stop response" @click="emit('interrupt')">
          <Square class="h-3.5 w-3.5 fill-current" />
        </Button>
        <Button v-else type="submit" size="icon" class="h-8 w-8 shrink-0 max-sm:order-4" :disabled="!canSend" :aria-label="goalMode ? 'Set goal' : sending ? 'Sending' : 'Send message'" :title="sendTitle">
          <ArrowUp class="h-4 w-4" />
        </Button>
        <IntegratedControlDrawer v-if="controls.selectors.length" :selectors="controls.selectors" :disabled="!controlling || sending || ended" @select="(id, value) => emit('configure', id, value)" />
      </div>
    </div>
    <input ref="picker" type="file" multiple class="hidden" :accept="accept" @change="onPick">
  </form>
</template>

<script setup lang="ts">
import { cn } from '@/lib/utils';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { EditorContent } from '@tiptap/vue-3';
import { ArrowUp, Paperclip, Square, Target, TerminalSquare } from 'lucide-vue-next';
import { Button } from './ui/button';
import AgentIcon from './AgentIcon.vue';
import ComposerWorkingBorder from './ComposerWorkingBorder.vue';
import IntegratedControlDrawer from './IntegratedControlDrawer.vue';
import IntegratedControlPicker from './IntegratedControlPicker.vue';
import IntegratedGoalChip from './IntegratedGoalChip.vue';
import HostBadge from './HostBadge.vue';
import TabActivity from './TabActivity.vue';
import {
  addFiles,
  draftFor,
  formatBytes,
  highlightRuns,
  mentionPreview,
  mentionQuery,
  payloadFor,
  rankCommands,
  removeAttachment,
  retryUpload,
  slashQuery,
  type ComposerSendPayload
} from '../lib/integratedComposer';
import type { MentionAgent, MentionBot, MentionLauncher, MentionProcess } from '../lib/agentMentions';
import type { IntegratedGoal, IntegratedGoalAction, IntegratedGoalSupport } from '../lib/integratedConversation';
import { harnessLabel } from '../lib/harnesses';
import type { ComposerChip } from '../lib/composerDocument';
import { createComposerEditor, type ComposerEditor } from '../lib/composerEditor';
import { interceptMcpCallbackPaste } from '../lib/mcpCallbackPaste';
import { processStatusIcon, sessionStatusIcon } from '../lib/statusIcons';
import { touchScreen } from '../lib/touch';

interface Selector { id: string; label: string; value: string; options: Array<{ value: string; label: string; description?: string }> }
interface NativeCommand { name: string; description?: string; source?: 'patterm' }

const props = defineProps<{
  processId: string;
  provider?: string | null;
  controls: { selectors: Selector[]; commands: NativeCommand[]; goals?: IntegratedGoalSupport };
  controlling: boolean;
  sending: boolean;
  pending: boolean;
  ended: boolean;
  restartable?: boolean;
  // The agent is working on a turn; a comet circles the border.
  working?: boolean;
  // Other agents the @ menu offers.
  agents?: MentionAgent[] | undefined;
  // Running bots that work in the project, which the agent can message.
  bots?: MentionBot[] | undefined;
  // Live processes, such as shells and dev servers, the @ menu offers.
  processes?: MentionProcess[] | undefined;
  // Presets and harnesses the @ menu offers for launching a new agent.
  launchers?: MentionLauncher[] | undefined;
  // One row without pickers or usage, for a bot's chat; the
  // placeholder names who you're messaging.
  compact?: boolean;
  addressee?: string | undefined;
  // The goal shown as a chip, while it is open or just met.
  goal?: IntegratedGoal | null | undefined;
  // Sets the goal from goal mode; resolves whether it was set.
  setGoal?: ((objective: string) => Promise<boolean>) | undefined;
}>();
const emit = defineEmits<{
  send: [request: ComposerSendPayload & { hash: string }];
  command: [name: string];
  invalid: [message: string];
  interrupt: [];
  configure: [selector: string, value: string];
  goal: [action: Exclude<IntegratedGoalAction, 'set'>];
  takeControl: [];
}>();

const draft = computed(() => draftFor(props.processId));
const editor = shallowRef<ComposerEditor | null>(null);
const menu = ref<HTMLElement>();
const listboxId = `composer-menu-${useId()}`;
const picker = ref<HTMLInputElement>();
const dragging = ref(false);
const mode = ref<'mention' | 'slash' | null>(null);
const menuIndex = ref(0);
const accept = 'image/png,image/jpeg,image/gif,image/webp,.pdf,.md,.markdown,.txt,.json,.yaml,.yml,.toml,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.hpp,.sh,.zsh,.css,.scss,.html,.sql,.csv,.xml,.log,.ini,.conf,.env';

const agents = computed(() => props.agents ?? []);
const bots = computed(() => props.bots ?? []);
const processes = computed(() => props.processes ?? []);
const launchers = computed(() => props.launchers ?? []);
// The menu offers no files: attach them instead. Without anything to
// mention, @ is plain text.
const mentionable = computed(() => Boolean(agents.value.length || bots.value.length || processes.value.length || launchers.value.length));
// The current mention's text, which every row matches at once.
const agentQuery = ref('');
const agentMatches = computed(() => mode.value === 'mention' ? rankCommands(agents.value, agentQuery.value) : []);
const botMatches = computed(() => mode.value === 'mention' ? rankCommands(bots.value, agentQuery.value) : []);
const processMatches = computed(() => mode.value === 'mention' ? rankCommands(processes.value, agentQuery.value) : []);
const launcherMatches = computed(() => mode.value === 'mention' ? rankCommands(launchers.value, agentQuery.value) : []);
const botOffset = computed(() => agentMatches.value.length);
const processOffset = computed(() => botOffset.value + botMatches.value.length);
const launcherOffset = computed(() => processOffset.value + processMatches.value.length);
const commandMatches = computed(() => rankCommands(props.controls.commands, slashQuery(draft.value.text)?.query ?? ''));
const menuItems = computed(() => mode.value === 'mention'
  ? [
      ...agentMatches.value.map((agent) => ({ kind: 'agent' as const, agent })),
      ...botMatches.value.map((bot) => ({ kind: 'bot' as const, bot })),
      ...processMatches.value.map((process) => ({ kind: 'process' as const, process })),
      ...launcherMatches.value.map((launcher) => ({ kind: 'launcher' as const, launcher }))
    ]
  : commandMatches.value.map((command) => ({ kind: 'command' as const, command })));
const menuOpen = computed(() => mode.value === 'mention' || mode.value === 'slash');
const previewSessionId = computed(() => {
  const item = menuOpen.value ? menuItems.value[menuIndex.value] : undefined;
  return item?.kind === 'agent' ? item.agent.session.id : null;
});
const goalSupport = computed(() => props.compact || !props.setGoal ? null : props.controls.goals ?? null);
// Goal mode borrows the editor; the message draft waits until it ends.
const goalMode = ref(false);
const goalBusy = ref(false);
let stashedDraft: { processId: string; text: string; chips: ComposerChip[] } | null = null;
// Counts goal edits, so a slow submit only ends the edit it came from.
let goalEdit = 0;
const placeholder = computed(() => {
  if (props.ended) return props.restartable ? 'Type /restart to resume this conversation' : 'This session has ended';
  if (goalMode.value) return 'Describe when the work is done…';
  if (props.compact) return `Message ${props.addressee ?? 'agent'}`;
  const parts = ['Message agent', ...mentionable.value ? ['type @ for agents'] : [], ...props.controls.commands.length ? ['/ for commands'] : []];
  return parts.join(', ');
});
// The editable element is the combobox that owns the menus.
const editorAttributes = computed<Record<string, string>>(() => ({
  class: props.compact
    ? 'block max-h-44 min-h-8 w-full overflow-y-auto bg-transparent px-2.5 py-1.5 text-sm leading-5 outline-none'
    : 'block max-h-44 min-h-14 w-full overflow-y-auto bg-transparent px-4 pb-1 pt-3 text-sm leading-5 outline-none',
  'data-patterm-integrated-input': '',
  role: 'combobox',
  'aria-label': goalMode.value ? 'Goal: describe when the work is done' : 'Message agent',
  'aria-placeholder': placeholder.value,
  'aria-multiline': 'true',
  'aria-autocomplete': 'list',
  'aria-expanded': String(menuOpen.value),
  ...(menuOpen.value ? { 'aria-controls': listboxId } : {}),
  ...(menuOpen.value && menuItems.value.length ? { 'aria-activedescendant': optionId(menuIndex.value) } : {})
}));
const recoveryCommand = computed(() => Boolean(props.ended && props.restartable
  && (draft.value.text.trim() === '/restart' || /^\/resume(?:\s|$)/.test(draft.value.text.trim()))
  && !draft.value.chips.length && !draft.value.attachments.length));
const canSend = computed(() => goalMode.value ? props.controlling && !props.ended && !goalBusy.value && draft.value.text.trim().length > 0
  : props.controlling && (!props.ended || recoveryCommand.value) && !props.sending && !props.pending
  && (draft.value.text.trim().length > 0 || draft.value.attachments.length > 0)
  && !draft.value.attachments.some((attachment) => attachment.status !== 'ready'));
// While the agent works, an empty box offers Stop in Send's place.
const stoppable = computed(() => !goalMode.value && Boolean(props.working) && props.controlling && !props.ended && !props.sending
  && !draft.value.text.trim() && !draft.value.attachments.length);
const sendTitle = computed(() => {
  if (goalMode.value) return 'Set goal';
  if (props.pending) return 'Resolve the pending delivery before sending again';
  if (props.sending) return 'Sending';
  if (draft.value.attachments.some((attachment) => attachment.status !== 'ready')) return 'Wait for attachments to finish uploading';
  return 'Send message';
});

let mentionRange = { start: 0, caret: 0 };

function optionId(index: number): string {
  return `${listboxId}-option-${index}`;
}

function mentionRuns(item: { name: string }) {
  const query = agentQuery.value.toLowerCase();
  const start = query ? item.name.toLowerCase().indexOf(query) : -1;
  return highlightRuns(item.name, start < 0 ? [] : Array.from({ length: query.length }, (_, offset) => start + offset));
}

function closeMenus(): void {
  mode.value = null;
  menuIndex.value = 0;
}

function evaluate(): void {
  const current = editor.value;
  if (!current) return;
  // A goal is plain text, without mentions or commands.
  if (goalMode.value) {
    closeMenus();
    return;
  }
  const caret = current.getSelection().start;
  const mention = mentionable.value ? mentionQuery(draft.value.text, caret) : null;
  if (mention) {
    // Moving the caret within an unchanged mention keeps the highlighted row.
    const unchanged = mode.value === 'mention' && mention.start === mentionRange.start && mention.query === agentQuery.value;
    mentionRange = { start: mention.start, caret };
    if (unchanged) return;
    mode.value = 'mention';
    agentQuery.value = mention.query;
    menuIndex.value = 0;
    return;
  }
  // Agents without native commands send `/text` as a prompt.
  if (props.controls.commands.length && slashQuery(draft.value.text)) {
    mode.value = 'slash';
    menuIndex.value = 0;
    return;
  }
  closeMenus();
}

function chooseAgent(agent: MentionAgent): void {
  editor.value?.replace(mentionRange.start, mentionRange.caret, { kind: 'agent', token: agent.processId, name: agent.name, harness: agent.session.harness, ...(agent.session.host ? { host: agent.session.host } : {}) });
  closeMenus();
  focusEditor();
}

// A bot is sent as its process ID, which send_message accepts while the
// bot's purview includes the agent's project.
function chooseBot(bot: MentionBot): void {
  editor.value?.replace(mentionRange.start, mentionRange.caret, { kind: 'agent', token: bot.processId, name: bot.name, harness: bot.harness });
  closeMenus();
  focusEditor();
}

function chooseProcess(process: MentionProcess): void {
  editor.value?.replace(mentionRange.start, mentionRange.caret, { kind: 'process', token: process.processId, name: process.name, harness: null, ...(process.process.host ? { host: process.process.host } : {}) });
  closeMenus();
  focusEditor();
}

function chooseLauncher(launcher: MentionLauncher): void {
  editor.value?.replace(mentionRange.start, mentionRange.caret, { kind: launcher.kind, token: launcher.token, name: launcher.name, harness: launcher.harness });
  closeMenus();
  focusEditor();
}

function chooseCommand(command: NativeCommand): void {
  if (props.ended && (!props.restartable || !props.controlling || (command.name !== 'restart' && command.name !== 'resume'))) return;
  closeMenus();
  draft.value.chips = [];
  if (command.source === 'patterm') {
    draft.value.text = '';
    emit('command', command.name);
    return;
  }
  // The draft watcher shows it in the editor, with the caret at the end.
  draft.value.text = `/${command.name} `;
  void nextTick(focusEditor);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  // Shift+Enter is always a newline, even while a menu is open.
  if (event.key === 'Enter' && event.shiftKey) return;
  const accepting = event.key === 'Enter' || event.key === 'Tab';
  const highlighted = menuOpen.value ? menuItems.value[menuIndex.value] : undefined;
  if (accepting && highlighted?.kind === 'agent') {
    event.preventDefault();
    chooseAgent(highlighted.agent);
    return;
  }
  if (accepting && highlighted?.kind === 'bot') {
    event.preventDefault();
    chooseBot(highlighted.bot);
    return;
  }
  if (accepting && highlighted?.kind === 'process') {
    event.preventDefault();
    chooseProcess(highlighted.process);
    return;
  }
  if (accepting && highlighted?.kind === 'launcher') {
    event.preventDefault();
    chooseLauncher(highlighted.launcher);
    return;
  }
  if (menuOpen.value && menuItems.value.length) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      menuIndex.value = (menuIndex.value + 1) % menuItems.value.length;
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      menuIndex.value = (menuIndex.value - 1 + menuItems.value.length) % menuItems.value.length;
      return;
    }
    if (accepting) {
      event.preventDefault();
      if (highlighted?.kind === 'command') chooseCommand(highlighted.command);
      return;
    }
  }
  if (event.key === 'Escape' && mode.value) {
    event.preventDefault();
    closeMenus();
    return;
  }
  if (event.key === 'Escape' && goalMode.value) {
    event.preventDefault();
    leaveGoalMode();
    return;
  }
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  submit();
}

function submit(): void {
  if (goalMode.value) {
    void submitGoal();
    return;
  }
  if (!canSend.value) return;
  const prepared = payloadFor(props.processId);
  if (!prepared.ok) {
    emit('invalid', prepared.error);
    return;
  }
  emit('send', { ...prepared.payload, hash: prepared.hash });
  closeMenus();
}

// `prefill` is the goal being edited.
function enterGoalMode(prefill = ''): void {
  if (!goalMode.value) {
    stashedDraft = { processId: props.processId, text: draft.value.text, chips: draft.value.chips };
    goalEdit += 1;
  }
  closeMenus();
  draft.value.chips = [];
  draft.value.text = prefill;
  goalMode.value = true;
  void nextTick(focusEditor);
}

function leaveGoalMode(): void {
  if (!goalMode.value) return;
  goalMode.value = false;
  const stashed = stashedDraft;
  stashedDraft = null;
  const target = draftFor(stashed?.processId ?? props.processId);
  target.chips = stashed?.chips ?? [];
  target.text = stashed?.text ?? '';
  void nextTick(focusEditor);
}

function toggleGoalMode(): void {
  if (goalMode.value) leaveGoalMode();
  else enterGoalMode();
}

// A goal is plain text: mentions and files belong to messages.
async function submitGoal(): Promise<void> {
  const objective = draft.value.text.trim();
  if (!objective || goalBusy.value || !props.setGoal || !props.controlling) return;
  if (draft.value.chips.length) {
    emit('invalid', 'A goal is plain text; send mentions as a message.');
    return;
  }
  const edit = goalEdit;
  const processId = props.processId;
  goalBusy.value = true;
  try {
    const set = await props.setGoal(objective);
    // Text typed while the goal was being set stays for another try.
    if (set && goalMode.value && goalEdit === edit && props.processId === processId && draft.value.text.trim() === objective) leaveGoalMode();
  } finally {
    goalBusy.value = false;
  }
}

function goalAction(action: 'edit' | Exclude<IntegratedGoalAction, 'set'>): void {
  if (action === 'edit') enterGoalMode(props.goal?.objective ?? '');
  else emit('goal', action);
}

// Returns true when the composer took the paste over.
function onPaste(event: ClipboardEvent): boolean {
  const clipboard = event.clipboardData;
  if (!clipboard) return false;
  const pasted = Array.from(clipboard.items).flatMap((item) => {
    if (item.kind !== 'file') return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
  if (pasted.length) {
    event.preventDefault();
    attach(pasted);
    return true;
  }
  const range = editor.value?.getSelection() ?? { start: draft.value.text.length, end: draft.value.text.length };
  if (!interceptMcpCallbackPaste(clipboard.getData('text/plain'), (text) => insertText(text, range))) return false;
  event.preventDefault();
  return true;
}

// Pastes text as the browser would, for pastes that Patterm took over first.
function insertText(text: string, range: { start: number; end: number }): void {
  editor.value?.replace(range.start, range.end, text);
  focusEditor();
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  const dropped = event.dataTransfer?.files;
  if (dropped?.length) attach(Array.from(dropped));
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) attach(Array.from(input.files));
  input.value = '';
}

// Files belong to the message draft, which goal mode sets aside.
function attach(files: File[]): void {
  if (goalMode.value) emit('invalid', 'A goal is plain text; attach files to a message.');
  else void addFiles(props.processId, files);
}

function onBlur(): void {
  // Let a menu click land before closing; mousedown handlers run first.
  setTimeout(() => closeMenus(), 0);
}

// The editor's edits. Mention chips arrive as CHIP characters, with the
// chips listed in order.
function onEditorChange(text: string, chips: ComposerChip[]): void {
  draft.value.text = text;
  draft.value.chips = chips;
  evaluate();
}

// Each agent gets a fresh editor, so undo never reaches another agent's draft.
function mountEditor(): void {
  editor.value?.destroy();
  editor.value = createComposerEditor({
    text: draft.value.text,
    chips: draft.value.chips,
    placeholder: () => placeholder.value,
    attributes: () => editorAttributes.value,
    onChange: onEditorChange,
    onSelectionChange: evaluate,
    onKeyDown: (event) => {
      onKeydown(event);
      return event.defaultPrevented;
    },
    onPaste,
    // Dropped files bubble to the composer, which attaches them.
    onDrop: (event) => Boolean(event.dataTransfer?.files.length),
    onBlur
  });
}

function focusEditor(): void {
  if (!props.ended) editor.value?.focus();
}

watch(menuIndex, () => void nextTick(() => {
  menu.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}));
// Drafts also change outside the editor: a delivered message empties its
// draft, and choosing a command rewrites it.
watch(() => draft.value.text, (text) => {
  if (editor.value && editor.value.getText() !== text) editor.value.setText(text, draft.value.chips);
});
watch([placeholder, editorAttributes], () => editor.value?.refresh());
// Arriving at an agent focuses its composer, except on touch screens, where
// that would reopen the keyboard the user just closed.
function focusOnArrival(): void {
  if (!touchScreen()) focusEditor();
}

watch(() => props.processId, () => {
  // The stashed draft belongs to the agent being left.
  if (goalMode.value) leaveGoalMode();
  closeMenus();
  mountEditor();
  void nextTick(focusOnArrival);
});
watch(previewSessionId, (sessionId) => { mentionPreview.value = sessionId; });
// Created last so the editor's callbacks can read everything above, and
// before the first render so the composer never renders without it.
mountEditor();
onMounted(() => void nextTick(focusOnArrival));
onBeforeUnmount(() => {
  leaveGoalMode();
  mentionPreview.value = null;
  editor.value?.destroy();
});
</script>

<style scoped>
/* The placeholder sits where the first line of text will. */
.composer-editor :deep(.ProseMirror p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
  color: hsl(var(--muted-foreground));
}
</style>
