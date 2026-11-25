<template>
  <SettingsPanel title="Bots" description="Bots are persistent companions you text with. Each one runs an agent CLI with its own model settings, which you can copy from a profile. It keeps one conversation that carries on after a restart, and works in the projects you give it. The helpers it starts stay out of view. The assistant is the built-in bot: it oversees every project and lists first.">
    <template #actions>
      <Button type="button" size="sm" variant="outline" @click="addBot">Add bot</Button>
    </template>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>

    <SettingsSection list scope="bots">
      <SettingsItem v-for="bot in bots" :key="bot.id" :keywords="bot.name" :save-key="`bots.${bot.id}`">
        <template #title>
          <BotAvatar :avatar="bot.avatar" :size="20" />
          <span class="truncate">{{ bot.name }}</span>
        </template>
        <template #meta>{{ harnessLabel(bot.harness) }} · {{ settingsSummary(catalog, bot.harness, bot) }} · {{ purviewLabel(bot.purview) }} · {{ statusLabel(bot.id) }}</template>
        <template #actions>
          <Switch
            :model-value="bot.enabled"
            :disabled="saving"
            :aria-label="`Turn ${bot.name} ${bot.enabled ? 'off' : 'on'}`"
            title="Off stops it and hides it until turned back on"
            @update:model-value="toggleEnabled(bot, Boolean($event))"
          />
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2" @click="editBot(bot)">Edit</Button>
          <Button v-if="!isAssistantBot(bot)" type="button" size="sm" variant="ghost" class="h-7 px-2 text-destructive hover:text-destructive" @click="removeBot(bot)">Delete</Button>
        </template>
      </SettingsItem>
      <p v-if="!bots.length" class="px-3.5 py-3 text-xs text-muted-foreground">No bots yet.</p>
    </SettingsSection>

    <SettingsSection title="Voice" scope="bots.voice">
      <SettingsRow label="Your name" description="What voices call you with the Patterm voice profile. Leave blank to leave it out. Codex default uses your system account name." html-for="bots-user-name" save-key="bots.userName">
        <Input id="bots-user-name" :model-value="userName" class="h-8 w-full text-xs [@container(min-width:26rem)]:w-56" placeholder="Not set" autocomplete="off" maxlength="60" @update:model-value="typeName(String($event))" @blur="flushName" />
      </SettingsRow>
    </SettingsSection>

    <Dialog v-model:open="editorOpen">
      <DialogContent class="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editor?.isNew ? 'Add bot' : `Edit ${editorTitle}` }}</DialogTitle>
          <DialogDescription>Changes to a running bot apply when it restarts. Changing its harness starts a new conversation.</DialogDescription>
        </DialogHeader>
        <form v-if="editor" class="space-y-4" @submit.prevent="applyEditor">
          <div class="grid gap-4 sm:grid-cols-[208px_minmax(0,1fr)]">
            <div class="flex flex-col items-center justify-center gap-3 rounded-lg border border-border px-3 py-5" :style="{ background: `radial-gradient(circle at 50% 38%, ${facePalette(editor.avatar.look.color).halo}, transparent 68%), hsl(0 0% 3%)` }">
              <BotAvatar :avatar="editor.avatar" :size="96" motion />
              <SettingsChoice v-model="editor.avatar.kind" :options="AVATAR_KINDS" aria-label="Avatar" segmented />
              <Button v-if="editor.avatar.kind === 'face'" type="button" size="sm" variant="outline" class="h-7 gap-1.5 text-xs" @click="shuffleFace">
                <Dices class="h-3.5 w-3.5" />
                Shuffle
              </Button>
              <template v-else-if="editor.avatar.kind === 'picture'">
                <Button type="button" size="sm" variant="outline" class="h-7 text-xs" @click="pictureInput?.click()">{{ editor.avatar.picture ? 'Change picture' : 'Choose picture' }}</Button>
                <input ref="pictureInput" type="file" accept="image/*" class="hidden" @change="choosePicture" />
              </template>
            </div>
            <div class="grid content-start items-center gap-3 sm:grid-cols-[90px_minmax(0,1fr)]">
              <label class="text-xs text-muted-foreground" for="bot-name">Name</label>
              <Input id="bot-name" v-model="editor.name" class="h-8 text-xs" placeholder="Fable" autocomplete="off" maxlength="40" />
              <span class="text-xs text-muted-foreground">Harness</span>
              <SettingsChoice :model-value="editor.fields.harness" :options="HARNESS_CHOICES" aria-label="Harness" segmented @update:model-value="chooseHarness" />
              <template v-if="presetOptions.length">
                <label class="text-xs text-muted-foreground" for="bot-copy-profile">Copy from</label>
                <SettingsChoice id="bot-copy-profile" :model-value="null" :options="presetOptions" placeholder="A profile's settings…" aria-label="Copy a profile's settings" @update:model-value="copyProfile" />
              </template>
              <HarnessProfileFields v-model:fields="editor.fields" :catalog="catalog" :supports-service-tier="supportsServiceTier(editor.fields.harness)" id-prefix="bot" />
              <span class="text-xs text-muted-foreground">Projects</span>
              <p v-if="editorIsAssistant" class="text-xs text-muted-foreground">All projects. The assistant also adds and renames projects.</p>
              <SettingsChoice v-else v-model="editor.purviewKind" :options="PURVIEW_KINDS" aria-label="Projects" segmented />
              <template v-if="!editorIsAssistant && editor.purviewKind === 'projects'">
                <span />
                <div class="flex max-h-36 flex-col gap-1.5 overflow-y-auto rounded-md border border-border px-2.5 py-2">
                  <label v-for="project in userProjects" :key="project.id" class="flex items-center gap-2 text-xs">
                    <Checkbox :model-value="editor.projectIds.includes(project.id)" @update:model-value="(on) => toggleProject(project.id, on === true)" />
                    <span class="truncate">{{ project.name }}</span>
                  </label>
                  <span v-if="!userProjects.length" class="text-xs text-muted-foreground">No projects yet.</span>
                </div>
              </template>
              <template v-if="!editorIsAssistant">
                <span />
                <p class="-mt-1 text-xs text-muted-foreground">{{ editor.purviewKind === 'projects' ? 'Lists in these projects only.' : 'Lists in every project.' }}</p>
              </template>
              <template v-if="!editor.isNew">
                <label class="text-xs text-muted-foreground" for="bot-enabled">On</label>
                <div class="flex items-center gap-2">
                  <Switch id="bot-enabled" v-model="editor.enabled" />
                  <span class="text-xs text-muted-foreground">Off stops it and hides it until you turn it back on. Its conversation resumes then.</span>
                </div>
              </template>
              <label class="text-xs text-muted-foreground" for="bot-memory">Memory</label>
              <div class="flex items-center gap-2">
                <Switch id="bot-memory" v-model="editor.memory" />
                <span class="text-xs text-muted-foreground">{{ editorIsAssistant ? 'Shared memory for the assistant, routines and agents in every project.' : 'Reads and adds to the shared memory.' }}</span>
              </div>
              <template v-if="editor.memory">
                <label class="text-xs text-muted-foreground" for="bot-memory-budget">Budget</label>
                <SettingsChoice id="bot-memory-budget" v-model="editor.memoryBudgetTokens" :options="MEMORY_BUDGETS" aria-label="Memory context budget" />
              </template>
              <label class="text-xs text-muted-foreground" for="bot-digests">Digests</label>
              <div class="flex items-center gap-2">
                <Switch id="bot-digests" v-model="editor.digests" />
                <span class="text-xs text-muted-foreground">Sends it a short summary when agents in its projects need you or finish.</span>
              </div>
              <label class="text-xs text-muted-foreground" for="bot-focus">Focus mode</label>
              <div class="flex items-center gap-2">
                <Switch id="bot-focus" v-model="editor.focus" />
                <span class="text-xs text-muted-foreground">Lets it hold notifications, messages and reports until you're done focusing.</span>
              </div>
              <label class="text-xs text-muted-foreground" for="bot-requests">Agent requests</label>
              <div class="flex items-center gap-2">
                <Switch id="bot-requests" v-model="editor.requests" />
                <span class="text-xs text-muted-foreground">Lets it reject permission requests and answer questions waiting for you in its projects, and approve one-time reads of ordinary workspace and skill files. You're still notified.</span>
              </div>
              <template v-if="!host">
                <label class="text-xs text-muted-foreground" for="bot-discord">Discord</label>
                <div class="flex items-center gap-2">
                  <Switch id="bot-discord" v-model="editor.discord.enabled" />
                  <span class="text-xs text-muted-foreground">Answers your mentions and DMs on Discord with short replies, and pings you there when work you started finishes.</span>
                </div>
                <template v-if="editor.discord.enabled">
                  <label class="text-xs text-muted-foreground" for="bot-discord-token">Bot token</label>
                  <div class="flex items-center gap-2">
                    <Input id="bot-discord-token" v-model="editor.discord.token" type="password" class="h-8 text-xs" :placeholder="editor.discord.status?.token_saved ? 'Saved. Paste a new one to replace it' : 'From your Discord application\'s Bot page'" autocomplete="off" spellcheck="false" />
                    <Button v-if="editor.discord.status?.token_saved" type="button" size="sm" variant="ghost" class="h-7 shrink-0 px-2 text-destructive hover:text-destructive" :disabled="saving" @click="removeDiscordToken">Remove</Button>
                  </div>
                  <label class="text-xs text-muted-foreground" for="bot-discord-users">Your user ID</label>
                  <Input id="bot-discord-users" v-model="editor.discord.ids" class="h-8 text-xs" placeholder="123456789012345678" autocomplete="off" spellcheck="false" />
                  <span />
                  <p class="-mt-1 text-xs text-muted-foreground">
                    Create an application in the Discord Developer Portal, add a bot, and invite it to your server with Send Messages, Add Reactions and Read Message History. It ignores everyone except the user IDs here; separate several with commas.
                    <span v-if="editor.discord.status?.enabled" :class="cn('block pt-1', discordStatusTone(editor.discord.status))">{{ discordStatusText(editor.discord.status) }}</span>
                  </p>
                </template>
              </template>
              <label class="text-xs text-muted-foreground" for="bot-voice">Voice</label>
              <div class="flex items-center gap-2">
                <Switch id="bot-voice" v-model="editor.voice.enabled" />
                <span class="text-xs text-muted-foreground">{{ editorSupportsVoice ? 'Talk to it in a GPT-Live voice call.' : 'Voice calls are not supported by this harness.' }}</span>
              </div>
              <template v-if="editor.voice.enabled">
                <label class="text-xs text-muted-foreground" for="bot-voice-name">Speaks as</label>
                <SettingsChoice id="bot-voice-name" v-model="editor.voice.voice" :options="voiceOptions" aria-label="Voice" />
                <span class="text-xs text-muted-foreground">Voice profile</span>
                <SettingsChoice v-model="editor.voice.profile" :options="VOICE_PROFILES" aria-label="Voice profile" segmented />
                <span class="text-xs text-muted-foreground">Acknowledge</span>
                <SettingsChoice v-model="editor.voice.acknowledgements" :options="ACKNOWLEDGEMENTS" aria-label="Acknowledgements" segmented />
                <span />
                <p class="-mt-1 text-xs text-muted-foreground">Patterm answers status questions itself and hands longer jobs to agents. Acknowledgements are short spoken reassurances, such as "Let me check".</p>
              </template>
              <template v-if="editor.avatar.kind === 'emoji'">
                <label class="text-xs text-muted-foreground" for="bot-emoji">Emoji</label>
                <div class="flex flex-wrap items-center gap-1">
                  <button v-for="emoji in EMOJI" :key="emoji" type="button" :class="cn('flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-muted/60', editor.avatar.emoji === emoji && 'bg-white/[0.1] ring-1 ring-inset ring-white/[0.16]')" :aria-label="`Use ${emoji}`" @click="editor.avatar.emoji = emoji">{{ emoji }}</button>
                  <Input id="bot-emoji" :model-value="editor.avatar.emoji ?? ''" class="h-8 w-16 text-center text-base" placeholder="🙂" autocomplete="off" aria-label="Any emoji" @update:model-value="(value) => { editor!.avatar.emoji = String(value).trim() || null; }" />
                </div>
              </template>
            </div>
          </div>
          <div class="space-y-1.5">
            <label class="text-xs text-muted-foreground" for="bot-about">About</label>
            <Textarea id="bot-about" v-model="editor.instructions" rows="3" maxlength="2000" class="min-h-16 text-xs" placeholder="What it looks after, or how you'd like it to talk. Added to its instructions." />
          </div>
          <FaceMaker v-if="editor.avatar.kind === 'face'" v-model="editor.avatar.look" />
          <p v-if="editorError" role="alert" class="text-xs text-destructive">{{ editorError }}</p>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" @click="editorOpen = false">Cancel</Button>
            <Button type="submit" size="sm" :disabled="saving">{{ editor.isNew ? 'Add bot' : 'Save' }}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog :open="restart !== null" @update:open="(open) => { if (!open) restart = null; }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Restart {{ restart?.name }}?</DialogTitle>
          <DialogDescription>{{ restart?.need === 'harness' ? `It moves to ${harnessLabel(restart.harness)} when it restarts, on a new conversation or the last one it had there.` : 'Its new settings apply when it restarts. It can carry on its conversation or start a new one.' }}</DialogDescription>
        </DialogHeader>
        <p v-if="restartError" role="alert" class="text-xs text-destructive">{{ restartError }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" :disabled="restarting" @click="restart = null">Later</Button>
          <Button v-if="restart?.need === 'harness'" type="button" size="sm" :disabled="restarting" @click="restartNow(false)">Restart</Button>
          <template v-else>
            <Button type="button" variant="outline" size="sm" :disabled="restarting" @click="restartNow(true)">New conversation</Button>
            <Button type="button" size="sm" :disabled="restarting" @click="restartNow(false)">Resume conversation</Button>
          </template>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Dices } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { isSingleEmoji } from '../../../app/Bots/BotAvatar';
