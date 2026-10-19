<template>
  <ResponsiveMenu v-model:open="menuOpen" title="Launch agent" align="end" desktop-class="w-56" :nested="nested ?? false">
    <template #trigger>
      <Button
        :variant="label ? 'secondary' : 'ghost'"
        :size="label ? 'sm' : 'icon'"
        :class="cn(label ? 'h-7 gap-2 px-2 text-xs' : 'h-7 w-7 rounded-tab text-muted-foreground', triggerClass)"
        :title="label ?? 'Launch agent'"
        :aria-label="label ?? 'Launch agent'"
      >
        <Plus class="h-4 w-4" />
        <span v-if="label">{{ label }}</span>
      </Button>
    </template>
    <template #header-actions>
      <InterfaceModeToggle :model-value="interfaceMode" @update:model-value="saveInterface" />
    </template>
    <template #desktop>
      <!-- Showing all agents, the agent you picked asks which project next. -->
      <template v-if="pending">
        <DropdownMenuItem class="gap-2 text-[13px] text-muted-foreground" @select.prevent="backToAgents">
          <ChevronLeft class="h-4 w-4 shrink-0" />
          <span class="min-w-0 flex-1 truncate">{{ pendingLabel }}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem v-for="target in pendingTargets" :key="target.targetProjectId" data-launch-target class="gap-2 text-[13px]" @select="launchHarness(pending.harness, pending.presetId, target)">
          <ProjectLogo :project="target.project" :size="14" />
          <span class="min-w-0 flex-1 truncate">{{ target.project.name }}</span>
          <HostBadge v-if="target.host" :host="target.host" />
        </DropdownMenuItem>
        <DropdownMenuItem v-if="!pendingTargets.length" disabled>
          <span class="text-xs text-muted-foreground">No shown project can run it</span>
        </DropdownMenuItem>
      </template>
      <template v-else>
      <InterfaceModeToggle menu :model-value="interfaceMode" @update:model-value="saveInterface" />
      <div v-if="hostOptions.length > 1" class="px-1 py-1" @keydown.stop>
        <SettingsChoice v-model="targetProjectId" :options="hostOptions" aria-label="Launch on" segmented class="w-full" />
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuSub v-for="harness in launchableHarnesses" :key="harness.id">
        <DropdownMenuSubTrigger
          data-launch-harness
          class="gap-2"
          @click.prevent.stop="pickHarness(harness.harness, defaultPresetId(harness.harness))"
        >
          <AgentIcon :harness="harness.harness" class="h-4 w-4 shrink-0" />
          <span class="flex-1 truncate">{{ harnessLabel(harness.harness) }}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="w-64">
          <DropdownMenuItem v-if="!presetsFor(harness.harness).length" disabled>
            <span class="text-xs text-muted-foreground">{{ remoteTarget ? `Launches with ${targetHost}’s default preset` : 'No presets — launches with its own model' }}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            v-for="preset in presetsFor(harness.harness)"
            :key="preset.id"
            @select="selectPreset($event, harness.harness, preset.id)"
          >
            <span class="min-w-0 flex-1 truncate text-xs">{{ preset.name }}</span>
            <Badge v-if="defaultPresetId(harness.harness) === preset.id" variant="secondary" class="ml-2 h-4 shrink-0 px-1 text-[9px]">Default</Badge>
            <span class="ml-2 max-w-28 shrink-0 truncate text-[10px] text-muted-foreground">{{ preset.model ?? 'Harness default' }}{{ preset.reasoning ? ` · ${preset.reasoning}` : '' }}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem v-if="launchableHarnesses.length === 0" disabled>
        <span class="text-xs text-muted-foreground">No agent CLIs found on PATH</span>
      </DropdownMenuItem>
      </template>
    </template>
    <template #mobile>
      <div v-if="pending" class="space-y-1">
        <button type="button" class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-muted-foreground hover:bg-muted/60" @click="backToAgents">
          <ChevronLeft class="h-4 w-4 shrink-0" />
          <span class="min-w-0 flex-1 truncate">{{ pendingLabel }}</span>
        </button>
        <button v-for="target in pendingTargets" :key="target.targetProjectId" type="button" class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60" @click="launchHarness(pending.harness, pending.presetId, target)">
          <ProjectLogo :project="target.project" :size="16" />
          <span class="min-w-0 flex-1 truncate">{{ target.project.name }}</span>
          <HostBadge v-if="target.host" :host="target.host" />
        </button>
        <p v-if="!pendingTargets.length" class="py-2 text-sm text-muted-foreground">No shown project can run it</p>
      </div>
      <template v-else>
        <div v-if="hostOptions.length > 1" class="pb-2">
          <SettingsChoice v-model="targetProjectId" :options="hostOptions" aria-label="Launch on" segmented class="w-full" />
        </div>
        <p v-if="!launchableHarnesses.length" class="py-3 text-sm text-muted-foreground">No agent CLIs found on PATH</p>
        <div class="divide-y divide-border">
          <div v-for="harness in launchableHarnesses" :key="harness.id" class="py-1">
            <div class="flex items-center gap-1">
              <button type="button" class="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60" @click="pickHarness(harness.harness, defaultPresetId(harness.harness))">
                <AgentIcon :harness="harness.harness" class="h-4 w-4 shrink-0" />
                <span class="min-w-0 flex-1 truncate">{{ harnessLabel(harness.harness) }}</span>
              </button>
              <button v-if="presetsFor(harness.harness).length" type="button" class="flex min-h-11 max-w-[45%] shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60" :aria-expanded="expandedHarness === harness.harness" :aria-label="`Choose ${harnessLabel(harness.harness)} preset`" @click="expandedHarness = expandedHarness === harness.harness ? null : harness.harness">
                <span class="min-w-0 truncate">{{ presetSummary(harness.harness) }}</span>
                <ChevronDown class="h-4 w-4 shrink-0 transition-transform" :class="expandedHarness === harness.harness ? 'rotate-180' : ''" />
              </button>
            </div>
            <div v-if="expandedHarness === harness.harness" class="pb-1 pl-7">
              <button v-for="preset in presetsFor(harness.harness)" :key="preset.id" type="button" class="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-muted/60" @click="pickHarness(harness.harness, preset.id)">
                <span class="min-w-0 flex-1 truncate">{{ preset.name }}</span>
                <span class="max-w-[50%] shrink-0 truncate text-xs text-muted-foreground">{{ preset.model ?? 'Harness default' }}{{ preset.reasoning ? ` · ${preset.reasoning}` : '' }}</span>
                <Check class="h-4 w-4 shrink-0" :class="defaultPresetId(harness.harness) === preset.id ? 'text-foreground' : 'invisible'" :aria-label="defaultPresetId(harness.harness) === preset.id ? 'Default preset' : undefined" />
              </button>
            </div>
          </div>
        </div>
      </template>
    </template>
  </ResponsiveMenu>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { Check, ChevronDown, ChevronLeft, Plus } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { useHarnessLaunch } from '../Composables/useHarnessLaunch';
