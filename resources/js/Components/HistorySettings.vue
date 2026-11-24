<template>
  <SettingsPanel title="Conversation history" description="Patterm imports conversations from every agent CLI it finds on this host, so you can search and resume them. New conversations import automatically.">
    <SettingsSection title="Import" keywords="sources claude codex opencode antigravity" scope="history.import">
      <SettingsRow label="Import now" description="Check every agent CLI for new conversations.">
        <Button type="button" size="sm" variant="outline" :disabled="busy" @click="importNow">{{ busy ? 'Importing…' : 'Import now' }}</Button>
        <template v-if="status.batches.length || status.files.length" #below>
          <details class="text-xs">
            <summary class="cursor-pointer text-muted-foreground">Recent import results</summary>
            <div class="mt-2 space-y-1.5 rounded-md bg-black/20 p-3 text-[11px] text-muted-foreground">
              <p v-for="batch in status.batches.slice(0, 3)" :key="batch.id">{{ batch.status }} · {{ batch.conversationsImported }} conversations · {{ batch.errorCount }} errors</p>
              <p v-for="file in status.files.slice(0, 3)" :key="file.id" class="truncate text-warning" :title="file.path">{{ file.status }} · {{ file.path }}</p>
            </div>
          </details>
        </template>
      </SettingsRow>
      <SettingsRow label="Import notifications" description="Notify when imports start, complete, or fail." html-for="history-import-toasts" save-key="history.import.toasts" toggle>
        <Switch id="history-import-toasts" :model-value="draft.historyImportToasts" @update:model-value="(value) => { draft.historyImportToasts = value; void save('history.import.toasts'); }" />
      </SettingsRow>
      <SettingsRow label="Reset imported history" description="Clear imported conversations and import them again. Agent CLIs’ own history files are not touched.">
        <Button type="button" size="sm" variant="outline" class="text-destructive hover:text-destructive" :disabled="busy" @click="resetAndReimport">Reset and re-import…</Button>
      </SettingsRow>
    </SettingsSection>

    <SemanticSearchSettings />
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useAppearanceSettings } from '../Composables/useAppearanceSettings';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import SemanticSearchSettings from './SemanticSearchSettings.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';

interface HistoryStatus {
  batches: Array<{ id: string; status: string; conversationsImported: number; errorCount: number }>;
  files: Array<{ id: string; status: string; path: string }>;
}

const { draft, save } = useAppearanceSettings();
const busy = ref(false);
const error = ref('');
const status = ref<HistoryStatus>({ batches: [], files: [] });

void loadStatus();

async function loadStatus(): Promise<void> {
  status.value = (await window.patterm.call('history_import_status', {}) as HistoryStatus | null) ?? { batches: [], files: [] };
}

async function run(task: () => Promise<unknown>): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await task();
    await loadStatus();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}

function importNow(): Promise<void> {
  return run(() => window.patterm.call('history_import', { trigger: 'manual' }));
}

function resetAndReimport(): Promise<void> {
  if (!window.confirm('Clear imported conversation history and import it again? Agent CLIs’ own history files will not be touched.')) return Promise.resolve();
  return run(() => window.patterm.call('history_reset_imports', { reimport: true }));
}
</script>
