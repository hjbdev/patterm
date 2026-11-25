<template>
  <BotEditorSettings
    v-if="openBot"
    :key="`${host ?? 'local'}:${openBot.id}`"
    :bot="openBot"
    :bots="bots"
    :host="host"
    :status="statusLabel(openBot.id)"
    :catalog="catalog"
    :presets="presets"
    :harnesses="harnesses"
    :voices="voices"
    :projects="userProjects"
    :persist="persist"
    @back="closeBot(false)"
    @remove="removeBot(openBot)"
  />
  <SettingsPanel v-else title="Bots" description="Bots are persistent companions you text with. Each one runs an agent CLI with its own model settings, which you can copy from a profile. It keeps one conversation that carries on after a restart, and works in the projects you give it. The helpers it starts stay out of view. The assistant is the built-in bot: it oversees every project and lists first.">
    <template #actions>
      <Button type="button" size="sm" variant="outline" @click="addBot">Add bot</Button>
    </template>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>

    <SettingsSection list scope="bots">
      <SettingsItem v-for="bot in bots" :key="bot.id" :keywords="bot.name" :save-key="`bots.${bot.id}.enabled`">
        <template #title>
          <BotAvatar :avatar="bot.avatar" :size="20" />
          <span class="truncate">{{ bot.name }}</span>
        </template>
        <template #meta>{{ harnessLabel(bot.harness) }} · {{ settingsSummary(catalog, bot.harness, bot) }} · {{ purviewLabel(bot.purview) }} · {{ statusLabel(bot.id) }}</template>
        <template #actions>
          <Switch
            :model-value="bot.enabled"
            :aria-label="`Turn ${bot.name} ${bot.enabled ? 'off' : 'on'}`"
            title="Off stops it and hides it until turned back on"
            @update:model-value="toggleEnabled(bot, Boolean($event))"
          />
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2" @click="showBot(bot.id)">Settings</Button>
        </template>
      </SettingsItem>
      <p v-if="!bots.length" class="px-3.5 py-3 text-xs text-muted-foreground">No bots yet.</p>
    </SettingsSection>

    <SettingsSection title="Voice" scope="bots.voice">
      <SettingsRow label="Your name" description="What voices call you with the Patterm voice profile. Leave blank to leave it out. Codex default uses your system account name." html-for="bots-user-name" save-key="bots.userName">
        <Input id="bots-user-name" :model-value="userName" class="h-8 w-full text-xs [@container(min-width:26rem)]:w-56" placeholder="Not set" autocomplete="off" maxlength="60" @update:model-value="typeName(String($event))" @blur="flushName" />
      </SettingsRow>
    </SettingsSection>

    <Dialog v-model:open="adding">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add bot</DialogTitle>
          <DialogDescription>You can set up the rest on its settings page.</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="createBot">
          <div class="space-y-1.5">
            <label class="text-xs text-muted-foreground" for="new-bot-name">Name</label>
            <Input id="new-bot-name" v-model="newName" class="h-8 text-xs" placeholder="Fable" autocomplete="off" maxlength="40" />
          </div>
          <div class="space-y-1.5">
            <span class="text-xs text-muted-foreground">Harness</span>
            <SettingsChoice v-model="newHarness" :options="HARNESS_CHOICES" aria-label="Harness" segmented />
          </div>
          <p v-if="addError" role="alert" class="text-xs text-destructive">{{ addError }}</p>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" @click="adding = false">Cancel</Button>
            <Button type="submit" size="sm" :disabled="creating">Add bot</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useBots } from '../Composables/useBots';
import { useWorkbench } from '../Composables/useWorkbench';
import { isAssistantBot, plainBot, readBots, saveBots, type Bot, type BotPurview, type BotSettings } from '../lib/bots';
import { autosave } from '../Composables/useSettingsAutosave';
import { randomLook } from '../lib/faces';
import { harnessLabel } from '../lib/harnesses';
import { DEFAULT_MODEL, PROFILE_HARNESSES, emptyModelCatalog, fieldsFrom, settingsFrom, settingsSummary, type ModelCatalog, type ProfileFieldsState, type ProfileHarness } from '../lib/profileFields';
import type { ProfileSettings } from '../lib/profiles';
import { randomId } from '../lib/randomId';
import { harnessModels, harnessPresets } from '../lib/serverQuery';
import type { HarnessInstallationRecord } from '../types';
import BotAvatar from './BotAvatar.vue';
import BotEditorSettings from './BotEditorSettings.vue';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsItem from './settings/SettingsItem.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { useSettingsHost } from './settings/settingsHost';
import { useSettingsSearch } from './settings/settingsSearch';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Switch } from './ui/switch';

