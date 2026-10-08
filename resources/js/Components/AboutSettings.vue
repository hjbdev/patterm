<template>
  <SettingsPanel title="About" :description="`Patterm ${version}`">
    <SettingsSection>
      <SettingsRow label="Licence" description="Patterm is released under the MIT licence.">
        <Button type="button" size="sm" variant="ghost" class="h-7 px-2" :aria-expanded="open === 'licence'" @click="toggle('licence')">{{ open === 'licence' ? 'Hide' : 'View' }}</Button>
        <template v-if="open === 'licence'" #below><pre :class="textClass">{{ texts.licence }}</pre></template>
      </SettingsRow>
      <SettingsRow label="Third-party licences" description="Open-source components included in Patterm, and the licences they are used under.">
        <Button type="button" size="sm" variant="ghost" class="h-7 px-2" :aria-expanded="open === 'notices'" @click="toggle('notices')">{{ open === 'notices' ? 'Hide' : 'View' }}</Button>
        <template v-if="open === 'notices'" #below><pre :class="textClass">{{ texts.notices }}</pre></template>
      </SettingsRow>
      <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    </SettingsSection>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { Button } from './ui/button';

type Document = 'licence' | 'notices';

const version = __PATTERM_VERSION__;
// The notices run to hundreds of kilobytes, so both load only when opened.
const loaders: Record<Document, () => Promise<{ default: string }>> = {
  licence: () => import('../../../LICENSE?raw'),
  notices: () => import('../../../THIRD_PARTY_NOTICES.md?raw')
};
const texts = reactive<Record<Document, string>>({ licence: '', notices: '' });
const open = ref<Document | null>(null);
const error = ref('');
const textClass = 'max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] p-4 font-mono text-[11px] leading-relaxed text-muted-foreground';

async function toggle(document: Document): Promise<void> {
  if (open.value === document) {
    open.value = null;
    return;
  }
  error.value = '';
  try {
    texts[document] ||= (await loaders[document]()).default;
    open.value = document;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}
</script>
