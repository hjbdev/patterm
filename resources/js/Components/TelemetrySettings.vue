<template>
  <SettingsPanel title="Usage telemetry">
    <template #description>Off unless you turn it on. Patterm then sends counts of the features you use to your own PostHog project, so you can find what you never use. It sends tool, page, and component names, settings you changed from their defaults (names only), and table row counts. It never sends prompts, terminal or conversation text, file paths, or project, branch, or agent names.</template>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    <SettingsSection title="PostHog" scope="telemetry">
      <SettingsRow label="Project API key" description="Your PostHog project's key, which starts with phc_. Turning telemetry on needs one." html-for="telemetry-key" save-key="telemetry.key">
        <Input id="telemetry-key" :model-value="draft.apiKey" class="h-8 font-mono text-xs sm:max-w-sm" placeholder="phc_…" autocomplete="off" spellcheck="false" :disabled="!loaded" @update:model-value="(value) => { draft.apiKey = String(value).trim(); }" @blur="save('telemetry.key')" />
      </SettingsRow>
      <SettingsRow label="Region" html-for="telemetry-host" save-key="telemetry.host">
        <SettingsChoice id="telemetry-host" :model-value="draft.host" :options="HOST_OPTIONS" aria-label="PostHog region" segmented :disabled="!loaded" @update:model-value="(value) => { draft.host = value; void save('telemetry.host'); }" />
      </SettingsRow>
      <SettingsRow label="Send usage telemetry" description="Each time you turn it on, Patterm makes a new random ID, so earlier data can't be linked to it." html-for="telemetry-enabled" save-key="telemetry.enabled" toggle>
        <Switch id="telemetry-enabled" :model-value="draft.enabled" :disabled="!loaded || (!draft.enabled && !draft.apiKey)" @update:model-value="(value) => { draft.enabled = value; void save('telemetry.enabled'); }" />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection v-if="saved.enabled" title="Feedback" description="Say what you like or dislike. The note is sent as you write it.">
      <div class="flex flex-col gap-2 py-3">
        <Textarea v-model="note" aria-label="Feedback note" class="min-h-20 text-xs" placeholder="What works, what gets in the way…" maxlength="2000" />
        <div class="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" :disabled="sending" @click="sendFeedback('like')"><ThumbsUp class="h-3.5 w-3.5" />Like</Button>
          <Button type="button" size="sm" variant="outline" :disabled="sending" @click="sendFeedback('dislike')"><ThumbsDown class="h-3.5 w-3.5" />Dislike</Button>
          <span v-if="feedbackStatus" class="text-xs text-muted-foreground" role="status">{{ feedbackStatus }}</span>
        </div>
      </div>
    </SettingsSection>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ThumbsDown, ThumbsUp } from 'lucide-vue-next';
import { autosave } from '../Composables/useSettingsAutosave';
import { errorMessage } from '../lib/utils';
import { loadTelemetrySettings, saveTelemetrySettings, sendTelemetryFeedback, type TelemetrySettings } from '../lib/telemetry';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';

const HOST_OPTIONS = [{ value: 'us' as const, label: 'US' }, { value: 'eu' as const, label: 'EU' }];

const draft = reactive<TelemetrySettings>({ enabled: false, apiKey: '', host: 'us' });
const saved = reactive<TelemetrySettings>({ ...draft });
const loaded = ref(false);
const error = ref('');
const note = ref('');
const sending = ref(false);
const feedbackStatus = ref('');

// Saves run one at a time and each sends the latest draft.
let saving: Promise<unknown> = Promise.resolve();

function save(key: string): Promise<unknown> {
  if (!loaded.value || (draft.enabled === saved.enabled && draft.apiKey === saved.apiKey && draft.host === saved.host)) return saving;
  error.value = '';
  saving = saving.then(() => autosave(key, async () => {
    try {
      Object.assign(saved, await saveTelemetrySettings({ ...draft }));
    } catch (caught) {
      error.value = errorMessage(caught);
      throw caught;
    } finally {
      Object.assign(draft, saved);
    }
  }));
  return saving;
}

async function sendFeedback(sentiment: 'like' | 'dislike'): Promise<void> {
  sending.value = true;
  feedbackStatus.value = '';
  try {
    feedbackStatus.value = await sendTelemetryFeedback({ sentiment, note: note.value }) ? 'Sent.' : 'Telemetry is off.';
    note.value = '';
  } catch (caught) {
    feedbackStatus.value = errorMessage(caught);
  } finally {
    sending.value = false;
  }
}

onMounted(async () => {
  try {
    const settings = await loadTelemetrySettings();
    Object.assign(draft, settings);
    Object.assign(saved, settings);
    loaded.value = true;
  } catch (caught) {
    error.value = errorMessage(caught);
  }
});
</script>