const HARNESS_CHOICES = PROFILE_HARNESSES.map((harness) => ({ value: harness, label: harnessLabel(harness) }));

const host = useSettingsHost().value;
const route = useRoute();
const router = useRouter();
const { searching } = useSettingsSearch(() => []);
const { settings: localSettings, rows, voices: localVoices } = useBots();
const { projects, harnesses: localHarnesses } = useWorkbench();
const remoteSettings = ref<BotSettings>({ bots: [], userName: null });
const remoteVoices = ref<string[]>([]);
const remoteHarnesses = ref<HarnessInstallationRecord[]>([]);
const remoteProjects = ref<Array<{ id: string; name: string }>>([]);
const activeSettings = computed(() => host ? remoteSettings.value : localSettings.value);
const voices = computed(() => host ? remoteVoices.value : localVoices.value);
const harnesses = computed(() => host ? remoteHarnesses.value : localHarnesses.value);
const bots = computed(() => activeSettings.value.bots);
const presets = ref<ProfileSettings>({ presets: [], defaultPresetIdByHarness: { claude: null, codex: null, opencode: null, agy: null } });
const userProjects = computed(() => host
  ? remoteProjects.value
  : projects.value.map((item) => item.project).filter((project) => !project.host && (project.kind === 'workspace' || project.kind === 'personal' || !project.kind)));
const catalog = ref<ModelCatalog>(emptyModelCatalog());
const error = ref('');

// Each bot's settings are a page of their own, named in the address, such as
// /settings?tab=bots&bot=assistant. Search always lists the bots.
const openBot = computed(() => {
  const botId = route.query.bot;
  if (searching.value || typeof botId !== 'string') return null;
  return bots.value.find((bot) => bot.id === botId) ?? null;
});
function showBot(botId: string): void {
  void router.push({ query: { ...route.query, tab: 'bots', bot: botId } });
}
function closeBot(replace: boolean): void {
  const query = { ...route.query };
  delete query.bot;
  void (replace ? router.replace({ query }) : router.push({ query }));
}

// The name saves once typing pauses, or when the field loses focus.
const userName = ref('');
let nameTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => activeSettings.value.userName, (value) => { if (nameTimer === undefined) userName.value = value ?? ''; }, { immediate: true });
function typeName(value: string): void {
  userName.value = value;
  clearTimeout(nameTimer);
  nameTimer = setTimeout(flushName, 600);
}
function flushName(): void {
  if (nameTimer === undefined) return;
  clearTimeout(nameTimer);
  nameTimer = undefined;
  const next = userName.value.trim() || null;
  void autosave('bots.userName', async () => { await persist(bots.value, next); });
}
onBeforeUnmount(flushName);

