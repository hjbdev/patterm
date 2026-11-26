<template>
  <!-- A project with nothing open starts its next conversation here: the
       agent CLI's logo, the first message, and where and how it runs. It is
       the same composer an empty agent centres, so @ offers agents and presets. -->
  <div class="flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto">
    <IntegratedComposer
      v-if="harness"
      ref="composer"
      :process-id="draftKey"
      :controls="controls"
      :controlling="true"
      :sending="false"
      :pending="false"
      :ended="false"
      :agents="mentionAgents"
      :bots="mentionBots"
      :processes="mentionProcesses"
      :launchers="mentionLaunchers"
      :harness="harness"
      :upload-route="route"
      :blocked="blocked"
      hero
      @send="start"
      @invalid="toast.error($event)"
      @configure="configure"
    >
      <template #hero>
        <HarnessFan :harness="harness" :harnesses="installed" @select="chooseHarness" />
      </template>
      <template #meta>
        <span v-if="controls.selectors.length" aria-hidden="true" class="text-xs opacity-50">·</span>
        <LaunchTargetPickers v-model:target-project-id="targetProjectId" v-model:worktree-id="worktreeId" :targets="targets" :worktrees="worktrees" @close-auto-focus="refocus" />
      </template>
    </IntegratedComposer>
    <!-- With no agent CLI on the chosen machine, the project picker stays so you can pick another. -->
    <div v-else class="my-auto w-full max-w-[40rem] px-4 pb-[14vh] pt-4">
      <p class="text-center text-sm text-muted-foreground">{{ emptyText }}</p>
      <div class="flex flex-wrap items-center justify-center gap-0.5 pt-3.5 text-muted-foreground">
        <LaunchTargetPickers v-model:target-project-id="targetProjectId" v-model:worktree-id="worktreeId" :targets="targets" :worktrees="worktrees" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import HarnessFan from './HarnessFan.vue';
import IntegratedComposer from './IntegratedComposer.vue';
import LaunchTargetPickers from './LaunchTargetPickers.vue';
import { useBots } from '../Composables/useBots';
import { useHarnessLaunch } from '../Composables/useHarnessLaunch';
import { useWorkbench } from '../Composables/useWorkbench';
import { mentionLaunchers as buildMentionLaunchers, mentionableAgents, mentionableBots, mentionableProcesses } from '../lib/agentMentions';
import { allAgents, allAgentsHiding, launchTargets } from '../lib/allAgents';
import { handOffComposer } from '../lib/composerFlip';
import { draftFor, rerouteAttachments, takeAttachments, type ComposerSendPayload } from '../lib/integratedComposer';
import { launchableHarnesses } from '../lib/harnesses';
import { NEW_CONVERSATION_DRAFT, lastNewConversationHarness, newConversationRoute, rememberNewConversationHarness } from '../lib/newConversation';
import { emptyModelCatalog, modelsFor, type ModelCatalog, type ProfileHarness } from '../lib/profileFields';
import { profileName, type ProfileSettings } from '../lib/profiles';
import { harnessModels, harnessPresets } from '../lib/serverQuery';
import { defaultReasoningLevelsFor } from '../../../app/Agents/AgentCapabilitiesDto';
import type { HarnessInstallationRecord, WorktreeRecord } from '../types';

// `chooseProject`: the All agents view, which lists every shown project.
const props = defineProps<{ projectId: string; chooseProject?: boolean }>();

const ORDER = ['claude', 'codex', 'opencode', 'agy'];
const DEFAULT = '__default__';

const { harnesses, projects } = useWorkbench();
const { rows: botRows } = useBots();
const { launchHarness } = useHarnessLaunch();
const composer = ref<InstanceType<typeof IntegratedComposer> | null>(null);

// Where the agent can start: this project and its paired hosts, or every
// shown project when choosing among them.
const targets = computed(() => props.chooseProject
  ? launchTargets(projects.value, allAgentsHiding(allAgents, projects.value))
  : launchTargets(projects.value, { active: false, hidden: [] }));
const targetProjectId = ref(props.projectId);
watch([targets, () => props.projectId], ([, projectId], previous) => {
  if (previous && previous[1] !== projectId) targetProjectId.value = projectId;
  if (targets.value.some((option) => option.targetProjectId === targetProjectId.value)) return;
  targetProjectId.value = targets.value.find((option) => option.targetProjectId === props.projectId)?.targetProjectId ?? targets.value[0]?.targetProjectId ?? props.projectId;
}, { immediate: true });
const target = computed(() => targets.value.find((option) => option.targetProjectId === targetProjectId.value) ?? null);

// The message waits in one composer draft whichever project is chosen. When
// the agent would start on another machine, as after choosing a paired
// host's project, returning to the page, or a host going offline, its
// attachments upload again there.
const draftKey = NEW_CONVERSATION_DRAFT;
const route = computed(() => newConversationRoute(target.value?.host));
watch(route, (next) => rerouteAttachments(draftKey, next), { immediate: true });

