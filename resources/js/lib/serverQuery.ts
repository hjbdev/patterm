import { QueryClient, hashKey, type QueryKey } from '@tanstack/vue-query';

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

// The newest data cached under any key that starts with `prefix`, so a view
// can show what it last read while a read for the current revision runs.
// Elements are compared whole: `{ limit: 100 }` doesn't match a key with
// `{ limit: 100, query: 'x' }`.
export function latestQueryData<T>(prefix: QueryKey): T | undefined {
  const hash = hashKey(prefix);
  let latest: { data: T; at: number } | undefined;
  for (const query of queryClient.getQueryCache().findAll({ predicate: (item) => hashKey(item.queryKey.slice(0, prefix.length)) === hash })) {
    const { data, dataUpdatedAt } = query.state;
    if (data !== undefined && (!latest || dataUpdatedAt > latest.at)) latest = { data: data as T, at: dataUpdatedAt };
  }
  return latest?.data;
}

// Keys invalidated when the server announces a change to their topic, or
// after a reconnect, when announcements may have been missed.
const topicKeys: Record<string, QueryKey[]> = {
  settings: [['harness_presets']]
};

// Starts on first use, not at import: the bundler may evaluate this module
// before browser.ts installs window.patterm.
let listening = false;
function listen(): void {
  if (listening || !window.patterm) return;
  listening = true;
  const invalidate = (topics: string[]) => {
    for (const topic of topics) for (const queryKey of topicKeys[topic] ?? []) void queryClient.invalidateQueries({ queryKey });
  };
  window.patterm.onDataChanged(invalidate);
  let state = window.patterm.connectionState?.() ?? 'connected';
  window.patterm.onConnectionChanged?.((next) => {
    if (next === 'connected' && state !== 'connected') invalidate(Object.keys(topicKeys));
    state = next;
  });
}

export interface HarnessPresetSettings { presets?: unknown[] }

// Saved harness presets, read once and again after settings change.
export function harnessPresets<T extends HarnessPresetSettings>(): Promise<T | null> {
  listen();
  return queryClient.fetchQuery({ queryKey: ['harness_presets'], queryFn: async () => (await window.patterm.harnessPresets() ?? null) as T | null });
}
