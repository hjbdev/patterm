<template>
  <header class="flex h-11 shrink-0 items-center gap-1.5 overflow-hidden bg-transparent px-2 [container-type:inline-size] sm:gap-2">
    <!-- Only when the bar is wide enough: narrower, as in a small window or beside the docked assistant, the switcher and toolbar already fill it and the icons would push Settings out of view. -->
    <div v-if="showRecentProjects && recentProjects.length" class="hidden shrink-0 items-center [@container(min-width:46rem)]:flex">
      <Tooltip v-for="projectGroup in [...recentProjects].reverse()" :key="projectGroup.project.id">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="group h-[26px] w-[26px] rounded-tab" :aria-label="`Switch to ${projectGroup.project.name}`" @click="emit('selectProject', projectGroup.project.id)" @pointerenter="prefetchProject(projectGroup.project.id, Tier.Intent)">
            <ProjectStatusLogo :project="projectGroup.project" :states="agentStates(projectGroup.project.id)" dim />
          </Button>
        </TooltipTrigger>
        <TooltipContent class="bg-popover text-popover-foreground">
          {{ projectGroup.project.name }}
          <HostBadge v-if="projectGroup.project.host" :host="projectGroup.project.host" class="ml-1" />
        </TooltipContent>
      </Tooltip>
    </div>

    <ResponsiveMenu v-model:open="projectMenuOpen" title="Projects" desktop-class="w-72" @content-pointer-enter="cancelProjectMenuClose" @content-pointer-leave="scheduleProjectMenuClose" @content-keydown="stopProjectMenuHover" @open-auto-focus="keepHoverFocus" @close-auto-focus="keepHoverFocus">
      <template #trigger>
        <Button variant="ghost" size="sm" class="h-[26px] max-w-[60vw] shrink-0 justify-between gap-1 rounded-tab px-2 py-0.5 text-[13px] sm:max-w-64 sm:gap-2" @pointerenter="openProjectMenuOnHover" @pointerleave="scheduleProjectMenuClose" @pointerdown="stopProjectMenuHover" @keydown="stopProjectMenuHover">
          <template v-if="allAgents">
            <Layers class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span class="truncate">All agents</span>
          </template>
          <template v-else>
            <ProjectStatusLogo v-if="activeProject" :project="activeProject.project" :states="agentStates(activeProject.project.id)" />
            <span class="truncate">{{ activeProject?.project.name ?? 'Projects' }}</span>
            <HostBadge v-if="activeProject?.project.host" :host="activeProject.project.host" />
            <!-- A phone shows one project's list, so another waiting shows here. -->
            <span v-if="phoneLayout && elsewhereWaiting" class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-label="An agent in another project is waiting" />
          </template>
          <Badge v-if="shownAgentCount > 0" variant="secondary" class="ml-auto h-5 px-1.5 text-[10px] tabular-nums">
            {{ shownAgentCount }}
          </Badge>
          <ChevronDown class="h-4 w-4 shrink-0 opacity-70" />
        </Button>
      </template>
      <template #desktop>
        <!-- Every shown project's agents together, until you pick a project. -->
        <DropdownMenuItem
          class="py-1 text-[13px] data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
          :class="allAgents && 'bg-primary/10'"
          @select="emit('selectAllAgents')"
        >
          <Layers class="mr-2 h-3.5 w-3.5 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">All agents</span>
          <Badge v-if="totalAgentCount > 0" variant="secondary" class="ml-2 h-5 px-1.5 text-[10px] tabular-nums">{{ totalAgentCount }}</Badge>
        </DropdownMenuItem>
        <DropdownMenuSeparator v-if="projects.length" />
        <DropdownMenuItem
          v-for="projectGroup in switcherProjects"
          :key="projectGroup.project.id"
          class="py-1 text-[13px] data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
          :class="projectSnoozed(projectGroup.project) && 'text-muted-foreground opacity-70'"
          @select="emit('selectProject', projectGroup.project.id)"
          @pointerenter="prefetchProject(projectGroup.project.id, Tier.Intent)"
          @focus="prefetchProject(projectGroup.project.id, Tier.Intent)"
        >
          <ProjectStatusLogo :project="projectGroup.project" :states="agentStates(projectGroup.project.id)" class="mr-2" />
          <span class="min-w-0 flex-1 truncate">{{ projectGroup.project.name }}</span>
          <SnoozeIcon v-if="projectSnoozed(projectGroup.project)" class="ml-1.5 h-3.5 w-3.5 shrink-0" />
          <HostBadge v-if="projectGroup.project.host" :host="projectGroup.project.host" class="ml-1.5" />
          <UnreadDot :urgency="projectUnread(projectGroup.project.id) ? 'normal' : null" />
          <Badge v-if="openAgentCount(projectGroup, botHidden.sessions) > 0" variant="secondary" class="ml-2 h-5 px-1.5 text-[10px] tabular-nums">
            {{ openAgentCount(projectGroup, botHidden.sessions) }}
          </Badge>
        </DropdownMenuItem>
        <DropdownMenuSeparator v-if="projects.length" />
        <DropdownMenuItem class="py-1 text-[13px] data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground" @select="emit('selectProject', null)">
          <LayoutGrid class="mr-2 h-3.5 w-3.5" />
          Project selector
        </DropdownMenuItem>
      </template>
      <!-- On a phone: the projects, a ? on any with an agent waiting, then the
           ways out to every project. -->
      <template #mobile>
        <div class="space-y-1">
          <button v-for="projectGroup in switcherProjects" :key="projectGroup.project.id" type="button" :class="[MOBILE_ROW, !allAgents && projectGroup.project.id === activeProjectId ? 'bg-primary/10' : '', projectSnoozed(projectGroup.project) && 'text-muted-foreground opacity-70']" @click="selectMobileProject(projectGroup.project.id)">
            <ProjectStatusLogo :project="projectGroup.project" :states="agentStates(projectGroup.project.id)" :size="16" />
            <span class="min-w-0 flex-1 truncate">{{ projectGroup.project.name }}</span>
            <StatusIcon v-if="waiting(projectGroup.project.id)" :spec="activityIcon('question')" class="h-3.5 w-3.5" />
            <SnoozeIcon v-if="projectSnoozed(projectGroup.project)" class="h-4 w-4 shrink-0" />
            <HostBadge v-if="projectGroup.project.host" :host="projectGroup.project.host" />
            <UnreadDot :urgency="projectUnread(projectGroup.project.id) ? 'normal' : null" />
            <span v-if="openAgentCount(projectGroup, botHidden.sessions) > 0" class="min-w-5 text-right text-[13px] tabular-nums text-muted-foreground">{{ openAgentCount(projectGroup, botHidden.sessions) }}</span>
          </button>
          <div v-if="projects.length" class="my-2 border-t border-border" />
          <button type="button" :class="[MOBILE_ROW, allAgents ? 'bg-primary/10' : '']" @click="selectMobileAllAgents">
            <Layers class="h-4 w-4 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate">All agents</span>
            <span v-if="totalAgentCount > 0" class="min-w-5 text-right text-[13px] tabular-nums text-muted-foreground">{{ totalAgentCount }}</span>
          </button>
          <button type="button" :class="MOBILE_ROW" @click="selectMobileProject(null)">
            <LayoutGrid class="h-4 w-4 text-muted-foreground" />All projects
          </button>
          <NewProjectDialog @created="selectMobileProject">
            <template #trigger>
              <button type="button" :class="[MOBILE_ROW, 'text-muted-foreground']"><Plus class="h-4 w-4" />New project</button>
            </template>
          </NewProjectDialog>
        </div>
      </template>
    </ResponsiveMenu>

    <slot name="terminal-tabs" />

    <div class="ml-auto flex shrink-0 items-center gap-1.5">
      <!-- The app's own pages wait behind ⋯. A phone's Library has them and
           the notifications instead. -->
      <AssistantButton />
      <Button variant="ghost" size="sm" class="h-7 gap-2 rounded-tab px-2 text-xs text-muted-foreground" aria-label="Search or jump to" @click="emit('commandPalette')">
        <Search class="h-4 w-4" /><span class="hidden sm:inline">Search or jump to…</span><kbd class="hidden rounded border border-border/70 px-1 text-[10px] sm:inline">Ctrl K</kbd>
      </Button>
      <template v-if="!phoneLayout">
        <NotificationTray />
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon" class="relative h-7 w-7 rounded-tab text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground" :aria-label="menuLabel" :title="menuLabel">
              <Ellipsis class="h-4 w-4" />
              <span v-if="updateAvailable" class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-56">
            <DropdownMenuItem class="text-[13px]" @select="emit('routines')"><CalendarClock class="mr-2 h-4 w-4 text-muted-foreground" />Scheduled</DropdownMenuItem>
            <DropdownMenuItem class="text-[13px]" @select="emit('usage')"><Gauge class="mr-2 h-4 w-4 text-muted-foreground" />Usage</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem class="text-[13px]" @select="emit('settings')">
              <Settings class="mr-2 h-4 w-4 text-muted-foreground" /><span class="flex-1">Settings</span>
              <span v-if="updateAvailable" class="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </template>
      <Tooltip v-if="!sidecarAvailable">
        <TooltipTrigger as-child>
          <Badge variant="outline" class="h-6 cursor-help border-destructive/40 bg-destructive/10 px-2 text-[11px] text-destructive">
            {{ sidecarStatus }}
          </Badge>
        </TooltipTrigger>
        <TooltipContent align="end" class="max-w-72 bg-popover text-popover-foreground">
          <p class="font-medium">Terminal core unavailable</p>
          <p class="mt-1 text-muted-foreground">Agent and process terminals cannot launch until the native terminal sidecar starts.</p>
        </TooltipContent>
      </Tooltip>
    </div>
  </header>