import { useWorkbench } from '../Composables/useWorkbench';
import { harnessLabel, launchableHarnesses as filterLaunchableHarnesses } from '../lib/harnesses';
import { harnessPresets } from '../lib/serverQuery';
import AgentIcon from './AgentIcon.vue';
import InterfaceModeToggle from './InterfaceModeToggle.vue';
import ResponsiveMenu from './ResponsiveMenu.vue';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from './ui/dropdown-menu';
import { allAgents, allAgentsHiding, launchTargets, targetsWithHarness, type LaunchTarget } from '../lib/allAgents';
import HostBadge from './HostBadge.vue';
import ProjectLogo from './ProjectLogo.vue';
import SettingsChoice from './settings/SettingsChoice.vue';
import { cn } from '../lib/utils';
import type { AgentInterface, HarnessInstallationRecord } from '../types';

type PresetHarness = 'claude' | 'codex' | 'opencode';

interface HarnessPreset {
  id: string;
  harness: PresetHarness;
  name: string;
  model: string | null;
  reasoning: string | null;
}

interface HarnessPresetSettings {
  presets: HarnessPreset[];
  defaultPresetIdByHarness: Partial<Record<PresetHarness, string | null>>;
}

// `chooseProject` asks which shown project to launch in, after the agent,
// instead of using `projectId`.
const props = defineProps<{ projectId: string; label?: string; nested?: boolean; chooseProject?: boolean; triggerClass?: string }>();
const emit = defineEmits<{ started: [] }>();
const { launchHarness: startHarness } = useHarnessLaunch();
const { harnesses, projects } = useWorkbench();
const menuOpen = ref(false);