// Another host lists its own CLIs, profiles, and model catalog.
const hostHarnesses = ref<Record<string, HarnessInstallationRecord[]>>({});
const hostPresets = ref<Record<string, ProfileSettings>>({});
const hostCatalogs = ref<Record<string, ModelCatalog>>({});
watch(() => target.value?.host, async (host) => {
  const projectId = target.value?.targetProjectId;
  if (!host || !projectId) return;
  if (!hostHarnesses.value[host]) {
    try {
      const result = await window.patterm.call('harness_list', { project_id: projectId }) as { harnesses?: HarnessInstallationRecord[] } | HarnessInstallationRecord[];
      hostHarnesses.value = { ...hostHarnesses.value, [host]: launchableHarnesses(Array.isArray(result) ? result : result.harnesses ?? []) };
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : `Could not list ${host}’s agents`);
    }
  }
  if (!hostPresets.value[host]) {
    void window.patterm.call('harness_presets', {}, host).then((result) => {
      if (result && typeof result === 'object' && 'presets' in result) {
        hostPresets.value = { ...hostPresets.value, [host]: result as ProfileSettings };
      }
    }).catch(() => {});
  }
  if (!hostCatalogs.value[host]) {
    void window.patterm.call('harness_models', {}, host).then((result) => {
      if (result && typeof result === 'object' && 'providers' in result) {
        hostCatalogs.value = { ...hostCatalogs.value, [host]: result as ModelCatalog };
      }
    }).catch(() => {});
  }
}, { immediate: true });

const installedRecords = computed(() => {
  const host = target.value?.host;
  return host ? hostHarnesses.value[host] ?? [] : launchableHarnesses(harnesses.value);
});
const installed = computed(() => {
  const ids = new Set(installedRecords.value.map((record) => record.harness));
  return ORDER.filter((id) => ids.has(id));
});
const chosenHarness = ref(lastNewConversationHarness());
const harness = computed(() => chosenHarness.value && installed.value.includes(chosenHarness.value) ? chosenHarness.value : installed.value[0] ?? null);
const emptyText = computed(() => target.value?.host ? `No agent CLIs found on ${target.value.host}` : 'No installed agent CLIs were found on PATH.');

function chooseHarness(next: string): void {
  chosenHarness.value = next;
  rememberNewConversationHarness(next);
  void nextTick(() => composer.value?.focus());
}

// The model and thinking level start at the CLI's default profile on the target host.
const presets = ref<ProfileSettings | null>(null);
const catalog = ref<ModelCatalog>(emptyModelCatalog());
void harnessPresets<ProfileSettings>().then((settings) => { presets.value = settings; }).catch(() => {});
void harnessModels<ModelCatalog>().then((value) => { catalog.value = value; }).catch(() => {});
const activePresets = computed(() => target.value?.host ? hostPresets.value[target.value.host] ?? null : presets.value);
const activeCatalog = computed(() => target.value?.host ? hostCatalogs.value[target.value.host] ?? emptyModelCatalog() : catalog.value);
const harnessProfiles = computed(() => {
  const id = harness.value;
  if (!id || !activePresets.value) return [];
  return activePresets.value.presets.filter((candidate) => candidate.harness === id);
});
const defaultProfile = computed(() => {
  const id = harness.value;
  if (!id || !activePresets.value) return null;
  const defaultId = activePresets.value.defaultPresetIdByHarness[id as ProfileHarness];
  return harnessProfiles.value.find((candidate) => candidate.id === defaultId) ?? harnessProfiles.value[0] ?? null;
});
const chosenPresetId = ref<string | null>(null);
watch([() => target.value?.host, harness, defaultProfile], () => {
  chosenPresetId.value = defaultProfile.value?.id ?? null;
}, { immediate: true });
const profile = computed(() => harnessProfiles.value.find((candidate) => candidate.id === chosenPresetId.value) ?? defaultProfile.value ?? null);
const profileSelector = computed(() => {
  if (harnessProfiles.value.length <= 1) return null;
  return {
    id: 'profile',
    label: 'Profile',
    value: profile.value?.id ?? DEFAULT,
    // The CLI is already chosen above, so its seeded Default reads as a profile, not the CLI's name.
    options: harnessProfiles.value.map((candidate) => ({ value: candidate.id, label: candidate.name.toLowerCase() === 'default' ? 'Default Profile' : profileName(candidate) }))
  };
});
function chooseProfile(value: string): void {
  chosenPresetId.value = value === DEFAULT ? null : value;
}

const model = ref<string | null>(null);
const reasoning = ref<string | null>(null);
watch([profile, () => target.value?.host, harness], ([current]) => {
  model.value = current?.model ?? null;
  reasoning.value = current?.reasoning ?? null;
}, { immediate: true });

