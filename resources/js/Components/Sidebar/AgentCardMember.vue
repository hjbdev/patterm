<template>
  <!-- A subagent or process in the agent card: its status, its name, and
       where it stands in a word. Nested subagents step in under their parent. -->
  <SidebarItemMenu :session="member.session" :process="member.process">
    <button
      type="button"
      :title="hostLabel(member.name, host)"
      :aria-current="active ? 'page' : undefined"
      :class="cn(
        'relative isolate flex h-7 w-full min-w-0 select-none items-center gap-2 rounded-tab pr-1.5 text-left transition-colors duration-150 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        active && 'bg-primary/10 hover:bg-primary/[0.12]'
      )"
      :style="{ paddingLeft: `${6 + (Math.min(member.depth, MAX_INDENT_DEPTH) - 1) * 16}px` }"
      @click="open"
    >
      <TabWash :activity="member.activity" />
      <span class="flex h-4 w-4 shrink-0 items-center justify-center">
        <!-- Subagents are rings, as in the sidebar; the header already names the harness. -->
        <TabIcon :activity="member.activity" compact muted>
          <template #default="{ working }">
            <span v-if="member.session" :class="cn('block h-3 w-3 rounded-full border-[1.75px] border-current', working ? 'opacity-90' : 'opacity-[0.55]')" />
            <TerminalSquare v-else class="h-3.5 w-3.5" />
          </template>
        </TabIcon>
      </span>
      <span class="min-w-0 flex-1 truncate text-[13px]" :class="active ? 'text-foreground' : 'text-foreground/85'">{{ member.name }}</span>
      <HostBadge v-if="host && host !== parentHost" :host="host" />
      <span class="shrink-0 text-[11px]" :class="member.state === 'attention' ? 'text-foreground/80' : 'text-muted-foreground'">{{ word }}</span>
    </button>
  </SidebarItemMenu>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { TerminalSquare } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import type { DigestMember } from '../../lib/agentDigest';
import { hostLabel } from '../../lib/hosts';
import { MAX_INDENT_DEPTH } from '../../lib/sidebarTree';
import HostBadge from '../HostBadge.vue';
import TabIcon from '../TabIcon.vue';
import TabWash from '../TabWash.vue';
import SidebarItemMenu from './SidebarItemMenu.vue';
import { useSidebar } from './sidebarContext';

const props = defineProps<{ member: DigestMember; rootId: string; parentHost: string | undefined }>();
const sidebar = useSidebar();

const host = computed(() => props.member.session?.host ?? props.member.process?.host);
const active = computed(() => props.member.session ? sidebar.sessionActive(props.member.session)
  : props.member.process ? sidebar.processActive(props.member.process) : false);

const word = computed(() => {
  const { activity, process } = props.member;
  switch (activity.self) {
    case 'permission': return 'needs you';
    case 'error': return 'error';
    case 'closing': return 'done';
    case 'working': return 'working';
    case 'unknown': return 'unknown';
    default:
      // An idle subagent whose own subagents are at work is waiting on them.
      return !process && activity.subagents.working ? 'waiting' : 'idle';
  }
});

function open(): void {
  if (props.member.session) sidebar.selectSession(props.rootId, props.member.session);
  else if (props.member.process) sidebar.selectProcess(props.member.process);
}
</script>