onMounted(async () => {
  try {
    if (host) {
      const [botData, presetData, modelData, harnessResult, projectResult] = await Promise.all([
        readBots(host),
        window.patterm.call('harness_presets', {}, host).catch(() => null) as Promise<ProfileSettings | null>,
        window.patterm.call('harness_models', {}, host).catch(() => emptyModelCatalog()) as Promise<ModelCatalog>,
        window.patterm.call('harness_list', {}, host).catch(() => []) as Promise<{ harnesses?: HarnessInstallationRecord[] } | HarnessInstallationRecord[]>,
        window.patterm.call('project_list', {}, host).catch(() => ({ projects: [] })) as Promise<{ projects?: Array<{ id: string; name: string; kind?: string }> } | Array<{ id: string; name: string; kind?: string }>>
      ]);
      remoteSettings.value = { bots: botData.bots ?? [], userName: botData.userName ?? null };
      remoteVoices.value = botData.voices ?? [];
      if (presetData) presets.value = presetData;
      catalog.value = modelData;
      remoteHarnesses.value = Array.isArray(harnessResult) ? harnessResult : harnessResult?.harnesses ?? [];
      const listed = Array.isArray(projectResult) ? projectResult : projectResult?.projects ?? [];
      remoteProjects.value = listed
        .filter((project) => project.kind === 'workspace' || project.kind === 'personal' || !project.kind)
        .map((project) => ({ id: project.id, name: project.name }));
    } else {
      [presets.value, catalog.value] = await Promise.all([
        harnessPresets<ProfileSettings>().then((value) => value ?? presets.value),
        harnessModels<ModelCatalog>()
      ]);
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
});

function rowFor(botId: string) {
  const qualified = host ? `${host}:${botId}` : botId;
  return rows.value.find((row) => row.bot.id === qualified) ?? null;
}

function purviewLabel(purview: BotPurview): string {
  if (purview.kind === 'none') return 'No projects';
  if (purview.kind === 'all') return 'All projects';
  return purview.projectIds.length === 1 ? '1 project' : `${purview.projectIds.length} projects`;
}

function statusLabel(botId: string): string {
  const bot = bots.value.find((candidate) => candidate.id === botId);
  if (bot && !bot.enabled) return 'Off';
  if (bot && isAssistantBot(bot)) return 'Built in';
  const session = rowFor(botId)?.session;
  if (!session) return 'Starting';
  return session.exitedAt ? 'Stopped' : 'Running';
}

// Throws on failure, so autosave shows the reason beside the setting.
async function persist(next: Bot[], name = activeSettings.value.userName): Promise<void> {
  const saved = await saveBots({ bots: next.map(plainBot), userName: name }, host);
  if (host) remoteSettings.value = saved;
  else localSettings.value = saved;
  error.value = '';
}

function toggleEnabled(bot: Bot, enabled: boolean): void {
  if (bot.enabled === enabled) return;
  void autosave(`bots.${bot.id}.enabled`, () => persist(bots.value.map((candidate) => candidate.id === bot.id ? { ...candidate, enabled } : candidate)));
}

// Deleting closes its page; the list stays mounted to finish it.
async function removeBot(bot: Bot): Promise<void> {
  if (!window.confirm(`Delete ${bot.name}? Its conversation stops, and its helpers keep running in their projects.`)) return;
  try {
    await persist(bots.value.filter((candidate) => candidate.id !== bot.id));
    closeBot(true);
  } catch (caught) {
    window.alert(caught instanceof Error ? caught.message : String(caught));
  }
}

// Adding a bot asks for its name and CLI, then opens its page.
const adding = ref(false);
const creating = ref(false);
const newName = ref('');
const newHarness = ref<ProfileHarness>('claude');
const addError = ref('');

function addBot(): void {
  newName.value = '';
  newHarness.value = presets.value.presets.find((preset) => preset.id === presets.value.defaultPresetIdByHarness.claude)?.harness ?? 'claude';
  addError.value = '';
  adding.value = true;
}

// A new bot starts with its CLI's default profile, if there is one.
function newBotFields(harness: ProfileHarness): ProfileFieldsState {
  const preset = presets.value.presets.find((candidate) => candidate.id === presets.value.defaultPresetIdByHarness[harness]);
  return preset ? fieldsFrom(catalog.value, harness, preset) : { harness, model: DEFAULT_MODEL, customModel: '', reasoning: '', serviceTier: '' };
}

async function createBot(): Promise<void> {
  const name = newName.value.trim();
  if (!name) { addError.value = 'Give the bot a name.'; return; }
  if (bots.value.some((bot) => bot.name.toLowerCase() === name.toLowerCase())) { addError.value = `A bot named '${name}' already exists.`; return; }
  const fields = newBotFields(newHarness.value);
  const profile = settingsFrom(fields);
  if ('error' in profile) { addError.value = profile.error; return; }
  const bot: Bot = {
    id: `bot_${randomId()}`, name, harness: fields.harness, ...profile,
    avatar: { kind: 'face', look: randomLook(Math.floor(Math.random() * 2 ** 32)), emoji: null, picture: null },
    purview: { kind: 'none' }, instructions: '', enabled: true, memory: true, memoryBudgetTokens: 4000,
    voice: { enabled: false, voice: null, profile: 'codex', acknowledgements: 'default' }, digests: false, focus: false, requests: false
  };
  creating.value = true;
  try {
    await persist([...bots.value, bot]);
    adding.value = false;
    showBot(bot.id);
  } catch (caught) {
    addError.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    creating.value = false;
  }
}
</script>
