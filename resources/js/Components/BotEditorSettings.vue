<template>
  <div>
    <Button type="button" variant="ghost" size="sm" class="-ml-2 mb-3 h-7 gap-1 px-2 text-xs text-muted-foreground" @click="emit('back')">
      <ChevronLeft class="h-3.5 w-3.5" />
      Bots
    </Button>
    <SettingsPanel :title="bot.name" :description="summary">
      <template #actions>
        <div class="flex items-center gap-2">
          <Switch
            :model-value="bot.enabled"
            :aria-label="`Turn ${bot.name} ${bot.enabled ? 'off' : 'on'}`"
            title="Off stops it and hides it until turned back on"
            @update:model-value="saveEnabled(Boolean($event))"
          />
          <Button v-if="!isAssistant" type="button" size="sm" variant="ghost" class="h-7 px-2 text-destructive hover:text-destructive" @click="emit('remove')">Delete</Button>
        </div>
      </template>

      <div v-if="restart" class="flex flex-col gap-2 py-4 [@container(min-width:36rem)]:flex-row [@container(min-width:36rem)]:items-center [@container(min-width:36rem)]:justify-between">
        <p class="text-xs text-muted-foreground">{{ restart.need === 'harness' ? `${bot.name} moves to ${harnessLabel(bot.harness)} when it restarts, on a new conversation or the last one it had there.` : `Its new settings apply when ${bot.name} restarts.` }}<span v-if="restart.error" class="block text-destructive">{{ restart.error }}</span></p>
        <div class="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="restart.busy" @click="emit('dismissRestart')">Later</Button>
          <Button v-if="restart.need !== 'harness'" type="button" variant="outline" size="sm" class="h-7 text-xs" :disabled="restart.busy" @click="emit('restart', true)">New conversation</Button>
          <Button type="button" size="sm" class="h-7 text-xs" :disabled="restart.busy" @click="emit('restart', false)">{{ restart.need === 'harness' ? 'Restart' : 'Resume conversation' }}</Button>
        </div>
      </div>

      <SettingsSection title="Profile" :scope="`${scope}.profile`">
        <SettingsRow label="Name" html-for="bot-name" :save-key="`${scope}.profile.name`">
          <Input id="bot-name" v-model="name" class="h-8 w-full text-xs [@container(min-width:26rem)]:w-56" placeholder="Fable" autocomplete="off" maxlength="40" @update:model-value="later('name', saveName)" @blur="now('name')" @keydown.enter="now('name')" />
        </SettingsRow>
        <SettingsRow label="About" description="What it looks after, or how you'd like it to talk. Added to its instructions." html-for="bot-about" :save-key="`${scope}.profile.about`">
          <template #below>
            <Textarea id="bot-about" v-model="about" rows="3" maxlength="2000" class="min-h-16 text-xs" placeholder="Looks after the website and keeps me posted on deploys." @update:model-value="later('about', saveAbout)" @blur="now('about')" />
          </template>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Avatar" :scope="`${scope}.avatar`" keywords="face emoji picture">
        <div class="flex items-center gap-4">
          <div class="flex h-20 w-20 shrink-0 items-center justify-center rounded-full" :style="halo">
            <BotAvatar :avatar="{ ...bot.avatar, look }" :size="64" motion />
          </div>
          <div class="flex min-w-0 flex-col items-start gap-2">
            <SettingsChoice :model-value="avatarKind" :options="AVATAR_KINDS" aria-label="Avatar" segmented @update:model-value="chooseKind" />
            <Button v-if="avatarKind === 'face'" type="button" size="sm" variant="outline" class="h-7 gap-1.5 text-xs" @click="saveLook(newFace())">
              <Dices class="h-3.5 w-3.5" />
              Shuffle
            </Button>
            <template v-else-if="avatarKind === 'picture'">
              <Button type="button" size="sm" variant="outline" class="h-7 text-xs" @click="pictureInput?.click()">{{ bot.avatar.picture ? 'Change picture' : 'Choose picture' }}</Button>
              <input ref="pictureInput" type="file" accept="image/*" class="hidden" @change="choosePicture" />
            </template>
          </div>
        </div>
        <p v-if="avatarError" role="alert" class="text-xs text-destructive">{{ avatarError }}</p>
        <FaceMaker v-if="avatarKind === 'face'" :model-value="look" @update:model-value="saveLook" />
        <div v-else-if="avatarKind === 'emoji'" class="flex flex-wrap items-center gap-1">
          <button v-for="emoji in EMOJI" :key="emoji" type="button" :class="cn('flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-muted/60', bot.avatar.emoji === emoji && 'bg-white/[0.1] ring-1 ring-inset ring-white/[0.16]')" :aria-label="`Use ${emoji}`" @click="saveAvatar({ kind: 'emoji', emoji })">{{ emoji }}</button>
          <Input :model-value="customEmoji" class="h-8 w-16 text-center text-base" placeholder="🙂" autocomplete="off" aria-label="Any emoji" @update:model-value="typeEmoji(String($event))" />
        </div>
      </SettingsSection>

      <SettingsSection title="Model" :scope="`${scope}.model`" keywords="harness reasoning speed profile">
        <SettingsRow label="Harness" description="Changing it starts a new conversation." :save-key="`${scope}.model.harness`">
          <SettingsChoice :model-value="fields.harness" :options="HARNESS_CHOICES" aria-label="Harness" segmented @update:model-value="chooseHarness" />
        </SettingsRow>
        <SettingsRow v-if="presetOptions.length" label="Copy from" description="Copies a profile's settings once. Later changes to the profile don't reach the bot." html-for="bot-copy-profile">
          <SettingsChoice id="bot-copy-profile" :model-value="null" :options="presetOptions" placeholder="A profile's settings…" aria-label="Copy a profile's settings" @update:model-value="copyProfile" />
        </SettingsRow>
        <SettingsRow label="Model" html-for="bot-model" :save-key="`${scope}.model.model`">
          <SettingsChoice id="bot-model" :model-value="fields.model" :options="modelChoices(catalog, fields.harness)" aria-label="Model" @update:model-value="(value) => { changeModel(catalog, fields, value); saveModel(); }" />
        </SettingsRow>
        <SettingsRow v-if="fields.model === CUSTOM_MODEL" label="Custom ID" html-for="bot-custom-model" inset>
          <Input id="bot-custom-model" v-model="fields.customModel" class="h-8 w-full text-xs [@container(min-width:26rem)]:w-56" placeholder="claude-opus-4-8" autocomplete="off" @update:model-value="later('model', saveModel)" @blur="now('model')" />
        </SettingsRow>
        <SettingsRow label="Reasoning" html-for="bot-reasoning" :disabled="fields.model === DEFAULT_MODEL">
          <SettingsChoice id="bot-reasoning" :model-value="fields.reasoning" :options="reasoningChoices(catalog, fields)" aria-label="Reasoning" :disabled="fields.model === DEFAULT_MODEL" @update:model-value="(value) => { fields.reasoning = value; saveModel(); }" />
        </SettingsRow>
        <SettingsRow v-if="showServiceTier" label="Speed" html-for="bot-speed">
          <SettingsChoice id="bot-speed" :model-value="fields.serviceTier" :options="speedChoices(catalog, fields)" aria-label="Speed" @update:model-value="(value) => { fields.serviceTier = value; saveModel(); }" />
        </SettingsRow>
        <p v-if="modelError" role="alert" class="text-xs text-destructive">{{ modelError }}</p>
      </SettingsSection>

      <SettingsSection title="Projects" :scope="`${scope}.projects`" keywords="purview">
        <SettingsRow v-if="isAssistant" label="Works in" description="All projects. The assistant also adds and renames projects." />
        <SettingsRow v-else label="Works in" :description="purviewKind === 'projects' ? 'It lists in these projects only.' : purviewKind === 'all' ? 'It lists in every project.' : 'It only talks, and starts no agents.'" :save-key="`${scope}.projects.kind`">
          <SettingsChoice :model-value="purviewKind" :options="PURVIEW_KINDS" aria-label="Projects" segmented @update:model-value="choosePurview" />
          <template v-if="purviewKind === 'projects'" #below>
            <div class="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-md border border-white/[0.06] px-3 py-2.5">
              <label v-for="project in projects" :key="project.id" class="flex items-center gap-2 text-xs">
                <Checkbox :model-value="projectIds.includes(project.id)" @update:model-value="(on) => toggleProject(project.id, on === true)" />
                <span class="truncate">{{ project.name }}</span>
              </label>
              <span v-if="!projects.length" class="text-xs text-muted-foreground">No projects yet.</span>
            </div>
            <p v-if="!projectIds.length" class="mt-2 text-xs text-muted-foreground">Choose at least one project.</p>
          </template>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Behaviour" :scope="`${scope}.behaviour`">
        <SettingsRow label="Memory" :description="isAssistant ? 'Shared memory for the assistant, routines and agents in every project.' : 'Reads and adds to the shared memory.'" html-for="bot-memory" :save-key="`${scope}.behaviour.memory`" toggle>
          <Switch id="bot-memory" :model-value="bot.memory" @update:model-value="save('behaviour.memory', { memory: Boolean($event) })" />
        </SettingsRow>
        <SettingsRow v-if="bot.memory" label="Budget" description="How much memory it reads at the start of a conversation." html-for="bot-memory-budget" :save-key="`${scope}.behaviour.budget`" inset>
          <SettingsChoice id="bot-memory-budget" :model-value="bot.memoryBudgetTokens" :options="MEMORY_BUDGETS" aria-label="Memory context budget" @update:model-value="save('behaviour.budget', { memoryBudgetTokens: $event })" />
        </SettingsRow>
        <SettingsRow label="Digests" description="Sends it a short summary when agents in its projects need you or finish." html-for="bot-digests" :save-key="`${scope}.behaviour.digests`" toggle>
          <Switch id="bot-digests" :model-value="bot.digests" @update:model-value="save('behaviour.digests', { digests: Boolean($event) })" />
        </SettingsRow>
        <SettingsRow label="Focus mode" description="Lets it hold notifications, messages and reports until you're done focusing." html-for="bot-focus" :save-key="`${scope}.behaviour.focus`" toggle>
          <Switch id="bot-focus" :model-value="bot.focus" @update:model-value="save('behaviour.focus', { focus: Boolean($event) })" />
        </SettingsRow>
        <SettingsRow label="Agent requests" description="Lets it reject permission requests and answer questions waiting for you in its projects, and approve one-time reads of ordinary workspace and skill files. You're still notified." html-for="bot-requests" :save-key="`${scope}.behaviour.requests`" toggle>
          <Switch id="bot-requests" :model-value="bot.requests" @update:model-value="save('behaviour.requests', { requests: Boolean($event) })" />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Voice" :scope="`${scope}.voice`">
        <SettingsRow label="Voice calls" :description="supportsVoice ? 'Talk to it in a GPT-Live voice call.' : 'Voice calls are not supported by this harness.'" html-for="bot-voice" :save-key="`${scope}.voice.enabled`" toggle>
          <Switch id="bot-voice" :model-value="bot.voice.enabled" @update:model-value="saveVoice('enabled', { enabled: Boolean($event) })" />
        </SettingsRow>
        <template v-if="bot.voice.enabled">
          <SettingsRow label="Speaks as" html-for="bot-voice-name" :save-key="`${scope}.voice.voice`" inset>
            <SettingsChoice id="bot-voice-name" :model-value="bot.voice.voice" :options="voiceOptions" aria-label="Voice" @update:model-value="saveVoice('voice', { voice: $event })" />
          </SettingsRow>
          <SettingsRow label="Voice profile" description="Patterm answers status questions itself and hands longer jobs to agents." :save-key="`${scope}.voice.profile`" inset>
            <SettingsChoice :model-value="bot.voice.profile" :options="VOICE_PROFILES" aria-label="Voice profile" segmented @update:model-value="saveVoice('profile', { profile: $event })" />
          </SettingsRow>
          <SettingsRow label="Acknowledge" description="Short spoken reassurances, such as &quot;Let me check&quot;." :save-key="`${scope}.voice.acknowledgements`" inset>
            <SettingsChoice :model-value="bot.voice.acknowledgements" :options="ACKNOWLEDGEMENTS" aria-label="Acknowledgements" segmented @update:model-value="saveVoice('acknowledgements', { acknowledgements: $event })" />
          </SettingsRow>
        </template>
      </SettingsSection>

      <SettingsSection v-if="!host" title="Discord" :scope="`${scope}.discord`" keywords="mentions dm token">
        <template #description>Create an application in the Discord Developer Portal. On its Bot page, copy the token and turn on Message Content Intent, so the bot can read messages you tag it in a reply to. Once it connects, add it to a server from here.</template>
        <SettingsRow label="Answer on Discord" description="Answers your mentions and DMs with short replies, and pings you there when work you started finishes." html-for="bot-discord" :save-key="`${scope}.discord.enabled`" toggle>
          <Switch id="bot-discord" :model-value="Boolean(bot.discord?.enabled)" @update:model-value="saveDiscord('enabled', { enabled: Boolean($event) })" />
        </SettingsRow>
        <template v-if="bot.discord?.enabled">
          <SettingsRow label="Bot token" description="From your Discord application's Bot page. It can't be shown again." html-for="bot-discord-token" :save-key="`${scope}.discord.token`" inset>
            <div class="flex w-full items-center gap-2 [@container(min-width:26rem)]:w-auto">
              <Input id="bot-discord-token" v-model="token" type="password" class="h-8 w-full text-xs [@container(min-width:26rem)]:w-56" :placeholder="status?.token_saved ? 'Saved' : 'Paste the token'" autocomplete="off" spellcheck="false" @keydown.enter="saveToken" />
              <Button v-if="token.trim()" type="button" size="sm" variant="outline" class="h-8 shrink-0 text-xs" @click="saveToken">Save</Button>
              <Button v-else-if="status?.token_saved" type="button" size="sm" variant="ghost" class="h-8 shrink-0 px-2 text-xs text-destructive hover:text-destructive" @click="removeToken">Remove</Button>
            </div>
          </SettingsRow>
          <SettingsRow label="Your user ID" description="In Discord, turn on Developer Mode, then right-click your name and choose Copy User ID. Separate several with commas." html-for="bot-discord-users" :save-key="`${scope}.discord.users`" inset>
            <Input id="bot-discord-users" v-model="userIds" class="h-8 w-full text-xs [@container(min-width:26rem)]:w-56" placeholder="123456789012345678" autocomplete="off" spellcheck="false" @blur="saveUserIds" @keydown.enter="saveUserIds" />
          </SettingsRow>
          <SettingsRow v-if="status" label="Status" inset>
            <template v-if="status.invite_url" #description>Add the bot to a server you manage, then mention it there.</template>
            <div class="flex items-center gap-3">
              <span :class="cn('text-xs', status.state === 'error' ? 'text-destructive' : status.state === 'connected' ? 'text-foreground' : 'text-muted-foreground')">{{ statusText }}</span>
              <Button v-if="status.invite_url" as="a" :href="status.invite_url" target="_blank" rel="noopener noreferrer" size="sm" variant="outline" class="h-8 shrink-0 gap-1.5 text-xs">Add to server<ExternalLink class="h-3.5 w-3.5" /></Button>
            </div>
          </SettingsRow>
        </template>
      </SettingsSection>
    </SettingsPanel>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ChevronLeft, Dices, ExternalLink } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { isSingleEmoji } from '../../../app/Bots/BotAvatar';