// A project linked with paired hosts can launch on any of them. The ID names
// the project on that host, so the launch runs there.
const project = computed(() => props.chooseProject ? null : projects.value.find((candidate) => candidate.project.id === props.projectId) ?? null);
const hostOptions = computed(() => {
  const current = project.value?.project;
  if (!current || current.host) return [];
  return [{ value: current.id, label: 'This host' }, ...(current.remotes ?? []).map((remote) => ({ value: remote.projectId, label: remote.host }))];
});
const targetProjectId = ref(props.projectId);
watch(() => [props.projectId, hostOptions.value.length], () => {
  if (!hostOptions.value.some((option) => option.value === targetProjectId.value)) targetProjectId.value = props.projectId;
});
// A project that exists only on a paired host is remote whichever option is
// chosen.
const remoteTarget = computed(() => Boolean(project.value?.project.host) || targetProjectId.value !== props.projectId);

// Showing all agents, the agent you pick waits while you choose a shown
// project, or one of its paired hosts, to start it in.
const pending = ref<{ harness: string; presetId: string | null } | null>(null);
watch(menuOpen, (open) => { if (!open) pending.value = null; });
const pendingLabel = computed(() => {
  if (!pending.value) return '';
  const preset = presets.value.presets.find((candidate) => candidate.id === pending.value?.presetId);
  return `${harnessLabel(pending.value.harness)}${preset ? ` · ${preset.name}` : ''}`;
});
const shownTargets = computed(() => launchTargets(projects.value, allAgentsHiding(allAgents, projects.value)));
const targetHost = computed(() => project.value?.project.host ?? hostOptions.value.find((option) => option.value === targetProjectId.value)?.label ?? '');
// Another host has its own CLIs; its presets stay there, so a launch there
// uses that host's default preset.
const remoteHarnesses = ref<HarnessInstallationRecord[]>([]);
watch([targetProjectId, () => menuOpen.value], async ([target, open]) => {
  if (!open || !remoteTarget.value) return;
  try {
    const result = await window.patterm.call('harness_list', { project_id: target }) as { harnesses?: HarnessInstallationRecord[] } | HarnessInstallationRecord[];
    remoteHarnesses.value = Array.isArray(result) ? result : result.harnesses ?? [];
  } catch (caught) {
    remoteHarnesses.value = [];
    toast.error(caught instanceof Error ? caught.message : 'Could not list that host\'s agents');
  }
});

// Showing all agents, each paired host offers its own CLIs, so the list
// covers every host and the project step offers only targets that have the
// one you picked. A host that can't be reached offers none.
const hostHarnesses = ref<Record<string, HarnessInstallationRecord[]>>({});
watch(menuOpen, async (open) => {
  if (!open || !props.chooseProject) return;
  const hosts = new Map(shownTargets.value.flatMap((target) => target.host ? [[target.host, target.targetProjectId] as const] : []));
  hostHarnesses.value = Object.fromEntries(await Promise.all([...hosts].map(async ([host, projectId]) => {
    try {
      const result = await window.patterm.call('harness_list', { project_id: projectId }) as { harnesses?: HarnessInstallationRecord[] } | HarnessInstallationRecord[];
      return [host, filterLaunchableHarnesses(Array.isArray(result) ? result : result.harnesses ?? [])] as const;
    } catch {
      return [host, []] as const;
    }
  })));
});
function harnessesOn(host: string | null): HarnessInstallationRecord[] {
  return host ? hostHarnesses.value[host] ?? [] : filterLaunchableHarnesses(harnesses.value);
}
const pendingTargets = computed(() => pending.value ? targetsWithHarness(shownTargets.value, pending.value.harness, harnessesOn) : []);

