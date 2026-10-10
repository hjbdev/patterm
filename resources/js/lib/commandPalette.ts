import type { InjectionKey } from 'vue';
import type { IntegratedControls } from './integratedConversation';
import type { SessionWorktree } from './projectContext';

// Opens the palette from pages without the top bar, such as the project list.
export const openCommandPaletteKey: InjectionKey<() => void> = Symbol('openCommandPalette');

export interface CommandRunResult {
  navigate?: { projectId?: string | undefined; tab?: string | undefined; terminalProcessId?: string | undefined; sessionId?: string | undefined; processId?: string | undefined; recordId?: string | undefined };
  refresh?: boolean;
  rendererAction?: 'settings' | 'usage' | 'routines' | 'workspaceSearch' | 'terminalSearch' | 'pickProjectDirectory' | 'quit' | 'createTodo' | 'createScratchpad'
    | 'copy' | 'integrated' | 'sessionContext' | 'reviewChanges' | 'openTarget' | 'launchSet' | 'restartAssistant';
  integrated?: 'interrupt' | 'new' | 'configure';
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
  field?: 'harness' | 'presetId' | 'worktreeId' | 'interfaceMode';
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
export function rendererCommands(projectId: string | null) {
  return [
    ...(projectId ? ['Agents', 'Todos', 'Scratchpads', 'Worktrees', 'History', 'Media'].map(label => ({
      id: `navigate:project-tab:${encodeURIComponent(projectId)}:${label.toLowerCase()}`,
      label: label === 'History' ? 'Conversation history' : label,
      group: 'navigation', kind: 'navigate',
      result: { navigate: { projectId, tab: label.toLowerCase() } }
    })) : []),
    ...(projectId ? [
      { id: 'renderer:todo-create', label: 'New todo', aliases: ['new todos'], group: 'create', kind: 'renderer', pages: ['todos'], result: { rendererAction: 'createTodo' as const } },
      { id: 'renderer:scratchpad-create', label: 'New scratchpad', aliases: ['new scratchpads', 'new note', 'create note'], group: 'create', kind: 'renderer', pages: ['scratchpads'], result: { rendererAction: 'createScratchpad' as const } }
    ] : []),
    { id: 'renderer:settings', label: 'Settings', group: 'navigation', kind: 'renderer', result: { rendererAction: 'settings' as const } },
    { id: 'renderer:usage', label: 'Usage', aliases: ['tokens', 'limits', 'quota', 'rate limits'], group: 'navigation', kind: 'renderer', result: { rendererAction: 'usage' as const } },
    { id: 'renderer:routines', label: 'Scheduled', aliases: ['routines', 'schedule', 'once', 'later', 'cron', 'recurring'], group: 'navigation', kind: 'renderer', result: { rendererAction: 'routines' as const } },
    { id: 'renderer:workspace-search', label: 'Search workspace content…', hint: 'Agents, conversations, and history', group: 'navigation', kind: 'renderer', result: { rendererAction: 'workspaceSearch' as const } }
  ];
}

// The open conversation publishes its native selectors. Each becomes a setting
// that opens its choices, placed after the agent's main actions.
export function withIntegratedSelectors(commands: CommandDescriptor[], processId: string | null, controls: IntegratedControls | null): CommandDescriptor[] {
  if (!processId || !controls?.selectors.length) return commands;
  const selectors: CommandDescriptor[] = controls.selectors.filter(selector => selector.options.length > 1).map(selector => ({
    id: `integrated:selector:${processId}:${selector.id}`,
    label: selector.label,
    hint: selector.options.find(option => option.value === selector.value)?.label ?? selector.value,
    aliases: [`Change ${selector.label.toLowerCase()}`],
    group: 'current',
    kind: 'page',
    inline: selector.id === 'model',
    actions: selector.options.map(option => ({
      id: `integrated:configure:${processId}:${selector.id}:${option.value}`,
      label: option.label,
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
  'spawn:agent:amp': 'Spawn Amp'
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
const CREATE_ORDER = ['page:launch', 'page:conversations', 'spawn:agent:', 'spawn:terminal', 'spawn:process', 'renderer:todo-create', 'renderer:scratchpad-create', 'worktree:', 'renderer:project-create'];

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
  // The agents page has its own section; other pages lift their commands.
  if (page && page !== 'agents') take('suggested', candidates.filter(command => !used.has(command) && command.pages?.includes(page)));
  for (const section of SECTION_ORDER) {
    const members = candidates.filter(command => !used.has(command) && sectionFor(command) === section);
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
  const record = await call(`patterm.${kind}.create`, { project_id: projectId, title: `Untitled ${kind}` }) as { id: string };
  return { projectId, tab: kind === 'todo' ? 'todos' : 'scratchpads', recordId: record.id };
}
