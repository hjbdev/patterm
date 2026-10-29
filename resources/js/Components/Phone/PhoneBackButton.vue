<template>
  <!-- Back to the phone's list, showing the status of the next agent waiting on you. -->
  <button
    type="button"
    class="flex h-11 shrink-0 items-center gap-0.5 rounded-lg pl-0.5 pr-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    :aria-label="waiting ? `Back to agents. ${agentLabel(waiting.family.root.session)}: ${familyWaitingOn(sidebar, waiting.family)}` : 'Back to agents'"
    @click="emit('back')"
  >
    <ChevronLeft class="h-6 w-6" />
    <RowStatus v-if="waiting" :activity="sidebar.activity(waiting.session)" />
  </button>
</template>

<script setup lang="ts">
import { ChevronLeft } from 'lucide-vue-next';
import RowStatus from '../RowStatus.vue';
import { useSidebar } from '../Sidebar/sidebarContext';
import { agentLabel, type AgentTabFamily } from '../../lib/agentTabs';
import { familyWaitingOn } from '../../lib/sidebarTree';
import type { SessionRecord } from '../../types';

defineProps<{ waiting: { family: AgentTabFamily; session: SessionRecord } | null }>();
const emit = defineEmits<{ back: [] }>();
const sidebar = useSidebar();
</script>