</template>

<script setup lang="ts">
import HostBadge from './HostBadge.vue';
import AssistantButton from './Assistant/AssistantButton.vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { CalendarClock, ChevronDown, Ellipsis, Gauge, Layers, LayoutGrid, Plus, Search, Settings } from 'lucide-vue-next';
import NewProjectDialog from './NewProjectDialog.vue';
import StatusIcon from './StatusIcon.vue';
import { activityIcon } from '../lib/statusIcons';
import { phoneLayout } from '../lib/phoneLayout';
import { allAgents as allAgentsState, listedProjects, openAgentCount, projectShown } from '../lib/allAgents';
import { projectSnoozed, snoozedProjectsLast } from '../lib/projectSnooze';
import SnoozeIcon from './SnoozeIcon.vue';
import { readRecentProjectIds, rememberRecentProject, shownRecentProjects } from '../lib/recentProjects';
import type { ProjectWorkbench } from '../types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import ResponsiveMenu from './ResponsiveMenu.vue';
import ProjectStatusLogo from './ProjectStatusLogo.vue';
import { projectOverviews, type AgentState } from '../lib/projectOverview';
import { useBots } from '../Composables/useBots';
import UnreadDot from './UnreadDot.vue';
import { useUpdates } from '../lib/updates';
import NotificationTray from './NotificationTray.vue';
import { projectUnread } from '../Composables/useNotifications';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { prefetchProject, Tier } from '../lib/prefetch';

