import type { InjectionKey } from 'vue';
import type { IntegratedControls } from './integratedConversation';
import type { SessionWorktree } from './projectContext';
import type { HarnessInstallationRecord, ProcessRecord, ProjectWorkbench, SessionRecord, WorktreeRecord } from '../types';

// Opens the palette from pages without the top bar, such as the project list.
export const openCommandPaletteKey: InjectionKey<() => void> = Symbol('openCommandPalette');

export interface CommandRunResult {
  navigate?: { projectId?: string | undefined; tab?: string | undefined; terminalProcessId?: string | undefined; sessionId?: string | undefined; processId?: string | undefined; recordId?: string | undefined };
  refresh?: boolean;
  message?: string;
  rendererAction?: 'settings' | 'usage' | 'toggleSnoozed' | 'toggleBotAgents' | 'snoozeProject' | 'routines' | 'workspaceSearch' | 'terminalSearch' | 'pickProjectDirectory' | 'quit' | 'createTodo' | 'createScratchpad' | 'newConversation'
    | 'copy' | 'integrated' | 'sessionContext' | 'reviewChanges' | 'openTarget' | 'launchSet' | 'restartAssistant';
  integrated?: 'interrupt' | 'new' | 'restart' | 'configure';
  processId?: string;
  sessionId?: string;
  name?: string;
  text?: string;
  selector?: string;
  value?: string;
  worktree?: SessionWorktree;
  // A workspace search target, such as a conversation in the history page.
  target?: { project_id: string | null; tab: string | null; terminal_process_id: string | null; conversation_id?: string | null; conversation_message_id?: string | null };
  // A launch choice to change, such as the preset.
  field?: 'harness' | 'presetId' | 'worktreeId';
}

export interface CommandDescriptor {
  id: string;
  label: string;
  hint?: string;
  confirmation?: string;
  confirmVerb?: string;
  aliases?: string[];
  group: string;
  // `page` rows open their actions instead of running.
  kind: string;
  input?: { type: 'text' | 'process-form' | 'project-form' | 'timer-form'; title: string; placeholder?: string; value?: string };
  disabled?: boolean;
  target?: { kind: 'agent' | 'process' | 'worktree' | 'project'; projectId: string; sessionId?: string; processId?: string };
  primary?: string;
  actions?: CommandDescriptor[];
  pages?: string[];
  inline?: boolean;
  result?: CommandRunResult;
  // Fixed input sent when the command runs, such as an interface mode.
  params?: Record<string, unknown>;
  // The chosen option in a list of choices, such as the current model.
  current?: boolean;
  // The agent whose icon the row shows, such as a conversation's.
  harness?: string;
  // Rows such as duration presets read better without icons.
  iconless?: boolean;
  // Listed only once the user types or has run it, such as one row per preset.
  searchOnly?: boolean;
}

export type PaletteSection = 'current' | 'recent' | 'suggested' | 'agent' | 'process' | 'create' | 'navigation' | 'worktree' | 'project' | 'search' | 'app';

export const SECTION_TITLES: Record<PaletteSection, string> = {
  current: 'Current',
  recent: 'Recent',
  suggested: 'Suggested',
  agent: 'Agents',
  process: 'Processes',
  create: 'Create',
  navigation: 'Go to',
  worktree: 'Worktrees',
  project: 'Projects',
  search: 'Workspace',
  app: 'Patterm'
};

export interface PaletteRow {
  command: CommandDescriptor;
  score: number;
  index: number;
  key: string;
  section?: PaletteSection;
}

// These destinations belong to the renderer and must remain available while
// the backend is loading, disconnected, or running an older command catalogue.
// The Personal project is not a repository, so it has no Worktrees page.
// `projectSnoozed` is whether the open project is snoozed, or null when it
// can't be, such as a paired host's. `botAgentsShown` is whether agents
// started by bots list.
export function rendererCommands(projectId: string | null, repository = true, snoozedShown = false, projectSnoozed: boolean | null = null, botAgentsShown = true) {
  return [
    ...(projectId ? ['Agents', 'Todos', 'Scratchpads', ...(repository ? ['Worktrees'] : []), 'History', 'Media'].map(label => ({
      id: `navigate:project-tab:${encodeURIComponent(projectId)}:${label.toLowerCase()}`,
      label: label === 'History' ? 'Conversation history' : label,
      group: 'navigation', kind: 'navigate',
      result: { navigate: { projectId, tab: label.toLowerCase() } }
    })) : []),
    ...(projectId ? [
      { id: 'renderer:new-conversation', label: 'New conversation', hint: 'Ctrl+N', aliases: ['new chat', 'start chat'], group: 'create', kind: 'renderer', result: { rendererAction: 'newConversation' as const } },
      { id: 'renderer:todo-create', label: 'New todo', aliases: ['new todos'], group: 'create', kind: 'renderer', pages: ['todos'], result: { rendererAction: 'createTodo' as const } },
      { id: 'renderer:scratchpad-create', label: 'New scratchpad', aliases: ['new scratchpads', 'new note', 'create note'], group: 'create', kind: 'renderer', pages: ['scratchpads'], result: { rendererAction: 'createScratchpad' as const } }
    ] : []),
    { id: 'renderer:settings', label: 'Settings', group: 'navigation', kind: 'renderer', result: { rendererAction: 'settings' as const } },
    ...(projectId && projectSnoozed !== null ? [{ id: 'renderer:project-snooze', label: projectSnoozed ? 'Wake project' : 'Snooze project…', aliases: ['snooze', 'mute project', 'quiet project'], group: 'navigation', kind: 'renderer', result: { rendererAction: 'snoozeProject' as const } }] : []),
    { id: 'renderer:toggle-snoozed', label: snoozedShown ? 'Hide snoozed agents' : 'Show snoozed agents', aliases: ['snoozed', 'snooze'], group: 'navigation', kind: 'renderer', result: { rendererAction: 'toggleSnoozed' as const } },
    { id: 'renderer:toggle-bot-agents', label: botAgentsShown ? 'Hide agents started by bots' : 'Show agents started by bots', aliases: ['bot agents', 'bot helpers', 'helpers'], group: 'navigation', kind: 'renderer', result: { rendererAction: 'toggleBotAgents' as const } },
    { id: 'renderer:usage', label: 'Usage', aliases: ['tokens', 'limits', 'quota', 'rate limits'], group: 'navigation', kind: 'renderer', result: { rendererAction: 'usage' as const } },
    { id: 'renderer:routines', label: 'Scheduled', aliases: ['routines', 'schedule', 'once', 'later', 'cron', 'recurring'], group: 'navigation', kind: 'renderer', result: { rendererAction: 'routines' as const } },
    { id: 'renderer:workspace-search', label: 'Search workspace content…', hint: 'Agents, conversations, and history', group: 'navigation', kind: 'renderer', result: { rendererAction: 'workspaceSearch' as const } }
  ];
}

