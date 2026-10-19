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
        :aria-label="mode === 'mention' ? (agents.length || processes.length || launchers.length ? 'Agents, processes, and worktree files' : 'Worktree files') : 'Slash commands'"
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
          <div v-if="agentMatches.length && processMatches.length" aria-hidden="true" class="mx-2 my-1 border-t border-border/60" />
          <div v-if="processMatches.length" role="group" aria-label="Processes">
            <button
              v-for="(process, index) in processMatches"
              :id="optionId(agentMatches.length + index)"
              :key="process.processId"
              type="button"
              role="option"
              tabindex="-1"
              :aria-selected="agentMatches.length + index === menuIndex"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm"
              :class="agentMatches.length + index === menuIndex && 'bg-muted'"
              @mouseenter="menuIndex = agentMatches.length + index"
              @mousedown.prevent="chooseProcess(process)"
            >
              <TabActivity :spec="processStatusIcon(process.process)"><TerminalSquare class="h-3.5 w-3.5" aria-hidden="true" /></TabActivity>
              <span class="min-w-0 truncate"><span v-for="(run, runIndex) in mentionRuns(process)" :key="runIndex" :class="run.match && 'font-semibold text-primary'">{{ run.text }}</span></span>
              <HostBadge v-if="process.process.host" :host="process.process.host" />
              <span v-if="process.owner" class="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">{{ process.owner }}</span>
            </button>
          </div>
          <div v-if="(agentMatches.length || processMatches.length) && launcherMatches.length" aria-hidden="true" class="mx-2 my-1 border-t border-border/60" />
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
          <div v-if="namedCount && (files.length || searchError)" aria-hidden="true" class="mx-2 my-1 border-t border-border/60" />
          <div role="group" aria-label="Worktree files">
            <button
              v-for="(file, index) in files"
              :id="optionId(namedCount + index)"
              :key="file.path"
              type="button"
              role="option"
              tabindex="-1"
              :aria-selected="namedCount + index === menuIndex"
              class="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm"
              :class="[namedCount + index === menuIndex && 'bg-muted', searching && 'opacity-60']"
              @mouseenter="menuIndex = namedCount + index"
              @mousedown.prevent="chooseFile(file)"
            >
              <span class="shrink-0"><span v-for="(run, runIndex) in nameRuns(file)" :key="runIndex" :class="run.match && 'font-semibold text-primary'">{{ run.text }}</span></span>
              <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground" dir="rtl"><bdi><span v-for="(run, runIndex) in directoryRuns(file)" :key="runIndex" :class="run.match && 'font-semibold text-foreground'">{{ run.text }}</span></bdi></span>
            </button>
          </div>
          <p v-if="searchError" class="px-2 py-1.5 text-xs text-destructive">{{ searchError }}</p>
          <p v-else-if="!files.length && !namedCount" class="px-2 py-1.5 text-xs text-muted-foreground" role="status">{{ searching ? 'Searching…' : agents.length || processes.length || launchers.length ? 'No matching agents, processes, or files' : 'No matching worktree files' }}</p>
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

      <div v-if="draft.attachments.length" class="flex flex-wrap items-center gap-2 px-2 pt-2">
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
      <EditorContent v-if="editor" :editor="editor.tiptap" class="composer-editor" />

      <!-- Phones keep one row: status on the left, then attach, the drawer
           that holds the pickers, stop, and send (order 1 to 4). -->
      <div class="flex min-h-11 items-center gap-2 px-2 pb-1 sm:flex-wrap">
        <div v-if="controls.selectors.length" class="hidden flex-wrap items-center gap-2 sm:flex">
          <IntegratedControlPicker v-for="selector in controls.selectors" :key="selector.id" :selector="selector" :disabled="!controlling || sending || ended" @select="emit('configure', selector.id, $event)" />
        </div>
        <span class="flex-1" />
        <!-- The agent's state and usage, from the conversation. -->
        <!-- On narrow phones it clips rather than run under the buttons. -->
        <div class="flex min-w-0 items-center gap-2 overflow-hidden max-sm:order-first">
          <slot name="status" />
        </div>
        <span v-if="sending" class="text-xs text-muted-foreground" role="status">Sending…</span>
        <Button type="button" size="icon" variant="ghost" class="h-8 w-8 text-muted-foreground max-sm:order-1" :disabled="!controlling || ended" aria-label="Attach files" title="Attach files" @click="picker?.click()">
          <Paperclip class="h-4 w-4" />
        </Button>
        <Button v-if="!controlling && (!ended || restartable)" type="button" size="sm" class="max-sm:order-4" @click="emit('takeControl')">Take control</Button>
        <Button v-else type="submit" size="icon" class="h-8 w-8 max-sm:order-4" :disabled="!canSend" :aria-label="sending ? 'Sending' : 'Send message'" :title="sendTitle">
          <ArrowUp class="h-4 w-4" />
        </Button>
        <Button type="button" size="icon" variant="outline" class="h-8 w-8 max-sm:order-3" :disabled="!controlling || ended" aria-label="Stop response" title="Stop response" @click="emit('interrupt')">
          <Square class="h-3.5 w-3.5" />
        </Button>
        <IntegratedControlDrawer v-if="controls.selectors.length" :selectors="controls.selectors" :disabled="!controlling || sending || ended" @select="(id, value) => emit('configure', id, value)" />
      </div>
    </div>
    <input ref="picker" type="file" multiple class="hidden" :accept="accept" @change="onPick">
  </form>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { EditorContent } from '@tiptap/vue-3';
