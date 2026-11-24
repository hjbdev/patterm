<template>
  <!-- Bots sit above a project's agents, and the global ones above the
       projects: each a conversation row with its face and its last line.
       Their helpers list in their projects like any agent; one waiting on
       you shows here too. The global
       assistant leads them while it is on. -->
  <div v-if="shownRows.length" class="mb-2 border-b border-white/[0.06] pb-2">
    <div v-if="!compact" class="flex h-7 items-center gap-2 pl-2 pr-0.5 text-[12.5px] font-medium text-muted-foreground">
      <span class="flex-1">Bots</span>
    </div>
    <div v-for="row in shownRows" :key="row.bot.id" class="group/bot relative">
      <button
        type="button"
        data-sidebar-bot
        :aria-current="activeBotId === row.bot.id ? 'page' : undefined"
        :class="cn(rowClass(activeBotId === row.bot.id), compact && 'items-center py-2', phone && 'min-h-[58px] items-center gap-3 rounded-xl px-2.5 py-2.5 text-[15.5px]')"
        @click="open(row.bot.id)"
      >
        <BotAvatar :avatar="row.bot.avatar" :size="phone ? 32 : 24" :activity="row.activity" :class="!compact && !phone ? 'mt-0.5' : ''" />
        <template v-if="compact">
          <span class="min-w-0 flex-1 truncate text-[14px] leading-5" :class="activeBotId === row.bot.id && 'font-medium'">{{ row.bot.name }}<span v-if="row.bot.host" class="ml-1.5 font-normal text-muted-foreground">{{ row.bot.host }}</span></span>
          <span v-if="row.waitingHelper" class="h-2 w-2 shrink-0 rounded-full bg-amber-400" :title="botLine(row)" aria-label="Helper waiting" />
        </template>
        <template v-else>
          <span class="min-w-0 flex-1">
            <span class="block truncate leading-5" :class="(activeBotId === row.bot.id || phone) && 'font-medium'">{{ row.bot.name }}<span v-if="row.bot.host" class="ml-1.5 font-normal text-muted-foreground">{{ row.bot.host }}</span></span>
            <span class="mt-0.5 block truncate text-[13.5px] leading-[18px]" :class="row.session?.asking || row.waitingHelper ? 'text-amber-300/90' : 'text-muted-foreground'">{{ botLine(row) }}</span>
          </span>
        </template>
      </button>
      <Button
        v-if="!compact && row.waitingHelper && row.waitingHelperProjectId"
        variant="ghost"
        size="sm"
        class="absolute right-1 top-2 h-6 px-2 text-[12px] text-warning hover:text-warning"
        @click="openHelper(row.waitingHelperProjectId, row.waitingHelper.id)"
      >
        Open helper
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { cn } from '@/lib/utils';
import { useBots } from '../Composables/useBots';
import { useWorkbench } from '../Composables/useWorkbench';
import { listedProjects } from '../lib/allAgents';
import { botHomeProjectId, botLine, botShownIn, isGlobalBot } from '../lib/bots';
import BotAvatar from './BotAvatar.vue';
import { Button } from './ui/button';

// projectId: the project whose bots list, which they open beside. Without
// one, as on the projects page, only global bots list. all: every bot, as in
// All agents mode. compact: quiet single-line rows for the desktop sidebar.
const props = defineProps<{ phone?: boolean; compact?: boolean; projectId?: string | null; all?: boolean }>();
const route = useRoute();
const router = useRouter();
const { rows } = useBots();
const { projects } = useWorkbench();
const projectIds = computed(() => listedProjects(projects.value).map((project) => project.project.id));
const activeBotId = computed(() => route.name === 'bot' || route.name === 'standaloneBot' ? String(route.params.botId) : null);
const shownRows = computed(() => {
  if (props.all) return rows.value;
  const projectId = props.projectId;
  if (projectId) return rows.value.filter((row) => botShownIn(row.bot, projectId));
  // Without a project, as on the projects page, only global bots list.
  return rows.value.filter((row) => isGlobalBot(row.bot));
});

function rowClass(active: boolean): string {
  return cn('flex w-full min-w-0 select-none items-start gap-2.5 rounded-tab px-2 py-2 text-left text-[14px] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', active ? 'bg-primary/10 text-foreground' : 'text-foreground/85');
}

// A bot opens beside the project you're in, or else one it lists in, or
// on its own when there are no projects.
function open(botId: string): void {
  const projectId = props.projectId || botHomeProjectId(rows.value.find((row) => row.bot.id === botId)?.bot, projectIds.value);
  void router.push(projectId ? { name: 'bot', params: { projectId, botId } } : { name: 'standaloneBot', params: { botId } });
}

// A helper waiting on you opens in its own project, like any agent.
function openHelper(projectId: string, sessionId: string): void {
  void router.push({ name: 'agent', params: { projectId, sessionId } });
}
</script>
