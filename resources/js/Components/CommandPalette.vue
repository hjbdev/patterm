<template>
  <Dialog v-model:open="open">
    <DialogContent hide-close :aria-describedby="undefined" class="top-[15vh] flex max-h-[calc(85dvh-1.5rem)] -translate-y-0 w-[calc(100%-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden rounded-xl p-0" @open-auto-focus.prevent="focusQueryInput" @close-auto-focus="handleCloseAutoFocus" @escape-key-down="handleEscape">
      <DialogTitle class="sr-only">Search or jump to</DialogTitle>
      <!-- Escape goes back a level here, before the dialog's own listener could close it. -->
      <div class="contents" @keydown.esc="handleEscapeKey">
        <div class="flex h-[62px] shrink-0 items-center gap-3 border-b border-border/70 px-5 text-muted-foreground">
          <!-- Keyboard users go back with Esc, Backspace, or Shift+Tab. -->
          <button v-if="page" type="button" tabindex="-1" class="flex min-w-0 max-w-[55%] shrink-0 items-center gap-1 rounded-md bg-muted/60 py-1 pl-1.5 pr-2 text-xs text-foreground hover:bg-muted" :aria-label="`Back from ${page.title}`" @mousedown.prevent @click="popPage">
            <ChevronLeft class="h-3.5 w-3.5 shrink-0" />
            <template v-if="parentPage">
              <span class="min-w-0 shrink-[3] truncate text-muted-foreground">{{ parentPage.title }}</span>
              <ChevronRight class="h-3 w-3 shrink-0 text-muted-foreground/60" />
            </template>
            <span class="min-w-0 truncate">{{ page.title }}</span>
          </button>
          <Search v-else class="h-4 w-4 shrink-0" />
          <input ref="queryInput" v-model="query" :aria-label="page?.entry ? page.title : 'Search or jump to'" role="combobox" aria-autocomplete="list" aria-expanded="true" :aria-controls="listId" :aria-activedescendant="visibleRows[highlighted] ? `${listId}-${highlighted}` : undefined" autocomplete="off" spellcheck="false" class="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" :class="{ 'font-mono text-[13px]': page?.entry?.mono }" :placeholder="placeholder" @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)" @keydown.enter.prevent="runHighlighted" @keydown.tab.prevent.stop="handleTab" @keydown.backspace="handleBackspace" />
        </div>
        <div :id="listId" ref="resultList" role="listbox" aria-label="Commands" :aria-busy="loadingCommands" class="max-h-[26rem] min-h-0 overflow-y-auto overscroll-contain p-2">
          <p v-if="subject" class="truncate px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground/80">{{ subject }}</p>
          <p v-if="!visibleRows.length" class="p-4 text-sm text-muted-foreground">{{ loadingCommands ? 'Loading commands…' : 'No matching commands.' }}</p>
          <div v-for="group in groupedRows" :key="group.key" role="group" :aria-labelledby="group.title ? `${listId}-${group.key}` : undefined" :class="{ 'mt-1 border-t border-border/60 pt-1': group.divider }">
            <div v-if="group.title" :id="`${listId}-${group.key}`" class="truncate px-2 pb-1 pt-3 text-[11px] font-medium text-muted-foreground/80">{{ group.title }}</div>
            <div v-for="{ row, index } in group.rows" :id="`${listId}-${index}`" :key="row.key" role="option" :aria-selected="index === highlighted" class="group/row flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm" :class="rowClass(row, index)" @pointermove="hover(index)" @mousedown.prevent @click="runCommand(row.command)">
              <span v-if="showIcons" class="flex w-4 shrink-0 items-center justify-center">
                <TabActivity v-if="rowSession(row.command)" :spec="sessionStatusIcon(rowSession(row.command)!)" compact>
                  <AgentIcon :harness="rowSession(row.command)!.harness" class="h-4 w-4" />
                </TabActivity>
                <TabActivity v-else-if="rowProcess(row.command)" :spec="processStatusIcon(rowProcess(row.command)!)" compact>
                  <Terminal class="h-4 w-4 text-muted-foreground" />
                </TabActivity>
                <AgentIcon v-else-if="commandHarness(row.command)" :harness="commandHarness(row.command)" class="h-4 w-4" />
                <ProjectLogo v-else-if="rowProject(row.command)" :project="rowProject(row.command)!" :size="16" />
                <component :is="commandIcon(row.command)" v-else-if="commandIcon(row.command)" class="h-4 w-4" :class="armedId === row.command.id ? 'text-destructive' : 'text-muted-foreground'" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate font-medium" :class="{ 'text-destructive': armedId === row.command.id }">{{ rowLabel(row.command) }}</span>
                <span v-if="armedId === row.command.id" role="status" class="block whitespace-normal text-xs leading-5 text-muted-foreground">{{ confirmationText(row.command) }}</span>
                <span v-else-if="describesBelow(row.command) && rowHint(row)" class="block truncate text-[11px] leading-4 text-muted-foreground/80">{{ rowHint(row) }}</span>
              </span>
              <template v-if="armedId !== row.command.id">
                <span v-if="!describesBelow(row.command) && rowHint(row)" class="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{{ rowHint(row) }}</span>
                <span v-if="index === highlighted && row.command.primary" class="shrink-0 text-[11px] text-muted-foreground">{{ row.command.primary }}</span>
                <template v-if="row.command.current">
                  <Check class="h-4 w-4 shrink-0" />
                  <span class="sr-only">Current</span>
                </template>
                <ChevronRight v-else-if="drillsIn(row.command)" class="h-4 w-4 shrink-0 text-muted-foreground/60" />
                <span v-else-if="choiceList" class="w-4 shrink-0" />
              </template>
              <button v-if="hasRowActions(row.command)" type="button" class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100" :class="{ 'opacity-100': index === highlighted }" :aria-label="`Actions for ${row.command.label}`" tabindex="-1" @mousedown.prevent @click.stop="openPage(row.command)">
                <Ellipsis class="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
        <div v-if="error" role="alert" class="border-t border-border/70 px-5 py-3 text-sm text-destructive">{{ error }} <button v-if="!page" class="ml-2 underline" @click="reloadCommands">Reload commands</button></div>
        <footer class="flex shrink-0 items-center gap-4 border-t border-border/70 px-5 py-2.5 text-[11px] text-muted-foreground/80">
          <span>↑ ↓ Navigate</span>
          <span>↵ {{ enterLabel }}</span>
          <span v-if="!armedId && highlightedCommand && hasRowActions(highlightedCommand)">Tab Actions</span>
          <span class="ml-auto">Esc {{ armedId ? 'Cancel' : page ? 'Back' : 'Close' }}</span>
        </footer>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch, type Component } from 'vue';
