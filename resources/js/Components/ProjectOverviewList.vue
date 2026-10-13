<template>
  <section aria-label="Projects">
    <div class="space-y-6">
      <section v-for="overview in overviews" :key="overview.project.id" :aria-label="overview.project.name">
        <div class="group -mx-2 flex items-center gap-2 rounded-md pr-1 transition-colors hover:bg-muted/40">
          <button type="button" class="ml-1.5 shrink-0 rounded-md p-0.5 outline-none transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring" :aria-label="`Change logo for ${overview.project.name}`" title="Change logo" @click="logoProjectId = overview.project.id">
            <ProjectLogo :project="overview.project" :size="28" />
          </button>
          <button type="button" class="-ml-1 flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring" @click="emit('openProject', overview.project.id)">
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-2">
                <span class="truncate text-[15px] font-semibold">{{ overview.project.name }}</span>
                <HostBadge v-if="overview.project.host" :host="overview.project.host" />
                <UnreadDot :urgency="projectUnread(overview.project.id) ? 'normal' : null" />
              </span>
              <span class="block truncate text-xs text-muted-foreground">
                <span class="font-mono" :title="overview.project.path">{{ displayPath(overview.project.path) }}</span>
                <span v-if="overview.project.remotes?.length" :title="`Linked with the same project on ${overview.project.remotes.map((remote) => remote.host).join(', ')}`"> · <Link2 class="mb-px inline h-3 w-3" aria-hidden="true" /> linked with {{ overview.project.remotes.map((remote) => remote.host).join(', ') }}</span>
              </span>
            </span>
            <span class="shrink-0 text-right text-[11px] text-muted-foreground">
              <span v-if="overview.waiting" class="block text-foreground">{{ overview.waiting }} {{ overview.waiting === 1 ? 'needs' : 'need' }} you</span>
              <span v-if="overview.working" class="block">{{ overview.working }} working</span>
              <span v-if="overview.idle && !(overview.waiting && overview.working)" class="block">{{ overview.idle }} idle</span>
              <span v-if="!overview.agents.length && overview.lastActiveAt" class="hidden sm:block">Active {{ relativeTime(overview.lastActiveAt, now) }}</span>
            </span>
          </button>
          <LaunchAgentMenu :project-id="overview.project.id" @launched="(sessionId, terminalId) => emit('launched', overview.project.id, sessionId, terminalId)" />
          <ProjectMenu v-if="!overview.project.host" :project="overview.project" @change-logo="logoProjectId = overview.project.id" />
        </div>
        <div v-if="overview.agents.length" class="mt-1 space-y-px">
          <button
            v-for="agent in overview.agents"
            :key="agent.session.id"
            type="button"
            class="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring"
            @click="emit('openSession', overview.project.id, agent.session)"
          >
            <span class="flex w-8 shrink-0 items-center gap-1">
              <TabActivity :spec="activityIcon((agent.waiting ?? agent.session).activity)">
                <AgentIcon :harness="agent.session.harness" class="h-3.5 w-3.5" />
              </TabActivity>
            </span>
            <span class="flex min-w-0 flex-1 items-center gap-1.5 sm:w-56 sm:flex-none sm:shrink-0" :title="hostLabel(agentLabel(agent.session), agent.session.host)">
              <span class="truncate text-[13px]">{{ agentLabel(agent.session) }}</span>
              <HostBadge v-if="agent.session.host && agent.session.host !== overview.project.host" :host="agent.session.host" />
            </span>
            <span class="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">{{ agentStatusText(agent) }}</span>
            <span v-if="agent.subagents.length" class="shrink-0 text-[11px] tabular-nums text-muted-foreground" :title="agent.subagents.map(agentLabel).join(', ')">+{{ agent.subagents.length }}</span>
            <UnreadDot :urgency="unreadUrgency(agent.session.processId)" />
          </button>
        </div>
      </section>
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
import HostBadge from './HostBadge.vue';
import { computed, ref } from 'vue';
import { FolderPlus, Link2 } from 'lucide-vue-next';
import AgentIcon from './AgentIcon.vue';
import LaunchAgentMenu from './LaunchAgentMenu.vue';
import ProjectLogo from './ProjectLogo.vue';
import ProjectLogoDialog from './ProjectLogoDialog.vue';
import ProjectMenu from './ProjectMenu.vue';
import TabActivity from './TabActivity.vue';
import UnreadDot from './UnreadDot.vue';
import { projectUnread, unreadUrgency } from '../Composables/useNotifications';
import { agentLabel } from '../lib/agentTabs';
import { hostLabel } from '../lib/hosts';
import { relativeTime } from '../lib/format';
import { agentStatusText, displayPath, type ProjectOverview } from '../lib/projectOverview';
import { activityIcon } from '../lib/statusIcons';
import type { ProjectSummary, SessionRecord } from '../types';

const props = defineProps<{ overviews: ProjectOverview[]; now: number; loaded: boolean }>();

const emit = defineEmits<{
  openProject: [projectId: string];
  openSession: [projectId: string, session: SessionRecord];
  launched: [projectId: string, sessionId: string, terminalId: string | null];
}>();

// The dialog reads the live project so it reflects a logo change made elsewhere.
const logoProjectId = ref<string | null>(null);
const logoProject = computed<ProjectSummary | null>(() => props.overviews.find((overview) => overview.project.id === logoProjectId.value)?.project ?? null);
const logoOpen = computed({
  get: () => logoProject.value !== null,
  set: (open) => { if (!open) logoProjectId.value = null; }
});
</script>