// Harnesses name reasoning selectors differently (effort, variant, thought_level).
const REASONING_ALIASES = ['Effort', 'Reasoning', 'Thinking'];
const FALLBACK_REASONING_SELECTORS = new Set(['effort', 'variant', 'thought_level']);
function selectorAliases(selectorId: string, controls: IntegratedControls): string[] {
  const reasoningId = controls.capabilities?.selectors.reasoning;
  if (reasoningId ? selectorId === reasoningId : FALLBACK_REASONING_SELECTORS.has(selectorId)) return REASONING_ALIASES;
  return [];
}

// The open conversation publishes its native selectors. Each becomes a setting
// that opens its choices, placed after the agent's main actions.
export function withIntegratedSelectors(commands: CommandDescriptor[], processId: string | null, controls: IntegratedControls | null): CommandDescriptor[] {
  if (!processId || !controls?.selectors.length) return commands;
  const selectors: CommandDescriptor[] = controls.selectors.filter(selector => selector.options.length > 1).map(selector => ({
    id: `integrated:selector:${processId}:${selector.id}`,
    label: selector.label,
    hint: selector.options.find(option => option.value === selector.value)?.label ?? selector.value,
    aliases: [selector.label, ...selectorAliases(selector.id, controls)].flatMap(name => [name, `Change ${name.toLowerCase()}`]),
    group: 'current',
    kind: 'page',
    inline: true,
    actions: selector.options.map(option => ({
      id: `integrated:configure:${processId}:${selector.id}:${option.value}`,
      label: option.label,
      ...(option.description ? { hint: option.description } : {}),
      ...(option.value === selector.value ? { current: true } : {}),
      group: 'current',
      kind: 'renderer',
      result: { rendererAction: 'integrated' as const, integrated: 'configure' as const, processId, selector: selector.id, value: option.value }
    }))
  }));
  const rename = commands.findIndex(command => command.group === 'current' && command.id.startsWith('process:rename:'));
  if (rename < 0) return commands;
  return [...commands.slice(0, rename), ...selectors, ...commands.slice(rename)];
}

export type ActionCluster = 'main' | 'settings' | 'danger';

// Actions pages set settings and destructive actions apart from the rest.
export function actionCluster(command: CommandDescriptor): ActionCluster {
  if (/^(integrated:selector|launch:field):/.test(command.id)) return 'settings';
  if (/^(process:close|worktree:abandon|timer:cancel)/.test(command.id)) return 'danger';
  return 'main';
}

const spawnLabels: Record<string, string> = {
  'spawn:agent:claude': 'Spawn Claude',
  'spawn:agent:codex': 'Spawn Codex',
  'spawn:agent:opencode': 'Spawn OpenCode',
  'spawn:agent:agy': 'Spawn Antigravity',
};

// Groups from older backends map onto the current sections.
const SECTION_FOR_GROUP: Record<string, PaletteSection> = {
  current: 'current', focused: 'current',
  agent: 'agent', open: 'agent',
  process: 'process',
  create: 'create', spawn: 'create',
  navigation: 'navigation', settings: 'navigation',
  worktree: 'worktree',
  project: 'project',
  search: 'search',
  app: 'app', quit: 'app'
};

const SECTION_ORDER: PaletteSection[] = ['agent', 'process', 'create', 'navigation', 'worktree', 'project', 'app'];
// Ties in search results follow this order.
const RESULT_ORDER: PaletteSection[] = ['current', 'agent', 'process', 'create', 'navigation', 'worktree', 'project', 'search', 'app'];

// Rows shown per section before typing. Searching reaches the rest.
const SECTION_LIMITS: Partial<Record<PaletteSection, number>> = { recent: 5, suggested: 5, agent: 25, process: 10, worktree: 8, project: 10 };

const INLINE_FALLBACK = 5;

// Agents come first among things to create, then terminals and records.
const CREATE_ORDER = ['renderer:new-conversation', 'page:launch', 'page:conversations', 'spawn:agent:', 'spawn:preset:', 'spawn:terminal', 'spawn:process', 'renderer:todo-create', 'renderer:scratchpad-create', 'worktree:', 'renderer:project-create'];

export interface RankOptions {
  // The workbench page, such as todos, used to rank commands made for it.
  page?: string | null;
  // Keep the given order and skip sections, as in an actions page.
  flat?: boolean;
  // Rows ranked elsewhere, such as workspace search results, listed after the
  // matching commands.
  appended?: CommandDescriptor[];
}

