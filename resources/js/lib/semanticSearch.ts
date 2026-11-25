import { onMounted, shallowRef } from 'vue';
import { topicChanged, topicRead, useTopicRefresh } from './serverQuery';

// Mirrors SemanticSearchState in app/Services/SemanticSearch/SemanticSearchService.ts.
export interface SemanticSearchState {
  enabled: boolean;
  model: {
    label: string;
    quantization: string;
    bytes: number;
    license: string;
    modelCardUrl: string;
    dimensions: number;
    install:
      | { status: 'absent' }
      | { status: 'downloading'; receivedBytes: number; totalBytes: number }
      | { status: 'verifying' }
      | { status: 'installed' }
      | { status: 'error'; error: string };
  };
  index: {
    state: 'off' | 'starting' | 'loading' | 'indexing' | 'waiting' | 'idle' | 'schema_missing' | 'error';
    counts: { conversations: number; indexed: number; pending: number; failed: number; passages: number; lastError: string | null } | null;
    error: string | null;
  };
  threads: number;
}

const state = shallowRef<SemanticSearchState | null>(null);
let reads = 0;

async function load(): Promise<void> {
  const read = ++reads;
  try {
    const next = await topicRead('semantic-search', ['settings_semantic_search_get'], async () => await window.patterm.call('settings_semantic_search_get', {}) as SemanticSearchState);
    if (read === reads) state.value = next;
  } catch { /* The next announcement retries. */ }
}

async function act(tool: string, args: Record<string, unknown> = {}, host?: string | null): Promise<SemanticSearchState> {
  const next = await window.patterm.call(tool, args, host ?? undefined) as SemanticSearchState;
  if (!host) {
    reads++;
    topicChanged('semantic-search');
    state.value = next;
  }
  return next;
}

export function useSemanticSearch(host?: string | null) {
  if (!host) {
    useTopicRefresh(['semantic-search'], () => void load());
    onMounted(() => { void load(); });
    return { state, refresh: load };
  }
  const remoteState = shallowRef<SemanticSearchState | null>(null);
  let remoteReads = 0;
  const refresh = async (): Promise<void> => {
    const read = ++remoteReads;
    try {
      const next = await window.patterm.call('settings_semantic_search_get', {}, host) as SemanticSearchState;
      if (read === remoteReads) remoteState.value = next;
    } catch { /* The user can retry from the panel. */ }
  };
  onMounted(() => { void refresh(); });
  return { state: remoteState, refresh };
}

export const setSemanticSearchEnabled = (enabled: boolean, host?: string | null) => act('settings_semantic_search_update', { enabled }, host);
export const installEmbeddingModel = (host?: string | null) => act('settings_semantic_search_install', {}, host);
export const cancelEmbeddingModelInstall = (host?: string | null) => act('settings_semantic_search_cancel_install', {}, host);
export const rebuildSemanticIndex = (host?: string | null) => act('settings_semantic_search_rebuild', {}, host);
export const removeEmbeddingModel = (host?: string | null) => act('settings_semantic_search_remove', { confirmed: true }, host);