import { toast } from 'vue-sonner';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { ArrowRight, ArrowUpRight, Brain, Check, ChevronLeft, ChevronRight, CircleStop, Clock, Copy, Ellipsis, Folder, GitBranch, GitCompare, History, Link, ListTodo, LogOut, MessageSquarePlus, MessagesSquare, NotebookPen, PanelRight, Pause, Pencil, Play, Rocket, RotateCcw, Search, Settings, ShieldCheck, SlidersHorizontal, Sparkles, Square, Terminal, TerminalSquare, Unlink, X, Zap } from 'lucide-vue-next';
import { actionCluster, createPaletteDocument, rankedCommands, readRecentIds, recordsRecent, rememberRecent, rendererCommands, SECTION_TITLES, withIntegratedSelectors, type CommandDescriptor, type CommandRunResult, type PaletteRow, type PaletteSection } from '../lib/commandPalette';
import { agentLabel } from '../lib/agentTabs';
import { restartAssistant } from '../lib/assistant';
import { harnessLabel } from '../lib/harnesses';
import { publishedIntegratedControls } from '../lib/integratedControlsRegistry';
import { interfaceLabel, launchParams, launchSummary, presetLabel, resumeInPlace, worktreeLabel } from '../lib/paletteSources';
import { displayPath } from '../lib/projectOverview';
import { processStatusIcon, sessionStatusIcon } from '../lib/statusIcons';
import { describeDuration, parseDurationSeconds, timerRemaining } from '../lib/timers';
import { sendWorkspaceRequest, type WorkspaceRequest } from '../lib/workspaceRequests';
import { usePaletteSources } from '../Composables/usePaletteSources';
import { useWorkbench } from '../Composables/useWorkbench';
import ProjectLogo from './ProjectLogo.vue';
import AgentIcon from './AgentIcon.vue';
import TabActivity from './TabActivity.vue';
import type { ProcessRecord, ProjectSummary, SessionRecord } from '../types';

interface CommandContext {
  active_project_id: string | null;
  active_terminal_id: string | null;
  active_tab: string | null;
  active_session_id?: string | null;
  active_process_id?: string | null;
}

// A page opened from a row, remembering the list it came from. Pages with a
// source follow live state, such as timer countdowns.
interface PalettePage {
  title: string;
  commands: CommandDescriptor[];
  source?: () => CommandDescriptor[];
  // A line about what the page acts on, such as an agent's status.
  subject?: () => string;
  // The input holds a value, such as a name or a first message, instead of a
  // filter. The rows say what Enter does with it.
  entry?: { placeholder: string; verb: string; mono?: boolean; required?: string };
  query: string;
  highlighted: number;
}

const TIMER_PRESETS = [['30s', '30 seconds'], ['1m', '1 minute'], ['5m', '5 minutes'], ['15m', '15 minutes'], ['1h', '1 hour']] as const;
// The open conversation's settings, by selector.
const SELECTOR_ICONS: Record<string, Component> = { model: Sparkles, effort: Brain, mode: ShieldCheck, speed: Zap };

const props = defineProps<{ context: CommandContext }>();
const emit = defineEmits<{
  navigate: [target: NonNullable<CommandRunResult['navigate']>];
  workspaceSearch: [query: string];
  settings: [];
  usage: [];
  routines: [];
  refresh: [];
  openTarget: [target: NonNullable<CommandRunResult['target']>];
}>();

const open = defineModel<boolean>('open', { default: false });
const listId = useId();
const resultList = ref<HTMLElement | null>(null);
const loadingCommands = ref(false);
const recentIds = ref<string[]>(readRecentIds(storage()));
let commandGeneration = 0;
// Workbench updates replace records, so the context is compared by value: only
// a different target resets the palette.
const contextKey = computed(() => JSON.stringify(props.context));
// Server commands are loaded when the palette opens, then follow workbench
// changes while it stays open. Reopening with nothing changed reuses them.
const { revision: workbenchRevision, projects } = useWorkbench();
let loadedFor = '';
let revisionTimer: ReturnType<typeof setTimeout> | null = null;
const commandKey = () => `${contextKey.value}\0${workbenchRevision.value}`;
const query = ref('');
const commands = ref<CommandDescriptor[]>([]);
const highlighted = ref(0);
const armedId = ref<string | null>(null);
const busy = ref(false);
const error = ref('');
const queryInput = ref<HTMLInputElement | null>(null);
const pages = ref<PalettePage[]>([]);
const page = computed(() => pages.value.at(-1) ?? null);
const parentPage = computed(() => pages.value.at(-2) ?? null);
const subject = computed(() => page.value?.subject?.() || '');
const sources = usePaletteSources({
  open,
  projectId: computed(() => props.context.active_project_id),
  query,
  // Workspace results join the top-level list, not pages.
  searchEnabled: computed(() => !page.value)
});
// Actions that move focus, such as opening the session panel, wait until the
// palette has closed. Its focus trap would otherwise take focus back.
let afterClose: (() => void) | null = null;
// Until the selection moves, the top row stays selected as rows arrive.
let selectionMoved = false;

