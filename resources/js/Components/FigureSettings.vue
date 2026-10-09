<template>
  <SettingsPanel title="Figures">
    <template #description>Integrated agents can save charts, tables, diagrams, and choices with ui_save and place them in their replies. TUI agents are not offered it. Patterm draws each one from the agent’s data, so agents never send their own markup or scripts.</template>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    <SettingsSection title="Agents" scope="figures">
      <SettingsRow label="Figures in replies" description="Turning this off removes ui_save from agents. Figures already in conversations still show." html-for="figures-enabled" save-key="figures.enabled" toggle>
        <Switch id="figures-enabled" :model-value="enabled ?? true" :disabled="enabled === null" @update:model-value="save" />
      </SettingsRow>
    </SettingsSection>
    <DrawnUiExamples />
  </SettingsPanel>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { autosave } from '../Composables/useSettingsAutosave';
import { message } from '../lib/assistant';
import DrawnUiExamples from './DrawnUiExamples.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { Switch } from './ui/switch';

const enabled = ref<boolean | null>(null);
const error = ref('');

// Saves run one at a time, so an earlier response cannot undo a later switch.
let revision = 0;
let saving: Promise<unknown> = Promise.resolve();

function save(value: boolean): void {
  enabled.value = value;
  const current = ++revision;
  saving = saving.then(() => autosave('figures.enabled', async () => {
    const saved = await window.patterm.call('settings_figures_update', { enabled: value }) as { enabled: boolean };
    if (current === revision) enabled.value = saved.enabled;
  }));
}

onMounted(async () => {
  try {
    enabled.value = (await window.patterm.call('settings_figures_get', {}) as { enabled: boolean }).enabled;
  } catch (caught) {
    error.value = message(caught);
  }
});
</script>
