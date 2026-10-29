<template>
  <ResponsivePopover v-model:open="menuOpen" title="Start an agent" align="end" content-class="w-[22rem] p-0">
    <template #trigger>
      <Button
        :variant="label ? 'secondary' : 'ghost'"
        :size="label ? 'sm' : 'icon'"
        :class="cn(label ? 'h-7 gap-2 px-2 text-xs' : 'h-7 w-7 rounded-tab text-muted-foreground', triggerClass)"
        :title="label ?? 'Start an agent'"
        :aria-label="label ?? 'Start an agent'"
      >
        <Plus class="h-4 w-4" />
        <span v-if="label">{{ label }}</span>
      </Button>
    </template>

    <!-- Tab on a profile writes its first message here; Start sends it. -->
    <div v-if="composerRow" data-launch-composer>
      <div class="flex h-10 items-center gap-2 pl-1 pr-3">
        <button type="button" class="flex h-7 w-7 shrink-0 items-center justify-center rounded-tab text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label="Back to profiles" title="Back (Esc)" @click="stopComposing">
          <ChevronLeft class="h-4 w-4" />
        </button>
        <AgentIcon :harness="composerRow.harness" class="h-4 w-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 truncate text-[13px]">{{ composerRow.name }}</span>
        <span class="ml-auto min-w-0 shrink-[3] truncate pl-2 text-[11px] text-muted-foreground">{{ composed?.detail ?? composerNote }}</span>
      </div>
      <Textarea v-model="message" rows="3" :placeholder="`Ask ${composerRow.name} to…`" aria-label="First message" class="min-h-20 resize-none rounded-none border-0 border-t border-border px-3 py-2.5 text-[13px] shadow-none focus-visible:ring-0" @keydown="onComposerKeydown" />
    </div>

    <Command v-else ref="command" @highlight="(item) => highlighted = typeof item?.value === 'string' ? item.value : null">
      <!-- The list filters itself, as ContextPickerList does, so the new
           profile row stays when the search stops matching it. -->
      <div class="flex items-center border-b px-3">
        <MagnifyingGlassIcon class="mr-2 h-4 w-4 shrink-0 opacity-50" />
        <!-- A phone keeps its keyboard down until you tap the search. -->
        <ListboxFilter v-model="search" :auto-focus="!phoneLayout" :placeholder="phoneLayout ? 'Search profiles' : 'Start an agent…'" aria-label="Filter profiles" class="flex h-10 w-full bg-transparent py-3 text-[13px] outline-none placeholder:text-muted-foreground" @keydown="onFilterKeydown" />
      </div>
      <CommandList class="max-h-none overflow-visible">
        <div class="max-h-[min(20rem,50dvh)] overflow-y-auto overscroll-contain p-1">
          <CommandGroup v-if="matches.length" class="p-0">
            <CommandItem v-for="(row, index) in matches" :key="row.key" :value="row.key" data-launch-profile :class="cn('gap-2.5 px-2', phoneLayout ? 'min-h-11' : 'h-[34px]')" @select="launchRow(row)">
              <!-- Profiles show their CLI; faces are for bots. -->
              <AgentIcon :harness="row.harness" class="!h-4 !w-4 shrink-0 text-muted-foreground" />
              <!-- Long names and details both give way, so the message button stays in the row. -->
              <span class="min-w-0 truncate text-[13px]">{{ row.name }}</span>
              <span class="ml-auto min-w-0 shrink-[3] truncate pl-2 text-[11px] text-muted-foreground">{{ row.detail }}</span>
              <button
                v-if="phoneLayout || highlighted === row.key"
                type="button"
                :class="cn('-mr-1 flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background/60 hover:text-foreground', phoneLayout ? 'h-9 w-9' : 'h-6 w-6')"
                :title="`Write ${row.name}’s first message (Tab)`"
                :aria-label="`Write ${row.name}’s first message`"
                @click.stop="compose(row)"
              >
                <MessageSquareText class="!h-3.5 !w-3.5" />
              </button>
              <kbd v-else-if="!phoneLayout && !search.trim() && index < 9" class="w-6 shrink-0 text-right font-sans text-[10.5px] text-muted-foreground/70">{{ index + 1 }}</kbd>
              <span v-else-if="!phoneLayout" class="w-6 shrink-0" />
            </CommandItem>
          </CommandGroup>
          <p v-else class="px-2 py-2.5 text-xs text-muted-foreground">{{ emptyText }}</p>
        </div>
        <CommandGroup class="border-t p-1">
          <CommandItem value="new-profile" :class="cn('gap-2.5 px-2 text-[13px] text-muted-foreground', phoneLayout ? 'min-h-11' : 'h-8')" @select="openProfiles">
            <Plus class="text-muted-foreground" />
            <span>New profile…</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>

    <div class="flex items-center gap-1 border-t border-border px-1.5 py-1.5">
      <DropdownMenu v-if="chooseProject || targets.length > 1">
        <DropdownMenuTrigger as-child>
          <button type="button" class="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground" :aria-label="`Start in ${targetLabel(target)}`">
            <ProjectLogo v-if="chooseProject && target" :project="target.project" :size="14" />
            <span class="min-w-0 truncate">{{ targetLabel(target) }}</span>
            <HostBadge v-if="chooseProject && target?.host" :host="target.host" />
            <ChevronDown class="h-3.5 w-3.5 shrink-0 opacity-70" />
          </button>
        </DropdownMenuTrigger>
        <!-- Typing carries on where it was, so Enter still starts the agent. -->
        <DropdownMenuContent align="start" class="max-h-72 w-60 overflow-y-auto" @close-auto-focus="refocus">
          <DropdownMenuItem v-for="option in targets" :key="option.targetProjectId" data-launch-target class="gap-2 text-[13px]" @select="targetProjectId = option.targetProjectId">
            <ProjectLogo v-if="chooseProject" :project="option.project" :size="14" />
            <span class="min-w-0 flex-1 truncate">{{ targetLabel(option) }}</span>
            <HostBadge v-if="chooseProject && option.host" :host="option.host" />
            <Check class="h-3.5 w-3.5 shrink-0" :class="option.targetProjectId === targetProjectId ? '' : 'invisible'" />
          </DropdownMenuItem>
          <DropdownMenuItem v-if="!targets.length" disabled>
            <span class="text-xs text-muted-foreground">No shown project</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span class="flex-1" />
      <InterfaceModeToggle :compact="!phoneLayout" :model-value="interfaceMode" @update:model-value="saveInterface" />
      <Button v-if="composing" type="button" size="sm" class="ml-1 h-7 gap-1.5 px-2.5 text-xs" :disabled="!composed || !launchTarget" @click="startComposed">
        Start
        <CornerDownLeft class="h-3 w-3 opacity-60" />
      </Button>
    </div>
  </ResponsivePopover>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { MagnifyingGlassIcon } from '@radix-icons/vue';
