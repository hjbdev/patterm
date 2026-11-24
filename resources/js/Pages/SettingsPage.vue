<template>
  <div class="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#080808] text-foreground">
    <header data-titlebar class="flex h-11 shrink-0 items-center gap-3 px-3">
      <Button variant="ghost" size="icon" class="h-8 w-8 rounded-tab text-muted-foreground" aria-label="Back" @click="goBack">
        <ArrowLeft class="h-4 w-4" />
      </Button>
      <h1 class="min-w-0 flex-1 text-sm font-semibold">Settings</h1>
    </header>

    <main class="mx-1.5 mb-1.5 min-h-0 flex-1 overflow-hidden rounded-xl border-t border-white/5 bg-background">
      <div ref="scroller" class="h-full overflow-y-auto">
        <div class="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pb-10 pt-6 sm:flex-row sm:gap-10 sm:px-6">
          <nav aria-label="Settings" class="flex w-full shrink-0 flex-col gap-3 sm:sticky sm:top-0 sm:w-56 sm:self-start sm:border-r sm:border-white/5 sm:pr-5">
            <div class="relative">
              <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                ref="searchInput"
                v-model="query"
                type="search"
                class="h-8 pl-8 pr-8 text-[13px] [&::-webkit-search-cancel-button]:hidden"
                placeholder="Search settings"
                aria-label="Search settings"
                autocomplete="off"
                spellcheck="false"
                @keydown.esc="query = ''"
              />
              <button v-if="query" type="button" class="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground" aria-label="Clear search" @click="clearSearch">
                <X class="h-3.5 w-3.5" />
              </button>
              <kbd v-else class="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-white/10 px-1.5 font-mono text-[10px] text-muted-foreground sm:block" aria-hidden="true">/</kbd>
            </div>

            <div class="flex flex-row gap-1 overflow-x-auto pb-1 sm:flex-col sm:gap-0 sm:overflow-visible sm:pb-0">
              <template v-for="group in groups" :key="group.label">
                <p class="hidden px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground/70 first:pt-0 sm:block">{{ group.label }}</p>
                <button
                  v-for="item in group.items"
                  :key="item.value"
                  type="button"
                  :aria-current="!searching && tab === item.value ? 'page' : undefined"
                  :class="['settings-nav-item relative flex h-9 shrink-0 items-center gap-2.5 rounded-md px-3 text-left text-[13px] text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground aria-[current=page]:bg-white/[0.07] aria-[current=page]:font-medium aria-[current=page]:text-foreground sm:h-8 sm:w-full', searching && !results[item.value]?.hit ? 'opacity-40 max-sm:hidden' : '']"
                  @click="open(item.value)"
                >
                  <component :is="item.icon" class="h-4 w-4 shrink-0" />
                  <span class="truncate">{{ item.label }}</span>
                  <span v-if="searching && results[item.value]?.hit" class="ml-auto shrink-0 rounded-full bg-white/[0.08] px-1.5 text-[10.5px] tabular-nums text-foreground">{{ results[item.value]?.matches || '•' }}</span>
                  <span v-else-if="!searching && hints[item.value]" class="ml-auto shrink-0 truncate text-[11px] font-normal" :class="hints[item.value]?.tone === 'warning' ? 'text-warning' : 'text-muted-foreground/70'">{{ hints[item.value]?.text }}</span>
                </button>
              </template>
            </div>
          </nav>

          <div class="min-w-0 max-w-3xl flex-1">
            <component :is="activeItem.component" v-if="!searching" :key="activeItem.value" />
            <template v-else>
              <div ref="results$" class="space-y-12">
                <SettingsSearchScope v-for="item in navItems" :key="item.value" :label="item.label" :keywords="item.keywords" @result="(result) => { results[item.value] = result; }">
                  <component :is="item.component" />
                </SettingsSearchScope>
              </div>
              <div v-if="!anyHit" class="py-16 text-center text-xs text-muted-foreground">
                <p class="text-sm text-foreground">No settings match “{{ query.trim() }}”</p>
                <p class="mt-1">Try another word, such as font, push, password, or model.</p>
              </div>
            </template>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type Component } from 'vue';
