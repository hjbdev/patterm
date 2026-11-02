<template>
  <SettingsPanel title="Harnesses" description="Each profile starts an agent CLI with its own model, reasoning effort and Codex speed. A CLI's default profile applies when none is chosen.">
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
        <Button type="button" size="sm" variant="outline" @click="addPreset(harness)">Add profile</Button>
      </template>

      <SettingsItem v-for="preset in presetsFor(harness)" :key="preset.id" :save-key="`harnesses.${harness}.${preset.id}`">
        <template #icon>
          <input
            type="radio"
            :name="`default-preset-${harness}`"
            class="h-4 w-4 shrink-0 cursor-pointer appearance-none rounded-full border border-white/25 transition-[border-width,border-color] checked:border-[5px] checked:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            :checked="defaults[harness] === preset.id"
            :aria-label="`Make ${preset.name} the default ${harnessName(harness)} profile`"
            @change="setDefault(harness, preset.id)"
          />
        </template>
        <template #title>
          <span class="truncate">{{ preset.name }}</span>
          <Badge v-if="defaults[harness] === preset.id" variant="secondary" class="h-4 px-1.5 text-[10px] font-medium">Default</Badge>
        </template>
        <template #meta>
          <span :title="`${preset.model ?? 'Harness default'}${preset.reasoning ? ` · ${preset.reasoning}` : ''}${preset.serviceTier ? ` · ${preset.serviceTier}` : ''}`">{{ settingsSummary(catalog, harness, preset) }}</span>
        </template>
        <template #actions>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2" @click="editPreset(harness, preset)">Edit</Button>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2 text-destructive hover:text-destructive" @click="removePreset(harness, preset)">Delete</Button>
        </template>
      </SettingsItem>
      <p v-if="!presetsFor(harness).length" class="px-3.5 py-3 text-xs text-muted-foreground">No profiles. {{ harnessName(harness) }} launches with its own model.</p>
    </SettingsSection>

    <Dialog v-model:open="editorOpen">
      <DialogContent class="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ editor?.id ? `Edit ${editorTitle}` : `Add ${editor ? harnessName(editor.harness) : ''} profile` }}</DialogTitle>
          <DialogDescription>Agents started with this profile use these settings.</DialogDescription>
        </DialogHeader>
        <form v-if="editor" class="space-y-4" @submit.prevent="applyEditor">
          <div class="grid items-center gap-3 sm:grid-cols-[90px_minmax(0,1fr)]">
              <label class="text-xs text-muted-foreground" for="preset-name">Name</label>
              <Input id="preset-name" v-model="editor.name" class="h-8 text-xs" placeholder="smartypants" autocomplete="off" />
              <HarnessProfileFields v-model:fields="editor.fields" :catalog="catalog" id-prefix="preset" />
          </div>
          <label class="flex items-center gap-2 text-xs">
            <Checkbox v-model="editor.isDefault" />
            Default for {{ harnessName(editor.harness) }}
          </label>
          <p v-if="editorError" role="alert" class="text-xs text-destructive">{{ editorError }}</p>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" @click="editorOpen = false">Cancel</Button>
            <Button type="submit" size="sm">{{ editor.id ? 'Save' : 'Add profile' }}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { randomId } from '../lib/randomId';
import { onMounted, reactive, ref } from 'vue';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import AgentIcon from './AgentIcon.vue';
import HarnessProfileFields from './HarnessProfileFields.vue';
import SettingsItem from './settings/SettingsItem.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { autosave, settingSaveStatus } from '../Composables/useSettingsAutosave';
import { useWorkbench } from '../Composables/useWorkbench';
import { harnessLabel } from '../lib/harnesses';
import { harnessModels, topicChanged } from '../lib/serverQuery';
import type { ProfileLook } from '../lib/faces';
import { DEFAULT_MODEL, PROFILE_HARNESSES, emptyModelCatalog, fieldsFrom, modelsFor, settingsFrom, settingsSummary, type ModelCatalog, type ProfileFieldsState, type ProfileHarness } from '../lib/profileFields';