export function rankedCommands(items: CommandDescriptor[], query: string, recentIds: string[] = [], options: RankOptions = {}): PaletteRow[] {
  const text = query.trim().toLowerCase();
  const contentSearch = items.find(command => command.id === 'renderer:workspace-search' && !command.disabled);
  const candidates = items.filter(command => !command.disabled && command !== contentSearch)
    .map(command => spawnLabels[command.id] ? { ...command, label: spawnLabels[command.id]!, hint: '' } : command);
  const rows: PaletteRow[] = !text
    ? options.flat
      ? candidates.map((command, index) => ({ command, score: 1, index, key: `${command.id}:${index}` }))
      : sectionedRows(candidates, recentIds, options.page ?? null, contentSearch)
    : candidates
      .map((command, index) => ({ command, score: scoreCommand(command, text), index, key: `${command.id}:${index}` }))
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score
        || pageRank(a.command, options.page) - pageRank(b.command, options.page)
        || recentRank(a.command.id, recentIds) - recentRank(b.command.id, recentIds)
        || groupRank(a.command.group) - groupRank(b.command.group)
        || a.index - b.index)
      .slice(0, 49);
  if (text) {
    for (const command of options.appended ?? []) rows.push({ command, score: 0, index: rows.length, key: `appended:${command.id}:${rows.length}`, section: sectionFor(command) });
  }
  // Searching always ends with the full-text search for the same words.
  if (contentSearch && (text || options.flat)) rows.push({ command: contentSearch, score: 0, index: items.indexOf(contentSearch), key: contentSearch.id });
  return rows;
}

function sectionedRows(candidates: CommandDescriptor[], recentIds: string[], page: string | null, contentSearch: CommandDescriptor | undefined): PaletteRow[] {
  const rows: PaletteRow[] = [];
  const used = new Set<CommandDescriptor>();
  const add = (command: CommandDescriptor, section: PaletteSection) => {
    rows.push({ command, score: 1, index: rows.length, key: `${section}:${command.id}:${rows.length}`, section });
    used.add(command);
  };

  // The current item's main actions, then a page with all of them.
  const current = candidates.filter(command => sectionFor(command) === 'current');
  const inline = current.some(command => command.inline) ? current.filter(command => command.inline) : current.slice(0, INLINE_FALLBACK);
  for (const command of inline) add(command, 'current');
  if (current.length > inline.length) {
    add({ id: 'page:current-actions', label: 'More actions…', hint: `${current.length - inline.length} more`, group: 'current', kind: 'page', actions: current }, 'current');
    for (const command of current) used.add(command);
  }

  const take = (section: PaletteSection, members: CommandDescriptor[]) => {
    for (const command of members.slice(0, SECTION_LIMITS[section] ?? members.length)) add(command, section);
  };
  take('recent', recentIds.flatMap(id => candidates.find(command => command.id === id && !used.has(command)) ?? []));
  const listed = candidates.filter(command => !command.searchOnly);
  // The agents page has its own section; other pages lift their commands.
  if (page && page !== 'agents') take('suggested', listed.filter(command => !used.has(command) && command.pages?.includes(page)));
  for (const section of SECTION_ORDER) {
    const members = listed.filter(command => !used.has(command) && sectionFor(command) === section);
    take(section, section === 'create' ? members.sort((a, b) => createRank(a) - createRank(b)) : members);
    if (section === 'navigation' && contentSearch) add(contentSearch, 'navigation');
  }
  return rows;
}

// Recent items repeat well: destinations and creation, not one-off actions on
// a particular agent or process.
export function recordsRecent(command: CommandDescriptor): boolean {
  if (command.confirmation || command.kind === 'page' || sectionFor(command) === 'current') return false;
  return !/^(process|integrated|goto|page|timer|history|search|launch|worktree:abandon|renderer:(quit|copy|set-timer|review|session-context))(:|$)/.test(command.id);
}

const RECENT_KEY = 'patterm.palette.recent';
const RECENT_LIMIT = 20;

export function readRecentIds(storage: Pick<Storage, 'getItem'> | undefined): string[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(recentIds: string[], id: string, storage: Pick<Storage, 'setItem'> | undefined): string[] {
  const next = [id, ...recentIds.filter(item => item !== id)].slice(0, RECENT_LIMIT);
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* Recent items still last until reload. */ }
  return next;
}

function createRank(command: CommandDescriptor): number {
  const index = CREATE_ORDER.findIndex(prefix => command.id.startsWith(prefix));
  return index < 0 ? CREATE_ORDER.length : index;
}

function sectionFor(command: CommandDescriptor): PaletteSection {
  return SECTION_FOR_GROUP[command.group] ?? 'app';
}

function pageRank(command: CommandDescriptor, page: string | null | undefined): number {
  return page && command.pages?.includes(page) ? 0 : 1;
}

function recentRank(id: string, recentIds: string[]) {
  const index = recentIds.indexOf(id);
  return index < 0 ? recentIds.length : index;
}

function groupRank(group: string) {
  const index = RESULT_ORDER.indexOf(SECTION_FOR_GROUP[group] ?? 'app');
  return index < 0 ? RESULT_ORDER.length : index;
}

function scoreCommand(command: CommandDescriptor, needle: string): number {
  if (!needle) return 1;
  if (command.id === 'renderer:quit') return command.label.toLowerCase().startsWith(needle) ? 1000 + needle.length : 0;
  const labels = [command.label, ...(command.aliases ?? [])];
  const aliases = labels.flatMap(label => {
    const match = /^(new|create|spawn) (.+)$/i.exec(label);
    return match ? ['new', 'create', 'spawn'].map(verb => `${verb} ${match[2]}`) : [];
  });
  return Math.max(...[...labels, ...aliases].map(label => scoreLabel(label.toLowerCase(), needle)), (command.hint ?? '').toLowerCase().includes(needle) ? 100 + needle.length : 0);
}

