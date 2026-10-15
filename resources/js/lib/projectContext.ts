import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useWorkbench } from '../Composables/useWorkbench';
import { latestQueryData, queryClient } from './serverQuery';

export interface Reference { id: string; url: string; provider: string; resource_type: string; identifier: string | null; title: string | null; revision: number }
export interface Scratchpad { id: string; title: string; body?: string; status: 'active' | 'archived'; revision: number; total_lines?: number; created_at?: string; updated_at?: string }
export interface Todo { id: string; title: string; notes: string; status: string; priority: string; revision: number; assignments: string[]; blockers: { id: string; title: string; status: string }[]; blocked: boolean; lease: { holder_actor: string; holder_session_id: string | null; expires_at: number } | null; created_at?: string; updated_at?: string; completed_at?: string | null }
export interface Page<T> { items: T[]; total: number }
// `own` marks the worktree the session runs in; it cannot be detached.
export interface SessionWorktree { id: string; branch: string | null; worktree_path: string; repo_path: string; linked_at: string | null; own: boolean }
export interface SessionContext { todos: Page<Todo>; scratchpads: Page<Scratchpad>; references: Page<Reference>; worktrees: Page<SessionWorktree> }

export function contextCall<T>(name: string, projectId: string, args: Record<string, unknown> = {}): Promise<T> {
  return window.patterm.call(name, { project_id: projectId, ...args }) as Promise<T>;
}

// Announcements of context changes, for projects whose revision is unknown:
// one the workbench doesn't list yet, or one on an older paired host.
const contextSignal = ref(0);
let signalling = false;

// What a project's context reads depend on: the server instance and the
// context revisions of the project and of the paired hosts linked to it. A
// paired host's project linked to a local one is found among its remotes.
// Null until the workbench first loads.
export function projectContextVersion(projectId: string): string | null {
  const { projects, epoch } = useWorkbench();
  if (!epoch.value) return null;
  const project = projects.value.find((item) => item.project.id === projectId)?.project;
  const remote = project ? undefined : projects.value.flatMap((item) => item.project.remotes ?? []).find((item) => item.projectId === projectId);
  const revisions = project ? [project.contextRevision, ...(project.remotes ?? []).map((item) => item.contextRevision)] : [remote?.contextRevision];
  if (!revisions.some((revision) => revision === undefined)) return `${epoch.value}:${revisions.join(',')}`;
  if (!signalling) {
    signalling = true;
    window.patterm.onDataChanged((topics) => { if (topics.includes('context')) contextSignal.value += 1; });
  }
  return `${epoch.value}:${revisions.join(',')}:${contextSignal.value}`;
}

// A context read, cached until the project's context changes.
export function contextRead<T>(name: string, projectId: string, args: Record<string, unknown> = {}): Promise<T> {
  return queryClient.fetchQuery({
    queryKey: [name, projectId, args, projectContextVersion(projectId)],
    queryFn: () => contextCall<T>(name, projectId, args)
  });
}

// The last result of a context read, perhaps from before the latest change,
// to show while `contextRead` brings it up to date.
export function lastContextRead<T>(name: string, projectId: string, args: Record<string, unknown> = {}): T | undefined {
  return latestQueryData<T>([name, projectId, args]);
}

// Calls `refresh` when the project's context changes. The change arrives with
// the workbench, which catches up after a reconnect.
export function useContextVersion(projectId: () => string, refresh: () => void) {
  watch(() => projectContextVersion(projectId()), () => refresh());
}

export type RefreshTopic = 'context' | 'settings' | 'mcp-servers' | 'routines' | 'history' | 'updates';

export interface ContextRefreshOptions {
  // Server topics whose changes make the view stale. Defaults to context.
  topics?: readonly RefreshTopic[];
  // Also refresh when sessions or processes start, stop, appear, or disappear.
  // Exits release todo leases without a context write. Defaults to true for
  // context views.
  lifecycle?: boolean;
}

// Refreshes a view when the server announces a change to one of its topics,
// and after a reconnect, when announcements may have been missed. Bursts of
// announcements share one refresh.
export function useContextRefresh(refresh: () => void, options: ContextRefreshOptions = {}) {
  const topics = options.topics ?? ['context'];
  let unsubscribe: (() => void) | undefined;
  let connection: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    timer ??= setTimeout(() => { timer = null; refresh(); }, 50);
  };
  if (options.lifecycle ?? topics.includes('context')) {
    const { lifecycleRevision } = useWorkbench();
    watch(lifecycleRevision, schedule);
  }
  onMounted(() => {
    unsubscribe = window.patterm.onDataChanged((changed) => {
      if (changed.some((topic) => (topics as readonly string[]).includes(topic))) schedule();
    });
    // The handler first runs with the current state, which is not a reconnect.
    let state = window.patterm.connectionState?.() ?? 'connected';
    connection = window.patterm.onConnectionChanged?.((next) => {
      if (next === 'connected' && state !== 'connected') schedule();
      state = next;
    });
  });
  onBeforeUnmount(() => {
    unsubscribe?.();
    connection?.();
    if (timer) clearTimeout(timer);
  });
}

export function useContextClock() {
  const now = ref(Date.now());
  const timer = setInterval(() => { now.value = Date.now(); }, 1000);
  onBeforeUnmount(() => clearInterval(timer));
  return now;
}
