<template>
  <div class="group/row relative">
    <SidebarItemMenu :session="session" :process="process" :tab="tab">
      <button
        type="button"
        data-sidebar-row
        :data-row-key="rowKey"
        :data-parent="parentKey"
        :data-node="nodeId"
        :data-expandable="nodeId ? 'true' : undefined"
        :data-expanded="nodeId ? String(expanded) : undefined"
        :data-patterm-tab-id="tab?.key"
        :title="hostLabel(label, host)"
        :aria-current="active ? 'page' : undefined"
        :class="cn(
          'relative isolate flex h-7 w-full min-w-0 select-none items-center gap-2 rounded-tab pl-2 text-left text-[13px] transition-[color,background-color,box-shadow] hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          count ? 'pr-[60px]' : 'pr-7',
          active || holdsSelection ? 'bg-primary/10 text-foreground' : 'text-foreground/85',
          session && mentionPreview === session.id && 'mention-glow'
        )"
        @click="select"
      >
        <TabWash :activity="rowActivity" />
        <span class="flex h-4 w-4 shrink-0 items-center justify-center">
          <!-- Subagents show only their status, a ring; the family's icon already names the harness. -->
          <TabIcon :activity="rowActivity" compact muted>
            <template #default="{ working }">
              <span v-if="session" :class="cn('block h-3 w-3 rounded-full border-[1.75px] border-current', working ? 'opacity-90' : 'opacity-[0.55]')" />
              <TerminalSquare v-else class="h-3.5 w-3.5" />
            </template>
          </TabIcon>
        </span>
        <!-- Rows outside the selected thread dim their text until hovered; status stays bright. -->
        <span class="min-w-0 truncate transition-colors duration-200 motion-reduce:transition-none" :class="dimmed && 'text-muted-foreground/80 group-hover/row:text-foreground/85'">{{ label }}</span>
        <HostBadge v-if="host && host !== parentHost" :host="host" class="-ml-0.5" />
      </button>
    </SidebarItemMenu>
    <span class="absolute right-1.5 top-1 flex h-5 items-center gap-0.5">
      <!-- An agent with its own subagents or processes folds like a family. -->
      <button
        v-if="nodeId && count"
        type="button"
        tabindex="-1"
        :class="cn('flex h-5 items-center gap-0.5 rounded pl-1 pr-0.5 text-xs tabular-nums transition-colors hover:bg-white/10 hover:text-foreground', subagentCountClass(rowActivity))"
        :aria-expanded="expanded"
        :aria-label="`${expanded ? 'Hide' : 'Show'} ${countLabel}`"
        :title="countLabel"
        @pointerdown.stop
        @click.stop="nodes.setOpen(nodeId, !expanded)"
      >
        {{ count }}<ChevronRight class="h-3 w-3 transition-transform duration-200 motion-reduce:transition-none" :class="expanded && 'rotate-90'" />
      </button>
      <span class="relative flex h-5 w-5 items-center justify-center">
        <UnreadDot class="transition-opacity group-hover/row:opacity-0" :urgency="urgency !== undefined ? urgency : unreadUrgency(session ? session.processId : process?.id)" />
        <SidebarActionsMenu class="pointer-events-none absolute inset-0 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100" :session="session" :process="process" :tab="tab" />
      </span>
    </span>
  </div>
</template>

<script setup lang="ts">
import HostBadge from '../HostBadge.vue';
import { computed } from 'vue';
import { ChevronRight, TerminalSquare } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { agentLabel } from '../../lib/agentTabs';
import { hostLabel } from '../../lib/hosts';
import { processActivity, subagentCountClass } from '../../lib/rowActivity';
import type { StripTab } from '../../lib/tabStrip';
import type { ProcessRecord, SessionRecord } from '../../types';
import { unreadUrgency, type NotificationUrgency } from '../../Composables/useNotifications';
import TabIcon from '../TabIcon.vue';
import TabWash from '../TabWash.vue';
import UnreadDot from '../UnreadDot.vue';
import SidebarActionsMenu from './SidebarActionsMenu.vue';
import SidebarItemMenu from './SidebarItemMenu.vue';
import { useSidebar } from './sidebarContext';
import { useSidebarNodes } from './sidebarNodes';
import { mentionPreview } from '../../lib/integratedComposer';

// One line for a subagent or a process. `tab` is set for top-level processes,
// which can be pinned; `rootId` and `parentKey` for members of an agent
// family. A subagent with its own members gets `nodeId`, `count`, and
// `expanded`, and folds like a family.
const props = withDefaults(defineProps<{
  session?: SessionRecord | undefined;
  process?: ProcessRecord | undefined;
  rootId?: string | undefined;
  parentKey?: string | undefined;
  // The host of the row this one sits under; a member shows its host only where it differs.
  parentHost?: string | undefined;
  tab?: StripTab | undefined;
  nodeId?: string | undefined;
  count?: number | undefined;
  countLabel?: string | undefined;
  expanded?: boolean | undefined;
  holdsSelection?: boolean | undefined;
  urgency?: NotificationUrgency | null | undefined;
}>(), { session: undefined, process: undefined, rootId: undefined, parentKey: undefined, parentHost: undefined, tab: undefined, nodeId: undefined, count: 0, countLabel: '', expanded: false, holdsSelection: false, urgency: undefined });

const sidebar = useSidebar();
const nodes = useSidebarNodes();
const rowActivity = computed(() => props.session ? sidebar.activity(props.session) : processActivity(props.process!));
const label = computed(() => props.session ? agentLabel(props.session) : props.process?.name ?? '');
const host = computed(() => props.session?.host ?? props.process?.host);
const rowKey = computed(() => props.tab?.key ?? (props.session ? `session:${props.session.id}` : `process:${props.process?.id}`));
const active = computed(() => props.session ? sidebar.sessionActive(props.session) : props.process ? sidebar.processActive(props.process) : false);
// Only family members dim; top-level processes aren't part of any thread.
const dimmed = computed(() => !props.tab && Boolean(nodes.dimmed?.(props.session?.id ?? props.process?.id ?? '')));

function select(): void {
  if (props.process) {
    sidebar.selectProcess(props.process);
    return;
  }
  if (!props.session || !props.rootId) return;
  const wasSelected = active.value;
  sidebar.selectSession(props.rootId, props.session);
  if (!nodes.expandOnSelect || !props.nodeId) return;
  if (!props.expanded) nodes.setOpen(props.nodeId, true);
  else if (wasSelected) nodes.setOpen(props.nodeId, false);
}
</script>
