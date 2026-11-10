<template>
  <SettingsPanel title="Figures">
    <template #description>Integrated agents can show charts, tables, diagrams, mockups, and questions in their replies as HTML pages, with html_render. TUI agents are not offered it. Each page runs in a sandboxed frame that cannot reach Patterm or your files.</template>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    <SettingsSection title="Agents" scope="figures">
      <SettingsRow label="Figures in replies" description="Turning this off removes html_render and html_preview from agents. Pages already in conversations still show." html-for="figures-enabled" save-key="figures.enabled" toggle>
        <Switch id="figures-enabled" :model-value="enabled ?? true" :disabled="enabled === null" @update:model-value="save" />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection list title="Templates" description="Saved pages agents fill with data instead of writing HTML each time. Agents publish them with template_publish. A version never changes once published, and every page shown keeps the version it drew.">
      <SettingsItem v-for="item in templates" :key="`${item.name}@${item.version}`" :muted="!item.latest" data-component="figure-template-version">
        <template #title>
          <span class="font-mono text-xs">{{ item.name }}</span>
          <Badge variant="secondary" class="h-4 px-1.5 text-[10px] font-medium">v{{ item.version }}</Badge>
          <Badge v-if="item.latest && item.count > 1" variant="outline" class="h-4 px-1.5 text-[10px] font-medium">Latest</Badge>
        </template>
        <template #meta>
          <span :title="new Date(item.published_at).toLocaleString()">Published by {{ publisher(item) }} {{ relativeTime(item.published_at) }}</span><template v-if="item.description"> · <span :title="item.description">{{ item.description }}</span></template>
        </template>
      </SettingsItem>
      <p v-if="templates && !templates.length" class="px-3.5 py-3 text-xs text-muted-foreground">No templates yet.</p>
    </SettingsSection>
    <FigureExamples />
  </SettingsPanel>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { autosave } from '../Composables/useSettingsAutosave';
import { relativeTime } from '../lib/format';
import { useTopicRefresh } from '../lib/serverQuery';
import { errorMessage } from '../lib/utils';
import FigureExamples from './FigureExamples.vue';
import SettingsItem from './settings/SettingsItem.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { Badge } from './ui/badge';
import { Switch } from './ui/switch';

interface TemplateVersion { name: string; version: number; description: string; published_at: string; published_by: { role: string; name: string | null } }
type ListedVersion = TemplateVersion & { latest: boolean; count: number };

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

// Every published version, newest first within each template, so the user
// sees what agents published and when.
const templates = ref<ListedVersion[] | null>(null);
async function loadTemplates(): Promise<void> {
  const { versions } = await window.patterm.call('settings_figure_templates', {}) as { versions: TemplateVersion[] };
  const counts = new Map<string, number>();
  for (const version of versions) counts.set(version.name, (counts.get(version.name) ?? 0) + 1);
  templates.value = versions.map((version, index) => ({ ...version, latest: versions[index - 1]?.name !== version.name, count: counts.get(version.name) ?? 1 }));
}

function publisher(version: TemplateVersion): string {
  const { role, name } = version.published_by;
  if (role === 'assistant') return 'the assistant';
  if (role === 'user') return 'you';
  return name ? `${role} "${name}"` : role === 'agent' ? 'an agent' : `a ${role}`;
}

useTopicRefresh(['settings'], () => { void loadTemplates().catch(() => {}); });

onMounted(async () => {
  try {
    const [figures] = await Promise.all([window.patterm.call('settings_figures_get', {}) as Promise<{ enabled: boolean }>, loadTemplates()]);
    enabled.value = figures.enabled;
  } catch (caught) {
    error.value = errorMessage(caught);
  }
});
</script>
