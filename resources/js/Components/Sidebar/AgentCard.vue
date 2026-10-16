<template>
  <!-- The whole story of one agent, beside its row in the sidebar: who it is,
       what it needs from you or is doing, its summary, its subagents and
       processes, and where its work lives. Flat text throughout; it scrolls
       when the story is long. -->
  <div ref="scroller" class="overflow-y-auto overflow-x-hidden [scrollbar-width:thin]" :style="fade" @scroll.passive="measure">
    <div ref="content" class="px-3 pb-3 pt-2.5">
      <div class="flex items-start gap-2.5">
        <span class="flex h-5 w-4 shrink-0 items-center justify-center text-foreground/80"><AgentIcon :harness="digest.harness" class="h-3.5 w-3.5" /></span>
        <h2 class="min-w-0 flex-1 text-[13px] font-medium leading-5 text-foreground [overflow-wrap:anywhere]">{{ digest.name }}</h2>
      </div>
      <!-- Each part leads with its separator, and the row is pulled left under a
           clip, so a part that wraps to a new line starts clean. -->
      <p class="ml-[26px] mt-0.5 overflow-hidden text-[11px] leading-4 text-muted-foreground">
        <span class="-ml-3 flex flex-wrap">
          <span v-for="(part, index) in meta" :key="index" class="whitespace-nowrap before:inline-block before:w-3 before:text-center before:content-['·'_/_'']">{{ part }}</span>
        </span>
      </p>

      <!-- What it needs from you, in its own words where it gave any; otherwise what it's doing. -->
      <div v-if="digest.ask" class="mt-3 flex items-start gap-2.5">
        <span class="flex h-5 w-4 shrink-0 items-center justify-center">
          <UnreadDot v-if="digest.ask.kind === 'message'" :urgency="digest.unread ?? 'normal'" />
          <StatusIcon v-else :spec="askMark" class="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-[13px] leading-5 text-foreground">{{ askHeadline }}</p>
          <p v-if="digest.ask.kind === 'close'" class="mt-0.5 text-[13px] leading-relaxed text-foreground/85">{{ digest.ask.text }}</p>
          <p v-if="digest.ask.from" class="mt-0.5 text-xs leading-5 text-muted-foreground">From {{ digest.ask.from }}</p>
        </div>
      </div>
      <p v-else class="mt-3 text-[13px] leading-5" :class="digest.state === 'idle' ? 'text-muted-foreground' : 'text-foreground/75'">
        <ShimmerText v-if="digest.activity.self === 'working'" :text="digest.status" />
        <template v-else>{{ digest.status }}</template>
      </p>

      <!-- What the thread is for, then where it stands. -->
      <div v-if="digest.summary" class="mt-2.5 space-y-1.5 text-[13px] leading-relaxed">
        <p class="text-muted-foreground">{{ digest.summary.goal }}</p>
        <p v-if="digest.summary.now !== digest.summary.goal" class="text-foreground/85">{{ digest.summary.now }}</p>
      </div>
      <p v-else class="mt-2.5 text-[13px] leading-relaxed text-muted-foreground/60">No summary yet</p>

      <div v-if="digest.members.length" class="-mx-1.5 mt-4">
        <p class="px-1.5 pb-1 text-[11px] leading-4 text-muted-foreground">{{ membersLabel(digest.counts, ' · ') }}</p>
        <AgentCardMember v-for="member in digest.members" :key="member.key" :member="member" :root-id="digest.family.rootId" :parent-host="digest.session.host" />
      </div>

      <!-- Where its work lives, as quiet label and value rows. -->
      <dl v-if="hasFacts" class="mt-4 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-xs leading-[18px]">
        <template v-if="digest.branch">
          <dt class="text-[11px] text-muted-foreground">Branch</dt>
          <dd class="flex min-w-0 items-baseline gap-2">
            <span class="min-w-0 truncate text-foreground/80" :title="digest.branch">{{ digest.branch }}</span>
            <DiffStat v-if="digest.diff" :additions="digest.diff.additions" :deletions="digest.diff.deletions" class="gap-1 font-sans text-[11px] [&>span]:text-muted-foreground" />
          </dd>
        </template>
        <template v-if="digest.todo">
          <dt class="text-[11px] text-muted-foreground">Todo</dt>
          <dd class="min-w-0 text-foreground/80">{{ digest.todo }}</dd>
        </template>
        <template v-if="digest.links.length">
          <dt class="text-[11px] text-muted-foreground">{{ digest.links.length === 1 ? 'Link' : 'Links' }}</dt>
          <dd class="min-w-0 space-y-0.5">
            <a
              v-for="link in digest.links"
              :key="link.id"
              :href="link.url"
              target="_blank"
              rel="noopener noreferrer"
              :title="link.title ? `${link.title}\n${link.url}` : link.url"
              class="group/link flex min-w-0 items-baseline gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span class="shrink-0 tabular-nums text-foreground/80 transition-colors group-hover/link:text-foreground">{{ linkLabel(link) }}</span>
              <span v-if="linkDetail(link)" class="min-w-0 truncate text-muted-foreground transition-colors group-hover/link:text-foreground/80">{{ linkDetail(link) }}</span>
            </a>
          </dd>
        </template>
        <template v-if="timers.length">
          <dt class="text-[11px] text-muted-foreground">{{ timers.length === 1 ? 'Timer' : 'Timers' }}</dt>
          <dd class="min-w-0 space-y-0.5">
            <p v-for="timer in timers" :key="timer.id" class="text-foreground/80">
              {{ timer.label }}<span v-if="timer.when" class="whitespace-nowrap tabular-nums text-muted-foreground"> · {{ timer.when }}</span>
            </p>
          </dd>
        </template>
        <template v-if="digest.session.host">
          <dt class="text-[11px] text-muted-foreground">Host</dt>
          <dd class="min-w-0 text-foreground/80">{{ digest.session.host }}</dd>
        </template>
      </dl>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ago, membersLabel, type AgentDigest } from '../../lib/agentDigest';
