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

async function act(tool: string, args: Record<string, unknown> = {}): Promise<void> {
  const next = await window.patterm.call(tool, args) as SemanticSearchState;
  reads++;
  topicChanged('semantic-search');
  state.value = next;
}

export function useSemanticSearch() {
  useTopicRefresh(['semantic-search'], () => void load());
  onMounted(() => { void load(); });
  return state;
}

export const setSemanticSearchEnabled = (enabled: boolean) => act('settings_semantic_search_update', { enabled });
export const installEmbeddingModel = () => act('settings_semantic_search_install');
export const cancelEmbeddingModelInstall = () => act('settings_semantic_search_cancel_install');
export const rebuildSemanticIndex = () => act('settings_semantic_search_rebuild');
export const removeEmbeddingModel = () => act('settings_semantic_search_remove', { confirmed: true });
