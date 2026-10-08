<template>
  <SettingsPanel title="Harnesses" description="Choose the model, reasoning effort, and Codex speed each agent CLI launches with. The default preset applies when no preset is chosen.">
    <template #actions>
      <Button type="button" size="sm" variant="outline" :disabled="refreshBusy" @click="refreshModels">{{ refreshBusy ? 'Discovering…' : 'Discover models' }}</Button>
    </template>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>

    <SettingsSection v-for="harness in PRESET_HARNESSES" :key="harness" list :scope="`harnesses.${harness}`">
      <template #title>
        <AgentIcon :harness="harness" class="h-3.5 w-3.5" />
        {{ harnessName(harness) }}
      </template>
      <template #description>
        <span v-if="installation(harness)?.status !== 'available'" class="text-warning">Not discovered</span>
        <template v-else>{{ installation(harness)?.version ? `Version ${installation(harness)?.version}` : 'Installed' }} · {{ refreshLabel(harness) }}</template>
        <span v-if="catalogError(harness)" class="block text-warning">{{ catalogError(harness) }}</span>
      </template>
      <template #actions>
        <Button type="button" size="sm" variant="outline" @click="addPreset(harness)">Add preset</Button>
      </template>

      <SettingsItem v-for="preset in presetsFor(harness)" :key="preset.id" :save-key="`harnesses.${harness}.${preset.id}`">
        <template #icon>
          <input
            type="radio"
            :name="`default-preset-${harness}`"
            class="h-4 w-4 shrink-0 cursor-pointer appearance-none rounded-full border border-white/25 transition-[border-width,border-color] checked:border-[5px] checked:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            :checked="defaults[harness] === preset.id"
            :aria-label="`Make ${preset.name} the default ${harnessName(harness)} preset`"
            @change="setDefault(harness, preset.id)"
          />
        </template>
        <template #title>
          <span class="truncate">{{ preset.name }}</span>
          <Badge v-if="defaults[harness] === preset.id" variant="secondary" class="h-4 px-1.5 text-[10px] font-medium">Default</Badge>
        </template>
        <template #meta>
          <span :title="`${preset.model ?? 'Harness default'}${preset.reasoning ? ` · ${preset.reasoning}` : ''}${preset.serviceTier ? ` · ${preset.serviceTier}` : ''}`">{{ modelLabel(harness, preset.model) }}{{ preset.reasoning ? ` · ${preset.reasoning}` : '' }}{{ preset.serviceTier ? ` · ${speedLabel(harness, preset.serviceTier)}` : '' }}</span>
        </template>
        <template #actions>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2" @click="editPreset(harness, preset)">Edit</Button>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2 text-destructive hover:text-destructive" @click="removePreset(harness, preset)">Delete</Button>
        </template>
      </SettingsItem>
      <p v-if="!presetsFor(harness).length" class="px-3.5 py-3 text-xs text-muted-foreground">No presets. {{ harnessName(harness) }} launches with its own {{ harness === 'amp' ? 'mode' : 'model' }}.</p>
    </SettingsSection>

    <Dialog v-model:open="editorOpen">
      <DialogContent class="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ editor?.id ? `Edit ${editorTitle}` : `Add ${editor ? harnessName(editor.harness) : ''} preset` }}</DialogTitle>
          <DialogDescription>Agents started with this preset use these settings.</DialogDescription>
        </DialogHeader>
        <form v-if="editor" class="space-y-4" @submit.prevent="applyEditor">
          <div class="grid items-center gap-3 sm:grid-cols-[90px_minmax(0,1fr)]">
            <label class="text-xs text-muted-foreground" for="preset-name">Name</label>
            <Input id="preset-name" v-model="editor.name" class="h-8 text-xs" placeholder="smartypants" autocomplete="off" />
            <label class="text-xs text-muted-foreground" for="preset-model">{{ editor.harness === 'amp' ? 'Mode' : 'Model' }}</label>
            <SettingsChoice id="preset-model" :model-value="editor.model" :options="modelChoices" :aria-label="editor.harness === 'amp' ? 'Mode' : 'Model'" @update:model-value="(value) => { editor!.model = value; onModelChange(); }" />
            <template v-if="editor.model === CUSTOM_MODEL">
              <label class="text-xs text-muted-foreground" for="preset-custom">Custom ID</label>
              <Input id="preset-custom" v-model="editor.customModel" class="h-8 text-xs" placeholder="claude-opus-4-8" autocomplete="off" />
            </template>
            <template v-if="editor.harness !== 'amp'">
              <label class="text-xs text-muted-foreground" for="preset-reasoning">Reasoning</label>
              <SettingsChoice id="preset-reasoning" :model-value="editor.reasoning" :options="reasoningChoices" aria-label="Reasoning" :disabled="editor.model === DEFAULT_MODEL" @update:model-value="(value) => { editor!.reasoning = value; }" />
            </template>
            <template v-if="editor.harness === 'codex'">
              <label class="text-xs text-muted-foreground" for="preset-speed">Speed</label>
              <SettingsChoice id="preset-speed" :model-value="editor.serviceTier" :options="speedChoices" aria-label="Speed" @update:model-value="(value) => { editor!.serviceTier = value; }" />
            </template>
          </div>
          <label class="flex items-center gap-2 text-xs">
            <Checkbox v-model="editor.isDefault" />
            Default for {{ harnessName(editor.harness) }}
          </label>
          <p v-if="editorError" role="alert" class="text-xs text-destructive">{{ editorError }}</p>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" @click="editorOpen = false">Cancel</Button>
            <Button type="submit" size="sm">{{ editor.id ? 'Save' : 'Add preset' }}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { randomId } from '../lib/randomId';