import { Check, ChevronDown, ChevronLeft, CornerDownLeft, MessageSquareText, Plus } from 'lucide-vue-next';
import { ListboxFilter, useFilter } from 'reka-ui';
import { toast } from 'vue-sonner';
import { useHarnessLaunch } from '../Composables/useHarnessLaunch';
import { useWorkbench } from '../Composables/useWorkbench';
import { harnessLabel, launchableHarnesses as filterLaunchableHarnesses } from '../lib/harnesses';
import { phoneLayout } from '../lib/phoneLayout';
import { composedRow, rosterRows, type ModelLabel, type ProfileSettings, type RosterRow } from '../lib/profiles';
import { harnessModels, harnessPresets } from '../lib/serverQuery';
import { allAgents, allAgentsHiding, chosenLaunchTarget, launchTargets, type LaunchTarget } from '../lib/allAgents';
import { cn } from '../lib/utils';
import AgentIcon from './AgentIcon.vue';
import HostBadge from './HostBadge.vue';
import InterfaceModeToggle from './InterfaceModeToggle.vue';
import ProjectLogo from './ProjectLogo.vue';
import ResponsivePopover from './ResponsivePopover.vue';
import { Button } from './ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from './ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Textarea } from './ui/textarea';
import type { AgentInterface, HarnessInstallationRecord } from '../types';

