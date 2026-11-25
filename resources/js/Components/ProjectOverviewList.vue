<template>
  <section aria-label="Projects">
    <div v-if="overviews.length" class="flex h-7 items-center px-2.5 text-[12.5px] font-medium text-muted-foreground">Projects</div>
    <div class="space-y-0.5">
      <div
        v-for="overview in overviews"
        :key="overview.project.id"
        class="group relative flex items-center rounded-xl transition-colors hover:bg-white/[0.05]"
        :class="projectSnoozed(overview.project) && 'opacity-70'"
      >
        <button
          type="button"
          class="flex min-h-[62px] min-w-0 flex-1 items-center gap-3.5 rounded-xl px-2.5 py-3 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
          @click="emit('openProject', overview.project.id)"
        >
          <ProjectStatusLogo :project="overview.project" :states="overview.agents.map((agent) => agent.state)" :size="mobile ? 32 : 30" />
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span class="truncate text-[16px] font-medium leading-5 text-foreground sm:text-[15.5px]">{{ overview.project.name }}</span>
              <SnoozeIcon v-if="projectSnoozed(overview.project)" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <HostBadge v-if="overview.project.host" :host="overview.project.host" />
            </span>
            <span class="mt-0.5 block truncate text-[13.5px] leading-[18px] text-muted-foreground">
              <template v-if="overview.agents.length">
                <span v-if="overview.waiting" class="text-amber-300">{{ overview.waiting }} {{ overview.waiting === 1 ? 'needs' : 'need' }} you</span>
                <span v-if="overview.waiting && (overview.working || overview.idle)"> · </span>
                <span v-if="overview.working">{{ overview.working }} working</span>
                <span v-if="overview.working && overview.idle"> · </span>
                <span v-if="overview.idle">{{ overview.idle }} idle</span>
              </template>
              <template v-else>
                <span v-if="!mobile" class="font-mono text-[12.5px]" :title="overview.project.path">{{ displayPath(overview.project.path) }}</span>
                <span v-if="!mobile && overview.lastActiveAt"> · </span>
                <span v-if="overview.lastActiveAt">Active {{ relativeTime(overview.lastActiveAt, now) }}</span>
                <span v-else-if="mobile">No active agents</span>
              </template>
            </span>
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <UnreadDot :urgency="overview.waiting ? 'high' : projectUnread(overview.project.id) ? 'normal' : null" />
            <span v-if="overview.agents.length" class="min-w-5 text-right text-[13.5px] tabular-nums text-muted-foreground">{{ overview.agents.length }}</span>
            <ChevronRight class="h-4 w-4 text-muted-foreground/50" aria-hidden="true" />
          </span>
        </button>

        <!-- Quiet desktop hover actions so resting rows stay uncluttered. -->
        <div class="hidden shrink-0 items-center gap-0.5 pr-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 sm:flex">
          <Button
            variant="ghost"
            size="icon"
            class="h-7 w-7 rounded-tab text-muted-foreground"
            :title="`New conversation in ${overview.project.name}`"
            :aria-label="`New conversation in ${overview.project.name}`"
            @click="openNewConversation(overview.project.id)"
          >
            <Plus class="h-4 w-4" />
          </Button>
          <ProjectMenu :project="overview.project" :live-agents="overview.agents.length" @change-logo="logoProjectId = overview.project.id" />
        </div>
      </div>
    </div>

    <ProjectLogoDialog v-if="logoProject" v-model:open="logoOpen" :project="logoProject" />
    <div v-if="loaded && !overviews.length" class="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <FolderPlus class="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <div>
        <p class="font-medium">No projects yet</p>
        <p class="mt-1 text-sm text-muted-foreground">Add a project to start launching agents.</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ChevronRight, FolderPlus, Plus } from 'lucide-vue-next';
import HostBadge from './HostBadge.vue';
import ProjectLogoDialog from './ProjectLogoDialog.vue';
import ProjectMenu from './ProjectMenu.vue';
import ProjectStatusLogo from './ProjectStatusLogo.vue';
import SnoozeIcon from './SnoozeIcon.vue';
import UnreadDot from './UnreadDot.vue';
import { Button } from './ui/button';
import { projectUnread } from '../Composables/useNotifications';
import { allAgents } from '../lib/allAgents';
import { relativeTime } from '../lib/format';
import { displayPath, type ProjectOverview } from '../lib/projectOverview';
import { projectSnoozed } from '../lib/projectSnooze';
import type { ProjectSummary } from '../types';

const props = defineProps<{ overviews: ProjectOverview[]; now: number; loaded: boolean; mobile?: boolean }>();

const emit = defineEmits<{
  openProject: [projectId: string];
}>();

const router = useRouter();
function openNewConversation(projectId: string): void {
  allAgents.active = false;
  void router.push({ name: 'newConversation', params: { projectId } });
}

// The dialog reads the live project so it reflects a logo change made elsewhere.
const logoProjectId = ref<string | null>(null);
const logoProject = computed<ProjectSummary | null>(() => props.overviews.find((overview) => overview.project.id === logoProjectId.value)?.project ?? null);
const logoOpen = computed({
  get: () => logoProject.value !== null,
  set: (open) => { if (!open) logoProjectId.value = null; }
});
</script>
