<template>
  <!-- An agent or process opened over the phone's list: the agent's context
       header, with a way back to the list that shows the status of anyone
       else waiting on you, and ⋯ for the agent's context and actions. A swipe
       across it moves to the agent beside this one in the list. -->
  <ContextHeader v-if="session" :project-id="projectId" :session="session" :active-worktree-id="activeWorktreeId" :folded="folded" @peek="emit('peek', $event)" @pointerdown="swipeStart" @pointerup="swipeEnd" @pointercancel="swipeX = null">
    <template #leading><PhoneBackButton :waiting="waiting" @back="back" /></template>
    <template #trailing>
      <SidebarItemMenu dropdown :session="session" :tab="menuTab">
        <button type="button" :class="ACTION" aria-label="Context and agent actions"><Ellipsis class="h-5 w-5" /></button>
        <!-- Everything the chips hold, also while they fold away over a terminal. -->
        <template #extra="{ item, separator }">
          <component :is="item" @select="emit('peek', { kind: 'context' })"><PanelRight class="h-4 w-4" /><span>Context</span></component>
          <component :is="separator" />
        </template>
      </SidebarItemMenu>
    </template>
  </ContextHeader>
  <header v-else class="flex h-12 shrink-0 items-center gap-1 border-b border-white/5 pl-1 pr-1.5">
    <PhoneBackButton :waiting="waiting" @back="back" />
    <SidebarItemMenu :process="process ?? undefined" :tab="processTab">
      <h1 class="min-w-0 flex-1 select-none truncate text-[15px] font-medium [-webkit-touch-callout:none]">
        {{ processName }}<span v-if="processPortLabel" class="ml-1 font-mono text-[13px] font-normal text-muted-foreground">:{{ processPortLabel }}</span><HostBadge v-if="process?.host" :host="process.host" class="ml-1.5" />
      </h1>
    </SidebarItemMenu>
    <SidebarItemMenu dropdown :process="process ?? undefined" :tab="processTab">
      <button type="button" :class="ACTION" aria-label="Server actions"><Ellipsis class="h-5 w-5" /></button>
    </SidebarItemMenu>
  </header>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Ellipsis, PanelRight } from 'lucide-vue-next';
import HostBadge from '../HostBadge.vue';
import ContextHeader from '../session-context/ContextHeader.vue';
import SidebarItemMenu from '../Sidebar/SidebarItemMenu.vue';
import { familyTabOf, useSidebar, type AgentTab } from '../Sidebar/sidebarContext';
import PhoneBackButton from './PhoneBackButton.vue';
import type { Peek } from '../../lib/peek';
import { processPort, serverLabel } from '../../lib/servers';
import { nextWaiting } from '../../lib/sidebarTree';
import { tabSnoozed } from '../../lib/snooze';
import type { ProcessRecord, SessionRecord } from '../../types';

// `folded` keeps the header to one line, as over a terminal while typing.
const props = defineProps<{ projectId: string; session?: SessionRecord | null; process?: ProcessRecord | null; activeWorktreeId?: string | null; folded?: boolean }>();
const emit = defineEmits<{ peek: [peek: Peek] }>();
const router = useRouter();
const sidebar = useSidebar();
const ACTION = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:text-foreground';

// The family this page belongs to: the agent's, or the one whose agent started
// the process. Back points past it to the next one asking.
const ownTab = computed(() => familyTabOf(sidebar, { sessionId: props.session?.id, processId: props.process?.id }));
const waiting = computed(() => nextWaiting(sidebar.tabs.value, ownTab.value?.family.rootId ?? null));
// Only list rows pin and snooze.
const menuTab = computed(() => props.session && props.session.id === ownTab.value?.family.rootId ? ownTab.value : undefined);
const processTab = computed(() => sidebar.tabs.value.find((candidate) => candidate.kind === 'process' && candidate.process.id === props.process?.id));
const processPortLabel = computed(() => props.process ? processPort(props.process) : null);
const processName = computed(() => props.process ? serverLabel(props.process.name, processPortLabel.value) : '');

// Back to the list the page opened from, or to the list in its place when the
// page was opened some other way, such as from a notification.
function back(): void {
  const list = router.resolve({ name: 'project', params: { projectId: props.projectId } });
  if (router.options.history.state.back === list.fullPath) router.back();
  else void router.replace(list);
}

// A sideways swipe across the title opens the agent above (right) or below
// (left) this one in the list, without going back to it.
const swipeX = ref<number | null>(null);
let swipeY = 0;
function swipeStart(event: PointerEvent): void {
  // Only across the title: the chips below it scroll sideways.
  if (event.pointerType === 'mouse' || !(event.target as Element | null)?.closest('h1')) return;
  swipeX.value = event.clientX;
  swipeY = event.clientY;
}
function swipeEnd(event: PointerEvent): void {
  if (swipeX.value === null) return;
  const dx = event.clientX - swipeX.value, dy = event.clientY - swipeY;
  swipeX.value = null;
  if (Math.abs(dx) < 64 || Math.abs(dy) > Math.abs(dx) / 2) return;
  const agents = sidebar.tabs.value.filter((tab): tab is AgentTab => tab.kind === 'agent' && !tabSnoozed(tab));
  const index = agents.findIndex((tab) => tab.family.rootId === ownTab.value?.family.rootId);
  const next = index < 0 ? undefined : agents[index + (dx < 0 ? 1 : -1)];
  if (next) sidebar.selectSession(next.family.rootId, next.family.root.session);
}
</script>
