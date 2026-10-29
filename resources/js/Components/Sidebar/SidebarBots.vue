<template>
  <!-- Bots sit above the agents: each a conversation row with its face and
       its last line. Their helpers never list; one waiting on you shows here. -->
  <div v-if="rows.length" class="mb-1 border-b border-white/[0.06] pb-1">
    <div class="flex h-7 items-center gap-2 pl-2 pr-0.5 text-xs text-muted-foreground">
      <span class="flex-1">Bots</span>
      <Button variant="ghost" size="icon" class="h-5 w-5 rounded-tab text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5" title="New bot" aria-label="New bot" @click="openSettings">
        <Plus />
      </Button>
    </div>
    <div v-for="row in rows" :key="row.bot.id" class="group/bot relative">
      <button
        type="button"
        data-sidebar-bot
        :aria-current="activeBotId === row.bot.id ? 'page' : undefined"
        :class="cn('flex w-full min-w-0 select-none items-start gap-2.5 rounded-tab px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', activeBotId === row.bot.id ? 'bg-primary/10 text-foreground' : 'text-foreground/85', phone && 'min-h-14 py-2.5')"
        @click="open(row.bot.id)"
      >
        <BotAvatar :avatar="row.bot.avatar" :size="phone ? 28 : 22" :activity="row.activity" class="mt-0.5" />
        <span class="min-w-0 flex-1">
          <span class="block truncate leading-5" :class="activeBotId === row.bot.id && 'font-medium'">{{ row.bot.name }}</span>
          <span class="block truncate text-xs leading-4" :class="row.session?.asking || row.waitingHelper ? 'text-foreground/75' : 'text-muted-foreground'">{{ row.line ?? (row.session ? (row.session.exitedAt ? 'Starting again…' : 'Ready') : 'Starting…') }}</span>
        </span>
      </button>
      <Button
        v-if="row.waitingHelper && row.waitingHelperProjectId"
        variant="ghost"
        size="sm"
        class="absolute right-1 top-1.5 h-5 px-1.5 text-[11px] text-warning hover:text-warning"
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
import { Plus } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { useBots } from '../../Composables/useBots';
import BotAvatar from '../BotAvatar.vue';
import { useSidebar } from './sidebarContext';
import { Button } from '../ui/button';

defineProps<{ phone?: boolean }>();
const route = useRoute();
const router = useRouter();
const { rows } = useBots();
const sidebar = useSidebar();
const activeBotId = computed(() => route.name === 'bot' ? String(route.params.botId) : null);

// A bot opens beside the project you're in.
function open(botId: string): void {
  void router.push({ name: 'bot', params: { projectId: sidebar.projectId.value, botId } });
}

// A helper waiting on you opens in its own project, like any agent.
function openHelper(projectId: string, sessionId: string): void {
  void router.push({ name: 'agent', params: { projectId, sessionId } });
}

function openSettings(): void {
  void router.push({ name: 'settings', query: { tab: 'bots' } });
}
</script>