import { useBots } from '../Composables/useBots';
import { useWorkbench } from '../Composables/useWorkbench';
import { botPicture } from '../lib/botPicture';
import { botProcess, discordStatus, isAssistantBot, parseDiscordIds, plainBot, readBots, restartBotFromSettings, restartNeed, saveBots, saveDiscordToken, type Bot, type BotAvatar as Avatar, type BotPurview, type BotSettings, type BotVoice, type DiscordBotStatus } from '../lib/bots';
import { autosave } from '../Composables/useSettingsAutosave';
import { facePalette, randomLook } from '../lib/faces';
import { harnessLabel } from '../lib/harnesses';
import { DEFAULT_MODEL, PROFILE_HARNESSES, emptyModelCatalog, fieldsFrom, settingsFrom, settingsSummary, type ModelCatalog, type ProfileFieldsState, type ProfileHarness } from '../lib/profileFields';
import { profileName, type ProfileSettings } from '../lib/profiles';
import { readFileAsDataUrl } from '../lib/projectLogo';
import { randomId } from '../lib/randomId';
import { harnessModels, harnessPresets } from '../lib/serverQuery';
import type { HarnessInstallationRecord } from '../types';
import BotAvatar from './BotAvatar.vue';
import FaceMaker from './FaceMaker.vue';
import HarnessProfileFields from './HarnessProfileFields.vue';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsItem from './settings/SettingsItem.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { useSettingsHost } from './settings/settingsHost';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';

