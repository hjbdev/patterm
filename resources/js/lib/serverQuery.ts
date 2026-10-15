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

// Counts settings changes, and reconnects, after which one may have been
// missed. Preset reads are keyed by it, so a read that was already under way
// when settings changed can't stand in for one made after.
let settingsGeneration = 0;

// Starts on first use, not at import: the bundler may evaluate this module
// before browser.ts installs window.patterm.
let listening = false;
function listen(): void {
  if (listening || !window.patterm) return;
  listening = true;
  window.patterm.onDataChanged((topics) => { if (topics.includes('settings')) settingsGeneration += 1; });
  let state = window.patterm.connectionState?.() ?? 'connected';
  window.patterm.onConnectionChanged?.((next) => {
    if (next === 'connected' && state !== 'connected') settingsGeneration += 1;
    state = next;
  });
}

export interface HarnessPresetSettings { presets?: unknown[] }

// Saved harness presets, read once and again after settings change.
export function harnessPresets<T extends HarnessPresetSettings>(): Promise<T | null> {
  listen();
  return queryClient.fetchQuery({ queryKey: ['harness_presets', settingsGeneration], queryFn: async () => (await window.patterm.harnessPresets() ?? null) as T | null });
}