function scoreLabel(label: string, needle: string): number {
  if (label.startsWith(needle)) return 1000 + needle.length;
  if (wordBoundaryIndex(label, needle) >= 0) return 500 + needle.length;
  if (label.includes(needle)) return 250 + needle.length;
  return scatteredInWord(label, needle) ? 10 * needle.length : 0;
}

function wordBoundaryIndex(value: string, needle: string): number {
  let index = value.indexOf(needle);
  while (index >= 0) {
    if (index === 0 || ' -_:./'.includes(value[index - 1] ?? '')) return index;
    index = value.indexOf(needle, index + 1);
  }
  return -1;
}

// Letters spread across several words match too much: "stop" would find
// "Switch to PAT-95". Abbreviations still work inside one word.
function scatteredInWord(value: string, needle: string): boolean {
  if (/\s/.test(needle)) return false;
  return value.split(/\s+/).some(word => scattered(word, needle));
}

function scattered(value: string, needle: string): boolean {
  let offset = 0;
  for (const char of value) {
    if (char === needle[offset]) offset++;
    if (offset === needle.length) return true;
  }
  return false;
}


export async function createPaletteDocument(
  kind: 'todo' | 'scratchpad',
  projectId: string | null,
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>
) {
  if (!projectId) throw new Error('Select a project first.');
  const record = await call(`${kind}_create`, { project_id: projectId, title: `Untitled ${kind}` }) as { id: string };
  return { projectId, tab: kind === 'todo' ? 'todos' : 'scratchpads', recordId: record.id };
}

// Decodes navigation command IDs on the client so switching agents, processes,
// projects, or tabs never waits on a backend round trip.
export function resolveNavigateCommand(id: string): CommandRunResult | null {
  if (!id.startsWith('navigate:')) return null;
  const parts = id.split(':');
  try {
    const [, kind, project, tail] = parts.map((part) => decodeURIComponent(part));
    if (kind === 'project' && project) return { navigate: { projectId: project } };
    if (kind === 'project-tab' && project && tail) return { navigate: { projectId: project, tab: tail } };
    if (kind === 'terminal' && project && tail) return { navigate: { projectId: project, terminalProcessId: tail } };
    if (kind === 'agent' && project && tail) return { navigate: { projectId: project, sessionId: tail } };
    if (kind === 'process' && project && tail) return { navigate: { projectId: project, processId: tail } };
  } catch {
    return null;
  }
  return null;
}

export interface PalettePresetInfo {
  id: string;
  harness: string;
  name: string;
  model: string | null;
  reasoning: string | null;
}

export interface PalettePresetSettings {
  presets: readonly PalettePresetInfo[];
  defaultPresetIdByHarness: Record<string, string | null | undefined>;
}

export interface PaletteWorkbenchContext {
  active_project_id: string | null;
  active_terminal_id: string | null;
  active_tab: string | null;
  active_session_id?: string | null;
  active_process_id?: string | null;
}

export interface PaletteWorkbenchInput {
  projects: readonly ProjectWorkbench[];
  harnesses: readonly HarnessInstallationRecord[];
  context: PaletteWorkbenchContext;
  presets?: PalettePresetSettings | null;
  sessionWorktrees?: readonly SessionWorktree[];
  assistantProject?: ProjectWorkbench | null;
  botProjects?: readonly ProjectWorkbench[];
}

const PALETTE_HARNESS_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  agy: 'Antigravity'
};

const PALETTE_PROCESS_STATUS_LABELS: Record<string, string> = {
  stopped: 'Stopped',
  exited: 'Exited',
  failed: 'Failed'
};

const PALETTE_RESPONDING = new Set(['working', 'thinking', 'permission', 'question']);
const enc = encodeURIComponent;

// Builds the workbench portion of the command catalogue synchronously from the
// renderer's live workbench state, so the palette opens immediately with zero
// round trips even while the backend is busy.
export function workbenchPaletteCommands(input: PaletteWorkbenchInput): CommandDescriptor[] {
  const listed = input.projects.filter((project) => project.project.kind !== 'bots' && project.project.kind !== 'assistant');
  if (!listed.length && !input.harnesses.length && !input.assistantProject && !input.botProjects?.length) return [];
  const activeProject = listed.find((project) => project.project.id === input.context.active_project_id) ?? null;
  const current = paletteCurrentTarget(activeProject, input.context);
  const orderedProjects = activeProject ? [activeProject, ...listed.filter((project) => project !== activeProject)] : listed;
  const commands: CommandDescriptor[] = [];

  if (activeProject && current) {
    if (current.kind === 'process') commands.push(...paletteProcessActions(activeProject.project.id, current.process, true));
    else commands.push(...paletteAgentActions(activeProject, current.session, current.processId, { current: true, worktrees: input.sessionWorktrees ?? [] }));
  }
  for (const project of orderedProjects) commands.push(...paletteAgentRows(project, activeProject, current));
  for (const project of orderedProjects) commands.push(...paletteProcessRows(project, activeProject, current));
  if (activeProject) {
    const presets = activeProject.project.host ? null : input.presets ?? null;
    commands.push(...paletteCreateCommands(input.harnesses, presets, activeProject));
    commands.push(...paletteWorktreeRows(activeProject));
  }
  commands.push(
    { id: 'renderer:project-create', label: 'New project', hint: 'Register a local project directory', group: 'create', kind: 'renderer', result: { rendererAction: 'pickProjectDirectory' } },
    ...paletteProjectRows(listed, activeProject)
  );

  const assistantRestart = paletteAssistantRestartCommand(input.assistantProject ?? null);
  if (assistantRestart) commands.push(assistantRestart);
  const restartAll = paletteRestartAgentsCommand(listed);
  if (restartAll) commands.push(restartAll);

  const allLocalProjects = [...listed, ...(input.botProjects ?? []), ...(input.assistantProject ? [input.assistantProject] : [])];
  const confirmation = paletteQuitConfirmation(allLocalProjects);
  commands.push({
    id: 'renderer:quit',
    label: 'Quit Patterm',
    hint: 'Stop agents, commands, and timers on this machine',
    ...(confirmation ? { confirmation } : {}),
    confirmVerb: 'quit and stop all',
    group: 'app',
    kind: 'renderer'
  });

  return commands;
}