interface EditorState {
  id: string;
  isNew: boolean;
  name: string;
  fields: ProfileFieldsState;
  avatar: Avatar;
  purviewKind: BotPurview['kind'];
  projectIds: string[];
  instructions: string;
  enabled: boolean;
  memory: boolean;
  memoryBudgetTokens: Bot['memoryBudgetTokens'];
  voice: BotVoice;
  digests: boolean;
  focus: boolean;
  requests: boolean;
  // ids: the allowed user IDs as typed. token: a new token to save; blank
  // keeps the saved one.
  discord: { enabled: boolean; ids: string; token: string; status: DiscordBotStatus | null };
}

const AVATAR_KINDS = [
  { value: 'face' as const, label: 'Face' },
  { value: 'emoji' as const, label: 'Emoji' },
  { value: 'picture' as const, label: 'Picture' },
  { value: 'mark' as const, label: 'Mark' }
];
const MEMORY_BUDGETS = [
  { value: 2000 as const, label: '≈ 2,000 tokens' },
  { value: 4000 as const, label: '≈ 4,000 tokens' },
  { value: 8000 as const, label: '≈ 8,000 tokens' }
];
const VOICE_PROFILES = [
  { value: 'codex' as const, label: 'Codex default' },
  { value: 'patterm' as const, label: 'Patterm' }
];
const ACKNOWLEDGEMENTS = [
  { value: 'default' as const, label: 'Default' },
  { value: 'on' as const, label: 'On' },
  { value: 'off' as const, label: 'Off' }
];
const PURVIEW_KINDS = [
  { value: 'none' as const, label: 'None' },
  { value: 'projects' as const, label: 'Chosen' },
  { value: 'all' as const, label: 'All' }
];
const HARNESS_CHOICES = PROFILE_HARNESSES.map((harness) => ({ value: harness, label: harnessLabel(harness) }));
const EMOJI = ['🦊', '🐙', '🦉', '🐢', '🤖', '🌱', '⚡', '🧠', '🎩', '🍄'];

