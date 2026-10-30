import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { QueryClient, hashKey, timeoutManager, type ManagedTimerId, type QueryKey } from '@tanstack/vue-query';
import { useWorkbench } from '../Composables/useWorkbench';

// The cache's timers, such as each entry's garbage collection, never keep a
// Node process such as a test run alive. Browsers have no unref.
const unref = <T extends ManagedTimerId>(id: T): T => {
  (id as { unref?: () => void }).unref?.();
  return id;
};
timeoutManager.setTimeoutProvider<ManagedTimerId>({
  setTimeout: (callback, delay) => unref(setTimeout(callback, delay) as ManagedTimerId),
  clearTimeout: (id) => clearTimeout(id as number | undefined),
  setInterval: (callback, delay) => unref(setInterval(callback, delay) as ManagedTimerId),
  clearInterval: (id) => clearInterval(id as number | undefined)
});

// The cache for server reads. Entries never go stale on a timer: a read's key
// carries the revision it depends on, so a change makes a new key, and topics
// without a revision invalidate their keys when the server announces them.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: 15 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false
    }
  }
});
// Mounted for the page's lifetime: a retry paused while the tab was hidden or
// offline resumes when it is shown or back online. Focus and reconnect still
// refetch nothing.
queryClient.mount();

// The newest data cached under any key that starts with `prefix`, so a view
// can show what it last read while a read for the current revision runs.
// Elements are compared whole: `{ limit: 100 }` doesn't match a key with
// `{ limit: 100, query: 'x' }`.
export function latestQueryData<T>(prefix: QueryKey): T | undefined {
  const hash = hashKey(prefix);
  let latest: { data: T; at: number } | undefined;
  for (const query of queryClient.getQueryCache().findAll({ queryKey: prefix.slice(0, 1), predicate: (item) => hashKey(item.queryKey.slice(0, prefix.length)) === hash })) {
    const { data, dataUpdatedAt } = query.state;
    if (data !== undefined && (!latest || dataUpdatedAt > latest.at)) latest = { data: data as T, at: dataUpdatedAt };
  }
  return latest?.data;
}

// Server topics announced without a revision. Each counts its announcements,
// and reconnects, after which one may have been missed. Reads are keyed by
// their topic's count, so a read that was under way when a change was
// announced can't stand in for one made after.
export type ServerTopic = 'settings' | 'mcp-servers' | 'routines' | 'history' | 'updates' | 'semantic-search' | 'browser' | 'secrets';
const SERVER_TOPICS: readonly ServerTopic[] = ['settings', 'mcp-servers', 'routines', 'history', 'updates', 'semantic-search', 'browser', 'secrets'];
const generations = Object.fromEntries(SERVER_TOPICS.map((topic) => [topic, ref(0)])) as Record<ServerTopic, Ref<number>>;

// Starts on first use, not at import: the bundler may evaluate this module
// before browser.ts installs window.patterm.
let listening = false;
function listen(): void {
  if (listening || !window.patterm) return;
  listening = true;
  window.patterm.onDataChanged?.((topics) => {
    for (const topic of SERVER_TOPICS) if (topics.includes(topic)) generations[topic].value += 1;
  });
  // As for the workbench, the first connection can open after the first
  // reads; only a later one may have missed announcements.
  let state = window.patterm.connectionState?.() ?? 'connected';
  let wasConnected = state === 'connected';
  window.patterm.onConnectionChanged?.((next) => {
    if (next === 'connected' && state !== 'connected' && wasConnected) for (const topic of SERVER_TOPICS) generations[topic].value += 1;
    if (next === 'connected') wasConnected = true;
    state = next;
  });
}

export function topicGeneration(topic: ServerTopic): number {
  listen();
  return generations[topic].value;
}

// Marks a topic changed by this client's own write, so the next read fetches
// without waiting for the server's announcement.
export function topicChanged(topic: ServerTopic): void {
  generations[topic].value += 1;
}

// When each topic read was last asked for, cached or not, so `trimQueries`
// keeps the ones in use.
const lastRead = new Map<string, number>();
let readCount = 0;
queryClient.getQueryCache().subscribe((event) => {
  if (event.type === 'removed') lastRead.delete(event.query.queryHash);
});

