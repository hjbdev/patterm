<template>
  <div v-if="route.name === 'not-found'" class="p-5 text-sm">Page not found. <RouterLink class="underline" to="/projects">View projects</RouterLink></div>
  <div v-else class="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#080808] text-foreground">
    <header class="flex h-11 shrink-0 items-center gap-3 px-3">
      <div class="min-w-0 pl-1">
        <h1 class="text-sm font-semibold">Patterm</h1>
        <p class="truncate text-[11px] text-muted-foreground">{{ subtitle }}</p>
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-1.5">
        <AssistantButton />
        <Button variant="ghost" size="sm" class="h-7 gap-2 rounded-tab px-2 text-xs text-muted-foreground" aria-label="Search or jump to" @click="openCommandPalette">
          <Search class="h-4 w-4" /><span class="hidden sm:inline">Search or jump to…</span><kbd class="hidden rounded border border-border/70 px-1 text-[10px] sm:inline">Ctrl K</kbd>
        </Button>
        <Button variant="ghost" size="icon" class="h-7 w-7 rounded-tab text-muted-foreground" aria-label="Usage" title="Usage" @click="router.push({ name: 'usage' })">
          <Gauge class="h-4 w-4" />
        </Button>
        <NotificationTray />
        <Button variant="ghost" size="icon" class="h-7 w-7 rounded-tab text-muted-foreground" aria-label="Settings" title="Settings" @click="router.push({ name: 'settings' })">
          <Settings class="h-4 w-4" />
        </Button>
        <NewProjectDialog @created="selectCreatedProject">
          <template #trigger>
            <Button variant="ghost" size="sm" class="h-7 gap-1.5 rounded-tab px-2 text-xs text-muted-foreground" aria-label="Add project" title="Add project">
              <Plus class="h-4 w-4" /><span class="hidden sm:inline">Add project</span>
            </Button>
          </template>
        </NewProjectDialog>
      </div>
    </header>

    <main class="mx-1.5 mb-1.5 flex min-h-0 flex-1 overflow-hidden rounded-xl border-t border-white/5 bg-background">
      <div class="min-w-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-[46rem] px-4 pb-10 pt-8 sm:px-6 sm:pt-10">
          <ProjectOverviewList :overviews="overviews" :now="now" :loaded="loaded" @open-project="pickProject" @open-session="openSession" />
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { useBots } from '../Composables/useBots';
import AssistantButton from '../Components/Assistant/AssistantButton.vue';
import { computed, inject, onBeforeUnmount, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { Gauge, Plus, Search, Settings } from 'lucide-vue-next';
import NewProjectDialog from '../Components/NewProjectDialog.vue';
import NotificationTray from '../Components/NotificationTray.vue';
import ProjectOverviewList from '../Components/ProjectOverviewList.vue';
import { Button } from '../Components/ui/button';
import { useWorkbench } from '../Composables/useWorkbench';
import { useWorkbenchNavigation } from '../Composables/useWorkbenchNavigation';
import { openCommandPaletteKey } from '../lib/commandPalette';
import { projectOverviews } from '../lib/projectOverview';
import type { SessionRecord } from '../types';

const { projects, loaded, sidecarAvailable, refresh } = useWorkbench();
const { route, router, pickProject, selectTerminal } = useWorkbenchNavigation();
const openCommandPalette = inject(openCommandPaletteKey, () => {});

// Relative times on this page show minutes at most.
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 30_000);
onBeforeUnmount(() => clearInterval(clock));

// A bot's helpers never count as the project's agents.
const { hidden: botHidden } = useBots();
const overviews = computed(() => projectOverviews(projects.value, botHidden.value.sessions));
const subtitle = computed(() => {
  if (!loaded.value) return 'Loading…';
  const agents = overviews.value.reduce((total, overview) => total + overview.agents.length, 0);
  const waiting = overviews.value.reduce((total, overview) => total + overview.waiting, 0);
  return [
    `${projects.value.length} ${projects.value.length === 1 ? 'project' : 'projects'}`,
    agents ? `${agents} ${agents === 1 ? 'agent' : 'agents'} running` : null,
    waiting ? `${waiting} ${waiting === 1 ? 'needs' : 'need'} you` : null,
    sidecarAvailable.value ? null : 'terminal core not started'
  ].filter(Boolean).join(' · ');
});

function openSession(projectId: string, session: SessionRecord): void {
  if (session.interfaceMode === 'integrated' || !session.ptyProcessId) void router.push({ name: 'agent', params: { projectId, sessionId: session.id } });
  else void selectTerminal(projectId, session.ptyProcessId);
}

async function selectCreatedProject(projectId: string): Promise<void> {
  await refresh();
  await pickProject(projectId);
}
</script>