const host = useSettingsHost().value;
const route = useRoute();
const router = useRouter();
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
const presetOptions = computed(() => presets.value.presets.map((preset) => ({ value: preset.id as string | null, label: `${profileName(preset)} · ${harnessLabel(preset.harness)}` })));
const editorIsAssistant = computed(() => editor.value ? isAssistantBot(editor.value) : false);
const editorHarness = computed(() => editor.value?.fields.harness ?? null);
function supportsServiceTier(harness: ProfileHarness): boolean | undefined {
  return harnesses.value.find((item) => item.harness === harness)?.capabilities?.features.serviceTier;
}
const editorSupportsVoice = computed(() => editorHarness.value ? (harnesses.value.find((item) => item.harness === editorHarness.value)?.capabilities?.features.voice ?? editorHarness.value === 'codex') : false);
const voiceOptions = computed(() => [
  { value: null as string | null, label: 'Default' },
  ...voices.value.map((voice) => ({ value: voice as string | null, label: voice[0]!.toUpperCase() + voice.slice(1) }))
]);

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
const editor = ref<EditorState | null>(null);
const editorOpen = ref(false);
const editorTitle = ref('');
const editorError = ref('');
const error = ref('');
const saving = ref(false);
const pictureInput = ref<HTMLInputElement | null>(null);
// A running bot whose saved changes apply once it restarts.
const restart = ref<{ processId: string; name: string; harness: Bot['harness']; need: 'harness' | 'settings' } | null>(null);
const restartError = ref('');
const restarting = ref(false);

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
  // Links such as Edit bot… from a bot's page open its editor.
  // The link opens it once, so search, which mounts this panel again, doesn't reopen it.
  const requested = typeof route.query.bot === 'string' ? bots.value.find((bot) => bot.id === route.query.bot) : null;
  if (route.query.bot !== undefined) void router.replace({ query: { ...route.query, bot: undefined } });
  if (requested) editBot(requested);
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

