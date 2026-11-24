<template>
  <!-- Far-left project dock in desktop sidebar mode: All agents at the top,
       each project with its live status bar, then Search, Notifications, and
       app settings pinned at the foot. -->
  <nav aria-label="Projects" class="flex h-full min-h-0 w-[56px] shrink-0 flex-col items-center py-2">
    <Tooltip>
      <TooltipTrigger as-child>
        <button
          type="button"
          class="relative mb-2 flex h-10 w-10 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :class="allAgents ? 'bg-white/[0.12] text-foreground' : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground'"
          aria-label="All agents"
          :aria-current="allAgents ? 'page' : undefined"
          @click="emit('selectAllAgents')"
        >
          <Layers class="h-[18px] w-[18px]" aria-hidden="true" />
          <span v-if="allAgents" class="absolute -left-2 h-5 w-1 rounded-r-full bg-white" aria-hidden="true" />
          <span v-if="anyWaiting" class="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-400" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" class="bg-popover text-popover-foreground">
        All agents<span v-if="totalAgentCount > 0" class="ml-1.5 tabular-nums text-muted-foreground">{{ totalAgentCount }}</span>
      </TooltipContent>
    </Tooltip>

    <div class="mb-2 h-px w-6 shrink-0 bg-white/[0.08]" aria-hidden="true" />

    <!-- Projects with live comet/amber status bars -->
    <div class="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden py-0.5 [scrollbar-width:none]">
      <Tooltip v-for="projectGroup in dockProjects" :key="projectGroup.project.id">
        <TooltipTrigger as-child>
          <button
            type="button"
            class="group relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            :class="[
              !allAgents && projectGroup.project.id === activeProjectId ? 'bg-white/[0.12]' : 'hover:bg-white/[0.06]',
              projectSnoozed(projectGroup.project) && 'opacity-50'
            ]"
            :aria-label="projectGroup.project.name"
            :aria-current="!allAgents && projectGroup.project.id === activeProjectId ? 'page' : undefined"
            @click="emit('selectProject', projectGroup.project.id)"
            @pointerenter="prefetchProject(projectGroup.project.id, Tier.Intent)"
            @focus="prefetchProject(projectGroup.project.id, Tier.Intent)"
          >
            <span v-if="!allAgents && projectGroup.project.id === activeProjectId" class="absolute -left-2 h-5 w-1 rounded-r-full bg-white" aria-hidden="true" />
            <ProjectStatusLogo
              :project="projectGroup.project"
              :states="agentStates(projectGroup.project.id)"
              :size="22"
              :dim="!allAgents && projectGroup.project.id !== activeProjectId"
            />
            <UnreadDot v-if="projectUnread(projectGroup.project.id)" class="absolute right-1.5 top-1.5" urgency="normal" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" class="bg-popover text-popover-foreground">
          <div class="flex items-center gap-1.5">
            <span>{{ projectGroup.project.name }}</span>
            <HostBadge v-if="projectGroup.project.host" :host="projectGroup.project.host" />
            <span v-if="openAgentCount(projectGroup, botHidden.sessions) > 0" class="tabular-nums text-muted-foreground">{{ openAgentCount(projectGroup, botHidden.sessions) }}</span>
          </div>
          <p v-if="projectSnoozed(projectGroup.project)" class="mt-0.5 text-xs text-muted-foreground">Snoozed</p>
        </TooltipContent>
      </Tooltip>

      <NewProjectDialog @created="selectCreatedProject">
        <template #trigger>
          <button
            type="button"
            class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Add project"
            title="Add project"
          >
            <Plus class="h-4 w-4" aria-hidden="true" />
          </button>
        </template>
      </NewProjectDialog>

      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="All projects"
            @click="emit('selectProject', null)"
          >
            <LayoutGrid class="h-4 w-4" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" class="bg-popover text-popover-foreground">All projects</TooltipContent>
      </Tooltip>
    </div>

    <!-- Bottom utility actions -->
    <div class="flex shrink-0 flex-col items-center gap-1 border-t border-white/[0.06] pt-2">
      <Tooltip v-if="!sidecarAvailable">
        <TooltipTrigger as-child>
          <span class="flex h-9 w-9 cursor-help items-center justify-center rounded-xl text-destructive" :aria-label="`Terminal core: ${sidecarStatus}`">
            <AlertTriangle class="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" class="max-w-72 bg-popover text-popover-foreground">
          <p class="font-medium">Terminal core unavailable ({{ sidecarStatus }})</p>
          <p class="mt-1 text-muted-foreground">Agent and process terminals cannot launch until the native terminal sidecar starts.</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            class="flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Search or jump to"
            @click="emit('commandPalette')"
          >
            <Search class="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" class="bg-popover text-popover-foreground">
          Search <kbd class="ml-1 rounded border border-border/70 px-1 text-[10px]">Ctrl K</kbd>
        </TooltipContent>
      </Tooltip>

      <NotificationTray side="right" align="end" trigger-class="h-9 w-9 rounded-xl hover:bg-white/[0.06] hover:text-foreground" />

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="relative flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-white/[0.08] data-[state=open]:text-foreground"
            :aria-label="menuLabel"
            :title="menuLabel"
          >
            <Settings class="h-[18px] w-[18px]" aria-hidden="true" />
            <span v-if="updateAvailable" class="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" class="w-56">
          <DropdownMenuItem class="text-[14px]" @select="emit('routines')"><CalendarClock class="mr-2 h-4 w-4 text-muted-foreground" />Scheduled</DropdownMenuItem>
          <DropdownMenuItem class="text-[14px]" @select="emit('usage')"><Gauge class="mr-2 h-4 w-4 text-muted-foreground" />Usage</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem class="text-[14px]" @select="emit('settings')">
            <Settings class="mr-2 h-4 w-4 text-muted-foreground" /><span class="flex-1">Settings</span>
            <span v-if="updateAvailable" class="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { AlertTriangle, CalendarClock, Gauge, Layers, LayoutGrid, Plus, Search, Settings } from 'lucide-vue-next';
