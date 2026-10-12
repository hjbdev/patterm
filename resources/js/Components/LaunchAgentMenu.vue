<template>
  <ResponsiveMenu v-model:open="menuOpen" title="Launch agent" align="end" desktop-class="w-56" :nested="nested ?? false">
    <template #trigger>
      <Button
        :variant="label ? 'secondary' : 'ghost'"
        :size="label ? 'sm' : 'icon'"
        :class="label ? 'h-7 gap-2 px-2 text-xs' : 'h-7 w-7 rounded-tab text-muted-foreground'"
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
      <InterfaceModeToggle menu :model-value="interfaceMode" @update:model-value="saveInterface" />
      <div v-if="hostOptions.length > 1" class="px-1 py-1" @keydown.stop>
        <SettingsChoice v-model="targetProjectId" :options="hostOptions" aria-label="Launch on" segmented class="w-full" />
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuSub v-for="harness in launchableHarnesses" :key="harness.id">
        <DropdownMenuSubTrigger
          :disabled="launching"
          class="gap-2"
          @click.prevent.stop="launchHarness(harness.harness, defaultPresetId(harness.harness))"
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
            :disabled="launching"
            @select="launchHarness(harness.harness, preset.id)"
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
    <template #mobile>
      <div v-if="hostOptions.length > 1" class="pb-2">
        <SettingsChoice v-model="targetProjectId" :options="hostOptions" aria-label="Launch on" segmented class="w-full" />
      </div>
      <p v-if="!launchableHarnesses.length" class="py-3 text-sm text-muted-foreground">No agent CLIs found on PATH</p>
      <div class="divide-y divide-border">
        <div v-for="harness in launchableHarnesses" :key="harness.id" class="py-1">
          <div class="flex items-center gap-1">
            <button type="button" class="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60" :disabled="launching" @click="launchHarness(harness.harness, defaultPresetId(harness.harness))">
              <AgentIcon :harness="harness.harness" class="h-4 w-4 shrink-0" />
              <span class="min-w-0 flex-1 truncate">{{ harnessLabel(harness.harness) }}</span>
            </button>
            <button v-if="presetsFor(harness.harness).length" type="button" class="flex min-h-11 max-w-[45%] shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60" :aria-expanded="expandedHarness === harness.harness" :aria-label="`Choose ${harnessLabel(harness.harness)} preset`" @click="expandedHarness = expandedHarness === harness.harness ? null : harness.harness">
              <span class="min-w-0 truncate">{{ presetSummary(harness.harness) }}</span>
              <ChevronDown class="h-4 w-4 shrink-0 transition-transform" :class="expandedHarness === harness.harness ? 'rotate-180' : ''" />
            </button>
          </div>
          <div v-if="expandedHarness === harness.harness" class="pb-1 pl-7">
            <button v-for="preset in presetsFor(harness.harness)" :key="preset.id" type="button" class="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-muted/60" :disabled="launching" @click="launchHarness(harness.harness, preset.id)">
              <span class="min-w-0 flex-1 truncate">{{ preset.name }}</span>
              <span class="max-w-[50%] shrink-0 truncate text-xs text-muted-foreground">{{ preset.model ?? 'Harness default' }}{{ preset.reasoning ? ` · ${preset.reasoning}` : '' }}</span>
              <Check class="h-4 w-4 shrink-0" :class="defaultPresetId(harness.harness) === preset.id ? 'text-foreground' : 'invisible'" :aria-label="defaultPresetId(harness.harness) === preset.id ? 'Default preset' : undefined" />
            </button>
          </div>
        </div>
      </div>
    </template>
  </ResponsiveMenu>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Check, ChevronDown, Plus } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { useWorkbench } from '../Composables/useWorkbench';
import { harnessLabel, launchableHarnesses as filterLaunchableHarnesses } from '../lib/harnesses';
import AgentIcon from './AgentIcon.vue';
import InterfaceModeToggle from './InterfaceModeToggle.vue';
import ResponsiveMenu from './ResponsiveMenu.vue';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from './ui/dropdown-menu';
import SettingsChoice from './settings/SettingsChoice.vue';
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

const props = defineProps<{ projectId: string; label?: string; nested?: boolean }>();
const emit = defineEmits<{ launched: [sessionId: string, terminalId: string | null] }>();
const { harnesses, projects } = useWorkbench();
const menuOpen = ref(false);

// A project linked with paired hosts can launch on any of them. The ID names
// the project on that host, so the launch runs there.
const project = computed(() => projects.value.find((candidate) => candidate.project.id === props.projectId) ?? null);
const hostOptions = computed(() => {
  const current = project.value?.project;
  if (!current || current.host) return [];
  return [{ value: props.projectId, label: 'This host' }, ...(current.remotes ?? []).map((remote) => ({ value: remote.projectId, label: remote.host }))];
});
const targetProjectId = ref(props.projectId);
watch(() => [props.projectId, hostOptions.value.length], () => {
  if (!hostOptions.value.some((option) => option.value === targetProjectId.value)) targetProjectId.value = props.projectId;
});
// A project that exists only on a paired host is remote whichever option is
// chosen.
const remoteTarget = computed(() => Boolean(project.value?.project.host) || targetProjectId.value !== props.projectId);
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

// Real agent CLIs only — the raw shell is offered as a process, not an agent.
const launchableHarnesses = computed(() => filterLaunchableHarnesses(remoteTarget.value ? remoteHarnesses.value : harnesses.value));
const launching = ref(false);
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
    const response = await window.patterm.harnessPresets() as HarnessPresetSettings | null;
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

async function launchHarness(harness: string, presetId: string | null): Promise<void> {
  if (launching.value) {
    return;
  }
  launching.value = true;
  menuOpen.value = false;
  try {
    const result = (await window.patterm?.call?.('harness_launch', {
      harness,
      project_id: targetProjectId.value,
      ...(presetId && !remoteTarget.value ? { preset: presetId } : {}),
      interface_mode: interfaceMode.value
    })) as { session_id?: unknown; pty_process_id?: unknown } | null | undefined;
    if (typeof result?.session_id === 'string') {
      emit('launched', result.session_id, typeof result.pty_process_id === 'string' ? result.pty_process_id : null);
    }
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : `Failed to launch ${harnessLabel(harness)}`);
  } finally {
    launching.value = false;
  }
}
</script>