function newFace(): Avatar['look'] {
  return randomLook(Math.floor(Math.random() * 2 ** 32));
}

// The CLI on its own configuration, as a harness with no profile launches.
function defaultFields(harness: ProfileHarness): ProfileFieldsState {
  return { harness, model: DEFAULT_MODEL, customModel: '', reasoning: '', serviceTier: '' };
}

// A new bot starts with the default Claude Code profile's settings.
function newBotFields(): ProfileFieldsState {
  const id = presets.value.defaultPresetIdByHarness.claude ?? presets.value.presets[0]?.id;
  const preset = presets.value.presets.find((candidate) => candidate.id === id);
  return preset ? fieldsFrom(catalog.value, preset.harness, preset) : defaultFields('claude');
}

function chooseHarness(harness: ProfileHarness): void {
  if (editor.value) editor.value.fields = defaultFields(harness);
}

// Copies a profile's settings into the bot once. The bot keeps its copy when
// the profile changes later.
function copyProfile(presetId: string | null): void {
  const preset = presets.value.presets.find((candidate) => candidate.id === presetId);
  if (editor.value && preset) editor.value.fields = fieldsFrom(catalog.value, preset.harness, preset);
}

function addBot(): void {
  editorError.value = '';
  editor.value = {
    id: `bot_${randomId()}`, isNew: true, name: '', fields: newBotFields(), avatar: { kind: 'face', look: newFace(), emoji: null, picture: null }, purviewKind: 'none', projectIds: [], instructions: '',
    enabled: true, memory: true, memoryBudgetTokens: 4000, voice: { enabled: false, voice: null, profile: 'codex', acknowledgements: 'default' }, digests: false, focus: false, requests: false,
    discord: { enabled: false, ids: '', token: '', status: null }
  };
  editorOpen.value = true;
}

