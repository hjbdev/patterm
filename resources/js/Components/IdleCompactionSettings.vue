<template>
  <SettingsPanel title="Idle compaction">
    <template #description>Compacts an idle Integrated agent once, just before its prompt cache expires. The compaction reads the conversation from the cache, so your next message starts from a short summary instead of caching the whole conversation again. Only a new turn makes the agent eligible again, and changing its model skips the compaction until the next turn.</template>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    <SettingsSection title="Agents" scope="idle_compaction">
      <SettingsRow v-for="row in rows" :key="row.harness" :label="row.label" :description="row.description" :html-for="`idle-compaction-${row.harness}`" :save-key="`idle_compaction.${row.harness}`" toggle>
        <Switch :id="`idle-compaction-${row.harness}`" :model-value="settings?.[row.harness] ?? true" :disabled="!settings" @update:model-value="save(row.harness, $event)" />
      </SettingsRow>
    </SettingsSection>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue';
import { autosave } from '../Composables/useSettingsAutosave';
import { errorMessage } from '../lib/utils';
import { loadIdleCompactionSettings, saveIdleCompactionSettings, type IdleCompactionHarness, type IdleCompactionSettings } from '../lib/idleCompaction';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { Switch } from './ui/switch';

const settings = shallowRef<IdleCompactionSettings | null>(null);
const afterMinutes = ref<Partial<Record<IdleCompactionHarness, number>>>({});
const error = ref('');

const idle = (harness: IdleCompactionHarness) => afterMinutes.value[harness] ? `After ${afterMinutes.value[harness]} minutes idle.` : '';
const rows = computed((): Array<{ harness: IdleCompactionHarness; label: string; description: string }> => [
  { harness: 'claude', label: 'Claude', description: `${idle('claude')} Claude Code keeps its cache for an hour on a subscription within its usage limits.` },
  { harness: 'codex', label: 'Codex', description: `${idle('codex')} Only on GPT-5.6 and later, which keep their cache for 30 minutes. The assistant is never compacted, because voice input that arrives during a compaction would be lost.` },
  { harness: 'opencode', label: 'OpenCode', description: `${idle('opencode')} Only on OpenAI's GPT-5.6 and later, which keep their cache for 30 minutes. Other providers, such as DeepSeek through OpenCode Go, keep theirs for hours.` }
]);

// Saves run one at a time and each sends the latest switches, so an earlier
// response can neither undo a later change here nor overwrite it on the server.
let revision = 0;
let saving: Promise<unknown> = Promise.resolve();

function save(harness: IdleCompactionHarness, enabled: boolean): void {
  if (!settings.value) return;
  settings.value = { ...settings.value, [harness]: enabled };
  const current = ++revision;
  saving = saving.then(() => autosave(`idle_compaction.${harness}`, async () => {
    const saved = await saveIdleCompactionSettings(settings.value!);
    if (current === revision) settings.value = saved;
  }));
}

onMounted(async () => {
  try {
    const loaded = await loadIdleCompactionSettings();
    settings.value = loaded.settings;
    afterMinutes.value = loaded.afterMinutes;
  } catch (caught) {
    error.value = errorMessage(caught);
  }
});
</script>
