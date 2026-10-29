<template>
  <!-- A phone's Library: everything its list leaves out, the project's pages
       and then the app's. One flat list, so nothing needs a heading. A desktop
       opens the same rows as the sidebar's Library menu. -->
  <div class="h-full min-h-0 overflow-y-auto">
    <nav aria-label="Library" class="mx-auto w-full max-w-xl px-2 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-6">
      <h1 v-if="!phoneLayout" class="mb-2 px-3 text-[14.5px] font-medium">Library</h1>
      <LibraryRows />
      <!-- On a desktop these sit behind the bar's ⋯. -->
      <template v-if="phoneLayout">
        <div class="h-5" aria-hidden="true" />
        <RouterLink :to="{ name: 'routines' }" :class="ROW">
          <CalendarClock :class="ICON" />
          <span class="min-w-0 flex-1">
            <span class="block truncate">Scheduled</span>
            <span v-if="nextRoutine" :class="DETAIL">{{ nextRoutine }}</span>
          </span>
          <span v-if="routineCount" :class="COUNT">{{ routineCount }}</span>
        </RouterLink>
        <RouterLink :to="{ name: 'usage' }" :class="ROW">
          <Gauge :class="ICON" />
          <span class="min-w-0 flex-1">
            <span class="block truncate">Usage</span>
            <span :class="DETAIL">Limits and spend by harness</span>
          </span>
        </RouterLink>
        <!-- A phone's bar has no bell or ⋯, so its notifications live here. -->
        <button type="button" :class="ROW" @click="notificationsOpen = true">
          <Bell :class="ICON" />
          <span class="min-w-0 flex-1 truncate">Notifications</span>
          <span v-if="unread" :class="COUNT">{{ unread }}</span>
        </button>
        <RouterLink :to="{ name: 'settings' }" :class="ROW">
          <Settings :class="ICON" />
          <span class="min-w-0 flex-1">
            <span class="block truncate">Settings</span>
            <span v-if="updateAvailable" :class="[DETAIL, 'flex items-center gap-1.5']"><span class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />Patterm {{ updates?.latest?.version }} available</span>
          </span>
        </RouterLink>
        <SidebarViewOptions label="List options" :trigger-class="cn(ROW, 'justify-start [&>svg]:ml-auto')" />
      </template>
    </nav>
    <NotificationTray v-if="phoneLayout" v-model:open="notificationsOpen" bare />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { Bell, CalendarClock, Gauge, Settings } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import LibraryRows from '../Components/LibraryRows.vue';
import NotificationTray from '../Components/NotificationTray.vue';
import SidebarViewOptions from '../Components/Sidebar/SidebarViewOptions.vue';
import { totalUnread } from '../Composables/useNotifications';
import { phoneLayout } from '../lib/phoneLayout';
import { listRoutines, nextRunLabel, type RoutineRecord } from '../lib/routines';
import { useUpdates } from '../lib/updates';

const ROW = 'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-[15px] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const ICON = 'h-[18px] w-[18px] shrink-0 text-muted-foreground';
const DETAIL = 'block truncate text-[13px] text-muted-foreground';
const COUNT = 'shrink-0 text-sm tabular-nums text-muted-foreground';

// The next routine to run, of those switched on.
const routines = ref<RoutineRecord[]>([]);
listRoutines().then((list) => { routines.value = list; }, () => undefined);
const routineCount = computed(() => routines.value.filter((routine) => routine.enabled).length);
const nextRoutine = computed(() => {
  const next = routines.value.filter((routine) => routine.enabled && routine.next_run_at)
    .sort((a, b) => Date.parse(a.next_run_at!) - Date.parse(b.next_run_at!))[0];
  return next ? `${next.name} · ${nextRunLabel(next, Date.now())}` : null;
});

const notificationsOpen = ref(false);
const unread = computed(() => totalUnread());
const updates = useUpdates();
const updateAvailable = computed(() => updates.value?.status === 'available');
</script>