import { autosave } from '../Composables/useSettingsAutosave';
import { botPicture } from '../lib/botPicture';
import { discordStatus, isAssistantBot, parseDiscordIds, saveDiscordToken, type Bot, type BotAvatar as Avatar, type BotPurview, type BotVoice, type DiscordBotStatus } from '../lib/bots';
import { facePalette, randomLook } from '../lib/faces';
import { harnessLabel } from '../lib/harnesses';
import { CUSTOM_MODEL, DEFAULT_MODEL, PROFILE_HARNESSES, changeModel, fieldsFrom, modelChoices, reasoningChoices, settingsFrom, speedChoices, tiersFor, type ModelCatalog, type ProfileFieldsState, type ProfileHarness } from '../lib/profileFields';
import { profileName, type ProfileSettings } from '../lib/profiles';
import { readFileAsDataUrl } from '../lib/projectLogo';
import type { HarnessInstallationRecord } from '../types';
import BotAvatar from './BotAvatar.vue';
import FaceMaker from './FaceMaker.vue';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsSection from './settings/SettingsSection.vue';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';

// One bot's settings, saved as they change like the rest of Settings.
// Every save sends the whole bot list with this bot's latest copy, one save
// at a time, so a later change never races an earlier one.
const props = defineProps<{
  bot: Bot;
  bots: Bot[];
  host: string | null;
  status: string;
  catalog: ModelCatalog;
  presets: ProfileSettings;
  harnesses: HarnessInstallationRecord[];
  voices: string[];
  projects: Array<{ id: string; name: string }>;
  // Saves a change to this bot. The list owns one queue for every save, so
  // each builds on the last, whichever page made it.
  // It names the bot, so a save still pending when the page closes reaches
  // this bot, whichever page opens next.
  update: (botId: string, key: string, patch: (bot: Bot) => Partial<Bot>) => Promise<boolean>;
  // A saved change that applies once the running bot restarts.
  restart: { need: 'harness' | 'settings'; busy: boolean; error: string } | null;
}>();
const emit = defineEmits<{ back: []; remove: []; restart: [fresh: boolean]; dismissRestart: [] }>();

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