import { computed, onMounted, reactive, ref } from 'vue';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import AgentIcon from './AgentIcon.vue';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsItem from './settings/SettingsItem.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { autosave, settingSaveStatus } from '../Composables/useSettingsAutosave';
import { useWorkbench } from '../Composables/useWorkbench';
import { harnessLabel } from '../lib/harnesses';

type PresetHarness = 'claude' | 'codex' | 'opencode' | 'amp';
type Harness = PresetHarness | 'rawpty';

interface HarnessPreset {
  id: string;
  harness: PresetHarness;
  name: string;
  model: string | null;
  reasoning: string | null;
  serviceTier: string | null;
}

interface PresetSettings {
  presets: HarnessPreset[];
  defaultPresetIdByHarness: Record<PresetHarness, string | null>;
}

interface CatalogModel {
  id: string;
  label: string;
  reasoning: string[];
  defaultReasoning: string | null;
  serviceTiers?: Array<{ id: string; label: string }>;
}

interface ProviderCatalog {
  harness: PresetHarness;
  source: string;
  refreshedAt: string | null;
  error: string | null;
  models: CatalogModel[];
}

interface ModelCatalog {
  providers: Record<PresetHarness, ProviderCatalog | null>;
}

interface EditorState {
  id: string | null;
  harness: PresetHarness;
  name: string;
  model: string;
  customModel: string;
  reasoning: string;
  serviceTier: string;
  isDefault: boolean;
}

const PRESET_HARNESSES: PresetHarness[] = ['claude', 'codex', 'opencode', 'amp'];
const CUSTOM_MODEL = '__custom__';
const DEFAULT_MODEL = '__default__';

const { harnesses } = useWorkbench();
const presets = ref<HarnessPreset[]>([]);
const defaults = reactive<Record<PresetHarness, string | null>>({ claude: null, codex: null, opencode: null, amp: null });
const catalog = ref<ModelCatalog>({ providers: { claude: null, codex: null, opencode: null, amp: null } });
const editor = ref<EditorState | null>(null);
const editorOpen = ref(false);
const editorTitle = ref('');
const editorError = ref('');
const error = ref('');
const refreshBusy = ref(false);
const loaded = ref(false);

const modelChoices = computed(() => {
  const current = editor.value;
  if (!current) return [];
  return [
    { value: DEFAULT_MODEL, label: 'Harness default (no override)' },
    ...modelsFor(current.harness).map((model) => ({ value: model.id, label: model.label })),
    ...(current.harness !== 'amp' ? [{ value: CUSTOM_MODEL, label: 'Custom model ID…' }] : [])
  ];
});

const reasoningChoices = computed(() => {
  const current = editor.value;
  if (!current) return [];
  const levels = reasoningFor(current.harness, current.model);
  return [
    { value: '', label: 'Model default' },
    ...levels.map((level) => ({ value: level, label: level })),
    ...(current.reasoning && !levels.includes(current.reasoning) ? [{ value: current.reasoning, label: current.reasoning }] : [])
  ];
});