function editBot(bot: Bot): void {
  editorError.value = '';
  editorTitle.value = bot.name;
  editor.value = {
    id: bot.id, isNew: false, name: bot.name, fields: fieldsFrom(catalog.value, bot.harness, bot),
    avatar: { ...bot.avatar, look: { ...bot.avatar.look } },
    purviewKind: bot.purview.kind, projectIds: bot.purview.kind === 'projects' ? [...bot.purview.projectIds] : [],
    instructions: bot.instructions, enabled: bot.enabled, memory: bot.memory, memoryBudgetTokens: bot.memoryBudgetTokens,
    voice: { ...bot.voice }, digests: bot.digests, focus: bot.focus, requests: bot.requests,
    discord: { enabled: bot.discord?.enabled ?? false, ids: (bot.discord?.allowedUserIds ?? []).join(', '), token: '', status: null }
  };
  editorOpen.value = true;
  void refreshDiscordStatus();
}

// The editor shows whether the bot is connected, checking again while it
// connects.
let discordTimer: ReturnType<typeof setTimeout> | undefined;
async function refreshDiscordStatus(): Promise<void> {
  clearTimeout(discordTimer);
  const current = editor.value;
  if (host || !current || current.isNew || !editorOpen.value) return;
  try {
    const status = await discordStatus(current.id);
    if (editor.value !== current) return;
    current.discord.status = status;
    if (status.state === 'connecting' || (status.state === 'error' && status.error?.endsWith('retrying'))) discordTimer = setTimeout(() => { void refreshDiscordStatus(); }, 2000);
  } catch {
    // An older server without Discord: leave the status out.
  }
}
watch(editorOpen, (open) => { if (!open) clearTimeout(discordTimer); });
onBeforeUnmount(() => clearTimeout(discordTimer));

function discordStatusText(status: DiscordBotStatus): string {
  if (status.state === 'connected') return `Connected as ${status.user?.username ?? 'the bot'}.`;
  if (status.state === 'connecting') return 'Connecting…';
  if (status.state === 'error') return status.error ?? 'Couldn\'t connect.';
  return status.reason ? `${status.reason}.` : 'Not connected.';
}

function discordStatusTone(status: DiscordBotStatus): string {
  return status.state === 'error' ? 'text-destructive' : status.state === 'connected' ? 'text-foreground' : '';
}

async function removeDiscordToken(): Promise<void> {
  const current = editor.value;
  if (!current || !window.confirm('Remove the saved Discord bot token? The bot disconnects from Discord.')) return;
  try {
    current.discord.status = await saveDiscordToken(current.id, null);
    current.discord.token = '';
  } catch (caught) {
    editorError.value = caught instanceof Error ? caught.message : String(caught);
  }
}

function shuffleFace(): void {
  if (editor.value) editor.value.avatar.look = newFace();
}

function toggleProject(projectId: string, on: boolean): void {
  const current = editor.value;
  if (!current) return;
  current.projectIds = on ? [...new Set([...current.projectIds, projectId])] : current.projectIds.filter((id) => id !== projectId);
}

async function choosePicture(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !editor.value) return;
  try {
    editor.value.avatar.picture = await botPicture(await readFileAsDataUrl(file));
    editorError.value = '';
  } catch {
    editorError.value = 'That picture could not be read.';
  }
}

async function persist(next: Bot[], name = activeSettings.value.userName): Promise<boolean> {
  saving.value = true;
  try {
    const saved = await saveBots({ bots: next.map(plainBot), userName: name }, host);
    if (host) remoteSettings.value = saved;
    else localSettings.value = saved;
    error.value = '';
    return true;
  } catch (caught) {
    editorError.value = error.value = caught instanceof Error ? caught.message : String(caught);
    return false;
  } finally {
    saving.value = false;
  }
}