const id = props.bot.id;
const scope = `bots.${id}`;
const isAssistant = computed(() => isAssistantBot(props.bot));
const current = (): Bot => props.bots.find((candidate) => candidate.id === id) ?? props.bot;

const summary = computed(() => {
  const purview = props.bot.purview;
  const where = purview.kind === 'none' ? 'No projects' : purview.kind === 'all' ? 'All projects' : purview.projectIds.length === 1 ? '1 project' : `${purview.projectIds.length} projects`;
  return `${harnessLabel(props.bot.harness)} · ${where} · ${props.status}`;
});

// Saving
function save(key: string, patch: Partial<Bot> | ((bot: Bot) => Partial<Bot>)): Promise<boolean> {
  return props.update(id, key, typeof patch === 'function' ? patch : () => patch);
}

// Text fields save once typing pauses, or when they lose focus.
const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>();
function later(key: string, run: () => void): void {
  clearTimeout(timers.get(key)?.timer);
  timers.set(key, { timer: setTimeout(() => now(key), 700), run });
}
function now(key: string): void {
  const pending = timers.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  timers.delete(key);
  pending.run();
}
onBeforeUnmount(() => { for (const key of [...timers.keys()]) now(key); });

function saveEnabled(enabled: boolean): void {
  void save('enabled', { enabled });
}