const props = defineProps<{
  projects: ProjectWorkbench[];
  activeProjectId: string | null;
  sidecarStatus: string;
  sidecarAvailable: boolean;
  showRecentProjects: boolean;
  // Showing every shown project's agents, and how many are open.
  allAgents?: boolean;
  allAgentsCount?: number;
}>();
// A bot's helpers never count as the project's agents.
const { hidden: botHidden } = useBots();

const emit = defineEmits<{
  selectProject: [projectId: string | null];
  selectAllAgents: [];
  commandPalette: [];
  settings: [];
  usage: [];
  routines: [];
}>();

const recentProjectIds = ref(readRecentProjectIds(globalThis.localStorage));
watch(() => props.activeProjectId, (projectId) => {
  if (projectId) recentProjectIds.value = rememberRecentProject(recentProjectIds.value, projectId, globalThis.localStorage);
}, { immediate: true });
// The state of each project's live root agents, for the status on its logo.
const projectAgentStates = computed(() => new Map(projectOverviews(props.projects, botHidden.value.sessions).map((overview) => [overview.project.id, overview.agents.map((agent) => agent.state)])));
const NO_AGENTS: AgentState[] = [];
function agentStates(projectId: string): AgentState[] {
  return projectAgentStates.value.get(projectId) ?? NO_AGENTS;
}
const recentProjects = computed(() => shownRecentProjects(recentProjectIds.value, props.projects, props.activeProjectId));
const MOBILE_ROW = 'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
function waiting(projectId: string): boolean {
  return agentStates(projectId).includes('waiting');
}
// Another awake project with an agent waiting on you.
const elsewhereWaiting = computed(() => props.projects.some((item) => item.project.id !== props.activeProjectId && !projectSnoozed(item.project) && waiting(item.project.id)));