// Combines live client-side workbench commands with server-only additions (such
// as finished subagents and the authoritative Quit confirmation).
export function mergePaletteCommands(workbench: readonly CommandDescriptor[], server: readonly CommandDescriptor[]): CommandDescriptor[] {
  if (!workbench.length) return [...server];
  if (!server.length) return [...workbench];

  const serverById = new Map(server.map((command) => [command.id, command]));
  const workbenchIds = new Set(workbench.map((command) => command.id));
  const merged = workbench.map((command) => {
    if (command.id === 'renderer:quit' || command.id === 'assistant:restart') {
      return serverById.get(command.id) ?? command;
    }
    return command;
  });

  const serverReviews = server.filter((command) => command.id.startsWith('renderer:review:') && !workbenchIds.has(command.id));
  if (serverReviews.length) {
    const interruptIndex = merged.findIndex((command) => command.group === 'current' && command.id.startsWith('integrated:interrupt:'));
    const insertAt = interruptIndex >= 0 ? interruptIndex + 1 : merged.findIndex((command) => command.group === 'current');
    if (insertAt >= 0) merged.splice(insertAt, 0, ...serverReviews);
    else merged.unshift(...serverReviews);
    for (const review of serverReviews) workbenchIds.add(review.id);
  }

  for (const command of server) {
    if (workbenchIds.has(command.id)) continue;
    if (command.id.startsWith('process:close-finished:') || command.id === 'assistant:restart') {
      merged.push(command);
      workbenchIds.add(command.id);
    }
  }
  return merged;
}

// Human-friendly progress label shown only when a background command takes
// longer than a brief threshold.
export function actionProgressLabel(command: CommandDescriptor): string {
  const id = command.id;
  if (id.startsWith('process:close-finished:')) return 'Closing finished subagents…';
  if (id.startsWith('process:close:')) return 'Closing…';
  if (id.startsWith('process:stop:')) return 'Stopping process…';
  if (id.startsWith('process:restart:')) return 'Restarting process…';
  if (id.startsWith('process:rename:')) return 'Renaming…';
  if (id === 'spawn:terminal' || id.startsWith('worktree:shell:')) return 'Opening terminal…';
  if (id === 'spawn:process') return 'Starting process…';
  if (id.startsWith('history:resume:')) return 'Resuming conversation…';
  if (id === 'worktree:create') return 'Creating worktree…';
  if (id === 'worktree:link') return 'Linking worktree…';
  if (id.startsWith('worktree:abandon:')) return 'Unlinking worktree…';
  if (id === 'project:create') return 'Adding project…';
  if (id.startsWith('timer:set:')) return 'Setting timer…';
  if (id.startsWith('timer:pause:')) return 'Pausing timer…';
  if (id.startsWith('timer:resume:')) return 'Resuming timer…';
  if (id.startsWith('timer:cancel:')) return 'Cancelling timer…';
  if (id === 'app:restart-agents') return 'Restarting agents…';
  if (id === 'renderer:todo-create') return 'Creating todo…';
  if (id === 'renderer:scratchpad-create') return 'Creating scratchpad…';
  if (id === 'assistant:restart') return 'Restarting assistant…';
  return `${command.label.replace(/…$/, '')}…`;
}

type PaletteCurrentTarget =
  | { kind: 'agent'; session: SessionRecord; processId: string }
  | { kind: 'process'; process: ProcessRecord };

function paletteCurrentTarget(project: ProjectWorkbench | null, context: PaletteWorkbenchContext): PaletteCurrentTarget | null {
  if (!project) return null;
  const session = context.active_session_id ? project.projectSessions.find((candidate) => candidate.id === context.active_session_id) : undefined;
  if (session?.processId) return { kind: 'agent', session, processId: session.processId };
  const process = context.active_process_id ? project.processes.find((candidate) => candidate.id === context.active_process_id && candidate.status !== 'closed') : undefined;
  if (process) return { kind: 'process', process };
  if (!context.active_terminal_id) return null;
  const procs = project.processes.filter((proc) => proc.ptyProcessId === context.active_terminal_id || proc.id === context.active_terminal_id);
  const proc = procs.find((candidate) => candidate.status === 'running') ?? procs[0];
  return proc ? { kind: 'process', process: proc } : null;
}

function paletteLiveAgents(project: ProjectWorkbench): SessionRecord[] {
  const live = project.projectSessions.filter((session) => !session.exitedAt && session.processId);
  const ids = new Set(live.map((session) => session.id));
  const children = new Map<string | null, SessionRecord[]>();
  for (const session of live) {
    const parentId = session.parentId && ids.has(session.parentId) ? session.parentId : null;
    const group = children.get(parentId);
    if (group) group.push(session);
    else children.set(parentId, [session]);
  }
  const ordered: SessionRecord[] = [];
  const visit = (parentId: string | null): void => {
    for (const session of children.get(parentId) ?? []) {
      ordered.push(session);
      visit(session.id);
    }
  };
  visit(null);
  return ordered;
}

function paletteAgentLabel(session: SessionRecord): string {
  return session.title ?? session.displayName ?? session.lastTitle ?? session.harness ?? 'agent';
}