// A read cached until its topic next changes. `fresh` says whether a cached
// result must be read again anyway, for data that changes without an
// announcement.
export function topicRead<T>(topic: ServerTopic, key: QueryKey, read: () => Promise<T>, fresh?: (cached: T) => boolean): Promise<T> {
  const queryKey = [...key, topicGeneration(topic)];
  lastRead.set(hashKey(queryKey), ++readCount);
  return queryClient.fetchQuery({
    queryKey,
    queryFn: read,
    ...(fresh ? { staleTime: (query: { state: { data: T | undefined } }) => query.state.data !== undefined && fresh(query.state.data) ? 0 : Infinity } : {})
  });
}

const sizes = new WeakMap<object, number>();
function sizeOf(data: unknown): number {
  if (typeof data !== 'object' || data === null) return JSON.stringify(data ?? null).length;
  let size = sizes.get(data);
  if (size === undefined) sizes.set(data, size = JSON.stringify(data).length);
  return size;
}

// Topic reads named `name` that can be large, such as conversation
// transcripts, kept within a budget of entries and of characters of JSON.
// The least recently read beyond it are dropped instead of waiting out the
// cache's 15 minutes; the most recent always stays, and so do reads under way.
export function trimQueries(name: string, budget: { entries: number; size: number }): void {
  const queries = queryClient.getQueryCache().findAll({ queryKey: [name] })
    .filter((query) => query.state.data !== undefined && query.state.fetchStatus === 'idle' && query.getObserversCount() === 0)
    .sort((a, b) => (lastRead.get(b.queryHash) ?? 0) - (lastRead.get(a.queryHash) ?? 0));
  let total = 0;
  queries.forEach((query, index) => {
    total += sizeOf(query.state.data);
    if (index > 0 && (index >= budget.entries || total > budget.size)) queryClient.removeQueries({ queryKey: query.queryKey, exact: true });
  });
}

// Whether a paired host announces `topic` here. Hosts share history changes,
// and mark the records they send when they do; older hosts don't.
function hostAnnounces(host: string, topic: ServerTopic): boolean {
  return topic === 'history' && useWorkbench().projects.value.some(({ project }) => (project.host === host && project.sharesHistory)
    || project.remotes?.some((remote) => remote.host === host && remote.sharesHistory));
}

// A tool call cached until its topic next changes. A call naming a paired
// host's record, as in `workstation:project_7`, is cached only if that host
// announces the topic here; otherwise it always reads.
export function topicCall<T>(topic: ServerTopic, name: string, args: Record<string, unknown>, key: QueryKey = [name, args]): Promise<T> {
  const call = () => window.patterm.call(name, args) as Promise<T>;
  const hosts = Object.entries(args).flatMap(([field, value]) => field.endsWith('_id') && typeof value === 'string' && value.includes(':') ? [value.slice(0, value.indexOf(':'))] : []);
  return hosts.every((host) => hostAnnounces(host, topic)) ? topicRead(topic, key, call) : call();
}

// Calls `refresh` when one of the topics changes. Bursts share one refresh.
// `lifecycle` also refreshes when sessions or processes start, stop, appear
// or disappear; reads such a view makes should key on the same revision.
export function useTopicRefresh(topics: readonly ServerTopic[], refresh: () => void, options: { lifecycle?: boolean } = {}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    timer ??= setTimeout(() => { timer = null; refresh(); }, 50);
  };
  watch(() => topics.map(topicGeneration).join(), schedule);
  if (options.lifecycle) watch(useWorkbench().lifecycleRevision, schedule);
  onBeforeUnmount(() => { if (timer) clearTimeout(timer); });
}

export interface HarnessPresetSettings { presets?: unknown[] }

// Saved harness presets, read once and again after settings change.
export function harnessPresets<T extends HarnessPresetSettings>(): Promise<T | null> {
  return topicRead('settings', ['harness_presets'], async () => (await window.patterm.harnessPresets() ?? null) as T | null);
}

// The harness model catalog, read once and again after settings change.
export function harnessModels<T>(): Promise<T> {
  return topicRead('settings', ['harness_models'], async () => await window.patterm.harnessModels() as T);
}