const activeProject = computed(() => projects.value.find(project => project.project.id === props.context.active_project_id) ?? null);
const currentSession = computed(() => props.context.active_session_id ? activeProject.value?.projectSessions.find(session => session.id === props.context.active_session_id) ?? null : null);
const currentProcess = computed(() => props.context.active_process_id ? activeProject.value?.processes.find(process => process.id === props.context.active_process_id) ?? null : null);
const currentTitle = computed(() => currentSession.value ? agentLabel(currentSession.value) : currentProcess.value?.name ?? SECTION_TITLES.current);
const currentControls = computed(() => {
  const session = currentSession.value;
  return session?.interfaceMode === 'integrated' && !session.exitedAt ? publishedIntegratedControls(session.processId) : null;
});
const sessionsById = computed(() => new Map(projects.value.flatMap(project => project.projectSessions.map(session => [session.id, session] as const))));
const processesById = computed(() => new Map(projects.value.flatMap(project => project.processes.map(process => [process.id, process] as const))));

const localCommands = computed(() => rendererCommands(props.context.active_project_id));
// Launching, resuming, and timers each open a page of their own.
const sourceCommands = computed<CommandDescriptor[]>(() => {
  if (!props.context.active_project_id) return [];
  const conversations = sources.conversationCommands.value;
  const timers = sources.timers.value;
  return [
    { id: 'page:launch', label: 'Launch agent…', hint: launchSummary(sources.launch, sources.launchPresets.value, sources.launchWorktrees.value), group: 'create', kind: 'page' },
    ...(conversations.length ? [{ id: 'page:conversations', label: 'Resume conversation…', hint: `${conversations.length} recent`, group: 'create', kind: 'page' }] : []),
    ...(timers.length ? [{ id: 'page:timers', label: 'Timers', hint: timersHint(), group: 'navigation', kind: 'page' }] : [])
  ];
});
const catalogue = computed(() => [
  ...localCommands.value,
  ...withIntegratedSelectors(commands.value.filter(command => !localCommands.value.some(local => local.id === command.id)), currentSession.value?.processId ?? null, currentControls.value),
  ...sourceCommands.value
]);
const visibleRows = computed<PaletteRow[]>(() => page.value
  ? rankedCommands(page.value.source?.() ?? page.value.commands, page.value.entry ? '' : query.value, [], { flat: true })
  : rankedCommands(catalogue.value, query.value, recentIds.value, { page: props.context.active_tab, appended: sources.searchCommands.value }));
const placeholder = computed(() => page.value?.entry?.placeholder ?? (page.value ? 'Filter…' : 'Search or jump to…'));
// At the top, consecutive rows from one section share a heading; search
// results have none. A page sets its settings and destructive actions apart
// until it is filtered.
const groupedRows = computed(() => {
  const groups: Array<{ key: string; title: string; divider: boolean; rows: Array<{ row: PaletteRow; index: number }> }> = [];
  const clustered = Boolean(page.value && (page.value.entry || !query.value.trim()));
  let previous: string | null = null;
  visibleRows.value.forEach((row, index) => {
    const key = clustered ? actionCluster(row.command) : row.section ?? '';
    const last = groups.at(-1);
    if (last && key === previous) last.rows.push({ row, index });
    else groups.push({ key: `group-${groups.length}`, title: !clustered && row.section ? sectionTitle(row.section) : '', divider: clustered && groups.length > 0, rows: [{ row, index }] });
    previous = key;
  });
  return groups;
});
// In a list of choices, the current one is checked and values line up.
const choiceList = computed(() => visibleRows.value.some(row => row.command.current));
// Lists of plain choices, such as models, leave out the icon column.
const showIcons = computed(() => visibleRows.value.some(row => Boolean(rowSession(row.command) || rowProcess(row.command) || commandHarness(row.command) || commandIcon(row.command))));
const highlightedCommand = computed(() => visibleRows.value[highlighted.value]?.command ?? null);
const enterLabel = computed(() => {
  if (armedId.value) return 'Confirm';
  if (highlightedCommand.value && drillsIn(highlightedCommand.value)) return 'Open';
  return page.value?.entry?.verb ?? 'Select';
});

watch([open, query, () => visibleRows.value[highlighted.value]?.command.id, contextKey], () => {
  armedId.value = null;
}, { flush: 'sync' });