import { ArrowUp, Paperclip, Square, TerminalSquare } from 'lucide-vue-next';
import { Button } from './ui/button';
import AgentIcon from './AgentIcon.vue';
import ComposerWorkingBorder from './ComposerWorkingBorder.vue';
import IntegratedControlDrawer from './IntegratedControlDrawer.vue';
import IntegratedControlPicker from './IntegratedControlPicker.vue';
import HostBadge from './HostBadge.vue';
import TabActivity from './TabActivity.vue';
import {
  addFiles,
  addReference,
  draftFor,
  formatBytes,
  highlightRuns,
  mentionPreview,
  mentionQuery,
  payloadFor,
  rankCommands,
  referenceToken,
  removeAttachment,
  retryUpload,
  slashQuery,
  type ComposerSendPayload
} from '../lib/integratedComposer';
import type { MentionAgent, MentionLauncher, MentionProcess } from '../lib/agentMentions';
import { harnessLabel } from '../lib/harnesses';
import type { ComposerChip } from '../lib/composerDocument';
import { createComposerEditor, type ComposerEditor } from '../lib/composerEditor';
import { interceptMcpCallbackPaste } from '../lib/mcpCallbackPaste';
import { processStatusIcon, sessionStatusIcon } from '../lib/statusIcons';
import { touchScreen } from '../lib/touch';

interface Selector { id: string; label: string; value: string; options: Array<{ value: string; label: string }> }
interface NativeCommand { name: string; description?: string; source?: 'patterm' }
interface WorktreeFile { path: string; name: string; matches?: number[] }