function paletteWorktreeName(branch: string | null, path: string): string {
  return branch ?? path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

function paletteCountLabel(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

function paletteListNames(names: string[]): string {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown}, and ${names.length - 3} more` : shown;
}

function paletteRunningDescendants(project: ProjectWorkbench, processId: string): { agents: SessionRecord[]; processes: ProcessRecord[] } {
  const owners = new Set([processId]);
  const agents: SessionRecord[] = [];
  const sessionsByProcess = new Map(project.projectSessions.flatMap((session) => session.processId ? [[session.processId, session] as const] : []));
  const pending = [processId];
  while (pending.length) {
    const ownerId = pending.shift()!;
    const owner = sessionsByProcess.get(ownerId);
    if (!owner) continue;
    for (const child of project.projectSessions) {
      if (child.parentId !== owner.id || !child.processId || owners.has(child.processId)) continue;
      owners.add(child.processId);
      pending.push(child.processId);
      if (!child.exitedAt) agents.push(child);
    }
  }
  const processes = project.processes.filter((process) => process.status === 'running' && process.parentProcessId !== null && owners.has(process.parentProcessId));
  return { agents, processes };
}

function paletteCloseConfirmation(project: ProjectWorkbench, processId: string): Pick<CommandDescriptor, 'confirmation' | 'confirmVerb'> {
  const { agents, processes } = paletteRunningDescendants(project, processId);
  if (!agents.length && !processes.length) return { confirmation: 'This stops the agent.', confirmVerb: 'close it' };
  const parts = [agents.length ? paletteCountLabel(agents.length, 'subagent') : '', processes.length ? paletteCountLabel(processes.length, 'process', 'processes') : ''].filter(Boolean).join(' and ');
  const names = [...agents.map(paletteAgentLabel), ...processes.map((process) => process.name)];
  return { confirmation: `Also closes ${parts}: ${paletteListNames(names)}.`, confirmVerb: 'close all of them' };
}

function paletteGotoCommand(projectId: string, session: SessionRecord): CommandDescriptor {
  return { id: `goto:${session.id}`, label: paletteAgentLabel(session), group: 'current', kind: 'navigate', result: { navigate: { projectId, sessionId: session.id } } };
}

function paletteAgentActions(
  project: ProjectWorkbench,
  session: SessionRecord,
  processId: string,
  extra: { current?: boolean; worktrees?: readonly SessionWorktree[] } = {}
): CommandDescriptor[] {
  const projectId = project.project.id;
  const name = paletteAgentLabel(session);
  const group = extra.current ? 'current' : 'agent';
  const live = !session.exitedAt;
  const commands: CommandDescriptor[] = [];

  if (!extra.current) {
    commands.push({ id: `navigate:agent:${enc(projectId)}:${enc(session.id)}`, label: 'Switch to agent', hint: name, group, kind: 'navigate', result: { navigate: { projectId, sessionId: session.id } } });
  }
  if (extra.current && live && PALETTE_RESPONDING.has(session.activity)) {
    commands.push({ id: `integrated:interrupt:${processId}`, label: 'Stop response', hint: name, group, kind: 'renderer', inline: true, result: { rendererAction: 'integrated', integrated: 'interrupt', processId } });
  }
  for (const [index, worktree] of (extra.worktrees ?? []).entries()) {
    commands.push({ id: `renderer:review:${session.id}:${worktree.id}`, label: 'Review changes', hint: paletteWorktreeName(worktree.branch, worktree.worktree_path), group, kind: 'renderer', inline: index === 0, result: { rendererAction: 'reviewChanges', sessionId: session.id, worktree } });
  }
  if (extra.current && live) {
    commands.push({ id: `integrated:new:${processId}`, label: 'New conversation', hint: name, group, kind: 'renderer', inline: true, result: { rendererAction: 'integrated', integrated: 'new', processId } });
    if (session.sessionRole === 'orchestrator' && !session.host) {
      commands.push({
        id: `integrated:restart:${processId}`,
        label: 'Restart agent',
        hint: 'Resume this conversation in a new process',
        group,
        kind: 'renderer',
        inline: true,
        result: { rendererAction: 'integrated', integrated: 'restart', processId },
        ...(PALETTE_RESPONDING.has(session.activity) ? { confirmation: 'This agent is responding, and restarting stops it.', confirmVerb: 'restart it' } : {})
      });
    }
  }
  if (extra.current && !live && session.processStatus !== 'closed' && session.sessionRole === 'orchestrator' && !session.host) {
    commands.push({
      id: `integrated:restart:${processId}`,
      label: 'Restart agent',
      hint: 'Resume this conversation in a new process',
      group,
      kind: 'renderer',
      inline: true,
      result: { rendererAction: 'integrated', integrated: 'restart', processId }
    });
  }
  if (extra.current) {
    commands.push({ id: `renderer:session-context:${session.id}`, label: 'Open session context', hint: 'Worktrees, todos, scratchpads, and links', group, kind: 'renderer', inline: true, result: { rendererAction: 'sessionContext', sessionId: session.id } });
  }
  commands.push({ id: `process:rename:${processId}`, label: 'Rename agent…', hint: name, group, kind: 'backend', inline: true, input: { type: 'text', title: 'Rename agent', placeholder: 'Agent name', value: name } });
  if (live) {
    commands.push({ id: `timer:set:${processId}`, label: 'Set timer…', hint: name, group, kind: 'backend', input: { type: 'timer-form', title: 'Set timer' } });
  }
  if (extra.current) {
    const family = paletteLiveAgents(project);
    const parent = session.parentId ? family.find((candidate) => candidate.id === session.parentId) : undefined;
    if (parent) commands.push({ ...paletteGotoCommand(projectId, parent), label: 'Go to parent agent', hint: paletteAgentLabel(parent) });
    const children = family.filter((candidate) => candidate.parentId === session.id);
    if (children.length === 1) commands.push({ ...paletteGotoCommand(projectId, children[0]!), label: 'Go to subagent', hint: paletteAgentLabel(children[0]!) });
    else if (children.length) {
      commands.push({ id: `page:subagents:${session.id}`, label: 'Go to subagent…', hint: paletteCountLabel(children.length, 'subagent'), group, kind: 'page', actions: children.map((child) => paletteGotoCommand(projectId, child)) });
    }
  }
  commands.push({ id: `renderer:copy:${processId}`, label: 'Copy process ID', hint: processId, group, kind: 'renderer', result: { rendererAction: 'copy', text: processId } });
  commands.push({ id: `process:close:${processId}`, label: 'Close agent', hint: name, group, kind: 'backend', inline: true, ...paletteCloseConfirmation(project, processId) });
  return commands;
}

function paletteProcessActions(projectId: string, process: ProcessRecord, current: boolean): CommandDescriptor[] {
  const group = current ? 'current' : 'process';
  const running = process.status === 'running';
  return [
    ...(!current && running ? [{ id: `navigate:process:${enc(projectId)}:${enc(process.id)}`, label: 'Switch to process', hint: process.name, group, kind: 'navigate', result: { navigate: { projectId, processId: process.id } } } satisfies CommandDescriptor] : []),
    { id: `process:restart:${process.id}`, label: 'Restart process', hint: process.name, group, kind: 'backend', inline: true },
    ...(running ? [{ id: `process:stop:${process.id}`, label: 'Stop process', hint: process.name, group, kind: 'backend', inline: true } satisfies CommandDescriptor] : []),
    { id: `process:rename:${process.id}`, label: 'Rename process…', hint: process.name, group, kind: 'backend', inline: true, input: { type: 'text', title: 'Rename process', placeholder: 'Process name', value: process.name } },
    { id: `renderer:copy:${process.id}`, label: 'Copy process ID', hint: process.id, group, kind: 'renderer', inline: true, result: { rendererAction: 'copy', text: process.id } },
    { id: `process:close:${process.id}`, label: 'Close process', hint: process.name, confirmation: 'This stops the process.', confirmVerb: 'close it', group, kind: 'backend', inline: true }
  ];
}

function paletteAgentRows(project: ProjectWorkbench, activeProject: ProjectWorkbench | null, current: PaletteCurrentTarget | null): CommandDescriptor[] {
  const projectId = project.project.id;
  const sessions = paletteLiveAgents(project);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return sessions
    .filter((session) => !(current?.kind === 'agent' && current.session.id === session.id))
    .map((session) => {
      const parent = session.parentId ? byId.get(session.parentId) : undefined;
      const hint = [parent ? `Subagent of ${paletteAgentLabel(parent)}` : '', project === activeProject ? '' : project.project.name].filter(Boolean).join(' · ');
      return {
        id: `navigate:agent:${enc(projectId)}:${enc(session.id)}`,
        label: paletteAgentLabel(session),
        ...(hint ? { hint } : {}),
        group: 'agent',
        kind: 'navigate',
        primary: 'Switch',
        result: { navigate: { projectId, sessionId: session.id } },
        target: { kind: 'agent', projectId, sessionId: session.id, processId: session.processId! },
        actions: paletteAgentActions(project, session, session.processId!)
      } satisfies CommandDescriptor;
    });
}

function paletteProcessRows(project: ProjectWorkbench, activeProject: ProjectWorkbench | null, current: PaletteCurrentTarget | null): CommandDescriptor[] {
  const projectId = project.project.id;
  const owners = new Map(project.projectSessions.flatMap((session) => session.processId ? [[session.processId, session] as const] : []));
  return project.processes.flatMap((process) => {
    if (process.status === 'closed' || (current?.kind === 'process' && current.process.id === process.id)) return [];
    const running = process.status === 'running';
    if (running && !process.ptyProcessId) return [];
    const owner = process.parentProcessId ? owners.get(process.parentProcessId) : undefined;
    const hint = [
      running ? '' : PALETTE_PROCESS_STATUS_LABELS[process.status] ?? 'Ended',
      owner ? `Started by ${paletteAgentLabel(owner)}` : '',
      project === activeProject ? '' : project.project.name
    ].filter(Boolean).join(' · ');
    return [{
      id: running ? `navigate:process:${enc(projectId)}:${enc(process.id)}` : `process:restart:${process.id}`,
      label: process.name,
      ...(hint ? { hint } : {}),
      group: 'process',
      kind: running ? 'navigate' : 'backend',
      primary: running ? 'Switch' : 'Restart',
      ...(running ? { result: { navigate: { projectId, processId: process.id } } } : {}),
      target: { kind: 'process', projectId, processId: process.id },
      actions: paletteProcessActions(projectId, process, false)
    } satisfies CommandDescriptor];
  });
}

function paletteCreateCommands(harnesses: readonly HarnessInstallationRecord[], presets: PalettePresetSettings | null, project: ProjectWorkbench): CommandDescriptor[] {
  const available = harnesses.filter((harness) => harness.status === 'available').map((harness) => harness.harness);
  const spawnRows = available.map((harness) => {
    const preset = presets?.presets.find((candidate) => candidate.id === presets.defaultPresetIdByHarness[harness]);
    return {
      id: `spawn:agent:${harness}`,
      label: `Spawn ${PALETTE_HARNESS_LABELS[harness] ?? harness}`,
      ...(preset && preset.name.toLowerCase() !== 'default' ? { aliases: [`Spawn ${preset.name}`] } : {}),
      group: 'create',
      kind: 'backend'
    } satisfies CommandDescriptor;
  });
  const presetRows: CommandDescriptor[] = presets ? presets.presets.flatMap((preset) => {
    if (!available.includes(preset.harness) || presets.defaultPresetIdByHarness[preset.harness] === preset.id) return [];
    const harness = PALETTE_HARNESS_LABELS[preset.harness] ?? preset.harness;
    const hint = [preset.model ?? `${harness}'s own model`, preset.reasoning].filter(Boolean).join(' · ');
    return [{
      id: `spawn:preset:${preset.id}`,
      label: `Spawn ${preset.name.toLowerCase() === 'default' ? harness : preset.name}`,
      hint,
      aliases: [`Spawn ${harness} ${preset.name}`],
      harness: preset.harness,
      searchOnly: true,
      group: 'create',
      kind: 'backend'
    } satisfies CommandDescriptor];
  }) : [];
  return [
    ...spawnRows,
    ...presetRows,
    { id: 'spawn:terminal', label: 'New terminal', group: 'create', kind: 'backend' },
    { id: 'spawn:process', label: 'New process…', hint: 'Run a command in this project', group: 'create', kind: 'backend', input: { type: 'process-form', title: 'New process' } },
    { id: 'worktree:create', label: 'Create worktree', hint: project.project.name, group: 'create', kind: 'backend', pages: ['worktrees'], input: { type: 'text', title: 'Create worktree', placeholder: 'Worktree name' } },
    { id: 'worktree:link', label: 'Link worktree…', hint: 'Choose an existing worktree directory', group: 'create', kind: 'backend', pages: ['worktrees'], input: { type: 'text', title: 'Link worktree', placeholder: '/path/to/worktree' } }
  ];
}