watch(open, async (isOpen) => {
  if (!isOpen) return;
  query.value = '';
  pages.value = [];
  highlighted.value = 0;
  error.value = '';
  afterClose = null;
  selectionMoved = false;
  if (loadedFor !== commandKey()) void reloadCommands();
  await nextTick();
  focusQueryInput();
});
watch(query, () => { highlighted.value = 0; selectionMoved = false; resultList.value?.scrollTo({ top: 0 }); }, { flush: 'sync' });
// A reload keeps the same command selected, or the top row if the selection
// has not moved. A new query or page has already chosen its selection.
let rankedQuery = '';
let rankedPage: PalettePage | null = null;
watch(visibleRows, (rows, previous) => {
  if (rankedQuery !== query.value || rankedPage !== page.value) {
    rankedQuery = query.value;
    rankedPage = page.value;
    return;
  }
  if (!selectionMoved) {
    highlighted.value = 0;
    return;
  }
  const selected = previous?.[highlighted.value];
  const index = rows.findIndex(row => row.key === selected?.key);
  const fallback = index >= 0 ? index : rows.findIndex(row => row.command.id === selected?.command.id);
  highlighted.value = fallback >= 0 ? fallback : 0;
});
watch(contextKey, () => {
  commands.value = [];
  pages.value = [];
  loadedFor = '';
  if (open.value) void reloadCommands();
});
watch(workbenchRevision, () => {
  if (!open.value || revisionTimer) return;
  revisionTimer = setTimeout(() => {
    revisionTimer = null;
    if (open.value) void reloadCommands();
  }, 500);
});

// Capture the shortcut before a focused terminal sends ^K to its program.
// With the palette open and empty, a second press passes ^K through.
function handleGlobalKeydown(event: KeyboardEvent): void {
  if (!((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  if (event.ctrlKey && !event.metaKey && open.value && !pages.value.length && query.value.trim() === '') {
    void sendCtrlKToTerminal();
    open.value = false;
    return;
  }
  open.value = !open.value;
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown, true);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown, true);
  if (revisionTimer) clearTimeout(revisionTimer);
  ++commandGeneration;
});

async function reloadCommands(): Promise<void> {
  const generation = ++commandGeneration;
  const key = commandKey();
  loadingCommands.value = true;
  error.value = '';
  try {
    const response = (await window.patterm.commandsList(props.context)) as { commands?: CommandDescriptor[] } | null;
    if (generation === commandGeneration) {
      commands.value = response?.commands ?? [];
      loadedFor = key;
    }
  } catch (caught) {
    if (generation === commandGeneration) error.value = caught instanceof Error ? caught.message : 'Could not load commands.';
  } finally {
    if (generation === commandGeneration) loadingCommands.value = false;
  }
}

// Escape goes back one level: out of a confirmation or a page. Only at the
// top does it close the palette.
function goBack(): boolean {
  if (armedId.value) {
    armedId.value = null;
    return true;
  }
  if (pages.value.length) {
    popPage();
    return true;
  }
  return false;
}

function handleEscapeKey(event: KeyboardEvent): void {
  if (event.isComposing || !goBack()) return;
  event.preventDefault();
  event.stopPropagation();
}

// The dialog's own Escape handling, for focus outside the palette's content.
function handleEscape(event: KeyboardEvent): void {
  if (goBack()) event.preventDefault();
}

function handleCloseAutoFocus(event: Event): void {
  const next = afterClose;
  afterClose = null;
  if (!next) return;
  event.preventDefault();
  next();
}

function handleTab(event: KeyboardEvent): void {
  if (event.shiftKey) {
    popPage();
    return;
  }
  const command = highlightedCommand.value;
  if (command && hasRowActions(command)) openPage(command);
}

function handleBackspace(event: KeyboardEvent): void {
  if (query.value || !pages.value.length) return;
  event.preventDefault();
  popPage();
}

function openPage(command: CommandDescriptor): void {
  const source = pageSource(command);
  if (!source && !command.actions?.length) return;
  const subject = pageSubject(command);
  pushPage({
    title: pageTitle(command),
    commands: command.actions ?? [],
    ...(source ? { source } : {}),
    ...(subject ? { subject } : {}),
    ...(command.id === 'page:launch' ? { entry: { placeholder: 'First message (optional)…', verb: 'Launch' } } : {})
  });
}

// Commands that need text, such as a new name, take it in the input. The page
// starts from the current value, selected so typing replaces it.
function openEntryPage(command: CommandDescriptor): void {
  const input = command.input!;
  const verb = entryVerb(command);
  pushPage({
    title: pageTitle(command),
    commands: [],
    source: () => entryCommands(command),
    entry: {
      placeholder: input.type === 'process-form' ? 'Command, like pnpm run dev' : input.type === 'timer-form' ? 'Duration and message, like 10m check the build' : input.placeholder ?? '',
      verb,
      ...(input.type === 'process-form' ? { mono: true } : {}),
      ...(input.type === 'timer-form' ? {} : { required: entryRequired(command) })
    }
  }, input.value ?? '');
}

function pushPage(next: Omit<PalettePage, 'query' | 'highlighted'>, value = ''): void {
  armedId.value = null;
  error.value = '';
  pages.value = [...pages.value, { ...next, query: query.value, highlighted: highlighted.value }];
  query.value = value;
  highlighted.value = 0;
  selectionMoved = false;
  // A list of choices opens on the current one.
  const current = visibleRows.value.findIndex(row => row.command.current);
  if (current > 0) {
    highlighted.value = current;
    selectionMoved = true;
  }
  void nextTick(() => {
    if (current > 0) scrollHighlighted();
    else resultList.value?.scrollTo({ top: 0 });
    focusQueryInput();
    if (value) queryInput.value?.select();
  });
}

function popPage(): void {
  const closed = pages.value.at(-1);
  if (!closed) return;
  pages.value = pages.value.slice(0, -1);
  query.value = closed.query;
  highlighted.value = closed.highlighted;
  selectionMoved = true;
  error.value = '';
  void nextTick(scrollHighlighted);
}

