<template>
  <SettingsPanel title="Auto-summaries" description="Conversation recaps that retain earlier goals and decisions, without interrupting the agent.">
    <SettingsSection title="General" description="Summaries begin after you message a top-level agent. Imported conversation history can take a few minutes to arrive. Child agents are skipped." scope="summaries.general">
      <p class="rounded-lg border border-warning/20 bg-warning/[0.04] px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">Enabling this sends conversation prose and a compact recap to the selected provider and consumes its usage allowance. Tools and reasoning are excluded from agent recaps. Redaction is best-effort: this text can still contain secrets. Shell summaries use recent terminal output. Large existing conversations begin with partial coverage; rebuild them deliberately from Session context.</p>
      <SettingsRow label="Enable auto-summaries" html-for="summary-enabled" save-key="summaries.general.enabled" toggle :disabled="enableDisabled">
        <Switch id="summary-enabled" :model-value="draft.enabled" :disabled="enableDisabled" @update:model-value="(value) => { draft.enabled = value; persist('summaries.general.enabled'); }" />
      </SettingsRow>
      <SettingsRow label="Generate titles" description="Names agents you haven't named from the same request. Names you or an agent choose always win." html-for="summary-titles" save-key="summaries.general.titles" toggle>
        <Switch id="summary-titles" :model-value="draft.titles" :disabled="loading || busy" @update:model-value="(value) => { draft.titles = value; persist('summaries.general.titles'); }" />
      </SettingsRow>
    </SettingsSection>

    <SettingsSection title="Summariser" description="Uses the selected CLI’s native login and model, without automatic fallback. Summaries have no tools or MCP access and do not create resumable conversations." scope="summaries.summariser">
      <SettingsRow label="Provider" html-for="summary-provider" save-key="summaries.summariser.provider">
        <SettingsChoice id="summary-provider" :model-value="draft.provider" :options="PROVIDERS" aria-label="Summary provider" :disabled="loading || busy" segmented @update:model-value="(value) => { draft.provider = value; persist('summaries.summariser.provider'); }" />
        <template v-if="selectedProvider?.reason" #below>
          <p class="text-xs text-warning">{{ selectedProvider.reason }}</p>
        </template>
      </SettingsRow>
      <SettingsRow label="Model" html-for="summary-model" save-key="summaries.summariser.model">
        <SettingsChoice v-if="modelOptions.length" id="summary-model" :model-value="draft.models[draft.provider]" :options="modelChoices" aria-label="Summary model" :disabled="loading || busy" @update:model-value="chooseModel" />
        <Input v-else id="summary-model" :model-value="draft.models[draft.provider]" class="h-8 w-full text-xs [@container(min-width:26rem)]:w-56" :disabled="loading || busy" @update:model-value="(value) => { draft.models[draft.provider] = String(value); persistAfterTyping('summaries.summariser.model'); }" @blur="flushTyping" />
        <template v-if="catalogError" #below>
          <p class="text-[11px] text-warning">{{ catalogError }}</p>
        </template>
      </SettingsRow>
      <SettingsRow v-if="draft.provider !== 'opencode'" label="Reasoning" html-for="summary-reasoning" save-key="summaries.summariser.reasoning">
        <SettingsChoice id="summary-reasoning" :model-value="currentReasoning" :options="reasoningChoices" aria-label="Summary reasoning" :disabled="loading || busy || (!reasoningOptions.length && !currentReasoning)" @update:model-value="chooseReasoning" />
      </SettingsRow>
      <SettingsRow label="Minimum interval" description="The shortest time between two summaries of one agent." html-for="summary-interval" save-key="summaries.summariser.interval">
        <SettingsChoice id="summary-interval" :model-value="draft.intervalSeconds" :options="INTERVALS" aria-label="Minimum interval" :disabled="loading || busy" segmented @update:model-value="(value) => { draft.intervalSeconds = value; persist('summaries.summariser.interval'); }" />
      </SettingsRow>
      <SettingsRow label="Connection test" description="Makes one model request using synthetic text only.">
        <span v-if="testPassed" role="status" class="text-xs text-success">Test passed</span>
        <Button type="button" variant="outline" size="sm" :disabled="loading || busy || !selectedAvailable" @click="test">{{ busy ? 'Testing…' : 'Test summariser' }}</Button>
        <template v-if="error" #below>
          <p role="alert" class="text-xs text-destructive">{{ error }}</p>
        </template>
      </SettingsRow>
    </SettingsSection>

    <p v-if="lastError" class="py-5 text-xs text-muted-foreground">Last background error: {{ lastError }}</p>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { autoSummarySettingsInput } from '../../../app/Services/AutoSummarySettings';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { autosave } from '../Composables/useSettingsAutosave';

interface CatalogModel { id: string; label: string; reasoning: string[]; defaultReasoning: string | null; }
interface ProviderCatalog { error: string | null; models: CatalogModel[]; }
type SummaryProvider = 'claude' | 'codex' | 'opencode';

const PROVIDERS: Array<{ value: SummaryProvider; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' }
];
const INTERVALS: Array<{ value: 15 | 30 | 60; label: string }> = [
  { value: 15, label: '15 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' }
];