import { familyOwnerLabel } from '../../lib/agentTabs';
import { harnessLabel } from '../../lib/harnesses';
import { activityIcon, CLOSING_MARK, type IconSpec } from '../../lib/statusIcons';
import { timerLabel, timerRemainingToMinute } from '../../lib/timers';
import type { TimerKind } from '../../types';
import { useScrollFade } from '../../Composables/useScrollFade';
import { linkDetail, linkLabel } from '../../Composables/useSessionContext';
import AgentIcon from '../AgentIcon.vue';
import DiffStat from '../DiffStat.vue';
import ShimmerText from '../ShimmerText.vue';
import StatusIcon from '../StatusIcon.vue';
import UnreadDot from '../UnreadDot.vue';
import AgentCardMember from './AgentCardMember.vue';
import { useSidebar } from './sidebarContext';

const props = defineProps<{ digest: AgentDigest; now: number }>();
const sidebar = useSidebar();

const scroller = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const { style: fade, measure } = useScrollFade(scroller, content);

// Opus 5.5 · high · started 48m ago · summary 1m ago. The harness stands in
// for a model it didn't report.
const meta = computed(() => [
  props.digest.model ?? (props.digest.harness ? harnessLabel(props.digest.harness) : null),
  props.digest.session.reasoning,
  `started ${ago(props.digest.startedAt, props.now)}`,
  props.digest.summary ? `summary ${ago(props.digest.summary.at, props.now)}` : null
].filter((part): part is string => Boolean(part)));

// The marks RowStatus draws on a row that needs you, so the two read alike.
const askMark = computed<IconSpec>(() => {
  const kind = props.digest.ask?.kind;
  return kind === 'close' ? CLOSING_MARK : activityIcon(kind === 'error' || kind === 'question' ? kind : 'permission');
});
const askHeadline = computed(() => props.digest.ask?.kind === 'close' ? 'Ready to close' : props.digest.ask?.text ?? '');

// Watches without a deadline fire on an event. One its agent named says which;
// an unnamed one is already called by its event.
const WATCH_WORDS: Record<TimerKind, string> = {
  delay: '',
  idle_any: 'when one is idle',
  idle_all: 'when all are idle',
  report_any: 'when one reports',
  report_all: 'when all report',
  output: 'when the text appears'
};
const timers = computed(() => sidebar.familyTimers(props.digest.family).map((timer) => {
  const owner = familyOwnerLabel(props.digest.family, timer.ownerProcessId);
  return {
    id: timer.id,
    label: owner ? `${timerLabel(timer)} · ${owner}` : timerLabel(timer),
    // To the minute, as on the tab, so the text doesn't tick every second.
    when: timerRemainingToMinute(timer, sidebar.now.value) || (timer.label ? WATCH_WORDS[timer.kind] : '')
  };
}));

const hasFacts = computed(() => Boolean(props.digest.branch || props.digest.todo || props.digest.links.length || timers.value.length || props.digest.session.host));
</script>