const projectMenuOpen = ref(false);
// Opening the switcher reads every project's running agents ahead; hovering
// one reads it first.
watch(projectMenuOpen, (open) => {
  if (open) for (const projectGroup of props.projects) prefetchProject(projectGroup.project.id, Tier.Other);
});
let projectMenuHovered = false;
let projectMenuCloseTimer: ReturnType<typeof setTimeout> | undefined;

function selectMobileAllAgents(): void {
  projectMenuOpen.value = false;
  emit('selectAllAgents');
}
function selectMobileProject(projectId: string | null): void {
  projectMenuOpen.value = false;
  emit('selectProject', projectId);
}

function cancelProjectMenuClose(): void {
  clearTimeout(projectMenuCloseTimer);
  projectMenuCloseTimer = undefined;
}

function openProjectMenuOnHover(event: PointerEvent): void {
  if (event.pointerType !== 'mouse' || window.matchMedia('(max-width: 639px)').matches) return;
  cancelProjectMenuClose();
  if (projectMenuOpen.value) return;
  projectMenuHovered = true;
  projectMenuOpen.value = true;
}

function scheduleProjectMenuClose(): void {
  if (!projectMenuHovered) return;
  cancelProjectMenuClose();
  projectMenuCloseTimer = setTimeout(() => { projectMenuOpen.value = false; }, 100);
}

function keepHoverFocus(event: Event): void {
  if (projectMenuHovered) event.preventDefault();
}

function stopProjectMenuHover(): void {
  projectMenuHovered = false;
  cancelProjectMenuClose();
}

onBeforeUnmount(cancelProjectMenuClose);

const activeProject = computed(() => props.projects.find((project) => project.project.id === props.activeProjectId) ?? null);
const shownAgentCount = computed(() => props.allAgents ? props.allAgentsCount ?? 0 : activeProject.value ? openAgentCount(activeProject.value, botHidden.value.sessions) : 0);
// What All agents would show: the projects switched on in its Projects menu.
// Snoozed projects wait at the bottom, muted.
const switcherProjects = computed(() => snoozedProjectsLast(props.projects, (item) => item.project));
const totalAgentCount = computed(() => listedProjects(props.projects).filter((project) => projectShown(allAgentsState, project.project.id) && !projectSnoozed(project.project)).reduce((total, project) => total + openAgentCount(project, botHidden.value.sessions), 0));


// A release newer than this install marks Settings, and the ⋯ it sits behind,
// until it is installed.
const updates = useUpdates();
const updateAvailable = computed(() => updates.value?.status === 'available');
const menuLabel = computed(() => updateAvailable.value ? `More: Patterm ${updates.value?.latest?.version} is available` : 'More');
</script>
