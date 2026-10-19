<template>
  <!-- One agent on the canvas: who it is, how it's doing, and what it's on.
       A click opens it; a drag moves it. -->
  <SidebarItemMenu :session="node.session" :tab="node.isRoot ? node.digest.tab : undefined">
    <div
      data-canvas-card
      :data-canvas-id="node.id"
      :class="cn(
        'absolute left-0 top-0 isolate flex flex-col rounded-[12px] border px-3.5 pb-3 pt-3 transition-[background-color,border-color,box-shadow] duration-150',
        active ? 'border-white/[0.14] bg-[hsl(0_0%_12.5%)]' : working ? 'border-white/[0.1] bg-[hsl(0_0%_11%)] hover:bg-[hsl(0_0%_12%)]' : 'border-white/[0.06] bg-[hsl(0_0%_10.5%)] hover:bg-[hsl(0_0%_11.5%)]',
        dragging ? 'z-10 cursor-grabbing shadow-[0_12px_32px_rgb(0_0_0/0.45)]' : 'canvas-card-glide cursor-pointer'
      )"
      :style="{ width: `${CARD_WIDTH}px`, height: `${CARD_HEIGHT}px`, transform: `translate(${position.x}px, ${position.y}px)` }"
      @click="open"
    >
      <span v-if="tint" class="canvas-tint" :data-tone="tint" aria-hidden="true" />
      <!-- The keyboard's way in; its clicks reach the card like any other. -->
      <button
        type="button"
        data-canvas-node
        :aria-current="active ? 'page' : undefined"
        :aria-label="`${name}: ${pill.label}`"
        class="absolute inset-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        @focus="onFocus"
      />
      <div class="pointer-events-none relative flex min-w-0 items-start gap-2.5">
        <!-- In All agents, the project says where it works; its harness rides in the corner. -->
        <span v-if="node.project" class="relative h-8 w-8 shrink-0">
          <ProjectLogo :project="node.project" :size="32" />
          <span class="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-[5px] border border-white/[0.08] bg-[hsl(0_0%_10.5%)] text-foreground/80">
            <AgentIcon :harness="node.session.harness" class="h-2.5 w-2.5" />
          </span>
        </span>
        <span v-else class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03] text-foreground/80">
          <AgentIcon :harness="node.session.harness" class="h-4 w-4" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="flex min-w-0 items-center gap-1.5">
            <span class="min-w-0 truncate text-sm font-medium leading-5 text-foreground" :title="hostLabel(name, node.session.host)">{{ name }}</span>
            <HostBadge v-if="node.session.host" :host="node.session.host" />
          </span>
          <span class="block truncate text-xs leading-4 text-muted-foreground">{{ model ?? harnessLabel(node.session.harness ?? '') }}</span>
        </span>
        <span :class="cn('relative flex h-6 shrink-0 items-center gap-1.5 rounded-md text-xs', pill.tone === 'working' ? 'px-2' : 'pl-1.5 pr-2', PILL_TONES[pill.tone])" :title="describeActivity(activity)">
          <ComposerWorkingBorder v-if="pill.tone === 'working'" :radius="6" />
          <!-- While it works, the comet is the pill's only motion. -->
          <RowStatus v-if="pill.tone !== 'working'" :activity="activity" />
          {{ pill.label }}
        </span>
      </div>

      <p :class="cn('pointer-events-none relative mt-2.5 line-clamp-2 min-w-0 text-[13px] leading-[19px]', text.muted ? 'text-muted-foreground/60' : text.urgent ? 'text-foreground' : 'text-foreground/85')" :title="text.full">{{ text.shown }}</p>

      <div class="relative mt-auto flex min-w-0 items-center gap-2 text-[11px] leading-4 text-muted-foreground">
        <span class="pointer-events-none flex min-w-0 items-center gap-1.5 truncate">
          <span class="shrink-0 tabular-nums" :title="`Started ${ago(node.session.startedAt, now)}`">{{ shortAgo(node.session.startedAt, now) }}</span>
          <template v-if="place"><span aria-hidden="true">·</span><span class="truncate" :title="place">{{ place }}</span></template>
        </span>
        <span class="flex-1" />
        <!-- Its processes open themselves. -->
        <button
          v-for="process in shownProcesses"
          :key="process.id"
          type="button"
          data-canvas-interactive
          :aria-current="sidebar.processActive(process) ? 'page' : undefined"
          class="flex h-5 min-w-0 max-w-28 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :title="process.command || process.name"
          @click.stop="sidebar.selectProcess(process)"
          @contextmenu.stop
        >
          <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center"><RowStatus :activity="processActivity(process)" /></span>
          <span class="truncate">{{ process.name }}</span>
        </button>
        <span v-if="hiddenProcesses" class="pointer-events-none tabular-nums">+{{ hiddenProcesses }}</span>
        <span v-if="node.descendants" class="pointer-events-none flex shrink-0 items-center gap-0.5 tabular-nums" :title="`${node.descendants} ${node.descendants === 1 ? 'subagent' : 'subagents'}`">
          <Workflow class="h-3 w-3" />{{ node.descendants }}
        </span>
      </div>
    </div>
  </SidebarItemMenu>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Workflow } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { agentLabel } from '../../lib/agentTabs';
