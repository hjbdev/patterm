<template>
  <SettingsPanel title="Assistant">
    <template #description>One Codex session that oversees agents across your projects. Open it from the button in the bottom-right corner.</template>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    <SettingsSection title="General" scope="assistant.general">
      <SettingsRow label="Assistant" description="Show the assistant button and let it start. Turning it off stops a running assistant and ends any voice call; its conversation resumes when you turn it back on." html-for="assistant-enabled" save-key="assistant.general.enabled" toggle>
        <Switch id="assistant-enabled" :model-value="settings?.enabled ?? true" :disabled="!settings" @update:model-value="save('assistant.general.enabled', { enabled: $event })" />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection title="Memory" description="Changes apply on the assistant's next request. Saved notes stay when memory is off." scope="assistant.memory">
      <SettingsRow label="Saved memory" description="Keep useful facts across conversations. Older notes are gradually compressed; high-importance notes last longer." html-for="assistant-memory-enabled" save-key="assistant.memory.enabled" toggle>
        <Switch id="assistant-memory-enabled" :model-value="settings?.memoryEnabled ?? false" :disabled="!settings" @update:model-value="save('assistant.memory.enabled', { memoryEnabled: $event })" />
      </SettingsRow>
      <SettingsRow label="Context budget" description="Approximate space for saved memory in the assistant's context. Starting a new conversation keeps saved memory." html-for="assistant-memory-budget" save-key="assistant.memory.budget" :disabled="!settings?.memoryEnabled">
        <SettingsChoice id="assistant-memory-budget" :model-value="settings?.memoryBudgetTokens ?? 4000" :options="memoryBudgetOptions" :disabled="!settings?.memoryEnabled" aria-label="Memory context budget" @update:model-value="save('assistant.memory.budget', { memoryBudgetTokens: $event })" />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection title="Voice" scope="assistant.voice">
      <SettingsRow label="Voice" description="The voice that speaks the assistant's replies in voice mode. Applies to the next voice session." html-for="assistant-voice" save-key="assistant.voice">
        <SettingsChoice id="assistant-voice" :model-value="settings?.voice ?? null" :options="voiceOptions" :disabled="!settings" aria-label="Assistant voice" @update:model-value="save('assistant.voice', { voice: $event })" />
      </SettingsRow>
      <SettingsRow label="Voice profile" description="Codex default uses Codex's own voice instructions. Patterm answers status questions itself and hands longer jobs to agents, so you can start another while one runs. Applies to the next voice session." html-for="assistant-voice-profile" save-key="assistant.voiceProfile">
        <SettingsChoice id="assistant-voice-profile" segmented :model-value="settings?.voiceProfile ?? 'codex'" :options="profileOptions" :disabled="!settings" aria-label="Voice profile" @update:model-value="save('assistant.voiceProfile', { voiceProfile: $event })" />
      </SettingsRow>
      <SettingsRow label="Acknowledgements" description="A short spoken reassurance, such as &quot;Let me check&quot;, when the voice hands a request to the assistant. Default keeps Codex's behaviour; Off leaves them out. Applies to the next voice session." html-for="assistant-voice-acknowledgements" save-key="assistant.voiceAcknowledgements">
        <SettingsChoice id="assistant-voice-acknowledgements" segmented :model-value="settings?.voiceAcknowledgements ?? 'default'" :options="acknowledgementOptions" :disabled="!settings" aria-label="Acknowledgements" @update:model-value="save('assistant.voiceAcknowledgements', { voiceAcknowledgements: $event })" />
      </SettingsRow>
      <SettingsRow label="Your name" description="What the voice calls you with the Patterm profile. Leave blank to leave it out. Codex default uses your system account name." html-for="assistant-user-name" save-key="assistant.userName">
        <Input id="assistant-user-name" :model-value="userName" class="h-8 w-full text-xs [@container(min-width:26rem)]:w-56" placeholder="Not set" autocomplete="off" maxlength="60" :disabled="!settings" @update:model-value="typeName(String($event))" @blur="flushName" />
      </SettingsRow>
    </SettingsSection>
    <SettingsSection title="Session" scope="assistant.session">
      <SettingsRow label="Model preset" description="The Codex preset the assistant starts with. Changes apply the next time the assistant starts." html-for="assistant-preset" save-key="assistant.preset">
        <SettingsChoice id="assistant-preset" :model-value="settings?.presetId ?? null" :options="presetOptions" :disabled="!settings" aria-label="Assistant model preset" @update:model-value="save('assistant.preset', { presetId: $event })" />
      </SettingsRow>
      <SettingsRow label="Forward notifications" description="Send the assistant a short summary when agents need you or finish. In voice mode it tells you out loud." html-for="assistant-forward" save-key="assistant.forward" toggle>
        <Switch id="assistant-forward" :model-value="settings?.forwardNotifications ?? true" :disabled="!settings" @update:model-value="save('assistant.forward', { forwardNotifications: $event })" />
      </SettingsRow>
    </SettingsSection>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { autosave } from '../Composables/useSettingsAutosave';
