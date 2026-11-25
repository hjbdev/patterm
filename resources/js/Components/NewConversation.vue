<template>
  <!-- A project with nothing open starts its next conversation here: the
       agent CLI's logo, the first message, and where and how it runs. -->
  <div class="flex min-h-0 w-full flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-[14vh] pt-4">
    <form class="w-full max-w-[40rem]" @submit.prevent="start">
      <div v-if="harness" class="pb-3.5">
        <HarnessFan :harness="harness" :harnesses="installed" @select="chooseHarness" />
      </div>
      <!-- With no agent CLI on the chosen machine, the project picker stays so you can pick another. -->
      <p v-if="!harness" class="text-center text-sm text-muted-foreground">{{ emptyText }}</p>
      <div v-else ref="card" class="flex items-end gap-1.5 rounded-[26px] border border-foreground/[0.07] bg-muted/50 p-2 shadow-sm">
        <textarea
          ref="field"
          v-model="newConversationDraft"
          rows="1"
          class="block max-h-44 min-h-8 min-w-0 flex-1 resize-none self-center bg-transparent px-3 py-1 text-[15px] leading-6 outline-none placeholder:text-muted-foreground"
          :placeholder="`What should ${harnessLabel(harness)} work on?`"
          aria-label="First message"
          data-patterm-new-conversation-input
          @input="grow"
          @keydown="onKeydown"
        />
        <Button type="submit" size="icon" class="h-8 w-8 shrink-0 rounded-full" :disabled="!canStart" :aria-label="`Start ${harnessLabel(harness)}`" :title="`Start ${harnessLabel(harness)}`">
          <ArrowUp class="h-4 w-4" />
        </Button>
      </div>
      <div class="flex flex-wrap items-center justify-center gap-0.5 pt-3.5 text-muted-foreground">
        <template v-if="harness">
          <template v-if="profileSelector">
            <IntegratedControlPicker :selector="profileSelector" :disabled="false" @select="chooseProfile" />
            <span aria-hidden="true" class="text-xs opacity-50">·</span>
          </template>
          <IntegratedControlPicker v-if="modelSelector" :selector="modelSelector" :disabled="false" @select="chooseModel" />
          <template v-if="reasoningSelector">
            <span aria-hidden="true" class="text-xs opacity-50">·</span>
            <IntegratedControlPicker :selector="reasoningSelector" :disabled="false" @select="chooseReasoning" />
          </template>
          <span aria-hidden="true" class="text-xs opacity-50">·</span>
        </template>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button type="button" variant="ghost" size="sm" :class="PICKER" :aria-label="`Project: ${target?.project.name ?? 'Choose a project'}`">
              <ProjectLogo v-if="target" :project="target.project" :size="13" />
              <span class="truncate">{{ target?.project.name ?? 'Choose a project' }}</span>
              <HostBadge v-if="target?.host" :host="target.host" />
              <ChevronsUpDown class="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" class="max-h-72 w-64 overflow-y-auto" @close-auto-focus="refocus">
            <DropdownMenuItem v-for="option in targets" :key="option.targetProjectId" class="gap-2 text-[13px]" @select="chooseTarget(option.targetProjectId)">
              <ProjectLogo :project="option.project" :size="14" />
              <span class="min-w-0 flex-1 truncate">{{ option.project.name }}</span>
              <HostBadge v-if="option.host" :host="option.host" />
              <Check class="h-3.5 w-3.5 shrink-0" :class="option.targetProjectId === targetProjectId ? '' : 'invisible'" />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <template v-if="worktrees.length">
          <span aria-hidden="true" class="text-xs opacity-50">·</span>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button type="button" variant="ghost" size="sm" :class="PICKER" :aria-label="`Run in ${worktreeLabel}`">
                <GitBranch class="h-3 w-3 shrink-0" aria-hidden="true" />
                <span class="truncate">{{ worktreeLabel }}</span>
                <ChevronsUpDown class="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" class="max-h-72 w-64 overflow-y-auto" @close-auto-focus="refocus">
              <DropdownMenuItem class="gap-2 text-[13px]" @select="worktreeId = null">
                <span class="min-w-0 flex-1 truncate">Project checkout</span>
                <Check class="h-3.5 w-3.5 shrink-0" :class="worktreeId === null ? '' : 'invisible'" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem v-for="worktree in worktrees" :key="worktree.id" class="gap-2 text-[13px]" @select="worktreeId = worktree.id">
                <span class="min-w-0 flex-1 truncate">{{ worktreeName(worktree) }}</span>
                <Check class="h-3.5 w-3.5 shrink-0" :class="worktreeId === worktree.id ? '' : 'invisible'" />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </template>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ArrowUp, Check, ChevronsUpDown, GitBranch } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import HarnessFan from './HarnessFan.vue';