function scrollHighlighted(): void {
  resultList.value?.querySelector(`[id="${listId}-${highlighted.value}"]`)?.scrollIntoView({ block: 'nearest' });
}

function move(delta: number): void {
  const length = visibleRows.value.length;
  if (length === 0) return;
  selectionMoved = true;
  highlighted.value = (highlighted.value + delta + length) % length;
  void nextTick(scrollHighlighted);
}

function hover(index: number): void {
  selectionMoved = true;
  highlighted.value = index;
}

function runHighlighted(event: KeyboardEvent): void {
  if (event.repeat || event.isComposing) return;
  const row = visibleRows.value[highlighted.value];
  if (row) void runCommand(row.command);
}

function needsConfirmation(command: CommandDescriptor): boolean {
  return command.id === 'renderer:quit' || Boolean(command.confirmation);
}

async function runCommand(command: CommandDescriptor): Promise<void> {
  if (command.disabled || busy.value) return;
  if (command.kind === 'page') {
    openPage(command);
    return;
  }
  if (needsConfirmation(command) && armedId.value !== command.id) {
    highlighted.value = visibleRows.value.findIndex(row => row.command.id === command.id);
    selectionMoved = true;
    armedId.value = command.id;
    return;
  }
  armedId.value = null;
  if (command.result?.rendererAction === 'launchSet') {
    applyLaunchChoice(command.result);
    return;
  }
  if (command.id === 'launch:go') {
    await launch();
    return;
  }
  const required = page.value?.entry?.required;
  if (required && !query.value.trim()) {
    error.value = required;
    return;
  }
  if (command.params) {
    await execute(command, { ...command.params });
    return;
  }
  if (command.result || localCommands.value.some(item => item.id === command.id)) {
    await execute(command, {});
    return;
  }
  // Browsers cannot pick server directories, so the path is typed.
  if (command.id === 'renderer:project-create' && window.patterm.runtime === 'browser') {
    command = { ...command, id: 'project:create', input: { type: 'text', title: 'New project', placeholder: 'Project path on the server, like /srv/app' } };
  }
  if (command.input) {
    openEntryPage(command);
    return;
  }
  await execute(command, needsConfirmation(command) ? { confirmed: true } : {});
}

// Launches with the launch page's choices and its input as the first message.
async function launch(): Promise<void> {
  const harness = sources.launch.harness;
  if (!harness) return;
  await execute({ id: `spawn:agent:${harness}`, label: `Launch ${harnessLabel(harness)}`, group: 'create', kind: 'backend' }, launchParams({ ...sources.launch, prompt: query.value }));
}

function applyLaunchChoice(result: CommandRunResult): void {
  const value = result.value ?? '';
  if (result.field === 'harness') sources.chooseHarness(value);
  else if (result.field === 'presetId') sources.launch.presetId = value || null;
  else if (result.field === 'worktreeId') sources.launch.worktreeId = value || null;
  else if (result.field === 'interfaceMode' && (value === 'tui' || value === 'integrated')) sources.launch.interfaceMode = value;
  popPage();
}

// The launch page leads with the launch, then the settings it uses. Each
// setting opens its options.
function launchPageCommands(): CommandDescriptor[] {
  const launch = sources.launch;
  const presets = sources.launchPresets.value;
  const worktrees = sources.launchWorktrees.value;
  const choice = (field: NonNullable<CommandRunResult['field']>, value: string, label: string, current: boolean, hint?: string | null): CommandDescriptor => ({
    id: `launch:set:${field}:${value}`,
    label,
    ...(hint ? { hint } : {}),
    ...(current ? { current: true } : {}),
    group: 'create',
    kind: 'renderer',
    result: { rendererAction: 'launchSet', field, value }
  });
  const setting = (field: NonNullable<CommandRunResult['field']>, label: string, value: string, actions: CommandDescriptor[]): CommandDescriptor => ({ id: `launch:field:${field}`, label, hint: value, group: 'create', kind: 'page', actions });
  return [
    { id: 'launch:go', label: `Launch ${harnessLabel(launch.harness)}`, ...(query.value.trim() ? { hint: 'With this first message' } : {}), group: 'create', kind: 'backend' },
    setting('harness', 'Agent', harnessLabel(launch.harness), sources.launchHarnesses.value.map(item => choice('harness', item.harness, harnessLabel(item.harness), item.harness === launch.harness))),
    ...(presets.length ? [setting('presetId', 'Preset', presetLabel(presets.find(item => item.id === launch.presetId)), [choice('presetId', '', 'Agent default', launch.presetId === null), ...presets.map(item => choice('presetId', item.id, item.name, item.id === launch.presetId, item.model))])] : []),
    ...(worktrees.length ? [setting('worktreeId', 'Runs in', worktreeLabel(worktrees.find(item => item.id === launch.worktreeId)), [choice('worktreeId', '', 'Project directory', launch.worktreeId === null), ...worktrees.map(item => choice('worktreeId', item.id, worktreeLabel(item), item.id === launch.worktreeId))])] : []),
    setting('interfaceMode', 'Interface', interfaceLabel(launch.interfaceMode), (['integrated', 'tui'] as const).map(mode => choice('interfaceMode', mode, interfaceLabel(mode), mode === launch.interfaceMode)))
  ];
}