function paletteWorktreeRows(project: ProjectWorkbench): CommandDescriptor[] {
  const projectId = project.project.id;
  return project.worktrees.map((worktree: WorktreeRecord) => ({
    id: `worktree:shell:${worktree.id}`,
    label: paletteWorktreeName(worktree.branch, worktree.worktreePath) || worktree.id,
    hint: worktree.worktreePath,
    group: 'worktree',
    kind: 'backend',
    primary: 'Open terminal',
    pages: ['worktrees'],
    target: { kind: 'worktree', projectId },
    actions: [
      { id: `worktree:shell:${worktree.id}`, label: 'Open terminal', group: 'worktree', kind: 'backend' },
      { id: `worktree:abandon:${worktree.id}`, label: 'Unlink worktree', hint: 'Keeps files and branch', group: 'worktree', kind: 'backend' }
    ]
  } satisfies CommandDescriptor));
}

function paletteProjectRows(projects: readonly ProjectWorkbench[], activeProject: ProjectWorkbench | null): CommandDescriptor[] {
  return projects
    .filter((project) => project !== activeProject)
    .map((project) => ({
      id: `navigate:project:${enc(project.project.id)}`,
      label: project.project.name,
      hint: project.project.path,
      group: 'project',
      kind: 'navigate',
      primary: 'Open',
      result: { navigate: { projectId: project.project.id } },
      target: { kind: 'project', projectId: project.project.id }
    } satisfies CommandDescriptor));
}

