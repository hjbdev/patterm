import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue';
import { CircleDot, GitPullRequest, Link2 } from 'lucide-vue-next';
import { contextCall, useContextClock, useContextRefresh, type Page, type Reference, type Scratchpad, type SessionContext, type Todo } from '../lib/projectContext';
import { worktreeName } from '../lib/worktreeDiff';
import { useWorkbench } from './useWorkbench';
import { useWorktreeDiffTotals } from './useWorktreeDiff';

export interface LinkChanges { url: string; resource_type: 'generic' | 'issue' | 'pull_request'; identifier: string; title: string }

// Matches the service limit on worktrees linked to one session.
export const MAX_LINKED_WORKTREES = 10;

// Recently shown sessions' context, so switching back to one shows it straight
// away while a fresh read is on the way.
const CACHED_CONTEXTS = 32;
const contextCache = new Map<string, SessionContext>();

function cacheContext(key: string, value: SessionContext): void {
  contextCache.delete(key);
  contextCache.set(key, value);
  while (contextCache.size > CACHED_CONTEXTS) contextCache.delete(contextCache.keys().next().value!);
}

// The worktrees, todos, scratchpads and links attached to one agent session,
// with the mutations the session context sidebar offers.
export function useSessionContext(props: { projectId: string; sessionId: string }) {
  const now = useContextClock();
  const { projects } = useWorkbench();
  const context = ref<SessionContext | null>(null);
  const error = ref(''), busy = ref(false);
  // Picker searches; the lists reload once typing pauses.
  const todoQuery = ref(''), noteQuery = ref('');
  // The pickers list the whole project, so they are read only while open.
  const todoPickerOpen = ref(false), notePickerOpen = ref(false);
  const todos = computed(() => [...context.value?.todos.items ?? []].sort((a, b) => Number(a.status === 'completed') - Number(b.status === 'completed')));
  const scratchpads = computed(() => context.value?.scratchpads.items ?? []);
  const links = computed(() => context.value?.references.items ?? []);
  const worktrees = computed(() => context.value?.worktrees.items ?? []);
  const linkedWorktrees = computed(() => worktrees.value.filter(worktree => !worktree.own).length);
  const project = computed(() => projects.value.find(item => item.project.id === props.projectId));
  // A paired host's agent can use only that host's records, so the pickers
  // read its project there. A linked project lists both hosts' records.
  // Only a paired host's IDs contain its name, as in `workstation:session_7`, and
  // an archived session may be missing from the workbench.
  const sessionHost = computed(() => props.sessionId.includes(':') ? props.sessionId.slice(0, props.sessionId.indexOf(':')) : undefined);
  const ownerProjectId = computed(() => sessionHost.value && !project.value?.project.host
    ? project.value?.project.remotes?.find(remote => remote.host === sessionHost.value)?.projectId ?? props.projectId
    : props.projectId);
  const projectWorktrees = computed(() => (project.value?.worktrees ?? []).filter(worktree => worktree.host === sessionHost.value));
  // Picker rows; items already attached to the session are checked and disabled.
  const worktreeOptions = computed(() => projectWorktrees.value.map(worktree => ({ id: worktree.id, label: worktreeName({ branch: worktree.branch, path: worktree.worktreePath }), detail: worktree.worktreePath, selected: worktrees.value.some(item => item.id === worktree.id) })));
  const todoPicker = usePickerList(todoPickerOpen, () => contextCall<Page<Todo>>('todo_list', ownerProjectId.value, { limit: 100, query: todoQuery.value }), error);
  const notePicker = usePickerList(notePickerOpen, () => contextCall<Page<Scratchpad>>('scratchpad_list', ownerProjectId.value, { limit: 100, status: 'active', query: noteQuery.value }), error);
  const todoOptions = computed(() => todoPicker.items.value.map(todo => ({ id: todo.id, label: todo.title, selected: todos.value.some(item => item.id === todo.id) })));
  const noteOptions = computed(() => notePicker.items.value.map(note => ({ id: note.id, label: note.title, selected: scratchpads.value.some(item => item.id === note.id) })));
  const todoPickerLoaded = todoPicker.loaded, notePickerLoaded = notePicker.loaded;
  const truncated = computed(() => !!context.value && (['todos', 'scratchpads', 'references'] as const).some(key => context.value![key].total > context.value![key].items.length));
  const empty = computed(() => !!context.value && !worktrees.value.length && !todos.value.length && !scratchpads.value.length && !links.value.length);
  const { states: diffTotals, refresh: refreshDiffTotals } = useWorktreeDiffTotals(computed(() => worktrees.value.map(worktree => worktree.id)));
  let generation = 0;

  const cacheKey = () => `${props.projectId}\0${props.sessionId}`;

  async function refresh() {
    const current = ++generation;
    const key = cacheKey();
    const pickers = [todoPicker.refresh(), notePicker.refresh()];
    try {
      const result = await contextCall<SessionContext>('session_context', props.projectId, { session_id: props.sessionId, limit: 100 });
      cacheContext(key, result);
      if (generation === current) context.value = result;
    }
    catch (cause) {
      if (generation === current) error.value = String(cause);
    }
    await Promise.all(pickers);
  }

  // Resolves true when the change was saved, so callers can close their pickers.
  async function mutate(name: string, args: Record<string, unknown>): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    error.value = '';
    try {
      await contextCall(name, ownerProjectId.value, args);
      await refresh();
      return true;
    }
    catch (cause) {
      error.value = String(cause);
      void refresh();
      return false;
    }
    finally {
      busy.value = false;
    }
  }

  const session = () => ({ session_id: props.sessionId });
  const sessionTarget = () => ({ target_type: 'session', target_id: props.sessionId });
  const actions = {
    linkWorktree: (worktreeId: string) => mutate('worktree_attach', { worktree_id: worktreeId, ...session() }),
    unlinkWorktree: (worktreeId: string) => mutate('worktree_detach', { worktree_id: worktreeId, ...session() }),
    assignTodo: (todoId: string) => mutate('todo_assign', { todo_id: todoId, assignee_id: props.sessionId }),
    unassignTodo: (todoId: string) => mutate('todo_unassign', { todo_id: todoId, assignee_id: props.sessionId }),
    setTodoStatus: (todo: Todo, status: string) => mutate('todo_update', { todo_id: todo.id, revision: todo.revision, status }),
    attachScratchpad: (scratchpadId: string) => mutate('scratchpad_attach', { scratchpad_id: scratchpadId, ...session() }),
    detachScratchpad: (scratchpadId: string) => mutate('scratchpad_detach', { scratchpad_id: scratchpadId, ...session() }),
    attachLink: (url: string) => url.trim() ? mutate('reference_attach', { ...sessionTarget(), url: url.trim(), provider: 'generic', resource_type: 'generic' }) : Promise.resolve(false),
    updateLink: (link: Reference, changes: LinkChanges) => mutate('reference_update', { reference_id: link.id, revision: link.revision, ...changes }),
    detachLink: (linkId: string) => mutate('reference_detach', { ...sessionTarget(), reference_id: linkId })
  };

  watch(() => [props.projectId, props.sessionId], () => {
    context.value = contextCache.get(cacheKey()) ?? null;
    error.value = '';
    void refresh();
  }, { immediate: true });
  watch(ownerProjectId, () => {
    todoPicker.reset();
    notePicker.reset();
  });
  useContextRefresh(() => {
    void refresh();
    void refreshDiffTotals();
  });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  watch([todoQuery, noteQuery], () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void Promise.all([todoPicker.refresh(), notePicker.refresh()]), 150);
  });
  onBeforeUnmount(() => {
    clearTimeout(searchTimer);
    ++generation;
  });

  return { now, context, todos, scratchpads, links, worktrees, linkedWorktrees, worktreeOptions, todoOptions, noteOptions, todoQuery, noteQuery, todoPickerOpen, notePickerOpen, todoPickerLoaded, notePickerLoaded, diffTotals, truncated, empty, error, busy, refresh, ...actions };
}

