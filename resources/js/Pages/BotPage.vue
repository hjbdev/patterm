<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="!row" class="p-5 text-sm text-muted-foreground">This bot no longer exists. Manage bots in Settings › Bots.</div>
    <template v-else>
      <header class="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.06] px-4">
        <BotAvatar :avatar="row.bot.avatar" :size="28" :activity="row.activity" motion />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium">{{ row.bot.name }}</div>
          <div class="truncate text-xs text-muted-foreground">{{ purviewLabel }}</div>
        </div>
        <Button v-if="row.waitingHelper && row.waitingHelperProjectId" variant="ghost" size="sm" class="h-7 text-xs text-warning hover:text-warning" @click="openHelper">Open waiting helper</Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon" class="h-8 w-8 rounded-tab text-muted-foreground" aria-label="Bot actions"><MoreHorizontal class="h-4 w-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-48">
            <DropdownMenuItem :disabled="busy" @select="restart(false)">Restart</DropdownMenuItem>
            <DropdownMenuItem :disabled="busy" @select="restart(true)">New conversation</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem @select="openSettings">Bot settings</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div class="relative min-h-0 flex-1">
        <!-- Helpers' reports and Patterm's notes to the bot stay out of view. -->
        <IntegratedConversation
          v-if="live && row.session?.processId"
          :key="row.session.processId"
          :process-id="row.session.processId"
          hide-background
          compact-composer
          :addressee="row.bot.name"
          :restartable="true"
          :on-new-session="() => restart(true)"
          :on-restart-session="() => restart(false)"
          class="h-full"
        />
        <div v-else class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <BotAvatar :avatar="row.bot.avatar" :size="72" motion />
          <p class="text-sm text-muted-foreground">{{ busy || !row.session ? `Starting ${row.bot.name}…` : `${row.bot.name} has stopped.` }}</p>
          <Button v-if="row.session && !busy" size="sm" @click="restart(false)">Start again</Button>
          <p v-if="error" role="alert" class="max-w-sm text-xs text-destructive">{{ error }}</p>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { MoreHorizontal } from 'lucide-vue-next';
import BotAvatar from '../Components/BotAvatar.vue';
import IntegratedConversation from '../Components/IntegratedConversation.vue';
import { Button } from '../Components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../Components/ui/dropdown-menu';
import { useBots } from '../Composables/useBots';
import { useWorkbench } from '../Composables/useWorkbench';
import { restartBot, startBot } from '../lib/bots';

const route = useRoute();
const router = useRouter();
const { rows } = useBots();
const { projects } = useWorkbench();
const row = computed(() => rows.value.find((candidate) => candidate.bot.id === route.params.botId) ?? null);
const live = computed(() => Boolean(row.value?.session && !row.value.session.exitedAt));
const busy = ref(false);
const error = ref('');

const purviewLabel = computed(() => {
  const purview = row.value?.bot.purview;
  if (!purview || purview.kind === 'none') return 'No projects';
  if (purview.kind === 'all') return 'All projects';
  const names = purview.projectIds.map((id) => projects.value.find((project) => project.project.id === id)?.project.name).filter(Boolean);
  return names.length ? names.join(', ') : 'Its projects are gone';
});

async function restart(fresh: boolean): Promise<void> {
  const bot = row.value?.bot;
  if (!bot || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const processId = live.value ? row.value?.session?.processId : null;
    if (processId) await restartBot(processId, fresh);
    else await startBot(bot.id);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}

function openHelper(): void {
  const current = row.value;
  if (current?.waitingHelper && current.waitingHelperProjectId) void router.push({ name: 'agent', params: { projectId: current.waitingHelperProjectId, sessionId: current.waitingHelper.id } });
}

function openSettings(): void {
  void router.push({ name: 'settings', query: { tab: 'bots', bot: row.value?.bot.id ?? '' } });
}
</script>