function paletteAssistantRestartCommand(assistantProject: ProjectWorkbench | null): CommandDescriptor | null {
  if (!assistantProject) return null;
  const session = assistantProject.projectSessions.find((candidate) => !candidate.exitedAt && candidate.processId);
  if (!session?.processId) return null;
  return {
    id: 'assistant:restart',
    label: 'Restart assistant',
    hint: 'Resume its conversation in a new process',
    group: 'app',
    kind: 'renderer',
    result: { rendererAction: 'restartAssistant', processId: session.processId },
    ...(PALETTE_RESPONDING.has(session.activity) ? { confirmation: 'The assistant is responding, and restarting stops it.', confirmVerb: 'restart it' } : {})
  };
}

function paletteRestartAgentsCommand(projects: readonly ProjectWorkbench[]): CommandDescriptor | null {
  const agents = projects.flatMap((project) => project.projectSessions)
    .filter((session) => !session.exitedAt && session.processId && !session.host && session.sessionRole === 'orchestrator');
  if (!agents.length) return null;
  const working = agents.filter((session) => session.activity !== 'idle' && session.activity !== 'error').length;
  const idle = agents.length - working;
  return {
    id: 'app:restart-agents',
    label: 'Restart all agents',
    hint: 'Resume each Integrated conversation in a new process',
    group: 'app',
    kind: 'backend',
    confirmation: `This restarts ${paletteCountLabel(idle, 'idle agent')} across all projects and resumes their conversations.${working ? ` ${paletteCountLabel(working, 'working agent')} keep${working === 1 ? 's' : ''} running.` : ''}`,
    confirmVerb: 'restart them'
  };
}

function paletteQuitConfirmation(projects: readonly ProjectWorkbench[]): string | undefined {
  const localProjects = projects.filter((project) => !project.project.host);
  const agents = new Set(localProjects.flatMap((project) => project.projectSessions.filter((session) => !session.host && !session.exitedAt && session.processId).map((session) => session.processId!)));
  const commands = new Set(localProjects.flatMap((project) => project.processes.filter((process) => !process.host && process.status === 'running' && !agents.has(process.id)).map((process) => process.id)));
  const timers = localProjects.reduce((total, project) => total + project.timers.length, 0);
  if (agents.size === 0 && commands.size === 0 && timers === 0) return undefined;
  return `This stops ${agents.size} agent${agents.size === 1 ? '' : 's'} and ${commands.size} command${commands.size === 1 ? '' : 's'} across all projects on this machine, including running sleeps and all Patterm timers. Saved conversations remain available to resume.`;
}