// A picker's rows, read when it opens and again on each refresh while it is
// open. Rows from the last read stay until the next one lands.
function usePickerList<T>(open: Ref<boolean>, read: () => Promise<Page<T>>, error: Ref<string>) {
  const items = shallowRef<T[]>([]), loaded = ref(false);
  let generation = 0;
  async function refresh(): Promise<void> {
    if (!open.value) return;
    const current = ++generation;
    try {
      const page = await read();
      if (current !== generation) return;
      items.value = page.items;
      loaded.value = true;
    }
    catch (cause) {
      if (current === generation) error.value = String(cause);
    }
  }
  // Another project's rows never show, even briefly.
  function reset(): void {
    ++generation;
    items.value = [];
    loaded.value = false;
    void refresh();
  }
  watch(open, (value) => { if (value) void refresh(); });
  return { items, loaded, refresh, reset };
}

export type SessionContextState = ReturnType<typeof useSessionContext>;

export function sessionWorktreeName(worktree: { branch: string | null; worktree_path: string }): string {
  return worktreeName({ branch: worktree.branch, path: worktree.worktree_path });
}

export function linkHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  }
  catch {
    return url;
  }
}

// The short name a link is listed under: its identifier, its title, or its host.
export function linkLabel(link: Reference): string {
  return link.identifier || link.title || linkHost(link.url);
}

// Shown beside the label: the title, the host, or for a bare URL its path.
export function linkDetail(link: Reference): string {
  if (link.identifier && link.title) return link.title;
  if (link.identifier || link.title) return linkHost(link.url);
  try {
    const url = new URL(link.url);
    return `${url.pathname}${url.search}`.replace(/^\/$/, '');
  }
  catch {
    return '';
  }
}

export function linkIcon(link: Reference) {
  if (link.resource_type === 'pull_request') return GitPullRequest;
  if (link.resource_type === 'issue') return CircleDot;
  return Link2;
}