// Real agent CLIs only — the raw shell is offered as a process, not an agent.
const launchableHarnesses = computed(() => {
  if (!props.chooseProject) return filterLaunchableHarnesses(remoteTarget.value ? remoteHarnesses.value : harnesses.value);
  const all = [harnessesOn(null), ...Object.values(hostHarnesses.value)].flat();
  return all.filter((record, index) => all.findIndex((other) => other.harness === record.harness) === index);
});
const interfaceMode = ref<AgentInterface>('integrated');
const savedInterfaceMode = ref<AgentInterface>('integrated');

onMounted(async () => {
  try {
    const result = await window.patterm.call('settings_agent_interface_get', {}) as { interface_mode?: unknown };
    if (result.interface_mode === 'tui' || result.interface_mode === 'integrated') interfaceMode.value = savedInterfaceMode.value = result.interface_mode;
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : 'Failed to load the agent interface preference');
  }
});

async function saveInterface(value: unknown): Promise<void> {
  if (value !== 'tui' && value !== 'integrated') return;
  interfaceMode.value = value;
  try {
    await window.patterm.call('settings_agent_interface_update', { interface_mode: value });
    savedInterfaceMode.value = value;
  } catch (caught) {
    interfaceMode.value = savedInterfaceMode.value;
    toast.error(caught instanceof Error ? caught.message : 'Failed to save the agent interface preference');
  }
}
const expandedHarness = ref<string | null>(null);
const presets = ref<HarnessPresetSettings>({ presets: [], defaultPresetIdByHarness: {} });

watch(menuOpen, (open) => {
  if (open) void loadPresets();
  else expandedHarness.value = null;
});

void loadPresets();

async function loadPresets(): Promise<void> {
  try {
    const response = await harnessPresets<HarnessPresetSettings>();
    if (response) presets.value = response;
  } catch {
    // The launch menu still works without presets; fall back to CLI defaults.
  }
}

function presetsFor(harness: string): HarnessPreset[] {
  if (remoteTarget.value) return [];
  return presets.value.presets.filter((preset) => preset.harness === harness);
}

function presetSummary(harness: string): string {
  const count = presetsFor(harness).length;
  const name = presetsFor(harness).find((preset) => preset.id === defaultPresetId(harness))?.name;
  if (!name) return `${count} ${count === 1 ? 'preset' : 'presets'}`;
  return count > 1 ? `${name} · ${count}` : name;
}

function defaultPresetId(harness: string): string | null {
  const id = presets.value.defaultPresetIdByHarness[harness as PresetHarness] ?? null;
  return id && presetsFor(harness).some((preset) => preset.id === id) ? id : null;
}

function pickHarness(harness: string, presetId: string | null): void {
  if (!props.chooseProject) {
    launchHarness(harness, presetId, { projectId: props.projectId, targetProjectId: targetProjectId.value, host: remoteTarget.value ? targetHost.value : null });
    return;
  }
  pending.value = { harness, presetId };
  focusFirst('[data-launch-target]');
}

function backToAgents(): void {
  pending.value = null;
  focusFirst('[data-launch-harness]');
}

// Swapping the menu's items drops focus, so keyboard users keep their place.
function focusFirst(selector: string): void {
  void nextTick(() => document.querySelector<HTMLElement>(selector)?.focus());
}

// Choosing the project next keeps the menu open.
function selectPreset(event: Event, harness: string, presetId: string): void {
  if (props.chooseProject) event.preventDefault();
  pickHarness(harness, presetId);
}

// Another host keeps its presets, so a launch there uses its default.
function launchHarness(harness: string, presetId: string | null, target: Pick<LaunchTarget, 'projectId' | 'targetProjectId' | 'host'>): void {
  menuOpen.value = false;
  startHarness({
    harness,
    projectId: target.projectId,
    targetProjectId: target.targetProjectId,
    ...(presetId && !target.host ? { preset: presetId } : {}),
    ...(target.host ? { host: target.host } : {}),
    interfaceMode: interfaceMode.value
  });
  emit('started');
}
</script>