type PresetHarness = ProfileHarness;
type Harness = PresetHarness | 'rawpty';

interface HarnessPreset {
  id: string;
  harness: PresetHarness;
  name: string;
  model: string | null;
  reasoning: string | null;
  serviceTier: string | null;
  look: ProfileLook | null;
}

interface PresetSettings {
  presets: HarnessPreset[];
  defaultPresetIdByHarness: Record<PresetHarness, string | null>;
}

interface EditorState {
  id: string | null;
  harness: PresetHarness;
  name: string;
  fields: ProfileFieldsState;
  isDefault: boolean;
}

const PRESET_HARNESSES = PROFILE_HARNESSES;

const { harnesses } = useWorkbench();
const presets = ref<HarnessPreset[]>([]);
const defaults = reactive<Record<PresetHarness, string | null>>({ claude: null, codex: null, opencode: null });
const catalog = ref<ModelCatalog>(emptyModelCatalog());
const editor = ref<EditorState | null>(null);
const editorOpen = ref(false);
const editorTitle = ref('');
const editorError = ref('');
const error = ref('');
const refreshBusy = ref(false);
const loaded = ref(false);

onMounted(() => {
  void load();
});

async function load(): Promise<void> {
  error.value = '';
  try {
    const [presetResponse, modelResponse] = await Promise.all([
      window.patterm.harnessPresets() as Promise<PresetSettings>,
      harnessModels<ModelCatalog>()
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
}

function snapshot(): PresetSettings {
  return {
    // Electron IPC cannot clone Vue's reactive array or its proxy elements.
    presets: presets.value.map(({ id, harness, name, model, reasoning, serviceTier, look }) => ({ id, harness, name, model, reasoning, serviceTier: serviceTier ?? null, look: look ? { ...look } : null })),
    defaultPresetIdByHarness: { claude: defaults.claude, codex: defaults.codex, opencode: defaults.opencode }
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
    // Other views read the catalog again.
    topicChanged('settings');
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
    catalog.value = await harnessModels<ModelCatalog>();
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
  editor.value = { id: null, harness, name: '', fields: { harness, model: modelsFor(catalog.value, harness)[0]?.id ?? DEFAULT_MODEL, customModel: '', reasoning: '', serviceTier: '' }, isDefault: presetsFor(harness).length === 0 };
  editorOpen.value = true;
}

function editPreset(harness: PresetHarness, preset: HarnessPreset): void {
  editorError.value = '';
  editorTitle.value = preset.name;
  editor.value = {
    id: preset.id,
    harness,
    name: preset.name,
    fields: fieldsFrom(catalog.value, harness, preset),
    isDefault: defaults[harness] === preset.id
  };
  editorOpen.value = true;
}

function applyEditor(): void {
  const current = editor.value;
  if (!current) return;
  const name = current.name.trim();
  if (!name) {
    editorError.value = 'Give the profile a name.';
    return;
  }
  const settings = settingsFrom(current.fields);
  if ('error' in settings) {
    editorError.value = settings.error;
    return;
  }
  const duplicate = presets.value.some((preset) => preset.harness === current.harness && preset.id !== current.id && preset.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    editorError.value = `A ${harnessName(current.harness)} profile named '${name}' already exists.`;
    return;
  }
  const preset: HarnessPreset = {
    id: current.id ?? `preset_${randomId()}`,
    harness: current.harness,
    name,
    ...settings,
    // A face saved earlier is kept for bots.
    look: presets.value.find((candidate) => candidate.id === current.id)?.look ?? null
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
  if (!window.confirm(`Delete the ${harnessName(harness)} profile “${preset.name}”?`)) return;
  presets.value = presets.value.filter((candidate) => candidate.id !== preset.id);
  if (defaults[harness] === preset.id) {
    defaults[harness] = presetsFor(harness)[0]?.id ?? null;
  }
  persist(`harnesses.${harness}`);
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