const catalogModels = computed(() => harness.value ? modelsFor(activeCatalog.value, harness.value as ProfileHarness) : []);
const modelSelector = computed(() => {
  if (!harness.value) return null;
  const options = catalogModels.value.map((entry) => ({ value: entry.id, label: entry.label, ...(entry.provider ? { description: entry.provider } : {}) }));
  if (model.value && !options.some((option) => option.value === model.value)) options.unshift({ value: model.value, label: model.value.slice(model.value.lastIndexOf('/') + 1) });
  if (!profile.value?.model) options.unshift({ value: DEFAULT, label: 'Default model' });
  return { id: 'model', label: 'Model', value: model.value ?? DEFAULT, options };
});
// A thinking level applies to a chosen model.
const reasoningSelector = computed(() => {
  if (!harness.value || !model.value) return null;
  const entry = catalogModels.value.find((candidate) => candidate.id === model.value);
  const levels = entry?.reasoning.length ? entry.reasoning : defaultReasoningLevelsFor(harness.value);
  if (!levels.length && !reasoning.value) return null;
  const options = [{ value: DEFAULT, label: 'Default thinking' }, ...levels.map((level) => ({ value: level, label: capitalise(level) }))];
  if (reasoning.value && !levels.includes(reasoning.value)) options.push({ value: reasoning.value, label: capitalise(reasoning.value) });
  return { id: 'reasoning', label: 'Thinking', value: reasoning.value ?? DEFAULT, options };
});
function chooseModel(value: string): void {
  model.value = value === DEFAULT ? null : value;
  const entry = catalogModels.value.find((candidate) => candidate.id === model.value);
  if (reasoning.value && entry && !entry.reasoning.includes(reasoning.value)) reasoning.value = entry.defaultReasoning;
  if (!model.value) reasoning.value = null;
}
function chooseReasoning(value: string): void {
  reasoning.value = value === DEFAULT ? null : value;
}
function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

// The composer shows the profile, model, and thinking pickers as an empty
// agent shows its own, then the project and worktree pickers after them.
const controls = computed(() => ({
  selectors: [profileSelector.value, modelSelector.value, reasoningSelector.value].filter((selector) => selector !== null),
  commands: []
}));
function configure(id: string, value: string): void {
  if (id === 'profile') chooseProfile(value);
  else if (id === 'model') chooseModel(value);
  else if (id === 'reasoning') chooseReasoning(value);
}

// The @ menu offers what the new agent could reach once it starts: the
// chosen project's live agents and processes, this host's bots that work in
// it, and presets and CLIs for spawning helpers.
const targetWorkbench = computed(() => target.value ? projects.value.find((item) => item.project.id === target.value!.projectId) ?? null : null);
const mentionAgents = computed(() => targetWorkbench.value ? mentionableAgents(targetWorkbench.value.projectSessions, '') : []);
// A paired host's agent cannot message this host's bots.
const mentionBots = computed(() => targetWorkbench.value && !target.value?.host ? mentionableBots(botRows.value, targetWorkbench.value.project.id, '') : []);
const mentionProcesses = computed(() => targetWorkbench.value ? mentionableProcesses(targetWorkbench.value.processes, targetWorkbench.value.projectSessions) : []);
const mentionLaunchers = computed(() => buildMentionLaunchers(installedRecords.value, activePresets.value?.presets ?? []));

const worktrees = computed<WorktreeRecord[]>(() => target.value
  // Only worktrees on the chosen target's host can host a launch there.
  ? (targetWorkbench.value?.worktrees ?? []).filter((worktree) => (worktree.host ?? null) === target.value!.host)
  : []);
const worktreeId = ref<string | null>(null);
watch(targetProjectId, () => { worktreeId.value = null; });

const draft = computed(() => draftFor(draftKey));
const blocked = computed(() => {
  if (!target.value) return 'Choose a project';
  if (!draft.value.text.trim() && draft.value.attachments.length) return 'Write a first message to send with the files';
  return null;
});

// The composer's send, with the message's chips as tokens and its uploaded files.
function start(payload: ComposerSendPayload): void {
  const chosen = target.value, cli = harness.value, prompt = payload.text.trim();
  if (!chosen || !cli || !prompt || !canStart.value) return;
  // The chosen profile's own settings launch as that profile; anything else
  // overrides its model and thinking level for this agent.
  const base = profile.value;
  const overridden = Boolean(model.value) && (model.value !== (base?.model ?? null) || reasoning.value !== (base?.reasoning ?? null));
  const card = composer.value?.card;
  if (card) handOffComposer(card);
  rememberNewConversationHarness(cli);
  const files = takeAttachments(draftKey);
  // Dismissing a failed launch puts the message back with its chips.
  const initialDraft = { text: draft.value.text, chips: [...draft.value.chips] };
  Object.assign(draft.value, { text: '', chips: [], references: [], lastAttempt: undefined });
  launchHarness({
    harness: cli,
    projectId: chosen.projectId,
    targetProjectId: chosen.targetProjectId,
    initialPrompt: prompt,
    initialDraft,
    ...(files.length ? { initialAttachments: files } : {}),
    ...(chosen.host ? { host: chosen.host } : {}),
    // The preset still applies under an override, keeping its Codex speed.
    ...(base ? { preset: base.id } : {}),
    ...(overridden ? { model: model.value!, ...(reasoning.value ? { reasoning: reasoning.value } : {}) } : {}),
    ...(worktreeId.value ? { worktreeId: worktreeId.value } : {})
  });
}
const canStart = computed(() => Boolean(harness.value && target.value) && !blocked.value);

function refocus(event: Event): void {
  if (!composer.value) return;
  event.preventDefault();
  composer.value.focus();
}
</script>