function pageSource(command: CommandDescriptor): (() => CommandDescriptor[]) | null {
  if (command.id === 'page:launch') return launchPageCommands;
  if (command.id === 'page:timers') return () => sources.timerCommands.value;
  if (command.id === 'page:conversations') {
    // From an open Integrated agent whose conversation is still empty, the
    // server swaps the resumed conversation in; otherwise it opens beside it.
    const session = currentSession.value;
    const processId = session?.interfaceMode === 'integrated' && !session.exitedAt ? session.processId : null;
    return () => processId ? resumeInPlace(sources.conversationCommands.value, processId) : sources.conversationCommands.value;
  }
  // A timer's actions follow it, so Pause becomes Resume once it is paused.
  if (command.id.startsWith('timer:')) return () => sources.timerCommands.value.find(item => item.id === command.id)?.actions ?? [];
  return null;
}

function timersHint(): string {
  const timers = sources.timers.value;
  const count = `${timers.length} ${timers.length === 1 ? 'timer' : 'timers'}`;
  const next = timers.find(item => item.timer.status === 'pending' && item.timer.firesAtUnixMs !== null);
  return next ? `${count} · next in ${timerRemaining(next.timer, sources.now.value)}` : count;
}

// The rows of a page that takes text, each saying what Enter does with it.
function entryCommands(command: CommandDescriptor): CommandDescriptor[] {
  const text = query.value.trim();
  const base = { id: command.id, group: command.group, kind: 'backend' };
  if (command.input?.type === 'timer-form') return timerEntryCommands(base, text);
  if (command.input?.type === 'process-form') {
    return [
      { ...base, label: text ? `Run “${text}”` : 'Run a command', params: { command: text } },
      { ...base, label: 'Run and relaunch on exit', params: { command: text, auto_restart: true } }
    ];
  }
  if (command.id.startsWith('process:rename:')) return [{ ...base, label: text ? `Rename to “${text}”` : pageTitle(command), params: { name: text } }];
  if (command.id === 'worktree:create') return [{ ...base, label: text ? `Create worktree “${text}”` : 'Create worktree', params: { name: text } }];
  if (command.id === 'worktree:link') return [{ ...base, label: text ? `Link ${text}` : 'Link worktree', params: { worktree_path: text } }];
  return [{ ...base, label: text ? `Add project ${text}` : 'Add project', params: { path: text } }];
}

// A timer reads its duration first; any words after it are what the agent
// receives when it fires.
function timerEntryCommands(base: Pick<CommandDescriptor, 'id' | 'group' | 'kind'>, text: string): CommandDescriptor[] {
  if (!text) return TIMER_PRESETS.map(([duration, label]) => ({ ...base, label, params: { duration }, iconless: true }));
  const [duration = '', ...words] = text.split(/\s+/);
  const seconds = parseDurationSeconds(duration);
  if (seconds === null || seconds <= 0) return [{ ...base, label: 'Set timer', hint: 'Start with a duration, like 10m', params: { duration: text } }];
  const message = words.join(' ');
  return [{ ...base, label: `Set timer for ${describeDuration(seconds)}`, hint: message ? `Sends “${message}”` : 'Sends the default reminder', params: { duration, ...(message ? { label: message, body: message } : {}) } }];
}

function entryVerb(command: CommandDescriptor): string {
  if (command.input?.type === 'timer-form') return 'Set timer';
  if (command.input?.type === 'process-form') return 'Run';
  if (command.id.startsWith('process:rename:')) return 'Rename';
  if (command.id === 'worktree:create') return 'Create';
  if (command.id === 'worktree:link') return 'Link';
  return 'Add';
}

function entryRequired(command: CommandDescriptor): string {
  if (command.input?.type === 'process-form') return 'Type a command to run.';
  if (command.id.startsWith('process:rename:')) return 'Type a name.';
  if (command.id === 'worktree:create') return 'Type a name for the worktree.';
  if (command.id === 'worktree:link') return 'Type the path of the worktree.';
  return 'Type the path of the project.';
}

async function execute(command: CommandDescriptor, input: Record<string, unknown>): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const result = command.result
      ?? localCommands.value.find(item => item.id === command.id)?.result
      ?? (command.id.startsWith('timer:set:') ? await setTimer(command.id.slice('timer:set:'.length), input) : null)
      ?? await window.patterm.commandsRun({ id: command.id, context: props.context, input }) as CommandRunResult;
    if (recordsRecent(command)) recentIds.value = rememberRecent(recentIds.value, command.id, storage());
    if (command.id.startsWith('spawn:agent:')) sources.rememberHarness(command.id.slice('spawn:agent:'.length));
    await handleResult(result);
    open.value = false;
  } catch (caught) {
    afterClose = null;
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}

// Timers use the same request as the timer dialog in the tab menu.
async function setTimer(ownerProcessId: string, input: Record<string, unknown>): Promise<CommandRunResult> {
  const seconds = parseDurationSeconds(typeof input.duration === 'string' ? input.duration : '');
  if (seconds === null || seconds <= 0) throw new Error('Enter a duration like 30s, 5m, or 1h.');
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  await window.patterm.timerSet({ owner_process_id: ownerProcessId, seconds, ...(label ? { label } : {}), ...(body ? { body } : {}) });
  toast.success('Timer set');
  return {};
}

