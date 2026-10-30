<template>
  <div ref="root" class="flex h-full min-h-0 flex-col">
    <div v-if="!row" class="p-5 text-sm text-muted-foreground">This bot no longer exists. Manage bots in Settings › Bots.</div>
    <template v-else>
      <header class="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.06] px-4">
        <BotAvatar :avatar="row.bot.avatar" :size="28" :activity="row.activity" motion />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium">{{ row.bot.name }}</div>
          <div class="truncate text-xs text-muted-foreground">{{ purviewLabel }}</div>
        </div>
        <button v-if="browser?.running" type="button" class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-white/[0.06] px-2.5 text-[12.5px] text-foreground/85 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" @click="peek = { kind: 'browser' }"><Globe class="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span class="py-1 [text-box:trim-both_cap_alphabetic]">Browser</span><span v-if="browser.help" class="h-1.5 w-1.5 rounded-full bg-foreground" aria-label="needs you" /></button>
        <Button v-if="row.waitingHelper && row.waitingHelperProjectId" variant="ghost" size="sm" class="h-7 text-xs text-warning hover:text-warning" @click="openHelper">Open waiting helper</Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon" class="h-8 w-8 rounded-tab text-muted-foreground" aria-label="Bot actions"><MoreHorizontal class="h-4 w-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-48">
            <DropdownMenuItem :disabled="busy" @select="restart(false)">Restart</DropdownMenuItem>
            <DropdownMenuItem :disabled="busy" @select="restart(true)">New conversation</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem :disabled="!projectId" @select="peek = { kind: 'context' }">Session context</DropdownMenuItem>
            <DropdownMenuItem @select="openSettings">Bot settings</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div class="flex min-h-0 flex-1">
        <div class="relative min-h-0 min-w-0 flex-1">
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
        <!-- The bot's browser or session context, beside its conversation while
             there's room and a sheet otherwise, as on an agent's page. -->
        <aside v-if="docked && peek && projectId && row.session" role="complementary" :aria-label="peekLabel" class="flex shrink-0 flex-col border-l border-border/30 bg-background" :style="{ width: `${paneWidth}px`, maxWidth: '100%' }" @keydown.esc.stop.prevent="peek = null">
          <PeekPane v-model:peek="peek" :project-id="projectId" :session-id="row.session.id" :process-id="row.session.processId" :summary="row.session.summary" @close="peek = null" />
        </aside>
      </div>
      <Sheet :open="Boolean(peek && projectId && !docked)" @update:open="open => { if (!open) peek = null }">
        <SheetContent side="right" hide-close aria-describedby="" class="flex w-[85vw] flex-col gap-0 border-border/30 p-0 pt-[env(safe-area-inset-top)] max-sm:w-full max-sm:max-w-none" :class="peek?.kind === 'browser' ? 'max-w-4xl' : 'max-w-sm'">
          <SheetTitle class="sr-only">{{ peekLabel }}</SheetTitle>
          <PeekPane v-if="peek && projectId && row.session" v-model:peek="peek" :project-id="projectId" :session-id="row.session.id" :process-id="row.session.processId" :summary="row.session.summary" @close="peek = null" />
        </SheetContent>
      </Sheet>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useElementSize } from '@vueuse/core';
import { Globe, MoreHorizontal } from 'lucide-vue-next';
import BotAvatar from '../Components/BotAvatar.vue';
import IntegratedConversation from '../Components/IntegratedConversation.vue';
import PeekPane from '../Components/peek/PeekPane.vue';
import { Button } from '../Components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '../Components/ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../Components/ui/dropdown-menu';
import { useBots } from '../Composables/useBots';
import { useWorkbench } from '../Composables/useWorkbench';
import { restartBot, startBot } from '../lib/bots';
import { useBrowserState } from '../lib/browser';
import type { Peek } from '../lib/peek';
import { phoneLayout } from '../lib/phoneLayout';
import { useSessionSecrets } from '../lib/secrets';

const route = useRoute();
const router = useRouter();
const { rows } = useBots();
const { projects, botProjects } = useWorkbench();
const row = computed(() => rows.value.find((candidate) => candidate.bot.id === route.params.botId) ?? null);
const live = computed(() => Boolean(row.value?.session && !row.value.session.exitedAt));
const busy = ref(false);
const error = ref('');

// The bot's own hidden project, where its session context lives.
const projectId = computed(() => {
  const sessionId = row.value?.session?.id;
  return sessionId ? botProjects.value.find((project) => project.projectSessions.some((session) => session.id === sessionId))?.project.id ?? null : null;
});

const peek = ref<Peek | null>(null);
const peekLabel = computed(() => peek.value?.kind === 'browser' ? 'Peek: browser' : 'Session context');
const root = ref<HTMLElement | null>(null);
const { width: rootWidth } = useElementSize(root);
const paneWidth = computed(() => peek.value?.kind === 'browser' ? 720 : 420);
// Docks while the conversation keeps 560 px beside it.
const docked = computed(() => !phoneLayout.value && rootWidth.value >= paneWidth.value + 560);
watch(() => row.value?.bot.id, () => { peek.value = null; });

// A request for help in the bot's browser opens it, once per request, so
// closing it sticks.
const browser = useBrowserState(() => row.value?.session?.processId);
const shownHelp = new Set<string>();
watch(() => browser.value?.help?.requestedAt, (requestedAt) => {
  const processId = row.value?.session?.processId;
  if (!requestedAt || !processId || shownHelp.has(`${processId}:${requestedAt}`)) return;
  shownHelp.add(`${processId}:${requestedAt}`);
  if (peek.value?.kind !== 'browser') peek.value = { kind: 'browser' };
}, { immediate: true });
// A request for a secret opens the session context, where its form waits,
// unless the browser is already asking for the user.
const secrets = useSessionSecrets(() => row.value?.session?.processId);
const shownSecretRequests = new Set<string>();
watch(() => secrets.value?.secrets.filter((secret) => secret.status === 'requested').map((secret) => secret.id) ?? [], (requested) => {
  const fresh = requested.filter((id) => !shownSecretRequests.has(id));
  if (!fresh.length) return;
  for (const id of fresh) shownSecretRequests.add(id);
  if (!peek.value) peek.value = { kind: 'context' };
}, { immediate: true });

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
    else await startBot(bot.id, fresh);
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