// Profile
const name = ref(props.bot.name);
const about = ref(props.bot.instructions);
function saveName(): void {
  const value = name.value.trim();
  if (value === current().name) return;
  void save('profile.name', () => {
    if (!value) throw new Error('Give the bot a name.');
    return { name: value };
  });
}
function saveAbout(): void {
  const value = about.value.trim();
  if (value !== current().instructions) void save('profile.about', { instructions: value });
}

// Avatar
const avatarKind = ref<Avatar['kind']>(props.bot.avatar.kind);
const avatarError = ref('');
const pictureInput = ref<HTMLInputElement | null>(null);
const customEmoji = ref(props.bot.avatar.emoji && !EMOJI.includes(props.bot.avatar.emoji) ? props.bot.avatar.emoji : '');
const halo = computed(() => ({ background: `radial-gradient(circle at 50% 40%, ${facePalette(look.value.color).halo}, transparent 70%)` }));
function newFace(): Avatar['look'] {
  return randomLook(Math.floor(Math.random() * 2 ** 32));
}
function saveAvatar(patch: Partial<Avatar>): void {
  avatarError.value = '';
  if (patch.kind) avatarKind.value = patch.kind;
  void save('avatar', (bot) => ({ avatar: { ...bot.avatar, ...patch, look: { ...(patch.look ?? bot.avatar.look) } } }));
}
// The face shows each change at once. A save sends only the parts that
// changed, so quick changes to different parts all stick.
const look = ref<Avatar['look']>({ ...props.bot.avatar.look });
function saveLook(next: Avatar['look']): void {
  const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => look.value[key as keyof Avatar['look']] !== value)) as Partial<Avatar['look']>;
  look.value = { ...next };
  avatarKind.value = 'face';
  avatarError.value = '';
  // A failed save puts back the saved value of each part it changed, unless
  // that part has changed again since, so trying again sends the change.
  void save('avatar', (bot) => ({ avatar: { ...bot.avatar, kind: 'face', look: { ...bot.avatar.look, ...changed } } }))
    .then((saved) => {
      if (saved) return;
      const stored = current().avatar.look;
      const reverted = Object.fromEntries(Object.entries(changed).filter(([key, value]) => look.value[key as keyof Avatar['look']] === value).map(([key]) => [key, stored[key as keyof Avatar['look']]]));
      look.value = { ...look.value, ...reverted };
    });
}
// A picture saves once one is chosen; the other kinds save straight away.
function chooseKind(kind: Avatar['kind']): void {
  avatarKind.value = kind;
  if (kind === 'picture' && !current().avatar.picture) return;
  saveAvatar(kind === 'emoji' && !current().avatar.emoji ? { kind, emoji: EMOJI[0]! } : { kind });
}
function typeEmoji(value: string): void {
  customEmoji.value = value;
  const emoji = value.trim();
  if (isSingleEmoji(emoji)) saveAvatar({ kind: 'emoji', emoji });
}
async function choosePicture(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    saveAvatar({ kind: 'picture', picture: await botPicture(await readFileAsDataUrl(file)) });
  } catch {
    avatarError.value = 'That picture could not be read.';
  }
}