async function handleResult(result: CommandRunResult): Promise<void> {
  if (result.rendererAction === 'createTodo' || result.rendererAction === 'createScratchpad') {
    const target = await createPaletteDocument(result.rendererAction === 'createTodo' ? 'todo' : 'scratchpad', props.context.active_project_id, window.patterm.call);
    emit('navigate', target);
  }
  if (result.rendererAction === 'integrated' || result.rendererAction === 'sessionContext' || result.rendererAction === 'reviewChanges') {
    const request = workspaceRequest(result);
    // The agent's own view runs these, so it has to be the one open.
    if (!request || !showsTarget(request)) throw new Error('Open this agent to use this action.');
    const send = () => { if (!sendWorkspaceRequest(request)) toast.error('Open this agent to use this action.'); };
    // Requests that open a panel wait for the palette to close.
    if (request.kind === 'integrated') send();
    else afterClose = send;
  }
  if (result.rendererAction === 'restartAssistant' && result.processId) await restartAssistant(result.processId);
  if (result.rendererAction === 'copy' && result.text) {
    await window.patterm.writeClipboardText(result.text);
    toast.success('Copied to the clipboard');
  }
  if (result.rendererAction === 'openTarget' && result.target) emit('openTarget', result.target);
  if (result.refresh) emit('refresh');
  if (result.navigate) emit('navigate', result.navigate);
  if (result.rendererAction === 'settings') emit('settings');
  if (result.rendererAction === 'usage') emit('usage');
  if (result.rendererAction === 'routines') emit('routines');
  if (result.rendererAction === 'workspaceSearch') emit('workspaceSearch', query.value);
  if (result.rendererAction === 'pickProjectDirectory') {
    const path = await window.patterm.pickDirectory();
    if (path) {
      const created = await window.patterm.commandsRun({ id: 'project:create', context: props.context, input: { path } }) as CommandRunResult;
      await handleResult(created);
    }
  }
  if (result.rendererAction === 'quit' && window.patterm.runtime !== 'browser') window.close();
}

function workspaceRequest(result: CommandRunResult): WorkspaceRequest | null {
  if (result.rendererAction === 'sessionContext' && result.sessionId) return { kind: 'session-context', sessionId: result.sessionId };
  if (result.rendererAction === 'reviewChanges' && result.sessionId && result.worktree) return { kind: 'review-changes', sessionId: result.sessionId, worktree: result.worktree };
  if (result.rendererAction !== 'integrated' || !result.processId || !result.integrated) return null;
  if (result.integrated !== 'configure') return { kind: 'integrated', processId: result.processId, action: result.integrated };
  return result.selector && result.value !== undefined ? { kind: 'integrated', processId: result.processId, action: 'configure', selector: result.selector, value: result.value } : null;
}

function showsTarget(request: WorkspaceRequest): boolean {
  return request.kind === 'integrated' ? currentSession.value?.processId === request.processId : props.context.active_session_id === request.sessionId;
}

function focusQueryInput(): void {
  queryInput.value?.focus();
}

async function sendCtrlKToTerminal(): Promise<void> {
  if (!props.context.active_terminal_id) return;
  try {
    await window.patterm.terminalInput({ process_id: props.context.active_terminal_id, text: '\u000b' });
  } catch (caught) { error.value = String(caught); }
}

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function sectionTitle(section: PaletteSection): string {
  return section === 'current' ? currentTitle.value : SECTION_TITLES[section];
}

function pageTitle(command: CommandDescriptor): string {
  if (command.id === 'page:current-actions') return currentTitle.value;
  return command.input?.title ?? command.label.replace(/…$/, '');
}

// A page for one thing starts with a line about it, such as an agent's state.
function pageSubject(command: CommandDescriptor): (() => string) | null {
  if (command.id === 'page:current-actions') {
    return () => currentSession.value ? agentSubject(currentSession.value) : currentProcess.value ? processSubject(currentProcess.value) : '';
  }
  if (command.target?.kind === 'agent') return () => { const session = rowSession(command); return session ? agentSubject(session) : ''; };
  if (command.target?.kind === 'process') return () => { const process = rowProcess(command); return process ? processSubject(process) : ''; };
  if (command.target?.kind === 'worktree') return () => displayPath(command.hint ?? '');
  if (command.id.startsWith('history:resume:')) return () => [command.harness ? harnessLabel(command.harness) : '', command.hint].filter(Boolean).join(' · ');
  // Timers count down while their page is open.
  if (command.kind === 'page' && command.id.startsWith('timer:')) return () => sources.timerCommands.value.find(item => item.id === command.id)?.hint ?? '';
  return null;
}

function agentSubject(session: SessionRecord): string {
  const worktree = session.worktreeId ? projects.value.flatMap(project => project.worktrees).find(item => item.id === session.worktreeId) : null;
  return [session.harness ? harnessLabel(session.harness) : '', sessionStatusIcon(session).label, worktree ? worktreeLabel(worktree) : ''].filter(Boolean).join(' · ');
}

function processSubject(process: ProcessRecord): string {
  const state = process.status === 'running' ? 'Running'
    : process.status === 'failed' && process.exitCode !== null ? `Failed with exit code ${process.exitCode}`
      : processStatusIcon(process).label;
  return [state, process.command === process.name ? '' : process.command].filter(Boolean).join(' · ');
}

// Rows that drill in show a chevron rather than an ellipsis.
function rowLabel(command: CommandDescriptor): string {
  return drillsIn(command) ? command.label.replace(/…$/, '') : command.label;
}

function drillsIn(command: CommandDescriptor): boolean {
  return command.kind === 'page' || Boolean(command.input) || (command.id === 'renderer:project-create' && window.patterm.runtime === 'browser');
}

// Rows for things, such as agents and conversations, describe them under the
// name. Rows for actions and settings show their value at the end.
function describesBelow(command: CommandDescriptor): boolean {
  return Boolean(command.target || command.primary || command.id.startsWith('search:') || (command.kind === 'page' && command.id.startsWith('timer:')));
}

function rowClass(row: PaletteRow, index: number): string {
  if (armedId.value === row.command.id) return 'bg-destructive/10';
  return index === highlighted.value ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50';
}

