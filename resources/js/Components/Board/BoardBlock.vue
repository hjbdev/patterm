<template>
  <!-- One agent on the board: what it is doing, in full; who is working for
       it; and where its work lives. A click anywhere opens it, except on its
       members and links, which open themselves. -->
  <SidebarItemMenu :session="digest.session" :tab="digest.tab">
    <div
      data-board-cell
      :class="cn(
        'relative isolate min-w-0 cursor-pointer rounded-[12px] px-4 pb-3.5 pt-3 transition-colors duration-150',
        digest.holdsSelection ? 'bg-white/[0.06] hover:bg-white/[0.075]' : 'bg-white/[0.025] hover:bg-white/[0.045]'
      )"
      @click="openAgent"
    >
      <span v-if="tint" class="board-tint" :data-tone="tint" aria-hidden="true" />
      <!-- The keyboard's way in; its clicks reach the block like any other. -->
      <button
        type="button"
        data-board-block
        :aria-current="digest.active ? 'page' : undefined"
        :aria-label="`${digest.name}: ${digest.status}`"
        class="absolute inset-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div class="relative min-w-0">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="flex h-5 w-4 shrink-0 items-center justify-center">
            <TabIcon :activity="digest.activity" compact><AgentIcon :harness="digest.harness" class="h-4 w-4" /></TabIcon>
          </span>
          <span class="min-w-0 truncate text-sm font-medium leading-5 text-foreground" :title="hostLabel(digest.name, digest.session.host)">{{ digest.name }}</span>
          <HostBadge v-if="digest.session.host" :host="digest.session.host" />
          <span class="ml-auto flex shrink-0 items-center gap-2 pl-2">
            <span class="text-[11px] tabular-nums text-muted-foreground/70" :title="ageTitle">{{ age }}</span>
            <UnreadDot :urgency="digest.unread" />
          </span>
        </div>
        <p class="flex min-w-0 items-baseline gap-2 pl-[26px] text-xs leading-[18px]">
          <span class="line-clamp-2 min-w-0 flex-1" :class="digest.state === 'attention' ? 'text-foreground' : 'text-muted-foreground'">{{ digest.status }}</span>
          <span v-if="digest.model" class="shrink-0 text-[11px] text-muted-foreground/70">{{ digest.model }}</span>
        </p>

        <!-- An agent's own question comes first, in its words. -->
        <p v-if="message" class="mt-2.5 line-clamp-4 text-[13px] leading-[19px] text-foreground">{{ message }}</p>
        <p v-if="story" class="mt-2.5 line-clamp-6 text-[13px] leading-[19px]" :title="story.goal ? `${story.goal} ${story.now}` : story.now"><span v-if="story.goal" class="text-muted-foreground">{{ `${story.goal} ` }}</span><span class="text-foreground/85">{{ story.now }}</span></p>
        <p v-else-if="!message" class="mt-2.5 text-[13px] leading-[19px] text-muted-foreground/60">No summary yet</p>

        <ul v-if="digest.members.length" class="-mx-1.5 mt-2.5" :aria-label="membersLabel(digest.counts, ', ')">
          <li v-for="member in shownMembers" :key="member.key">
            <SidebarItemMenu :session="member.session" :process="member.process">
              <button
                type="button"
                :aria-current="memberActive(member) ? 'page' : undefined"
                :class="cn(
                  'relative isolate flex h-6 w-full min-w-0 items-center gap-2 rounded-md pr-1.5 text-left text-xs transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  memberActive(member) ? 'bg-primary/10 text-foreground' : 'text-foreground/75'
                )"
                :style="{ paddingLeft: `${6 + (Math.min(member.depth, MAX_INDENT_DEPTH) - 1) * 14}px` }"
                :title="hostLabel(member.name, member.session?.host ?? member.process?.host)"
                @click.stop="openMember(member)"
                @contextmenu.stop
              >
                <TabWash class="opacity-70" :activity="member.activity" />
                <span class="flex h-4 w-4 shrink-0 items-center justify-center">
                  <!-- Subagents show only their status, a ring; the block's icon already names the harness. -->
                  <TabIcon :activity="member.activity" compact muted>
                    <template #default="{ working }">
                      <span v-if="member.session" class="block h-3 w-3 rounded-full border-[1.75px] border-current" :class="working ? 'opacity-90' : 'opacity-[0.55]'" />
                      <TerminalSquare v-else class="h-3.5 w-3.5" />
                    </template>
                  </TabIcon>
                </span>
                <span class="min-w-0 truncate">{{ member.name }}</span>
              </button>
            </SidebarItemMenu>
          </li>
          <li v-if="hiddenMembers">
            <button type="button" class="flex h-6 w-full items-center rounded-md pl-[30px] text-left text-xs text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" @click.stop="openAgent">
              {{ hiddenMembers }} more
            </button>
          </li>
        </ul>

        <div v-if="hasFooter" class="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-4 text-muted-foreground">
          <span v-if="digest.branch" class="flex min-w-0 max-w-full items-center gap-1" :title="digest.branch"><GitBranch class="h-3 w-3 shrink-0" /><span class="truncate">{{ digest.branch }}</span></span>
          <DiffStat v-if="digest.diff" :additions="digest.diff.additions" :deletions="digest.diff.deletions" class="gap-1 [&>span]:text-muted-foreground" :title="`${digest.diff.files} ${digest.diff.files === 1 ? 'file' : 'files'} changed`" />
          <a
            v-for="link in digest.links"
            :key="link.id"
            :href="link.url"
            target="_blank"
            rel="noopener noreferrer"
            class="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            :title="link.title ?? link.url"
            @click.stop
          >{{ linkLabel(link) }}</a>
          <span v-if="digest.timer" class="flex min-w-0 max-w-full items-center gap-1 tabular-nums" :title="digest.timer.title"><TimerIcon class="h-3 w-3 shrink-0" /><span class="truncate">{{ timerText }}</span></span>
        </div>
      </div>
    </div>
  </SidebarItemMenu>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { GitBranch, TerminalSquare, Timer as TimerIcon } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { ago, membersLabel, shortAgo, type AgentDigest, type DigestMember } from '../../lib/agentDigest';