// Model
const fields = ref<ProfileFieldsState>(fieldsFrom(props.catalog, props.bot.harness, props.bot));
const modelError = ref('');
// The catalog can arrive after the page opens; read the bot's model again then.
watch(() => props.catalog, (catalog) => { fields.value = fieldsFrom(catalog, current().harness, current()); });
const supportsServiceTier = computed(() => props.harnesses.find((item) => item.harness === fields.value.harness)?.capabilities?.features.serviceTier);
const showServiceTier = computed(() => supportsServiceTier.value ?? (tiersFor(props.catalog, fields.value.harness, null).length > 0 || fields.value.harness === 'codex'));
const presetOptions = computed(() => props.presets.presets.map((preset) => ({ value: preset.id as string | null, label: `${profileName(preset)} · ${harnessLabel(preset.harness)}` })));
function saveModel(key = 'model'): void {
  const profile = settingsFrom(fields.value, supportsServiceTier.value);
  if ('error' in profile) { modelError.value = profile.error; return; }
  modelError.value = '';
  void save(`model.${key}`, { harness: fields.value.harness, ...profile });
}
function chooseHarness(harness: ProfileHarness): void {
  fields.value = { harness, model: DEFAULT_MODEL, customModel: '', reasoning: '', serviceTier: '' };
  saveModel('harness');
}
function copyProfile(presetId: string | null): void {
  const preset = props.presets.presets.find((candidate) => candidate.id === presetId);
  if (!preset) return;
  fields.value = fieldsFrom(props.catalog, preset.harness, preset);
  saveModel('harness');
}