const props = defineProps<{
  processId: string;
  provider?: string | null;
  controls: { selectors: Selector[]; commands: NativeCommand[] };
  controlling: boolean;
  sending: boolean;
  pending: boolean;
  ended: boolean;
  restartable?: boolean;
  // The agent is working on a turn; a comet circles the border.
  working?: boolean;
  // Other agents the @ menu offers.
  agents?: MentionAgent[] | undefined;
  // Live processes, such as shells and dev servers, the @ menu offers.
  processes?: MentionProcess[] | undefined;
  // Presets and harnesses the @ menu offers for launching a new agent.
  launchers?: MentionLauncher[] | undefined;
}>();
const emit = defineEmits<{
  send: [request: ComposerSendPayload & { hash: string }];
  command: [name: string];
  invalid: [message: string];
  interrupt: [];
  configure: [selector: string, value: string];
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
const files = ref<WorktreeFile[]>([]);
const searchError = ref('');
const searching = ref(false);
const accept = 'image/png,image/jpeg,image/gif,image/webp,.pdf,.md,.markdown,.txt,.json,.yaml,.yml,.toml,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.hpp,.sh,.zsh,.css,.scss,.html,.sql,.csv,.xml,.log,.ini,.conf,.env';

const agents = computed(() => props.agents ?? []);
const processes = computed(() => props.processes ?? []);
const launchers = computed(() => props.launchers ?? []);
// The current mention's text. Agents, processes, and launchers match it at once; files
// arrive from a debounced search.
const agentQuery = ref('');
const agentMatches = computed(() => mode.value === 'mention' ? rankCommands(agents.value, agentQuery.value) : []);
const processMatches = computed(() => mode.value === 'mention' ? rankCommands(processes.value, agentQuery.value) : []);
const launcherMatches = computed(() => mode.value === 'mention' ? rankCommands(launchers.value, agentQuery.value) : []);
const launcherOffset = computed(() => agentMatches.value.length + processMatches.value.length);
// The rows above the files, which match without a search.
const namedCount = computed(() => launcherOffset.value + launcherMatches.value.length);
const commandMatches = computed(() => rankCommands(props.controls.commands, slashQuery(draft.value.text)?.query ?? ''));
const menuItems = computed(() => mode.value === 'mention'
  ? [
      ...agentMatches.value.map((agent) => ({ kind: 'agent' as const, agent })),
      ...processMatches.value.map((process) => ({ kind: 'process' as const, process })),
      ...launcherMatches.value.map((launcher) => ({ kind: 'launcher' as const, launcher })),
      ...files.value.map((file) => ({ kind: 'file' as const, file }))
    ]
  : commandMatches.value.map((command) => ({ kind: 'command' as const, command })));
const menuOpen = computed(() => mode.value === 'mention' || mode.value === 'slash');
const previewSessionId = computed(() => {
  const item = menuOpen.value ? menuItems.value[menuIndex.value] : undefined;
  return item?.kind === 'agent' ? item.agent.session.id : null;
});
const placeholder = computed(() => {
  if (props.ended) return props.restartable ? 'Type /restart to resume this conversation' : 'This session has ended';
  const mentions = agents.value.length || processes.value.length || launchers.value.length ? 'type @ for agents and files' : 'type @ for files';
  return props.controls.commands.length ? `Message agent, ${mentions}, / for commands` : `Message agent, ${mentions}`;
});
// The editable element is the combobox that owns the menus.
const editorAttributes = computed<Record<string, string>>(() => ({
  class: 'block max-h-44 min-h-14 w-full overflow-y-auto bg-transparent px-4 pb-1 pt-3 text-sm leading-5 outline-none',
  'data-patterm-integrated-input': '',
  role: 'combobox',
  'aria-label': 'Message agent',
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
const canSend = computed(() => props.controlling && (!props.ended || recoveryCommand.value) && !props.sending && !props.pending
  && (draft.value.text.trim().length > 0 || draft.value.attachments.length > 0)
  && !draft.value.attachments.some((attachment) => attachment.status !== 'ready'));
const sendTitle = computed(() => {
  if (props.pending) return 'Resolve the pending delivery before sending again';
  if (props.sending) return 'Sending';
  if (draft.value.attachments.some((attachment) => attachment.status !== 'ready')) return 'Wait for attachments to finish uploading';
  return 'Send message';
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSearch: (() => void) | null = null;
let searchToken = 0;
let searchQuery = '';
let mentionRange = { start: 0, caret: 0 };
// Enter or Tab pressed before the current query's results arrived. The first
// result is accepted with that key when they land, rather than a stale row
// from the last query.
let acceptWhenReady: 'Enter' | 'Tab' | null = null;

function optionId(index: number): string {
  return `${listboxId}-option-${index}`;
}

function nameRuns(file: WorktreeFile) {
  return highlightRuns(file.name, file.matches, file.path.length - file.name.length);
}

function directoryRuns(file: WorktreeFile) {
  return highlightRuns(file.path.slice(0, file.path.length - file.name.length).replace(/\/$/, ''), file.matches);
}

function mentionRuns(item: { name: string }) {
  const query = agentQuery.value.toLowerCase();
  const start = query ? item.name.toLowerCase().indexOf(query) : -1;
  return highlightRuns(item.name, start < 0 ? [] : Array.from({ length: query.length }, (_, offset) => start + offset));
}

// Fresh file results replace the rows the old index pointed at. A highlighted
// agent or launcher stays highlighted.
function resetFileSelection(): void {
  if (menuIndex.value >= namedCount.value) menuIndex.value = files.value.length ? namedCount.value : 0;
}

function invalidateSearch(clearResults = false): void {
  searchToken++;
  clearTimeout(searchTimer);
  pendingSearch = null;
  searching.value = false;
  acceptWhenReady = null;
  if (clearResults) files.value = [];
}

function closeMenus(): void {
  mode.value = null;
  menuIndex.value = 0;
  searchError.value = '';
  invalidateSearch(true);
}

function evaluate(): void {
  const current = editor.value;
  if (!current) return;
  const caret = current.getSelection().start;
  const mention = mentionQuery(draft.value.text, caret);
  if (mention) {
    // Moving the caret within an unchanged mention keeps the current results.
    const unchanged = mode.value === 'mention' && mention.start === mentionRange.start && mention.query === searchQuery;
    mentionRange = { start: mention.start, caret };
    if (unchanged) return;
    mode.value = 'mention';
    agentQuery.value = mention.query;
    menuIndex.value = 0;
    scheduleSearch(mention.query);
    return;
  }
  // Agents without native commands send `/text` as a prompt.
  if (props.controls.commands.length && slashQuery(draft.value.text)) {
    mode.value = 'slash';
    menuIndex.value = 0;
    invalidateSearch(true);
    return;
  }
  closeMenus();
}

function scheduleSearch(query: string): void {
  // Invalidate any in-flight or debounced reply immediately so a result from an
  // earlier process or query cannot land in this one.
  const token = ++searchToken;
  clearTimeout(searchTimer);
  searchQuery = query;
  searching.value = true;
  acceptWhenReady = null;
  const run = (): void => {
    pendingSearch = null;
    void searchFiles(query, token);
  };
  pendingSearch = run;
  searchTimer = setTimeout(run, 120);
}

async function searchFiles(query: string, token: number): Promise<void> {
  const processId = props.processId;
  try {
    const result = await window.patterm.call('integrated_files_search', { process_id: processId, query, limit: 20 }) as WorktreeFile[];
    if (!searchCurrent(token, processId, query)) return;
    files.value = Array.isArray(result) ? result.filter((file) => file && typeof file.path === 'string' && typeof file.name === 'string') : [];
    resetFileSelection();
    searchError.value = '';
    searching.value = false;
    const accept = acceptWhenReady;
    acceptWhenReady = null;
    const first = files.value[0];
    if (accept && first) acceptFile(first, accept);
  } catch (cause) {
    if (!searchCurrent(token, processId, query)) return;
    files.value = [];
    resetFileSelection();
    searchError.value = cause instanceof Error ? cause.message : String(cause);
    searching.value = false;
    acceptWhenReady = null;
  }
}

function searchCurrent(token: number, processId: string, query: string): boolean {
  return token === searchToken && mode.value === 'mention' && processId === props.processId && query === searchQuery;
}

// Tab on a directory completes into it, as shell completion does, and keeps
// the menu open on its contents. Enter or a click references the directory.
// Quoted paths cannot be extended, so they are always referenced.
function acceptFile(file: WorktreeFile, key: 'Enter' | 'Tab'): void {
  if (key === 'Tab' && file.path.endsWith('/') && !/\s/.test(file.path)) enterDirectory(file);
  else chooseFile(file);
}

// The directory stays a reference if the user ends the mention there. The
// edit reopens the menu on the directory's contents.
function enterDirectory(file: WorktreeFile): void {
  addReference(props.processId, file.path, file.name);
  editor.value?.replace(mentionRange.start, mentionRange.caret, `@${file.path}`);
  focusEditor();
}

function chooseFile(file: WorktreeFile): void {
  addReference(props.processId, file.path, file.name);
  editor.value?.replace(mentionRange.start, mentionRange.caret, `${referenceToken(file.path)} `);
  closeMenus();
  focusEditor();
}

function chooseAgent(agent: MentionAgent): void {
  editor.value?.replace(mentionRange.start, mentionRange.caret, { kind: 'agent', token: agent.processId, name: agent.name, harness: agent.session.harness, ...(agent.session.host ? { host: agent.session.host } : {}) });
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
  // Agents, processes, and launchers match without a search, so a highlighted
  // one is never stale.
  if (accepting && highlighted?.kind === 'agent') {
    event.preventDefault();
    chooseAgent(highlighted.agent);
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
  if (mode.value === 'mention' && searching.value && accepting) {
    event.preventDefault();
    acceptWhenReady = event.key as 'Enter' | 'Tab';
    if (pendingSearch) {
      clearTimeout(searchTimer);
      pendingSearch();
    }
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
      if (highlighted?.kind === 'file') acceptFile(highlighted.file, event.key as 'Enter' | 'Tab');
      else if (highlighted?.kind === 'command') chooseCommand(highlighted.command);
      return;
    }
  }
  if (event.key === 'Escape' && mode.value) {
    event.preventDefault();
    closeMenus();
    return;
  }
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  submit();
}

function submit(): void {
  if (!canSend.value) return;
  const prepared = payloadFor(props.processId);
  if (!prepared.ok) {
    emit('invalid', prepared.error);
    return;
  }
  emit('send', { ...prepared.payload, hash: prepared.hash });
  closeMenus();
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
    void addFiles(props.processId, pasted);
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
  if (dropped?.length) void addFiles(props.processId, Array.from(dropped));
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) void addFiles(props.processId, Array.from(input.files));
  input.value = '';
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
  invalidateSearch();
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