import { useBots } from '../../Composables/useBots';
import { projectUnread } from '../../Composables/useNotifications';
import { useWorkbench } from '../../Composables/useWorkbench';
import { allAgents as allAgentsState, listedProjects, openAgentCount, projectShown } from '../../lib/allAgents';
import { prefetchProject, Tier } from '../../lib/prefetch';
import { projectOverviews, type AgentState } from '../../lib/projectOverview';
import { projectSnoozed, snoozedProjectsLast } from '../../lib/projectSnooze';
import { useUpdates } from '../../lib/updates';
import type { ProjectWorkbench } from '../../types';
import HostBadge from '../HostBadge.vue';
import NewProjectDialog from '../NewProjectDialog.vue';
import NotificationTray from '../NotificationTray.vue';
import ProjectStatusLogo from '../ProjectStatusLogo.vue';
import UnreadDot from '../UnreadDot.vue';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

const props = defineProps<{
  projects: ProjectWorkbench[];
  activeProjectId: string | null;
  allAgents: boolean;
  sidecarStatus: string;
  sidecarAvailable: boolean;
}>();

const emit = defineEmits<{
  selectProject: [projectId: string | null];
  selectAllAgents: [];
  commandPalette: [];
  settings: [];
  usage: [];
  routines: [];
}>();

const { refresh } = useWorkbench();
const { uncounted: botHidden } = useBots();
const dockProjects = computed(() => snoozedProjectsLast(listedProjects(props.projects), (item) => item.project));
const projectAgentStates = computed(() => new Map(projectOverviews(props.projects, botHidden.value.sessions).map((overview) => [overview.project.id, overview.agents.map((agent) => agent.state)])));
const NO_AGENTS: AgentState[] = [];
function agentStates(projectId: string): AgentState[] {
  return projectAgentStates.value.get(projectId) ?? NO_AGENTS;
}
const anyWaiting = computed(() => dockProjects.value.some((item) => !projectSnoozed(item.project) && agentStates(item.project.id).includes('waiting')));
const totalAgentCount = computed(() => listedProjects(props.projects).filter((project) => projectShown(allAgentsState, project.project.id) && !projectSnoozed(project.project)).reduce((total, project) => total + openAgentCount(project, botHidden.value.sessions), 0));

const updates = useUpdates();
const updateAvailable = computed(() => updates.value?.status === 'available');
const menuLabel = computed(() => updateAvailable.value ? `Settings: Patterm ${updates.value?.latest?.version} is available` : 'Settings & more');

async function selectCreatedProject(projectId: string): Promise<void> {
  await refresh();
  emit('selectProject', projectId);
}
</script>
