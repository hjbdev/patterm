<template>
  <SettingsSection title="Semantic search" description="Find conversations by meaning as well as by their words. The model and index stay on this host and run on its CPU." scope="history.semantic">
    <SettingsRow label="Embedding model">
      <template #description>{{ modelDescription }}</template>
      <Button v-if="install?.status === 'downloading'" type="button" size="sm" variant="outline" :disabled="busy" @click="run(cancelEmbeddingModelInstall)">Cancel</Button>
      <Button v-else-if="install?.status === 'installed'" type="button" size="sm" variant="outline" class="text-destructive hover:text-destructive" :disabled="busy" @click="remove">Remove…</Button>
      <Button v-else type="button" size="sm" variant="outline" :disabled="busy || !state || install?.status === 'verifying'" @click="run(installEmbeddingModel)">{{ install?.status === 'error' ? 'Retry' : 'Install' }}</Button>
      <template v-if="install?.status === 'downloading' || install?.status === 'error'" #below>
        <div v-if="install.status === 'downloading'" class="h-1 overflow-hidden rounded-full bg-muted" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100" aria-label="Model download">
          <div class="h-full bg-foreground/60 transition-[width] duration-300" :style="{ width: `${percent}%` }" />
        </div>
        <p v-else role="alert" class="text-xs text-destructive">{{ install.error }}</p>
      </template>
    </SettingsRow>

    <SettingsRow label="Use semantic search" description="Adds related conversations to history search and the resume picker. Keyword search keeps working while the index builds." html-for="semantic-search-enabled" toggle :disabled="!installed && !state?.enabled">
      <Switch id="semantic-search-enabled" :model-value="Boolean(state?.enabled)" :disabled="busy || (!installed && !state?.enabled)" @update:model-value="(value) => run(() => setSemanticSearchEnabled(value))" />
    </SettingsRow>

    <SettingsRow v-if="installed || counts?.indexed" label="Index">
      <template #description>{{ indexDescription }}</template>
      <Button type="button" size="sm" variant="outline" :disabled="busy || !ready" @click="rebuild">Rebuild…</Button>
      <template v-if="indexError" #below>
        <p role="alert" class="text-xs text-destructive">{{ indexError }}</p>
      </template>
    </SettingsRow>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
  </SettingsSection>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { cancelEmbeddingModelInstall, installEmbeddingModel, rebuildSemanticIndex, removeEmbeddingModel, setSemanticSearchEnabled, useSemanticSearch } from '../lib/semanticSearch';

const state = useSemanticSearch();
const busy = ref(false);
const error = ref('');

const install = computed(() => state.value?.model.install ?? null);
const installed = computed(() => install.value?.status === 'installed');
const counts = computed(() => state.value?.index.counts ?? null);
// Rebuild needs a worker that has opened the upgraded history database.
const ready = computed(() => Boolean(state.value?.enabled) && ['loading', 'indexing', 'waiting', 'idle'].includes(state.value?.index.state ?? 'off'));
const percent = computed(() => {
  const current = install.value;
  return current?.status === 'downloading' && current.totalBytes > 0 ? Math.floor((current.receivedBytes / current.totalBytes) * 100) : 0;
});

const modelDescription = computed(() => {
  const model = state.value?.model;
  if (!model) return 'Loading…';
  const name = `${model.label} (${model.quantization}, ${model.license})`;
  const current = model.install;
  if (current.status === 'downloading') return `Downloading ${name}: ${formatBytes(current.receivedBytes)} of ${formatBytes(current.totalBytes)}`;
  if (current.status === 'verifying') return `Verifying ${name}…`;
  if (current.status === 'installed') return `${name}, ${formatBytes(model.bytes)} on this host.`;
  return `Downloads ${name} from Hugging Face: ${formatBytes(model.bytes)}. Nothing is sent to an external service when you search.`;
});

const indexDescription = computed(() => {
  const value = state.value;
  if (!value) return '';
  const summary = counts.value ? `${counts.value.indexed.toLocaleString()} of ${counts.value.conversations.toLocaleString()} conversations indexed` : 'No index yet';
  const queued = counts.value?.pending ? ` · ${counts.value.pending.toLocaleString()} queued` : '';
  const failed = counts.value?.failed ? ` · ${counts.value.failed.toLocaleString()} failed, retrying later` : '';
  const phase = {
    off: 'Paused while semantic search is off.',
    starting: 'Starting…',
    loading: 'Loading the model…',
    indexing: 'Indexing in the background.',
    waiting: 'Waiting for imports to finish.',
    idle: 'Up to date.',
    schema_missing: 'Preparing conversation history…',
    error: 'Stopped after an error.'
  }[value.index.state];
  return `${summary}${queued}${failed}. ${phase}`;
});

const indexError = computed(() => state.value?.index.error ?? counts.value?.lastError ?? '');

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  try { await action(); }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); }
  finally { busy.value = false; }
}

function remove(): void {
  if (!window.confirm('Remove the embedding model and the semantic index from this host? Imported conversation history is not affected.')) return;
  void run(removeEmbeddingModel);
}

function rebuild(): void {
  if (!window.confirm('Discard the semantic index and embed all conversation history again? This runs in the background and can take hours on large histories.')) return;
  void run(rebuildSemanticIndex);
}

function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
</script>