// Section headings and page titles already name the agent or process.
function rowHint(row: PaletteRow): string {
  const hint = row.command.hint ?? '';
  if (row.section === 'current' && hint === currentTitle.value) return '';
  return page.value && hint === page.value.title ? '' : hint;
}

function confirmationText(command: CommandDescriptor): string {
  const verb = command.confirmVerb ?? (command.id === 'renderer:quit' ? 'quit and stop all' : 'confirm');
  return `${command.confirmation ?? 'This stops all agents, commands, and Patterm timers across all projects.'} Press Enter again to ${verb}. Esc to cancel.`;
}

function hasRowActions(command: CommandDescriptor): boolean {
  return command.kind !== 'page' && Boolean(command.actions?.length);
}

// Rows that lead to an agent show its status.
function rowSession(command: CommandDescriptor): SessionRecord | null {
  const sessionId = command.target?.kind === 'agent' ? command.target.sessionId : command.id.startsWith('goto:') ? command.id.slice('goto:'.length) : null;
  return sessionId ? sessionsById.value.get(sessionId) ?? null : null;
}

function rowProcess(command: CommandDescriptor): ProcessRecord | null {
  return command.target?.kind === 'process' && command.target.processId ? processesById.value.get(command.target.processId) ?? null : null;
}

function commandHarness(command: CommandDescriptor): string | null {
  if (command.harness) return command.harness;
  if (command.id.startsWith('spawn:agent:')) return command.id.slice('spawn:agent:'.length);
  if (command.id === 'launch:field:harness') return sources.launch.harness || null;
  if (command.id.startsWith('launch:set:harness:')) return command.id.slice('launch:set:harness:'.length);
  return null;
}

// Project navigation rows show the project's logo.
function rowProject(command: CommandDescriptor): ProjectSummary | null {
  if (command.target?.kind !== 'project' || !command.id.startsWith('navigate:project:')) return null;
  return projects.value.find(project => project.project.id === command.target?.projectId)?.project ?? null;
}

function commandIcon(command: CommandDescriptor): Component | null {
  const id = command.id;
  if (command.iconless) return null;
  if (command.target?.kind === 'worktree') return GitBranch;
  if (command.target?.kind === 'project') return Folder;
  // Choices of a value, such as a model, are plain text.
  if (id.startsWith('integrated:configure:') || id.startsWith('launch:set:presetId:')) return null;
  if (id.startsWith('launch:set:worktreeId:')) return id === 'launch:set:worktreeId:' ? Folder : GitBranch;
  if (id === 'launch:field:worktreeId') return sources.launch.worktreeId ? GitBranch : Folder;
  if (id.startsWith('launch:set:interfaceMode:')) return id.endsWith(':tui') ? TerminalSquare : MessagesSquare;
  if (id === 'launch:field:interfaceMode') return sources.launch.interfaceMode === 'tui' ? TerminalSquare : MessagesSquare;
  if (id === 'launch:field:presetId') return SlidersHorizontal;
  if (id === 'page:launch' || id === 'launch:go') return Rocket;
  if (id.startsWith('history:resume:') && command.params?.interface_mode) return command.params.interface_mode === 'tui' ? TerminalSquare : MessagesSquare;
  if (id === 'page:conversations' || id.startsWith('history:')) return History;
  if (id.startsWith('timer:pause:')) return Pause;
  if (id.startsWith('timer:resume:')) return Play;
  if (id.startsWith('timer:cancel:')) return X;
  if (id === 'page:timers' || id.startsWith('timer:')) return Clock;
  if (id.startsWith('search:')) return Search;
  if (id.startsWith('integrated:interrupt:')) return CircleStop;
  if (id.startsWith('integrated:new:')) return MessageSquarePlus;
  if (id.startsWith('integrated:selector:')) return SELECTOR_ICONS[id.split(':').at(-1) ?? ''] ?? SlidersHorizontal;
  if (id.startsWith('renderer:review:')) return GitCompare;
  if (id.startsWith('renderer:session-context:')) return PanelRight;
  if (id.startsWith('renderer:copy:')) return Copy;
  if (id === 'page:current-actions') return Ellipsis;
  if (id.startsWith('goto:') || id.startsWith('page:subagents:') || id.startsWith('navigate:agent:') || id.startsWith('navigate:process:')) return ArrowUpRight;
  if (id.startsWith('process:rename:')) return Pencil;
  if (id.startsWith('process:restart:') || id === 'assistant:restart') return RotateCcw;
  if (id.startsWith('process:stop:')) return Square;
  if (id.startsWith('process:close')) return X;
  if (id === 'spawn:process' && command.params?.auto_restart) return RotateCcw;
  if (id.startsWith('worktree:abandon:')) return Unlink;
  if (id.startsWith('worktree:shell:')) return TerminalSquare;
  if (id === 'worktree:link') return Link;
  if (id === 'renderer:quit') return LogOut;
  if (id.endsWith(':todos') || id === 'renderer:todo-create') return ListTodo;
  if (id.endsWith(':scratchpads') || id === 'renderer:scratchpad-create') return NotebookPen;
  if (id.endsWith(':history')) return History;
  if (id.endsWith(':worktrees') || id.startsWith('worktree:')) return GitBranch;
  if (id.includes('search')) return Search;
  if (id === 'renderer:settings') return Settings;
  if (id.startsWith('navigate:project:') || id.includes('project-create') || id === 'project:create') return Folder;
  if (id.includes('terminal') || id.includes('process')) return Terminal;
  return ArrowRight;
}
</script>