import { Activity, ArrowLeft, Bell, Bot, ChartColumn, Cpu, History, Info, KeyRound, MessageSquare, Palette, Plug, Search, Server, Shrink, Sparkles, SquareTerminal, Tag, X } from 'lucide-vue-next';
import { Button } from '../Components/ui/button';
import { Input } from '../Components/ui/input';
import AboutSettings from '../Components/AboutSettings.vue';
import AutoSummarySettings from '../Components/AutoSummarySettings.vue';
import BotSettings from '../Components/BotSettings.vue';
import ConversationAppearanceSettings from '../Components/ConversationAppearanceSettings.vue';
import FigureSettings from '../Components/FigureSettings.vue';
import HarnessPresetSettings from '../Components/HarnessPresetSettings.vue';
import HistorySettings from '../Components/HistorySettings.vue';
import HostSettings from '../Components/HostSettings.vue';
import IdleCompactionSettings from '../Components/IdleCompactionSettings.vue';
import LookAndFeelSettings from '../Components/LookAndFeelSettings.vue';
import McpServerSettings from '../Components/McpServerSettings.vue';
import NotificationSettings from '../Components/NotificationSettings.vue';
import ServerAccessSettings from '../Components/ServerAccessSettings.vue';
import StatusLabelSettings from '../Components/StatusLabelSettings.vue';
import TelemetrySettings from '../Components/TelemetrySettings.vue';
import TerminalAppearanceSettings from '../Components/TerminalAppearanceSettings.vue';
import SettingsSearchScope from '../Components/settings/SettingsSearchScope.vue';
import { provideSettingsSearch, searchTerms } from '../Components/settings/settingsSearch';
import { useAppearanceSettings } from '../Composables/useAppearanceSettings';
import { resetSettingsSaveStatus } from '../Composables/useSettingsAutosave';
import { useSettingsNavHints } from '../Composables/useSettingsNavHints';
import { useWorkbenchNavigation } from '../Composables/useWorkbenchNavigation';
import { clearHighlight, highlightTerms } from '../lib/searchHighlight';

interface SettingsItem { value: string; label: string; icon: Component; component: Component; keywords?: string }

// Only the server is reached from browsers; the desktop app has no password.
const serverAccess = Boolean(window.patterm.serverAccess);

// Keywords find a whole page by words its settings don't use.
const GROUPS: Array<{ label: string; items: SettingsItem[] }> = [
  { label: 'Workspace', items: [
    { value: 'look', label: 'Look & feel', icon: Palette, component: LookAndFeelSettings, keywords: 'appearance' },
    { value: 'conversations', label: 'Conversations', icon: MessageSquare, component: ConversationAppearanceSettings, keywords: 'appearance' },
    { value: 'terminal', label: 'Terminal', icon: SquareTerminal, component: TerminalAppearanceSettings, keywords: 'appearance shell' }
  ] },
  { label: 'Agents', items: [
    { value: 'harnesses', label: 'Harnesses', icon: Cpu, component: HarnessPresetSettings, keywords: 'profiles presets models reasoning add profile' },
    { value: 'bots', label: 'Bots', icon: Bot, component: BotSettings, keywords: 'assistant voice add bot' },
    { value: 'summaries', label: 'Auto-summaries', icon: Sparkles, component: AutoSummarySettings, keywords: 'titles' },
    { value: 'compaction', label: 'Idle compaction', icon: Shrink, component: IdleCompactionSettings, keywords: 'cache context' },
    { value: 'status-labels', label: 'Status labels', icon: Tag, component: StatusLabelSettings, keywords: 'add label' },
    { value: 'figures', label: 'Figures', icon: ChartColumn, component: FigureSettings, keywords: 'html charts templates' }
  ] },
  { label: 'Activity', items: [
    { value: 'notifications', label: 'Notifications', icon: Bell, component: NotificationSettings, keywords: 'alerts push' },
    { value: 'history', label: 'Conversation history', icon: History, component: HistorySettings, keywords: 'import resume' }
  ] },
  { label: 'Connections', items: [
    { value: 'mcp', label: 'MCP servers', icon: Plug, component: McpServerSettings, keywords: 'tools integrations add server import' },
    { value: 'hosts', label: 'Hosts', icon: Server, component: HostSettings, keywords: 'pair machines' },
    { value: 'access', label: 'Remote access', icon: KeyRound, component: ServerAccessSettings, keywords: 'tailscale password browser phone' }
  ] },
  { label: 'System', items: [
    { value: 'about', label: 'About', icon: Info, component: AboutSettings, keywords: 'updates version licence' },
    { value: 'telemetry', label: 'Usage telemetry', icon: Activity, component: TelemetrySettings, keywords: 'posthog analytics' }
  ] }
];
const groups = GROUPS
  .map((group) => ({ ...group, items: group.items.filter((item) => item.value !== 'access' || serverAccess) }))
  .filter((group) => group.items.length);