import { loadAssistantSettings, message, saveAssistantSettings, type AssistantSettings, type AssistantVoiceAcknowledgements, type AssistantVoiceProfile } from '../lib/assistant';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { Input } from './ui/input';
import { Switch } from './ui/switch';

interface Preset { id: string; harness: string; name: string }

const settings = shallowRef<AssistantSettings | null>(null);
const voices = ref<string[]>([]);
const presets = ref<Preset[]>([]);
const error = ref('');

const memoryBudgetOptions = [
  { value: 2000, label: '≈ 2,000 tokens' },
  { value: 4000, label: '≈ 4,000 tokens' },
  { value: 8000, label: '≈ 8,000 tokens' }
];

const voiceOptions = computed(() => [
  { value: null as string | null, label: 'Default' },
  ...voices.value.map((voice) => ({ value: voice as string | null, label: voice[0]!.toUpperCase() + voice.slice(1) }))
]);
const profileOptions: Array<{ value: AssistantVoiceProfile; label: string }> = [
  { value: 'codex', label: 'Codex default' },
  { value: 'patterm', label: 'Patterm' }
];
const acknowledgementOptions: Array<{ value: AssistantVoiceAcknowledgements; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
];
const presetOptions = computed(() => [
  { value: null as string | null, label: 'Codex default' },
  ...presets.value.filter((preset) => preset.harness === 'codex').map((preset) => ({ value: preset.id as string | null, label: preset.name }))
]);

// The name saves once typing pauses, or when the field loses focus.
const userName = ref('');
let nameTimer: ReturnType<typeof setTimeout> | undefined;
function typeName(value: string): void {
  userName.value = value;
  clearTimeout(nameTimer);
  nameTimer = setTimeout(flushName, 600);
}
function flushName(): void {
  if (nameTimer === undefined) return;
  clearTimeout(nameTimer);
  nameTimer = undefined;
  save('assistant.userName', { userName: userName.value.trim() || null });
}
onBeforeUnmount(flushName);

function save(key: string, change: Partial<AssistantSettings>): void {
  if (!settings.value) return;
  const next = { ...settings.value, ...change };
  settings.value = next;
  void autosave(key, async () => { settings.value = await saveAssistantSettings(next); });
}

onMounted(async () => {
  try {
    const [loaded, presetSettings] = await Promise.all([loadAssistantSettings(), window.patterm.harnessPresets() as Promise<{ presets?: Preset[] } | null>]);
    settings.value = loaded.settings;
    userName.value = loaded.settings.userName ?? '';
    voices.value = loaded.voices;
    presets.value = presetSettings?.presets ?? [];
  } catch (caught) {
    error.value = message(caught);
  }
});
</script>
