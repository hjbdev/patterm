<template>
  <SettingsPanel title="Bots" description="Bots are persistent companions you text with. Each one runs one of your profiles, keeps one conversation that carries on after a restart, and works in the projects you give it. The helpers it starts stay out of view. The assistant is the built-in bot: it oversees every project and opens from its own panel.">
    <template #actions>
      <Button type="button" size="sm" variant="outline" :disabled="!presetOptions.length" @click="addBot">Add bot</Button>
    </template>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>

    <SettingsSection list scope="bots">
      <SettingsItem v-for="bot in bots" :key="bot.id" :save-key="`bots.${bot.id}`">
        <template #title>
          <BotAvatar :avatar="bot.avatar" :size="20" />
          <span class="truncate">{{ bot.name }}</span>
        </template>
        <template #meta>{{ profileLabel(bot.presetId) }} · {{ purviewLabel(bot.purview) }} · {{ statusLabel(bot.id) }}</template>
        <template #actions>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2" @click="editBot(bot)">Edit</Button>
          <Button v-if="!isAssistantBot(bot)" type="button" size="sm" variant="ghost" class="h-7 px-2 text-destructive hover:text-destructive" @click="removeBot(bot)">Delete</Button>
        </template>
      </SettingsItem>
      <p v-if="!bots.length" class="px-3.5 py-3 text-xs text-muted-foreground">{{ presetOptions.length ? 'No bots yet.' : 'Add a profile in Settings › Harnesses first.' }}</p>
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
          <DialogDescription>Changes to a running bot apply when it restarts. Changing its profile to another harness starts a new conversation.</DialogDescription>
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
              <label class="text-xs text-muted-foreground" for="bot-profile">Profile</label>
              <SettingsChoice id="bot-profile" v-model="editor.presetId" :options="editorPresetOptions" aria-label="Profile" />
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
              <label class="text-xs text-muted-foreground" for="bot-voice">Voice</label>
              <div class="flex items-center gap-2">
                <Switch id="bot-voice" v-model="editor.voice.enabled" />
                <span class="text-xs text-muted-foreground">{{ editorHarness === 'codex' ? 'Talk to it in a GPT-Live voice call.' : 'Voice calls need a Codex profile.' }}</span>
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
  </SettingsPanel>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Dices } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { isSingleEmoji } from '../../../app/Bots/BotAvatar';
import { useBots } from '../Composables/useBots';
import { useWorkbench } from '../Composables/useWorkbench';
import { botPicture } from '../lib/botPicture';
import { isAssistantBot, saveBots, type Bot, type BotAvatar as Avatar, type BotPurview, type BotVoice } from '../lib/bots';
import { autosave } from '../Composables/useSettingsAutosave';
import { facePalette, randomLook } from '../lib/faces';
import { harnessLabel } from '../lib/harnesses';
import { profileName, type ProfileSettings } from '../lib/profiles';
import { readFileAsDataUrl } from '../lib/projectLogo';
import { randomId } from '../lib/randomId';
import { harnessPresets } from '../lib/serverQuery';
import BotAvatar from './BotAvatar.vue';
import FaceMaker from './FaceMaker.vue';
import SettingsChoice from './settings/SettingsChoice.vue';
import SettingsItem from './settings/SettingsItem.vue';
import SettingsRow from './settings/SettingsRow.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsSection from './settings/SettingsSection.vue';
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
  presetId: string | null;
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
const EMOJI = ['🦊', '🐙', '🦉', '🐢', '🤖', '🌱', '⚡', '🧠', '🎩', '🍄'];

const route = useRoute();
const { settings, rows, voices } = useBots();
const { projects } = useWorkbench();
const bots = computed(() => settings.value.bots);
const presets = ref<ProfileSettings>({ presets: [], defaultPresetIdByHarness: { claude: null, codex: null, opencode: null } });
const userProjects = computed(() => projects.value.map((item) => item.project).filter((project) => project.kind === 'workspace' || project.kind === 'personal' || !project.kind));
const presetOptions = computed(() => presets.value.presets.map((preset) => ({ value: preset.id as string | null, label: `${profileName(preset)} · ${harnessLabel(preset.harness)}` })));
// A bot saved without a profile runs Codex with its own configuration.
const editorPresetOptions = computed(() => editor.value?.presetId === null ? [{ value: null, label: 'Codex default' }, ...presetOptions.value] : presetOptions.value);
const editorIsAssistant = computed(() => editor.value ? isAssistantBot(editor.value) : false);
const editorHarness = computed(() => harnessOf(editor.value?.presetId ?? null));
const voiceOptions = computed(() => [
  { value: null as string | null, label: 'Default' },
  ...voices.value.map((voice) => ({ value: voice as string | null, label: voice[0]!.toUpperCase() + voice.slice(1) }))
]);