interface ModelCatalog { providers: Record<string, { models: Array<{ id: string; label: string }> } | null> }

// `chooseProject` picks the project from the footer, among the shown ones,
// instead of using `projectId`.
const props = defineProps<{ projectId: string; label?: string; chooseProject?: boolean; triggerClass?: string }>();
const emit = defineEmits<{ started: [] }>();
const router = useRouter();
const { launchHarness: startHarness } = useHarnessLaunch();
const { harnesses, projects } = useWorkbench();
const { contains } = useFilter({ sensitivity: 'base' });
const menuOpen = ref(false);
const command = ref<InstanceType<typeof Command> | null>(null);
const search = ref('');
const highlighted = ref<string | null>(null);
const composing = ref<RosterRow | null>(null);
const message = ref('');

// Where the agent starts: this project and its paired hosts, or every shown
// project and its hosts when choosing. Each ID names the project on the host
// that runs it.
const targets = computed<LaunchTarget[]>(() => props.chooseProject
  ? launchTargets(projects.value, allAgentsHiding(allAgents, projects.value))
  : launchTargets(projects.value.filter((item) => item.project.id === props.projectId), { active: false, hidden: [] }));
const targetProjectId = ref(props.projectId);
watch([targets, () => props.projectId], () => {
  if (targets.value.some((option) => option.targetProjectId === targetProjectId.value)) return;
  targetProjectId.value = targets.value.find((option) => option.targetProjectId === props.projectId)?.targetProjectId ?? targets.value[0]?.targetProjectId ?? props.projectId;
}, { immediate: true });
const target = computed(() => targets.value.find((option) => option.targetProjectId === targetProjectId.value) ?? null);
// Null when choosing and no project is shown, so nothing starts.
const launchTarget = computed(() => chosenLaunchTarget(targets.value, targetProjectId.value, props.projectId, Boolean(props.chooseProject)));

function targetLabel(option: LaunchTarget | null): string {
  if (!option) return 'Choose a project';
  return props.chooseProject ? option.project.name : option.host ?? 'This host';
}

// Another host has its own CLIs, listed when it's chosen. A host that can't
// be reached lists none.
const hostHarnesses = ref<Record<string, HarnessInstallationRecord[]>>({});
const loadingHost = ref<string | null>(null);
watch([() => launchTarget.value?.host, menuOpen], async ([host, open]) => {
  const projectId = launchTarget.value?.targetProjectId;
  if (!open || !host || !projectId || hostHarnesses.value[host]) return;
  loadingHost.value = host;
  try {
    const result = await window.patterm.call('harness_list', { project_id: projectId }) as { harnesses?: HarnessInstallationRecord[] } | HarnessInstallationRecord[];
    hostHarnesses.value = { ...hostHarnesses.value, [host]: filterLaunchableHarnesses(Array.isArray(result) ? result : result.harnesses ?? []) };
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : `Could not list ${host}’s agents`);
  } finally {
    if (loadingHost.value === host) loadingHost.value = null;
  }
});

const presets = ref<ProfileSettings>({ presets: [], defaultPresetIdByHarness: { claude: null, codex: null, opencode: null } });
// Model names as Settings shows them, such as Fable 5.1 for `fable`.
const catalog = ref<ModelCatalog | null>(null);
const modelLabel: ModelLabel = (harness, model) => catalog.value?.providers[harness]?.models.find((entry) => entry.id === model)?.label ?? null;
const rows = computed(() => {
  if (!launchTarget.value) return [];
  const host = launchTarget.value.host;
  const installed = (host ? hostHarnesses.value[host] ?? [] : filterLaunchableHarnesses(harnesses.value)).map((record) => record.harness);
  return rosterRows(presets.value, installed, host, modelLabel);
});
const matches = computed(() => {
  const query = search.value.trim();
  if (!query) return rows.value;
  return rows.value.filter((row) => contains(row.name, query) || contains(row.detail, query) || contains(harnessLabel(row.harness), query));
});
// The profile a first message will start, re-checked when the host changes.
// The composer keeps showing the chosen one while no CLI there matches.
const composed = computed(() => composing.value ? composedRow(rows.value, composing.value) : null);
const composerRow = computed(() => composed.value ?? composing.value);
const emptyText = computed(() => {
  if (!launchTarget.value) return 'No shown project to start in';
  if (search.value.trim()) return 'No matching profiles';
  const host = launchTarget.value.host;
  if (host && loadingHost.value === host) return `Listing ${host}’s agents…`;
  return host ? `No agent CLIs found on ${host}` : 'No agent CLIs found on PATH';
});
// Why Start is off while a first message waits for a CLI the target lacks.
const composerNote = computed(() => {
  if (!launchTarget.value) return 'No shown project to start in';
  const host = launchTarget.value.host;
  if (host && loadingHost.value === host) return `Listing ${host}’s agents…`;
  return `Not on ${host ?? 'this host'}`;
});

