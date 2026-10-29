<template>
  <!-- A phone's home screen: the project's agents, as in the sidebar, with
       the Library (which has the rest) and a new agent at the foot, within
       thumb reach. -->
  <div data-phone-list class="flex h-full min-h-0 flex-col">
    <SidebarList placement="phone" class="min-h-0 flex-1">
      <template #footer>
        <div class="flex shrink-0 items-center gap-1 border-t border-white/5 px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2">
          <RouterLink
            :to="{ name: 'library', params: { projectId: sidebar.projectId.value } }"
            class="relative flex h-11 items-center gap-2 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Library class="h-4 w-4" />Library
            <span v-if="updateAvailable" class="absolute right-1.5 top-2.5 h-1.5 w-1.5 rounded-full bg-primary" aria-label="An update is available" />
          </RouterLink>
          <span class="flex-1" />
          <LaunchAgentMenu :project-id="sidebar.projectId.value" :choose-project="sidebar.allAgents.value" trigger-class="h-11 w-11 !rounded-full bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground [&_svg]:h-5 [&_svg]:w-5" />
        </div>
      </template>
    </SidebarList>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { Library } from 'lucide-vue-next';
import LaunchAgentMenu from '../LaunchAgentMenu.vue';
import SidebarList from '../Sidebar/SidebarList.vue';
import { useSidebar } from '../Sidebar/sidebarContext';
import { useUpdates } from '../../lib/updates';

const sidebar = useSidebar();
const updates = useUpdates();
// Settings waits in the Library, so an update marks it there.
const updateAvailable = computed(() => updates.value?.status === 'available');
</script>