const speedChoices = computed(() => {
  const current = editor.value;
  if (!current) return [];
  const tiers = tiersFor(current.harness, current.model);
  return [
    { value: '', label: 'Harness default' },
    { value: 'default', label: 'Standard' },
    ...tiers.map((tier) => ({ value: tier.id, label: tier.label })),
    ...(current.serviceTier && current.serviceTier !== 'default' && !tiers.some((tier) => tier.id === current.serviceTier) ? [{ value: current.serviceTier, label: current.serviceTier }] : [])
  ];
});

onMounted(() => {
  void load();
});

async function load(): Promise<void> {
  error.value = '';
  try {
    const [presetResponse, modelResponse] = await Promise.all([
      window.patterm.harnessPresets() as Promise<PresetSettings>,
      window.patterm.harnessModels() as Promise<ModelCatalog>
    ]);
    applySettings(presetResponse);
    catalog.value = modelResponse;
    loaded.value = true;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

function applySettings(settings: PresetSettings): void {
  presets.value = settings.presets ?? [];
  defaults.claude = settings.defaultPresetIdByHarness?.claude ?? null;
  defaults.codex = settings.defaultPresetIdByHarness?.codex ?? null;
  defaults.opencode = settings.defaultPresetIdByHarness?.opencode ?? null;
  defaults.amp = settings.defaultPresetIdByHarness?.amp ?? null;
}

function snapshot(): PresetSettings {
  return {
    // Electron IPC cannot clone Vue's reactive array or its proxy elements.
    presets: presets.value.map(({ id, harness, name, model, reasoning, serviceTier }) => ({ id, harness, name, model, reasoning, serviceTier: serviceTier ?? null })),
    defaultPresetIdByHarness: { claude: defaults.claude, codex: defaults.codex, opencode: defaults.opencode, amp: defaults.amp }
  };
}

// Saves every preset at once. Changes are applied locally first, so the list
// never waits for the round trip; a failed save reloads the saved presets.
let revision = 0;

async function save(): Promise<void> {
  if (!loaded.value) return;
  const current = ++revision;
  const response = await window.patterm.harnessPresetsUpdate(snapshot()) as PresetSettings;
  if (current === revision) applySettings(response);
}

function persist(key: string): void {
  void autosave(key, save).then(() => {
    if (settingSaveStatus(key)?.state === 'error') void load();
  });
}

async function refreshModels(): Promise<void> {
  refreshBusy.value = true;
  error.value = '';
  try {
    catalog.value = await window.patterm.harnessModelsRefresh() as ModelCatalog;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
    catalog.value = await window.patterm.harnessModels() as ModelCatalog;
  } finally {
    refreshBusy.value = false;
  }
}

function presetsFor(harness: PresetHarness): HarnessPreset[] {
  return presets.value.filter((preset) => preset.harness === harness);
}

function setDefault(harness: PresetHarness, presetId: string): void {
  defaults[harness] = presetId;
  persist(`harnesses.${harness}.${presetId}`);
}

function addPreset(harness: PresetHarness): void {
  editorError.value = '';
  editorTitle.value = '';
  editor.value = { id: null, harness, name: '', model: modelsFor(harness)[0]?.id ?? DEFAULT_MODEL, customModel: '', reasoning: '', serviceTier: '', isDefault: presetsFor(harness).length === 0 };
  editorOpen.value = true;
}

function editPreset(harness: PresetHarness, preset: HarnessPreset): void {
  editorError.value = '';
  editorTitle.value = preset.name;
  const known = preset.model !== null && modelsFor(harness).some((model) => model.id === preset.model);
  editor.value = {
    id: preset.id,
    harness,
    name: preset.name,
    model: preset.model === null ? DEFAULT_MODEL : known ? preset.model : CUSTOM_MODEL,
    customModel: preset.model !== null && !known ? preset.model : '',
    reasoning: preset.reasoning ?? '',
    serviceTier: preset.serviceTier ?? '',
    isDefault: defaults[harness] === preset.id
  };
  editorOpen.value = true;
}

function applyEditor(): void {
  const current = editor.value;
  if (!current) return;
  const name = current.name.trim();
  const model = current.model === DEFAULT_MODEL ? null : current.model === CUSTOM_MODEL ? current.customModel.trim() : current.model;
  if (!name) {
    editorError.value = 'Give the preset a name.';
    return;
  }
  if (current.model === CUSTOM_MODEL && !model) {
    editorError.value = 'Enter a custom model ID.';
    return;
  }
  const duplicate = presets.value.some((preset) => preset.harness === current.harness && preset.id !== current.id && preset.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    editorError.value = `A ${current.harness} preset named '${name}' already exists.`;
    return;
  }
  const preset: HarnessPreset = {
    id: current.id ?? `preset_${randomId()}`,
    harness: current.harness,
    name,
    model,
    reasoning: model === null ? null : current.reasoning.trim() || null,
    serviceTier: current.harness === 'codex' ? current.serviceTier || null : null
  };
  if (current.id) {
    presets.value = presets.value.map((candidate) => candidate.id === current.id ? preset : candidate);
  } else {
    presets.value = [...presets.value, preset];
  }
  if (current.isDefault) {
    defaults[current.harness] = preset.id;
  } else if (defaults[current.harness] === preset.id) {
    defaults[current.harness] = null;
  }
  editorOpen.value = false;
  persist(`harnesses.${preset.harness}.${preset.id}`);
}

function removePreset(harness: PresetHarness, preset: HarnessPreset): void {
  if (!window.confirm(`Delete the ${harnessName(harness)} preset “${preset.name}”?`)) return;
  presets.value = presets.value.filter((candidate) => candidate.id !== preset.id);
  if (defaults[harness] === preset.id) {
    defaults[harness] = presetsFor(harness)[0]?.id ?? null;
  }
  persist(`harnesses.${harness}`);
}

function onModelChange(): void {
  const current = editor.value;
  if (!current) return;
  const levels = reasoningFor(current.harness, current.model);
  if (current.reasoning && !levels.includes(current.reasoning)) {
    current.reasoning = '';
  }
}

function modelsFor(harness: PresetHarness): CatalogModel[] {
  return catalog.value.providers[harness]?.models ?? [];
}

function reasoningFor(harness: PresetHarness, modelId: string): string[] {
  if (modelId === DEFAULT_MODEL) return [];
  if (modelId === CUSTOM_MODEL) {
    const editorState = editor.value;
    const custom = editorState?.customModel.trim();
    const match = custom ? modelsFor(harness).find((model) => model.id === custom) : undefined;
    return match?.reasoning ?? builtinReasoning(harness);
  }
  return modelsFor(harness).find((model) => model.id === modelId)?.reasoning ?? builtinReasoning(harness);
}

// Without a chosen model, offer every tier any listed model supports.
function tiersFor(harness: PresetHarness, modelId: string): Array<{ id: string; label: string }> {
  const custom = editor.value?.customModel.trim();
  const id = modelId === CUSTOM_MODEL ? custom : modelId;
  const models = id === DEFAULT_MODEL ? modelsFor(harness) : modelsFor(harness).filter((model) => model.id === id);
  const tiers = new Map<string, string>();
  for (const model of models) for (const tier of model.serviceTiers ?? []) tiers.set(tier.id, tier.label);
  return [...tiers].map(([tierId, label]) => ({ id: tierId, label }));
}

function speedLabel(harness: PresetHarness, tier: string): string {
  if (tier === 'default') return 'Standard';
  return tiersFor(harness, DEFAULT_MODEL).find((candidate) => candidate.id === tier)?.label ?? tier;
}

function builtinReasoning(harness: PresetHarness): string[] {
  return harness === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : [];
}

function modelLabel(harness: PresetHarness, modelId: string | null): string {
  if (modelId === null) return 'Harness default';
  return modelsFor(harness).find((model) => model.id === modelId)?.label ?? modelId;
}

function catalogError(harness: PresetHarness): string | null {
  return catalog.value.providers[harness]?.error ?? null;
}

function refreshLabel(harness: PresetHarness): string {
  const entry = catalog.value.providers[harness];
  if (!entry?.refreshedAt) return 'Models never refreshed';
  const when = new Date(entry.refreshedAt);
  return Number.isNaN(when.getTime()) ? 'Models never refreshed' : `Models updated ${when.toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
}

function installation(harness: PresetHarness) {
  return harnesses.value.find((row) => row.harness === harness) ?? null;
}

function harnessName(harness: Harness): string {
  return harnessLabel(harness) ?? harness;
}

defineExpose({ save });
</script>