const navItems = groups.flatMap((group) => group.items);

const { router, activeProjectId } = useWorkbenchNavigation();

// Links can open a page directly, such as /settings?tab=notifications. Older
// links name pages that have since moved.
const MOVED_TABS: Record<string, string> = { appearance: 'look', assistant: 'bots' };
const requested = String(router.currentRoute.value.query.tab ?? '');
if (requested === 'assistant') void router.replace({ query: { ...router.currentRoute.value.query, tab: 'bots', bot: 'assistant' } });
const tab = ref(navItems.find((item) => item.value === (MOVED_TABS[requested] ?? requested))?.value ?? 'look');
const activeItem = computed(() => navItems.find((item) => item.value === tab.value) ?? navItems[0]!);

resetSettingsSaveStatus();
// Each visit starts from the saved appearance settings.
void useAppearanceSettings().reload();
const hints = useSettingsNavHints({ serverAccess });

const query = ref('');
provideSettingsSearch(query);
const terms = computed(() => searchTerms(query.value));
const searching = computed(() => terms.value.length > 0);
const results = reactive<Record<string, { hit: boolean; matches: number }>>({});
const anyHit = computed(() => navItems.some((item) => results[item.value]?.hit));
const scroller = ref<HTMLElement | null>(null);
const searchInput = ref<{ $el?: HTMLElement } | null>(null);
const results$ = ref<HTMLElement | null>(null);

function open(value: string): void {
  query.value = '';
  tab.value = value;
  scroller.value?.scrollTo({ top: 0 });
}

function clearSearch(): void {
  query.value = '';
  focusSearch();
}

function focusSearch(): void {
  const el = searchInput.value?.$el;
  (el instanceof HTMLInputElement ? el : el?.querySelector('input'))?.focus();
}

watch(searching, (now) => {
  if (!now) for (const key of Object.keys(results)) delete results[key];
  scroller.value?.scrollTo({ top: 0 });
});

// Panels load their data after they mount, so marks follow their text.
const HIGHLIGHT = 'settings-search';
let marking = 0;
function mark(): void {
  cancelAnimationFrame(marking);
  marking = requestAnimationFrame(() => highlightTerms(searching.value ? results$.value : null, terms.value, HIGHLIGHT));
}
const observer = new MutationObserver(mark);
watch(results$, (el) => {
  observer.disconnect();
  if (el) observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'hidden'] });
});
watch(terms, () => void nextTick(mark));

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
  event.preventDefault();
  focusSearch();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  observer.disconnect();
  cancelAnimationFrame(marking);
  clearHighlight(HIGHLIGHT);
});

function goBack(): void {
  // Vue Router records the previous in-app path in history.state.back.
  if (typeof window.history.state?.back === 'string') {
    router.back();
  } else if (activeProjectId.value) {
    void router.push({ name: 'project', params: { projectId: activeProjectId.value } });
  } else {
    void router.push({ name: 'projects' });
  }
}
</script>

<style scoped>
.settings-nav-item[aria-current='page']::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  height: 1rem;
  width: 2px;
  transform: translateY(-50%);
  border-radius: 9999px;
  background-color: rgb(255 255 255 / 0.75);
}
</style>