// Projects
const purviewKind = ref<BotPurview['kind']>(props.bot.purview.kind);
const projectIds = ref<string[]>(props.bot.purview.kind === 'projects' ? [...props.bot.purview.projectIds] : []);
function savePurview(): void {
  const purview: BotPurview = purviewKind.value === 'projects' ? { kind: 'projects', projectIds: [...projectIds.value] } : { kind: purviewKind.value };
  // Chosen with nothing chosen yet waits for a project.
  if (purview.kind === 'projects' && !purview.projectIds.length) return;
  void save('projects.kind', { purview });
}
function choosePurview(kind: BotPurview['kind']): void {
  purviewKind.value = kind;
  savePurview();
}
function toggleProject(projectId: string, on: boolean): void {
  projectIds.value = on ? [...new Set([...projectIds.value, projectId])] : projectIds.value.filter((candidate) => candidate !== projectId);
  savePurview();
}

// Voice
const supportsVoice = computed(() => props.harnesses.find((item) => item.harness === props.bot.harness)?.capabilities?.features.voice ?? props.bot.harness === 'codex');
const voiceOptions = computed(() => [
  { value: null as string | null, label: 'Default' },
  ...props.voices.map((voice) => ({ value: voice as string | null, label: voice[0]!.toUpperCase() + voice.slice(1) }))
]);
function saveVoice(key: string, patch: Partial<BotVoice>): void {
  void save(`voice.${key}`, (bot) => ({ voice: { ...bot.voice, ...patch } }));
}

