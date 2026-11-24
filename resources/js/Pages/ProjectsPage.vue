<template>
  <div v-if="route.name === 'not-found'" class="p-5 text-sm">Page not found. <RouterLink class="underline" to="/projects">View projects</RouterLink></div>
  <div v-else class="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#080808] text-foreground">
    <header data-titlebar class="flex h-12 shrink-0 items-center gap-2 px-3">
      <div class="min-w-0 pl-1">
        <h1 class="text-[16px] font-semibold tracking-[-0.01em]">Projects</h1>
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" class="h-9 gap-2 rounded-lg px-2.5 text-[14px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground" aria-label="Search or jump to" @click="openCommandPalette">
          <Search class="h-[18px] w-[18px]" /><span class="hidden sm:inline">Search…</span><kbd class="hidden rounded border border-white/10 px-1.5 text-[11px] sm:inline">Ctrl K</kbd>
        </Button>
        <NotificationTray trigger-class="h-9 w-9 rounded-lg hover:bg-white/[0.06] hover:text-foreground" />
        <Button variant="ghost" size="icon" class="hidden h-9 w-9 rounded-lg text-muted-foreground hover:bg-white/[0.06] hover:text-foreground sm:inline-flex" aria-label="Usage" title="Usage" @click="router.push({ name: 'usage' })">
          <Gauge class="h-[18px] w-[18px]" />
        </Button>
        <Button variant="ghost" size="icon" class="hidden h-9 w-9 rounded-lg text-muted-foreground hover:bg-white/[0.06] hover:text-foreground sm:inline-flex" aria-label="Settings" title="Settings" @click="router.push({ name: 'settings' })">
          <Settings class="h-[18px] w-[18px]" />
        </Button>
        <NewProjectDialog @created="selectCreatedProject">
          <template #trigger>
            <Button variant="ghost" size="sm" class="ml-1 hidden h-9 gap-1.5 rounded-lg bg-white/[0.09] px-3 text-[13.5px] font-medium text-foreground hover:bg-white/[0.14] sm:inline-flex" aria-label="Add project" title="Add project">
              <Plus class="h-4 w-4" /><span>Add project</span>
            </Button>
          </template>
        </NewProjectDialog>
      </div>
    </header>

    <main class="mx-1.5 mb-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border-t border-white/5 bg-background">
      <div class="min-w-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full px-2 pb-4 pt-2 sm:max-w-[48rem] sm:px-6 sm:pb-10 sm:pt-8">
          <GetStarted placement="page" class="mb-4" />
          <div class="mb-2"><BotList :phone="mobile" /></div>
          <ProjectOverviewList :overviews="overviews" :now="now" :loaded="loaded" :mobile="mobile" @open-project="pickProject" />
        </div>
      </div>

      <!-- Mobile thumb bar, matching PhoneHome's left links + circular primary + button. -->
      <div v-if="mobile" class="flex shrink-0 items-center gap-1 border-t border-white/5 px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2">
        <Button v-if="firstProjectId" variant="ghost" class="h-11 gap-2 rounded-lg px-3 text-[14.5px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground" @click="openAllAgents">
          <Layers class="h-4 w-4" />All agents
        </Button>
        <Button variant="ghost" class="h-11 gap-2 rounded-lg px-3 text-[14.5px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground" @click="router.push({ name: 'settings' })">
          <Settings class="h-4 w-4" />Settings
        </Button>
        <span class="flex-1" />
        <NewProjectDialog @created="selectCreatedProject">
          <template #trigger>
            <Button size="icon" class="h-11 w-11 rounded-full bg-primary text-primary-foreground shadow-sm hover:bg-primary/90" aria-label="Add project" title="Add project">
              <Plus class="h-5 w-5" />
            </Button>
          </template>
        </NewProjectDialog>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { RouterLink } from 'vue-router';
import { Gauge, Layers, Plus, Search, Settings } from 'lucide-vue-next';
import { useBots } from '../Composables/useBots';
import NewProjectDialog from '../Components/NewProjectDialog.vue';
import NotificationTray from '../Components/NotificationTray.vue';
import BotList from '../Components/BotList.vue';
import GetStarted from '../Components/GetStarted.vue';
import ProjectOverviewList from '../Components/ProjectOverviewList.vue';
import { Button } from '../Components/ui/button';
import { useWorkbench } from '../Composables/useWorkbench';
import { useWorkbenchNavigation } from '../Composables/useWorkbenchNavigation';
import { allAgents, listedProjects } from '../lib/allAgents';
import { openCommandPaletteKey } from '../lib/commandPalette';
import { projectOverviews } from '../lib/projectOverview';

const { projects, loaded, refresh } = useWorkbench();
const { route, router, pickProject, selectProject } = useWorkbenchNavigation();
const openCommandPalette = inject(openCommandPaletteKey, () => {});
// Bots list as in the sidebar, which on phones is the agent list.
const mobile = useMediaQuery('(max-width: 639px)');

// Relative times on this page show minutes at most.
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 30_000);
onBeforeUnmount(() => clearInterval(clock));

// A bot's own sessions never count as the project's agents; its helpers do.
const { uncounted: botHidden } = useBots();
const overviews = computed(() => projectOverviews(projects.value, botHidden.value.sessions));
const firstProjectId = computed(() => overviews.value[0]?.project.id ?? listedProjects(projects.value)[0]?.project.id ?? null);

function openAllAgents(): void {
  if (!firstProjectId.value) return;
  allAgents.active = true;
  void selectProject(firstProjectId.value);
}

async function selectCreatedProject(projectId: string): Promise<void> {
  await refresh();
  await pickProject(projectId);
}
</script>