watch(menuOpen, (open) => {
  if (open) {
    void loadPresets();
    return;
  }
  search.value = '';
  composing.value = null;
  message.value = '';
  highlighted.value = null;
});
// Enter starts the first profile straight away, also after backing out of
// a first message.
watch([menuOpen, () => matches.value.length, composing], ([open]) => {
  if (open && !composing.value) void nextTick(() => command.value?.highlightFirstItem());
});

void loadPresets();

async function loadPresets(): Promise<void> {
  try {
    const response = await harnessPresets<ProfileSettings>();
    if (response) presets.value = response;
  } catch {
    // The menu still lists each CLI, which launches with its own model.
  }
  try {
    catalog.value = await harnessModels<ModelCatalog>();
  } catch {
    // Rows show model IDs instead.
  }
}

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

// Tab writes a first message for the highlighted profile. 1–9 start one
// while the search is empty.
function onFilterKeydown(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'Tab' && !event.shiftKey) {
    const row = matches.value.find((candidate) => candidate.key === highlighted.value) ?? matches.value[0];
    if (!row) return;
    event.preventDefault();
    compose(row);
  } else if (/^[1-9]$/.test(event.key) && !search.value.trim()) {
    const row = matches.value[Number(event.key) - 1];
    if (!row) return;
    event.preventDefault();
    launchRow(row);
  }
}

const FILTER_FIELD = '[aria-label="Filter profiles"]';
const COMPOSER_FIELD = '[data-launch-composer] textarea';

function refocus(event: Event): void {
  const field = document.querySelector<HTMLElement>(composing.value ? COMPOSER_FIELD : FILTER_FIELD);
  if (!field) return;
  event.preventDefault();
  field.focus();
}

function compose(row: RosterRow): void {
  composing.value = row;
  void nextTick(() => document.querySelector<HTMLTextAreaElement>(COMPOSER_FIELD)?.focus());
}

function stopComposing(): void {
  composing.value = null;
  message.value = '';
}

// Enter starts, Shift+Enter adds a line, and Esc goes back to the list
// without closing the menu.
function onComposerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    stopComposing();
  } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    startComposed();
  }
}

function startComposed(): void {
  const row = composed.value, target = launchTarget.value;
  if (row && target) launchHarness(row.harness, row.presetId, target, message.value);
}

function launchRow(row: RosterRow): void {
  if (launchTarget.value) launchHarness(row.harness, row.presetId, launchTarget.value);
}

function openProfiles(): void {
  menuOpen.value = false;
  void router.push({ name: 'settings', query: { tab: 'harnesses' } });
}

// Another host keeps its presets, so a launch there uses its default.
function launchHarness(harness: string, presetId: string | null, target: Pick<LaunchTarget, 'projectId' | 'targetProjectId' | 'host'>, prompt = ''): void {
  menuOpen.value = false;
  startHarness({
    harness,
    projectId: target.projectId,
    targetProjectId: target.targetProjectId,
    ...(presetId && !target.host ? { preset: presetId } : {}),
    ...(target.host ? { host: target.host } : {}),
    ...(prompt.trim() ? { initialPrompt: prompt.trim() } : {}),
    interfaceMode: interfaceMode.value
  });
  emit('started');
}
</script>
