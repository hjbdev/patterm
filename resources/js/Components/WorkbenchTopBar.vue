<template>
  <header class="flex h-11 shrink-0 items-center gap-1.5 overflow-hidden bg-transparent px-2 [container-type:inline-size] sm:gap-2">
    <ResponsiveMenu v-model:open="projectMenuOpen" title="Projects" desktop-class="w-72" @content-pointer-enter="cancelProjectMenuClose" @content-pointer-leave="scheduleProjectMenuClose" @content-keydown="stopProjectMenuHover" @open-auto-focus="keepHoverFocus" @close-auto-focus="keepHoverFocus">
      <template #trigger>
        <Button variant="ghost" size="sm" class="h-[26px] max-w-[38vw] shrink-0 justify-between gap-1 rounded-tab px-2 py-0.5 text-[13px] sm:max-w-64 sm:gap-2" @pointerenter="openProjectMenuOnHover" @pointerleave="scheduleProjectMenuClose" @pointerdown="stopProjectMenuHover" @keydown="stopProjectMenuHover">
          <ProjectLogo v-if="activeProject" :project="activeProject.project" />
          <span class="truncate">{{ activeProject?.project.name ?? 'Projects' }}</span>
          <HostBadge v-if="activeProject?.project.host" :host="activeProject.project.host" />
          <Badge v-if="activeProjectAgentCount > 0" variant="secondary" class="ml-auto hidden h-5 px-1.5 text-[10px] tabular-nums sm:inline-flex">
            {{ activeProjectAgentCount }}
          </Badge>
          <ChevronDown class="h-4 w-4 shrink-0 opacity-70" />
        </Button>
      </template>
      <template #desktop>
        <DropdownMenuItem
          v-for="projectGroup in projects"
          :key="projectGroup.project.id"
          class="py-1 text-[13px]"
          @select="emit('selectProject', projectGroup.project.id)"
        >
          <ProjectLogo :project="projectGroup.project" class="mr-2" />
          <span class="min-w-0 flex-1 truncate">{{ projectGroup.project.name }}</span>
          <HostBadge v-if="projectGroup.project.host" :host="projectGroup.project.host" class="ml-1.5" />
          <UnreadDot :urgency="projectUnread(projectGroup.project.id) ? 'normal' : null" />
          <Badge v-if="openAgentCount(projectGroup) > 0" variant="secondary" class="ml-2 h-5 px-1.5 text-[10px] tabular-nums">
            {{ openAgentCount(projectGroup) }}
          </Badge>
        </DropdownMenuItem>
        <DropdownMenuSeparator v-if="projects.length" />
        <DropdownMenuItem class="py-1 text-[13px]" @select="emit('selectProject', null)">
          <LayoutGrid class="mr-2 h-3.5 w-3.5" />
          Project selector
        </DropdownMenuItem>
      </template>
      <template #mobile>
        <div class="space-y-1">
          <button v-for="projectGroup in projects" :key="projectGroup.project.id" type="button" class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="projectGroup.project.id === activeProjectId ? 'bg-primary/10' : ''" @click="selectMobileProject(projectGroup.project.id)">
            <ProjectLogo :project="projectGroup.project" :size="16" />
            <span class="min-w-0 flex-1 truncate">{{ projectGroup.project.name }}</span>
            <HostBadge v-if="projectGroup.project.host" :host="projectGroup.project.host" />
            <UnreadDot :urgency="projectUnread(projectGroup.project.id) ? 'normal' : null" />
            <Badge v-if="openAgentCount(projectGroup) > 0" variant="secondary" class="h-5 px-1.5 text-[10px] tabular-nums">{{ openAgentCount(projectGroup) }}</Badge>
          </button>
          <div v-if="projects.length" class="my-2 border-t border-border" />
          <button type="button" class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="selectMobileProject(null)">
            <LayoutGrid class="h-4 w-4" />Project selector
          </button>
        </div>
      </template>
    </ResponsiveMenu>

    <!-- Only when the bar is wide enough: narrower, as in a small window or beside the docked assistant, the switcher and toolbar already fill it and the icons would push Settings out of view. -->
    <div v-if="showRecentProjects && recentProjects.length" class="hidden shrink-0 items-center [@container(min-width:46rem)]:flex">
      <Tooltip v-for="projectGroup in recentProjects" :key="projectGroup.project.id">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-[26px] w-[26px] rounded-tab opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100" :aria-label="`Switch to ${projectGroup.project.name}`" @click="emit('selectProject', projectGroup.project.id)">
            <ProjectLogo :project="projectGroup.project" />
          </Button>
        </TooltipTrigger>
        <TooltipContent class="bg-popover text-popover-foreground">
          {{ projectGroup.project.name }}
          <HostBadge v-if="projectGroup.project.host" :host="projectGroup.project.host" class="ml-1" />
        </TooltipContent>
      </Tooltip>
    </div>

    <slot name="terminal-tabs" />

    <div class="ml-auto flex shrink-0 items-center gap-1.5">
      <Button variant="ghost" size="sm" class="h-7 gap-2 rounded-tab px-2 text-xs text-muted-foreground" aria-label="Search or jump to" @click="emit('commandPalette')">
        <Search class="h-4 w-4" /><span class="hidden sm:inline">Search or jump to…</span><kbd class="hidden rounded border border-border/70 px-1 text-[10px] sm:inline">Ctrl K</kbd>
      </Button>
      <Button variant="ghost" size="icon" class="h-7 w-7 rounded-tab text-muted-foreground" aria-label="Scheduled" title="Scheduled" @click="emit('routines')">
        <CalendarClock class="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" class="h-7 w-7 rounded-tab text-muted-foreground" aria-label="Usage" title="Usage" @click="emit('usage')">
        <Gauge class="h-4 w-4" />
      </Button>
      <NotificationTray />
      <Button variant="ghost" size="icon" class="h-7 w-7 rounded-tab text-muted-foreground" aria-label="Settings" title="Settings" @click="emit('settings')">
        <Settings class="h-4 w-4" />
      </Button>
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
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { CalendarClock, ChevronDown, Gauge, LayoutGrid, Search, Settings } from 'lucide-vue-next';
import { activeAgentSessions } from '../lib/agentTabs';
import { readRecentProjectIds, rememberRecentProject, shownRecentProjects } from '../lib/recentProjects';
import type { ProjectWorkbench, SessionRecord } from '../types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import ResponsiveMenu from './ResponsiveMenu.vue';
import ProjectLogo from './ProjectLogo.vue';
import UnreadDot from './UnreadDot.vue';
import NotificationTray from './NotificationTray.vue';
import { projectUnread } from '../Composables/useNotifications';
import { DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

const props = defineProps<{
  projects: ProjectWorkbench[];
  activeProjectId: string | null;
  sidecarStatus: string;
  sidecarAvailable: boolean;
  showRecentProjects: boolean;
}>();

const emit = defineEmits<{
  selectProject: [projectId: string | null];
  commandPalette: [];
  settings: [];
  usage: [];
  routines: [];
}>();

const recentProjectIds = ref(readRecentProjectIds(globalThis.localStorage));
watch(() => props.activeProjectId, (projectId) => {
  if (projectId) recentProjectIds.value = rememberRecentProject(recentProjectIds.value, projectId, globalThis.localStorage);
}, { immediate: true });
const recentProjects = computed(() => shownRecentProjects(recentProjectIds.value, props.projects, props.activeProjectId));

const projectMenuOpen = ref(false);
let projectMenuHovered = false;
let projectMenuCloseTimer: ReturnType<typeof setTimeout> | undefined;

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
const activeProjectAgentCount = computed(() => activeProject.value ? openAgentCount(activeProject.value) : 0);
function openAgentCount(project: ProjectWorkbench): number {
  return activeAgentSessions(projectAgentSessions(project)).length;
}

function projectAgentSessions(project: ProjectWorkbench): SessionRecord[] {
  return project.projectSessions;
}

</script>