// Discord: its settings save with the bot; the token saves on its own and
// can't be read back.
const token = ref('');
const userIds = ref((props.bot.discord?.allowedUserIds ?? []).join(', '));
const status = ref<DiscordBotStatus | null>(null);
function discordOf(bot: Bot): NonNullable<Bot['discord']> {
  return { enabled: bot.discord?.enabled ?? false, allowedUserIds: [...(bot.discord?.allowedUserIds ?? [])]};
}
async function saveDiscord(key: string, patch: Partial<NonNullable<Bot['discord']>> | (() => Partial<NonNullable<Bot['discord']>>)): Promise<void> {
  await save(`discord.${key}`, (bot) => ({ discord: { ...discordOf(bot), ...(typeof patch === 'function' ? patch() : patch) } }));
  void refreshStatus();
}
function saveUserIds(): void {
  const parsed = parseDiscordIds(userIds.value);
  if ('ids' in parsed && parsed.ids.join(',') === discordOf(current()).allowedUserIds.join(',')) return;
  void saveDiscord('users', () => {
    if ('error' in parsed) throw new Error(parsed.error);
    return { allowedUserIds: parsed.ids };
  });
}
function saveToken(): void {
  const value = token.value.trim();
  if (!value) return;
  void autosave(`${scope}.discord.token`, async () => {
    status.value = await saveDiscordToken(id, value);
    token.value = '';
    void refreshStatus();
  });
}
function removeToken(): void {
  if (!window.confirm('Remove the saved Discord bot token? The bot disconnects from Discord.')) return;
  void autosave(`${scope}.discord.token`, async () => { status.value = await saveDiscordToken(id, null); });
}
const statusText = computed(() => {
  const value = status.value;
  if (!value) return '';
  if (value.state === 'connected') return `Connected as ${value.user?.username ?? 'the bot'}`;
  if (value.state === 'connecting') return 'Connecting…';
  if (value.state === 'error') return value.error ?? 'Couldn\'t connect';
  return value.reason ?? 'Not connected';
});
// Checks again while it connects.
let statusTimer: ReturnType<typeof setTimeout> | undefined;
async function refreshStatus(): Promise<void> {
  clearTimeout(statusTimer);
  if (props.host) return;
  try {
    const next = await discordStatus(id);
    status.value = next;
    if (next.state === 'connecting' || (next.state === 'error' && next.error?.endsWith('retrying'))) statusTimer = setTimeout(() => { void refreshStatus(); }, 2000);
  } catch {
    // An older server without Discord: leave the status out.
  }
}
void refreshStatus();
onBeforeUnmount(() => clearTimeout(statusTimer));
</script>