import { hostLabel } from '../../lib/hosts';
import { MAX_INDENT_DEPTH } from '../../lib/sidebarTree';
import { linkLabel } from '../../Composables/useSessionContext';
import { timerLabel } from '../../lib/timers';
import AgentIcon from '../AgentIcon.vue';
import DiffStat from '../DiffStat.vue';
import HostBadge from '../HostBadge.vue';
import TabIcon from '../TabIcon.vue';
import TabWash from '../TabWash.vue';
import UnreadDot from '../UnreadDot.vue';
import SidebarItemMenu from '../Sidebar/SidebarItemMenu.vue';
import { useSidebar } from '../Sidebar/sidebarContext';

// Big families show their first few members; the rest are a click away.
const MEMBERS_SHOWN = 6;

const props = defineProps<{ digest: AgentDigest; now: number }>();
const sidebar = useSidebar();

// Needs you: a soft tint gathered at the icon, not a full wash.
const tint = computed(() => props.digest.state !== 'attention' ? null : props.digest.ask?.kind === 'error' ? 'error' : 'permission');

const message = computed(() => props.digest.ask?.kind === 'message' ? props.digest.ask.text : null);

// The summary's opening sentence says what the thread is for, the rest where
// it stands. A finished agent's close note says where it ended better.
const story = computed(() => {
  const { summary, ask } = props.digest;
  const now = ask?.kind === 'close' ? ask.text : summary?.now ?? null;
  if (!now) return null;
  return { goal: summary && summary.goal !== now ? summary.goal : null, now };
});

const age = computed(() => shortAgo(props.digest.updatedAt, props.now));
const ageTitle = computed(() => `${props.digest.summary ? 'Summary' : 'Started'} ${ago(props.digest.updatedAt, props.now)}`);

// A watch with no deadline has no countdown; its label says what it waits for.
const timerText = computed(() => {
  if (!props.digest.timer) return '';
  if (props.digest.timer.remaining) return props.digest.timer.remaining;
  const [first] = sidebar.familyTimers(props.digest.family);
  return first ? timerLabel(first) : '';
});

const hasFooter = computed(() => Boolean(props.digest.branch || props.digest.diff || props.digest.links.length || props.digest.timer));

const shownMembers = computed(() => props.digest.members.slice(0, MEMBERS_SHOWN));
const hiddenMembers = computed(() => Math.max(0, props.digest.members.length - MEMBERS_SHOWN));

function memberActive(member: DigestMember): boolean {
  return member.session ? sidebar.sessionActive(member.session) : member.process ? sidebar.processActive(member.process) : false;
}

function openAgent(event: MouseEvent): void {
  // Dragging to select text in the block isn't a click on it.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && event.currentTarget instanceof Node && event.currentTarget.contains(selection.anchorNode)) return;
  sidebar.selectSession(props.digest.family.rootId, props.digest.session);
}

function openMember(member: DigestMember): void {
  if (member.session) sidebar.selectSession(props.digest.family.rootId, member.session);
  else if (member.process) sidebar.selectProcess(member.process);
}
</script>

<style scoped>
.board-tint {
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
}

.board-tint[data-tone='permission'] { background: radial-gradient(280px 160px at 24px 20px, hsl(var(--warning) / 0.12), transparent 70%); }
.board-tint[data-tone='error'] { background: radial-gradient(280px 160px at 24px 20px, hsl(var(--destructive) / 0.12), transparent 70%); }
</style>