function harnessOf(presetId: string | null): string | null {
  if (!presetId) return 'codex';
  return presets.value.presets.find((preset) => preset.id === presetId)?.harness ?? null;
}

// The name saves once typing pauses, or when the field loses focus.
const userName = ref('');
let nameTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => settings.value.userName, (value) => { if (nameTimer === undefined) userName.value = value ?? ''; }, { immediate: true });
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

onMounted(async () => {
  try {
    presets.value = await harnessPresets<ProfileSettings>() ?? presets.value;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
  // Links such as Edit bot… from a bot's page open its editor.
  const requested = typeof route.query.bot === 'string' ? bots.value.find((bot) => bot.id === route.query.bot) : null;
  if (requested) editBot(requested);
});

function rowFor(botId: string) {
  return rows.value.find((row) => row.bot.id === botId) ?? null;
}

function profileLabel(presetId: string | null): string {
  if (!presetId) return 'Codex default';
  const preset = presets.value.presets.find((candidate) => candidate.id === presetId);
  return preset ? profileName(preset) : 'Missing profile';
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

function addBot(): void {
  editorError.value = '';
  const fallback = presets.value.defaultPresetIdByHarness.claude ?? presets.value.presets[0]?.id ?? '';
  editor.value = {
    id: `bot_${randomId()}`, isNew: true, name: '', presetId: fallback, avatar: { kind: 'face', look: newFace(), emoji: null, picture: null }, purviewKind: 'none', projectIds: [], instructions: '',
    enabled: true, memory: true, memoryBudgetTokens: 4000, voice: { enabled: false, voice: null, profile: 'codex', acknowledgements: 'default' }, digests: false, focus: false
  };
  editorOpen.value = true;
}

function editBot(bot: Bot): void {
  editorError.value = '';
  editorTitle.value = bot.name;
  editor.value = {
    id: bot.id, isNew: false, name: bot.name, presetId: bot.presetId,
    avatar: { ...bot.avatar, look: { ...bot.avatar.look } },
    purviewKind: bot.purview.kind, projectIds: bot.purview.kind === 'projects' ? [...bot.purview.projectIds] : [],
    instructions: bot.instructions, enabled: bot.enabled, memory: bot.memory, memoryBudgetTokens: bot.memoryBudgetTokens,
    voice: { ...bot.voice }, digests: bot.digests, focus: bot.focus
  };
  editorOpen.value = true;
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

// Electron IPC can't clone Vue's reactive proxies, so every bot is copied out
// as plain data.
function plain(bot: Bot): Bot {
  return { ...bot, avatar: { ...bot.avatar, look: { ...bot.avatar.look } }, voice: { ...bot.voice }, purview: bot.purview.kind === 'projects' ? { kind: 'projects', projectIds: [...bot.purview.projectIds] } : { kind: bot.purview.kind } };
}

async function persist(next: Bot[], name = settings.value.userName): Promise<boolean> {
  saving.value = true;
  try {
    const saved = await saveBots({ bots: next.map(plain), userName: name });
    settings.value = saved;
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
  if (!current.presetId && !editorPresetOptions.value.some((option) => option.value === null)) { editorError.value = 'Choose a profile.'; return; }
  if (current.avatar.kind === 'emoji' && !(current.avatar.emoji && isSingleEmoji(current.avatar.emoji))) { editorError.value = 'Choose one emoji.'; return; }
  if (current.avatar.kind === 'picture' && !current.avatar.picture) { editorError.value = 'Choose a picture.'; return; }
  if (current.purviewKind === 'projects' && !current.projectIds.length) { editorError.value = 'Choose at least one project, or None.'; return; }
  const purview: BotPurview = editorIsAssistant.value ? { kind: 'all' } : current.purviewKind === 'projects' ? { kind: 'projects', projectIds: current.projectIds } : { kind: current.purviewKind };
  const bot: Bot = {
    id: current.id, name, presetId: current.presetId, avatar: current.avatar, purview, instructions: current.instructions.trim(),
    enabled: current.enabled, memory: current.memory, memoryBudgetTokens: current.memoryBudgetTokens, voice: { ...current.voice }, digests: current.digests, focus: current.focus
  };
  const next = current.isNew ? [...bots.value, bot] : bots.value.map((candidate) => candidate.id === bot.id ? bot : candidate);
  if (await persist(next)) editorOpen.value = false;
}

async function removeBot(bot: Bot): Promise<void> {
  if (!window.confirm(`Delete ${bot.name}? Its conversation stops, and its helpers keep running in their projects.`)) return;
  await persist(bots.value.filter((candidate) => candidate.id !== bot.id));
}
</script>
