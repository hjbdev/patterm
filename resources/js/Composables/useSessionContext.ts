import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { CircleDot, GitPullRequest, Link2 } from 'lucide-vue-next';
import { contextCall, useContextClock, useContextRefresh, type Page, type Reference, type Scratchpad, type SessionContext, type Todo } from '../lib/projectContext';
import { worktreeName } from '../lib/worktreeDiff';
import { useWorkbench } from './useWorkbench';
import { useWorktreeDiffTotals } from './useWorktreeDiff';

export interface LinkChanges { url: string; resource_type: 'generic' | 'issue' | 'pull_request'; identifier: string; title: string }

// Matches the service limit on worktrees linked to one session.
export const MAX_LINKED_WORKTREES = 10;

// The worktrees, todos, scratchpads and links attached to one agent session,
// with the mutations the session context sidebar offers.
export function useSessionContext(props: { projectId: string; sessionId: string }) {
  const now = useContextClock();
  const { projects } = useWorkbench();
  const context = ref<SessionContext | null>(null), availableTodos = ref<Todo[]>([]), availableNotes = ref<Scratchpad[]>([]);
  const error = ref(''), busy = ref(false);
  // Picker searches; the lists reload once typing pauses.
  const todoQuery = ref(''), noteQuery = ref('');
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
  const todoOptions = computed(() => availableTodos.value.map(todo => ({ id: todo.id, label: todo.title, selected: todos.value.some(item => item.id === todo.id) })));
  const noteOptions = computed(() => availableNotes.value.map(note => ({ id: note.id, label: note.title, selected: scratchpads.value.some(item => item.id === note.id) })));
  const truncated = computed(() => !!context.value && (['todos', 'scratchpads', 'references'] as const).some(key => context.value![key].total > context.value![key].items.length));
  const empty = computed(() => !!context.value && !worktrees.value.length && !todos.value.length && !scratchpads.value.length && !links.value.length);
  const { states: diffTotals, refresh: refreshDiffTotals } = useWorktreeDiffTotals(computed(() => worktrees.value.map(worktree => worktree.id)));
  let generation = 0;

  async function refresh() {
    const current = ++generation;
    try {
      const [result, todoPage, notePage] = await Promise.all([
        contextCall<SessionContext>('session.context', props.projectId, { session_id: props.sessionId, limit: 100 }),
        contextCall<Page<Todo>>('todo.list', ownerProjectId.value, { limit: 100, query: todoQuery.value }),
        contextCall<Page<Scratchpad>>('scratchpad.list', ownerProjectId.value, { limit: 100, status: 'active', query: noteQuery.value })
      ]);
      if (generation !== current) return;
      context.value = result;
      availableTodos.value = todoPage.items;
      availableNotes.value = notePage.items;
    }
    catch (cause) {
      if (generation === current) error.value = String(cause);
    }
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
    linkWorktree: (worktreeId: string) => mutate('worktree.attach', { worktree_id: worktreeId, ...session() }),
    unlinkWorktree: (worktreeId: string) => mutate('worktree.detach', { worktree_id: worktreeId, ...session() }),
    assignTodo: (todoId: string) => mutate('todo.assign', { todo_id: todoId, assignee_id: props.sessionId }),
    unassignTodo: (todoId: string) => mutate('todo.unassign', { todo_id: todoId, assignee_id: props.sessionId }),
    setTodoStatus: (todo: Todo, status: string) => mutate('todo.update', { todo_id: todo.id, revision: todo.revision, status }),
    attachScratchpad: (scratchpadId: string) => mutate('scratchpad.attach', { scratchpad_id: scratchpadId, ...session() }),
    detachScratchpad: (scratchpadId: string) => mutate('scratchpad.detach', { scratchpad_id: scratchpadId, ...session() }),
    attachLink: (url: string) => url.trim() ? mutate('reference.attach', { ...sessionTarget(), url: url.trim(), provider: 'generic', resource_type: 'generic' }) : Promise.resolve(false),
    updateLink: (link: Reference, changes: LinkChanges) => mutate('reference.update', { reference_id: link.id, revision: link.revision, ...changes }),
    detachLink: (linkId: string) => mutate('reference.detach', { ...sessionTarget(), reference_id: linkId })
  };

  watch(() => [props.projectId, props.sessionId], () => {
    context.value = null;
    availableTodos.value = [];
    availableNotes.value = [];
    error.value = '';
    void refresh();
  }, { immediate: true });
  useContextRefresh(() => {
    void refresh();
    void refreshDiffTotals();
  });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  watch([todoQuery, noteQuery], () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void refresh(), 150);
  });
  onBeforeUnmount(() => {
    clearTimeout(searchTimer);
    ++generation;
  });

  return { now, context, todos, scratchpads, links, worktrees, linkedWorktrees, worktreeOptions, todoOptions, noteOptions, todoQuery, noteQuery, diffTotals, truncated, empty, error, busy, refresh, ...actions };
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