import { CARD_HEIGHT, CARD_WIDTH, type Point } from '../../lib/agentCanvas';
import { ago, memberState, modelLabel, shortAgo, splitSummary, type AgentDigest } from '../../lib/agentDigest';
import { harnessLabel } from '../../lib/harnesses';
import { hostLabel } from '../../lib/hosts';
import type { LiveProcessRecord } from '../../lib/processTabs';
import { describeActivity, processActivity } from '../../lib/rowActivity';
import type { ProjectSummary, SessionRecord } from '../../types';
import AgentIcon from '../AgentIcon.vue';
import ComposerWorkingBorder from '../ComposerWorkingBorder.vue';
import HostBadge from '../HostBadge.vue';
import ProjectLogo from '../ProjectLogo.vue';
import RowStatus from '../RowStatus.vue';
import SidebarItemMenu from '../Sidebar/SidebarItemMenu.vue';
import { useSidebar } from '../Sidebar/sidebarContext';

export interface CanvasNode {
  id: string;
  session: SessionRecord;
  // The family's digest; a root's own status and summary come from it.
  digest: AgentDigest;
  isRoot: boolean;
  descendants: number;
  processes: LiveProcessRecord[];
  // The agent's project, in All agents.
  project: ProjectSummary | null;
}

type Tone = 'attention' | 'error' | 'working' | 'quiet';

const PILL_TONES: Record<Tone, string> = {
  attention: 'bg-warning/10 text-warning',
  error: 'bg-destructive/10 text-destructive',
  working: 'border border-primary/15 bg-primary/[0.08] text-foreground',
  quiet: 'bg-white/[0.03] text-muted-foreground'
};

const PROCESSES_SHOWN = 2;

const props = defineProps<{ node: CanvasNode; position: Point; now: number; dragging: boolean }>();
const emit = defineEmits<{ focus: [id: string] }>();
const sidebar = useSidebar();

const name = computed(() => agentLabel(props.node.session));
const model = computed(() => modelLabel(props.node.session.model));
const activity = computed(() => sidebar.activity(props.node.session));
const active = computed(() => sidebar.sessionActive(props.node.session));
const working = computed(() => activity.value.self === 'working');

// A root says what its family needs; a subagent says only how it is.
const pill = computed((): { label: string; tone: Tone } => {
  const self = activity.value.self;
  if (self === 'error') return { label: 'Error', tone: 'error' };
  if (self === 'dead') return { label: 'Exited', tone: 'quiet' };
  const state = props.node.isRoot ? props.node.digest.state : memberState(activity.value);
  switch (state) {
    case 'attention': return { label: 'Needs you', tone: props.node.digest.ask?.kind === 'error' && props.node.isRoot ? 'error' : 'attention' };
    case 'working': return { label: 'Working', tone: 'working' };
    case 'waiting': return { label: 'Waiting', tone: 'quiet' };
    case 'done': return { label: 'Done', tone: 'quiet' };
    default: return { label: self === 'unknown' ? 'Unknown' : 'Idle', tone: 'quiet' };
  }
});

const tint = computed(() => pill.value.tone === 'attention' ? 'permission' : pill.value.tone === 'error' ? 'error' : null);

// A root's question comes first, in its words, then where it stands; a
// subagent's summary says what it's for.
const text = computed((): { shown: string; full: string; urgent?: boolean; muted?: boolean } => {
  const { session, digest, isRoot } = props.node;
  if (isRoot) {
    const ask = digest.ask;
    if (ask?.kind === 'message' || ask?.kind === 'close') return { shown: ask.text, full: ask.text, urgent: ask.kind === 'message' };
    if (digest.summary) return { shown: digest.summary.now, full: `${digest.summary.goal} ${digest.summary.now}` };
  } else if (session.closeRequest) {
    return { shown: session.closeRequest.summary, full: session.closeRequest.summary };
  } else if (session.summary) {
    const { goal, now } = splitSummary(session.summary.text);
    return { shown: goal === now ? now : `${goal} ${now}`, full: session.summary.text };
  }
  return { shown: 'No summary yet', full: '', muted: true };
});

const place = computed(() => props.node.isRoot ? [props.node.project?.name, props.node.digest.branch].filter(Boolean).join(' · ') : '');

const shownProcesses = computed(() => props.node.processes.slice(0, PROCESSES_SHOWN));
const hiddenProcesses = computed(() => Math.max(0, props.node.processes.length - PROCESSES_SHOWN));

// Only a card reached by keyboard pans into view; a press on a clipped card
// would otherwise move it from under the pointer.
function onFocus(event: FocusEvent): void {
  if (event.target instanceof HTMLElement && event.target.matches(':focus-visible')) emit('focus', props.node.id);
}

function open(): void {
  sidebar.selectSession(props.node.digest.family.rootId, props.node.session);
}
</script>

<style scoped>
.canvas-tint {
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
}

/* Cards glide to a new place when the layout changes, and arrive softly. */
.canvas-card-glide {
  transition-property: background-color, border-color, box-shadow, transform;
  transition-duration: 150ms, 150ms, 150ms, 320ms;
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}

[data-canvas-card] {
  animation: canvas-card-in 260ms cubic-bezier(0.2, 0, 0, 1);
}

@keyframes canvas-card-in {
  from { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .canvas-card-glide { transition-property: background-color, border-color, box-shadow; }
  [data-canvas-card] { animation: none; }
}

.canvas-tint[data-tone='permission'] { background: radial-gradient(260px 140px at 28px 24px, hsl(var(--warning) / 0.1), transparent 70%); }
.canvas-tint[data-tone='error'] { background: radial-gradient(260px 140px at 28px 24px, hsl(var(--destructive) / 0.1), transparent 70%); }
</style>