async function applyEditor(): Promise<void> {
  const current = editor.value;
  if (!current) return;
  const name = current.name.trim();
  if (!name) { editorError.value = 'Give the bot a name.'; return; }
  if (bots.value.some((bot) => bot.id !== current.id && bot.name.toLowerCase() === name.toLowerCase())) { editorError.value = `A bot named '${name}' already exists.`; return; }
  const profile = settingsFrom(current.fields, supportsServiceTier(current.fields.harness));
  if ('error' in profile) { editorError.value = profile.error; return; }
  if (current.avatar.kind === 'emoji' && !(current.avatar.emoji && isSingleEmoji(current.avatar.emoji))) { editorError.value = 'Choose one emoji.'; return; }
  if (current.avatar.kind === 'picture' && !current.avatar.picture) { editorError.value = 'Choose a picture.'; return; }
  if (current.purviewKind === 'projects' && !current.projectIds.length) { editorError.value = 'Choose at least one project, or None.'; return; }
  const before = bots.value.find((candidate) => candidate.id === current.id);
  // A paired host's bot keeps its Discord settings, which are set up there.
  let discord = before?.discord;
  if (!host) {
    const parsed = parseDiscordIds(current.discord.ids);
    if ('error' in parsed) { editorError.value = parsed.error; return; }
    if (current.discord.enabled && !parsed.ids.length) { editorError.value = 'Add your Discord user ID, so the bot knows whose messages to answer.'; return; }
    discord = { enabled: current.discord.enabled, allowedUserIds: parsed.ids };
  }
  const token = current.discord.token.trim();
  const purview: BotPurview = editorIsAssistant.value ? { kind: 'all' } : current.purviewKind === 'projects' ? { kind: 'projects', projectIds: current.projectIds } : { kind: current.purviewKind };
  const bot: Bot = {
    id: current.id, name, harness: current.fields.harness, ...profile, avatar: current.avatar, purview, instructions: current.instructions.trim(),
    enabled: current.enabled, memory: current.memory, memoryBudgetTokens: current.memoryBudgetTokens, voice: { ...current.voice }, digests: current.digests, focus: current.focus, requests: current.requests,
    ...(discord ? { discord } : {})
  };
  const next = current.isNew ? [...bots.value, bot] : bots.value.map((candidate) => candidate.id === bot.id ? bot : candidate);
  if (!await persist(next)) return;
  // The token saves once the bot exists. A rejected token keeps the editor
  // open with the reason; the rest is already saved.
  if (!host && token) {
    try {
      current.discord.status = await saveDiscordToken(bot.id, token);
      current.discord.token = '';
      current.isNew = false;
    } catch (caught) {
      current.isNew = false;
      editorError.value = caught instanceof Error ? caught.message : String(caught);
      return;
    }
  }
  editorOpen.value = false;
  const need = before && bot.enabled ? restartNeed(before, bot) : null;
  const processId = need ? await botProcess(host ? `${host}:${bot.id}` : bot.id).catch(() => null) : null;
  if (need && processId) {
    restartError.value = '';
    restart.value = { processId, name, harness: bot.harness, need };
  }
}

async function restartNow(fresh: boolean): Promise<void> {
  const target = restart.value;
  if (!target) return;
  restarting.value = true;
  try {
    await restartBotFromSettings(target.processId, fresh);
    restart.value = null;
  } catch (caught) {
    restartError.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    restarting.value = false;
  }
}

function toggleEnabled(bot: Bot, enabled: boolean): void {
  if (bot.enabled === enabled) return;
  const next = bots.value.map((candidate) => candidate.id === bot.id ? { ...candidate, enabled } : candidate);
  void autosave(`bots.${bot.id}`, async () => {
    if (!await persist(next)) throw new Error(error.value || `Could not update ${bot.name}`);
  });
}

async function removeBot(bot: Bot): Promise<void> {
  if (!window.confirm(`Delete ${bot.name}? Its conversation stops, and its helpers keep running in their projects.`)) return;
  await persist(bots.value.filter((candidate) => candidate.id !== bot.id));
}
</script>