const draft = ref(autoSummarySettingsInput.parse({}));
const providers = ref<Array<{ provider: string; available: boolean; reason: string | null }>>([]);
const catalog = ref<Partial<Record<SummaryProvider, ProviderCatalog | null>>>({});
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const lastError = ref<string | null>(null);
const testPassed = ref(false);
let saved = '';
let revision = 0;
const selectedProvider = computed(() => providers.value.find((item) => item.provider === draft.value.provider));
const selectedAvailable = computed(() => selectedProvider.value?.available === true);
const enableDisabled = computed(() => loading.value || busy.value || (!selectedAvailable.value && !draft.value.enabled));
// The OpenCode summariser calls OpenAI directly, so only openai/ models apply.
// Its catalogue can list one model more than once; the first entry is kept.
const modelOptions = computed<CatalogModel[]>(() => {
  const provider = draft.value.provider;
  const models = catalog.value[provider]?.models ?? [];
  if (provider !== 'opencode') return models;
  const seen = new Set<string>();
  return models.flatMap((model) => {
    const id = model.id.startsWith('openai/') ? model.id.slice('openai/'.length) : null;
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ ...model, id }];
  });
});
const selectedModel = computed(() => modelOptions.value.find((model) => model.id === draft.value.models[draft.value.provider]));
const reasoningOptions = computed(() => selectedModel.value?.reasoning ?? []);
const modelChoices = computed(() => {
  const current = draft.value.models[draft.value.provider];
  const choices = modelOptions.value.map((model) => ({ value: model.id, label: model.label }));
  return selectedModel.value ? choices : [...choices, { value: current, label: `${current} (not listed)` }];
});
const currentReasoning = computed(() => draft.value.provider === 'opencode' ? null : draft.value.reasoning[draft.value.provider]);
const reasoningChoices = computed(() => {
  const current = currentReasoning.value;
  const fallback = selectedModel.value?.defaultReasoning ? ` (${selectedModel.value.defaultReasoning})` : '';
  return [
    { value: null as string | null, label: `Model default${fallback}` },
    ...reasoningOptions.value.map((level) => ({ value: level as string | null, label: level })),
    ...(current && !reasoningOptions.value.includes(current) ? [{ value: current as string | null, label: current }] : [])
  ];
});
const catalogError = computed(() => {
  const message = catalog.value[draft.value.provider]?.error;
  return message ? `Model list may be out of date: ${message}` : '';
});
watch(() => JSON.stringify(draft.value), () => { testPassed.value = false; });
onMounted(async () => {
  try {
    const [result, models] = await Promise.all([
      window.patterm.autoSummarySettings() as Promise<{ settings: unknown; providers: typeof providers.value; lastError: string | null }>,
      // The model list is optional; the model can still be typed without it.
      Promise.resolve().then(() => window.patterm.harnessModels()).catch(() => null) as Promise<{ providers?: typeof catalog.value } | null>
    ]);
    draft.value = autoSummarySettingsInput.parse(result.settings);
    saved = JSON.stringify(draft.value);
    providers.value = result.providers;
    lastError.value = result.lastError;
    catalog.value = models?.providers ?? {};
  } catch { error.value = 'Could not load summary settings. Close and reopen Settings to retry.'; }
  finally { loading.value = false; }
});
function chooseModel(id: string): void {
  draft.value.models[draft.value.provider] = id;
  onModelChange();
  persist('summaries.summariser.model');
}
function chooseReasoning(level: string | null): void {
  const provider = draft.value.provider;
  if (provider === 'opencode') return;
  draft.value.reasoning[provider] = level;
  persist('summaries.summariser.reasoning');
}
function onModelChange(): void {
  const provider = draft.value.provider;
  if (provider === 'opencode') return;
  const level = draft.value.reasoning[provider];
  if (level && selectedModel.value && !reasoningOptions.value.includes(level)) draft.value.reasoning[provider] = null;
}
async function save() {
  if (!saved || loading.value) return;
  if (JSON.stringify(draft.value) === saved) return;
  const payload = autoSummarySettingsInput.parse(draft.value);
  const current = ++revision;
  const response = autoSummarySettingsInput.parse(await window.patterm.autoSummarySettingsUpdate(payload));
  // A newer change is already on its way; keep it rather than the older response.
  if (current !== revision) return;
  draft.value = response;
  saved = JSON.stringify(draft.value);
}
function persist(key: string): void {
  void autosave(key, save);
}
let typingTimer: ReturnType<typeof setTimeout> | undefined;
let typingKey = '';
function persistAfterTyping(key: string): void {
  clearTimeout(typingTimer);
  typingKey = key;
  typingTimer = setTimeout(flushTyping, 600);
}
function flushTyping(): void {
  if (!typingTimer) return;
  clearTimeout(typingTimer);
  typingTimer = undefined;
  persist(typingKey);
}
onBeforeUnmount(flushTyping);
async function test() {
  busy.value = true;
  error.value = '';
  testPassed.value = false;
  try { await window.patterm.autoSummaryTest(autoSummarySettingsInput.parse(draft.value)); testPassed.value = true; }
  catch (caught) { error.value = caught instanceof Error ? caught.message : 'Summariser test failed.'; }
  finally { busy.value = false; }
}
defineExpose({ save });
</script>
