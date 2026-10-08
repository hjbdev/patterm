<template>
  <!-- A subagent and, when open, everything it started: subagents first, then processes. -->
  <div>
    <SidebarMemberRow
      :session="node.session"
      :root-id="rootId"
      :parent-key="parentKey"
      :parent-host="parentHost"
      :node-id="count ? node.session.id : undefined"
      :count="count"
      :count-label="countLabel"
      :expanded="open"
      :holds-selection="!open && holdsSelection"
      :urgency="nodeUrgency(sidebar, node, owned, open)"
    />
    <Transition :css="false" @enter="expandIn" @leave="collapseOut">
      <div v-if="count && open" :class="depth < MAX_INDENT_DEPTH ? 'ml-4 border-l border-white/[0.08] pl-1' : ''">
        <TransitionGroup :css="false" @enter="expandIn" @leave="collapseOut">
          <SidebarNode v-for="child in node.children" :key="child.session.id" :node="child" :root-id="rootId" :parent-key="rowKey" :parent-host="node.session.host" :depth="depth + 1" :owned="owned" />
          <SidebarMemberRow v-for="process in processes" :key="process.id" :process="process" :root-id="rootId" :parent-key="rowKey" :parent-host="node.session.host" />
        </TransitionGroup>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { AgentNode } from '../../lib/agentTree';
import type { LiveProcessRecord } from '../../lib/processTabs';
import SidebarMemberRow from './SidebarMemberRow.vue';
import { useSidebar } from './sidebarContext';
import { collapseOut, expandIn } from '../../lib/sidebarMotion';
import { descendants, MAX_INDENT_DEPTH, nodeUrgency } from '../../lib/sidebarTree';
import { useSidebarNodes } from './sidebarNodes';

const props = defineProps<{
  node: AgentNode;
  rootId: string;
  parentKey: string;
  parentHost?: string | undefined;
  depth: number;
  owned: ReadonlyMap<string, LiveProcessRecord[]>;
}>();

const sidebar = useSidebar();
const nodes = useSidebarNodes();
const rowKey = computed(() => `session:${props.node.session.id}`);
const processes = computed(() => props.owned.get(props.node.session.processId ?? '') ?? []);
const below = computed(() => descendants(props.node, props.owned));
const count = computed(() => below.value.sessions.length + below.value.processes.length);
const countLabel = computed(() => {
  const agents = below.value.sessions.length;
  const processCount = below.value.processes.length;
  return [agents && `${agents} ${agents === 1 ? 'subagent' : 'subagents'}`, processCount && `${processCount} ${processCount === 1 ? 'process' : 'processes'}`].filter(Boolean).join(', ');
});
const open = computed(() => nodes.isOpen(props.node.session.id));
// A folded agent holding the selection is highlighted, so you can see where you are.
const holdsSelection = computed(() => below.value.sessions.some((child) => sidebar.sessionActive(child.session)) || below.value.processes.some(sidebar.processActive));
</script>