import HostBadge from './HostBadge.vue';
import IntegratedControlPicker from './IntegratedControlPicker.vue';
import ProjectLogo from './ProjectLogo.vue';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { useHarnessLaunch } from '../Composables/useHarnessLaunch';
import { useWorkbench } from '../Composables/useWorkbench';
import { allAgents, allAgentsHiding, launchTargets } from '../lib/allAgents';
import { handOffComposer } from '../lib/composerFlip';
import { harnessLabel, launchableHarnesses } from '../lib/harnesses';
import { lastNewConversationHarness, newConversationDraft, rememberNewConversationHarness } from '../lib/newConversation';
import { emptyModelCatalog, modelsFor, type ModelCatalog, type ProfileHarness } from '../lib/profileFields';
import { profileName, type ProfileSettings } from '../lib/profiles';
import { harnessModels, harnessPresets } from '../lib/serverQuery';
import { touchScreen } from '../lib/touch';
import { defaultReasoningLevelsFor } from '../../../app/Agents/AgentCapabilitiesDto';
import type { HarnessInstallationRecord, WorktreeRecord } from '../types';

// `chooseProject`: the All agents view, which lists every shown project.
const props = defineProps<{ projectId: string; chooseProject?: boolean }>();

const PICKER = 'h-8 max-w-56 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground';
const ORDER = ['claude', 'codex', 'opencode', 'agy'];
const DEFAULT = '__default__';

const { harnesses, projects } = useWorkbench();
const { launchHarness } = useHarnessLaunch();
const card = ref<HTMLElement>();
const field = ref<HTMLTextAreaElement>();

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

const installed = computed(() => {
  const host = target.value?.host;
  const records = host ? hostHarnesses.value[host] ?? [] : launchableHarnesses(harnesses.value);
  const ids = new Set(records.map((record) => record.harness));
  return ORDER.filter((id) => ids.has(id));
});
const chosenHarness = ref(lastNewConversationHarness());
const harness = computed(() => chosenHarness.value && installed.value.includes(chosenHarness.value) ? chosenHarness.value : installed.value[0] ?? null);
const emptyText = computed(() => target.value?.host ? `No agent CLIs found on ${target.value.host}` : 'No installed agent CLIs were found on PATH.');

function chooseHarness(next: string): void {
  chosenHarness.value = next;
  rememberNewConversationHarness(next);
  void nextTick(focusField);
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
    options: harnessProfiles.value.map((candidate) => ({ value: candidate.id, label: profileName(candidate) }))
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

const worktrees = computed<WorktreeRecord[]>(() => target.value
  // Only worktrees on the chosen target's host can host a launch there.
  ? (projects.value.find((item) => item.project.id === target.value!.projectId)?.worktrees ?? [])
    .filter((worktree) => (worktree.host ?? null) === target.value!.host)
  : []);
const worktreeId = ref<string | null>(null);
watch(targetProjectId, () => { worktreeId.value = null; });
const worktreeLabel = computed(() => {
  const worktree = worktrees.value.find((candidate) => candidate.id === worktreeId.value);
  return worktree ? worktreeName(worktree) : 'Project checkout';
});
function worktreeName(worktree: WorktreeRecord): string {
  return worktree.branch ?? worktree.worktreePath.slice(worktree.worktreePath.lastIndexOf('/') + 1);
}
function chooseTarget(id: string): void {
  targetProjectId.value = id;
}

const canStart = computed(() => Boolean(harness.value && target.value && newConversationDraft.value.trim()));

function start(): void {
  const chosen = target.value, cli = harness.value, prompt = newConversationDraft.value.trim();
  if (!chosen || !cli || !prompt) return;
  // The chosen profile's own settings launch as that profile; anything else
  // overrides its model and thinking level for this agent.
  const base = profile.value;
  const overridden = Boolean(model.value) && (model.value !== (base?.model ?? null) || reasoning.value !== (base?.reasoning ?? null));
  if (card.value) handOffComposer(card.value);
  rememberNewConversationHarness(cli);
  newConversationDraft.value = '';
  launchHarness({
    harness: cli,
    projectId: chosen.projectId,
    targetProjectId: chosen.targetProjectId,
    initialPrompt: prompt,
    ...(chosen.host ? { host: chosen.host } : {}),
    // The preset still applies under an override, keeping its Codex speed.
    ...(base ? { preset: base.id } : {}),
    ...(overridden ? { model: model.value!, ...(reasoning.value ? { reasoning: reasoning.value } : {}) } : {}),
    ...(worktreeId.value ? { worktreeId: worktreeId.value } : {})
  });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    start();
  }
}

function grow(): void {
  const element = field.value;
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

function focusField(): void {
  if (!touchScreen()) field.value?.focus();
}

function refocus(event: Event): void {
  if (!field.value) return;
  event.preventDefault();
  focusField();
}

// The field renders once the agent CLIs are known, which is often after
// mount, so it is focused when it appears.
watch(field, (element) => {
  if (!element) return;
  grow();
  focusField();
}, { immediate: true, flush: 'post' });
</script>
