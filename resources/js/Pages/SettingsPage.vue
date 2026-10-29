<template>
  <div class="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#080808] text-foreground">
    <header class="flex h-11 shrink-0 items-center gap-3 px-3">
      <Button variant="ghost" size="icon" class="h-8 w-8 rounded-tab text-muted-foreground" aria-label="Back" @click="goBack">
        <ArrowLeft class="h-4 w-4" />
      </Button>
      <h1 class="min-w-0 flex-1 text-sm font-semibold">Settings</h1>
      <AssistantButton />
    </header>

    <main class="mx-1.5 mb-1.5 min-h-0 flex-1 overflow-hidden rounded-xl border-t border-white/5 bg-background">
      <div class="h-full overflow-y-auto">
        <div class="mx-auto w-full max-w-5xl px-4 pb-10 pt-6 sm:px-6">
          <Tabs v-model="tab" orientation="vertical" class="flex flex-col gap-4 sm:flex-row sm:gap-10">
            <TabsList class="flex w-full shrink-0 flex-row items-stretch justify-start gap-1 overflow-x-auto rounded-none border-b border-white/5 bg-transparent p-0 pb-3 sm:w-56 sm:flex-col sm:self-start sm:border-b-0 sm:border-r sm:pb-0 sm:pr-5">
              <TabsTrigger v-for="item in navItems" :key="item.value" :value="item.value" :class="navItemClass">
                <span class="flex w-full items-center gap-2.5">
                  <component :is="item.icon" class="h-4 w-4 shrink-0" />
                  <span class="truncate">{{ item.label }}</span>
                </span>
              </TabsTrigger>
            </TabsList>

            <div class="min-w-0 max-w-3xl flex-1">
              <TabsContent value="appearance" class="m-0">
                <SettingsPanel title="Appearance" description="Navigation, fonts, terminal layout, and diff review. Changes apply as soon as you make them.">
                  <p v-if="loadError" role="alert" class="text-xs text-destructive">{{ loadError }}</p>
                  <SettingsSection title="Navigation" description="Where a project’s agents and processes are listed." scope="appearance.navigation">
                    <!-- One description for both choices, so switching never changes the row's height; the preview shows the difference. -->
                    <SettingsRow label="Layout" description="Tabs along the top bar, or a tree beside the workspace." html-for="navigation-layout" save-key="appearance.navigation.layout">
                      <SettingsChoice id="navigation-layout" :model-value="draft.navigation" :options="NAVIGATION_OPTIONS" aria-label="Agent navigation" segmented @update:model-value="(value) => { draft.navigation = value; void saveAppearance('appearance.navigation.layout'); }" />
                    </SettingsRow>
                    <NavigationPreview :layout="draft.navigation" />
                    <SettingsRow label="Personal project" description="List a project for agents outside any repository. Turned off, it still shows while something runs there." html-for="personal-project" save-key="appearance.navigation.personal" toggle>
                      <Switch id="personal-project" :model-value="draft.personalProject" @update:model-value="(value) => { draft.personalProject = value; void saveAppearance('appearance.navigation.personal'); }" />
                    </SettingsRow>
                    <SettingsRow label="Recent projects" description="Show the last few projects you visited beside the project switcher." html-for="recent-projects" save-key="appearance.navigation.recent" toggle>
                      <Switch id="recent-projects" :model-value="draft.recentProjects" @update:model-value="(value) => { draft.recentProjects = value; void saveAppearance('appearance.navigation.recent'); }" />
                    </SettingsRow>
                  </SettingsSection>

                  <SettingsSection title="Interface" description="Font for tabs, menus, and project views." scope="appearance.interface">
                    <SettingsRow label="Font" html-for="ui-font-preset" save-key="appearance.interface.font">
                      <SettingsChoice id="ui-font-preset" :model-value="draft.uiFont.preset" :options="UI_FONT_OPTIONS" aria-label="Interface font" @update:model-value="(value) => { draft.uiFont.preset = value; void saveAppearance('appearance.interface.font'); }" />
                      <template v-if="draft.uiFont.preset === 'custom'" #below>
                        <Input id="ui-font-custom" :model-value="draft.uiFont.customFamily" class="h-8 text-xs sm:max-w-sm" placeholder="Aptos, ui-sans-serif, system-ui" aria-label="Custom interface font family" @update:model-value="(value) => { draft.uiFont.customFamily = String(value); saveAfterTyping('appearance.interface.font'); }" @blur="flushTyping" />
                      </template>
                    </SettingsRow>
                    <div class="rounded-lg bg-white/[0.03] px-3 py-3" :style="{ fontFamily: uiPreviewFamily }">
                      <p class="text-sm">A space for your next idea.</p>
                      <p class="mt-1 text-xs text-muted-foreground">Projects, agents, and everything in between.</p>
                    </div>
                  </SettingsSection>

                  <SettingsSection title="Terminal" description="Fonts are bundled with Patterm, except the installed Nerd Font option, which falls back to JetBrains Mono. Custom uses fonts installed on this device. Font changes resize running terminals." scope="appearance.terminal">
                    <SettingsRow label="Font" html-for="terminal-font-preset" save-key="appearance.terminal.font">
                      <SettingsChoice id="terminal-font-preset" :model-value="draft.terminalFont.preset" :options="TERMINAL_FONT_OPTIONS" aria-label="Terminal font" @update:model-value="(value) => { draft.terminalFont.preset = value; void saveAppearance('appearance.terminal.font'); }" />
                      <template v-if="draft.terminalFont.preset === 'custom'" #below>
                        <Input id="terminal-font-custom" :model-value="draft.terminalFont.customFamily" class="h-8 text-xs sm:max-w-sm" placeholder="Iosevka Nerd Font, monospace" aria-label="Custom terminal font family" @update:model-value="(value) => { draft.terminalFont.customFamily = String(value); saveAfterTyping('appearance.terminal.font'); }" @blur="flushTyping" />
                      </template>
                    </SettingsRow>
                    <SettingsRow label="Font size" description="From 10 to 24 px." html-for="terminal-font-size" save-key="appearance.terminal.size">
                      <div class="flex items-center gap-2">
                        <Input id="terminal-font-size" :model-value="terminalFontSizeText" class="h-8 w-20 text-xs" type="number" min="10" max="24" inputmode="numeric" :aria-invalid="Boolean(fontSizeError)" @update:model-value="(value) => { terminalFontSizeText = String(value); saveAfterTyping('appearance.terminal.size'); }" @blur="flushTyping" />
                        <span class="text-xs text-muted-foreground">px</span>
                      </div>
                      <template v-if="fontSizeError" #below>
                        <p role="alert" class="text-xs text-destructive">{{ fontSizeError }}</p>
                      </template>
                    </SettingsRow>
                    <div class="rounded-lg bg-black/30 px-3 py-3 text-sm" :style="{ fontFamily: terminalPreviewFamily }">
                      <p><span class="text-muted-foreground">❯</span> pnpm run dev</p>
                      <p class="mt-1 text-muted-foreground">Ready when you are.</p>
                    </div>
                    <SettingsRow label="Centre terminals" description="Limit terminals to 960 px wide and centre them. Turn off to use the full width." html-for="terminal-container" save-key="appearance.terminal.container" toggle>
                      <Switch id="terminal-container" :model-value="draft.terminalContainer" @update:model-value="(value) => { draft.terminalContainer = value; void saveAppearance('appearance.terminal.container'); }" />
                    </SettingsRow>
                  </SettingsSection>

                  <SettingsSection title="Diff review" description="How a worktree’s changes open from the session sidebar." scope="appearance.diff">
                    <SettingsRow label="Layout" :description="DIFF_VIEWER_OPTIONS.find((option) => option.value === draft.diffViewer)?.description ?? ''" html-for="diff-viewer-layout" save-key="appearance.diff.layout">
                      <SettingsChoice id="diff-viewer-layout" :model-value="draft.diffViewer" :options="DIFF_VIEWER_OPTIONS" aria-label="Diff review layout" segmented @update:model-value="(value) => { draft.diffViewer = value; void saveAppearance('appearance.diff.layout'); }" />
                    </SettingsRow>
                  </SettingsSection>

                  <SettingsSection title="This device" description="Saved in this browser only." scope="appearance.device">
                    <SettingsRow label="Prefetch conversations" :description="PREFETCH_OPTIONS.find((option) => option.value === prefetch)?.description ?? ''" html-for="prefetch-conversations">
                      <SettingsChoice id="prefetch-conversations" :model-value="prefetch" :options="PREFETCH_OPTIONS" aria-label="Prefetch conversations" segmented @update:model-value="(value) => { prefetch = value; setPrefetchPreference(value); }" />
                    </SettingsRow>
                  </SettingsSection>
                </SettingsPanel>
              </TabsContent>

              <TabsContent value="history" class="m-0">
                <SettingsPanel title="Conversation history" description="Import conversations from agent CLIs so you can search and resume them.">
                  <SettingsSection title="Sources" description="Enabled sources import automatically." scope="history.sources" list>
                    <template #actions>
                      <DropdownMenu>
                        <DropdownMenuTrigger as-child>
                          <Button type="button" size="sm" variant="outline" :disabled="historyBusy">
                            Add source
                            <ChevronDown class="ml-1 h-3.5 w-3.5 opacity-60" aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" class="w-44">
                          <DropdownMenuItem v-for="provider in HISTORY_PROVIDERS" :key="provider" class="text-xs" @select="addHistoryPath(provider)">
                            <AgentIcon :harness="provider" class="mr-2 h-3.5 w-3.5" />
                            {{ providerLabel(provider) }}…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </template>
                    <SettingsItem v-for="source in historySources" :key="`${source.provider}:${source.path}`" :save-key="sourceKey(source)" :muted="!source.enabled">
                      <template #icon><AgentIcon :harness="source.provider" class="h-4 w-4" /></template>
                      <template #title>
                        {{ providerLabel(source.provider) }}
                        <span v-if="!source.exists" class="text-[11px] font-normal text-warning">Missing</span>
                      </template>
                      <template #meta><span :title="source.path">{{ source.path }}</span></template>
                      <template #control>
                        <Switch :model-value="Boolean(source.enabled)" :disabled="historyBusy" :aria-label="`Import from ${providerLabel(source.provider)} at ${source.path}`" @update:model-value="toggleHistorySource(source)" />
                      </template>
                    </SettingsItem>
                    <p v-if="!historySources.length" class="px-3.5 py-3 text-xs text-muted-foreground">No history sources discovered.</p>
                  </SettingsSection>

                  <SettingsSection title="Import" scope="history.import">
                    <SettingsRow label="Import now" description="Import new conversations from every enabled source.">
                      <Button type="button" size="sm" variant="outline" :disabled="historyBusy" @click="importHistoryNow">{{ historyBusy ? 'Importing…' : 'Import now' }}</Button>
                      <template v-if="historyStatus.batches.length || historyStatus.files.length" #below>
                        <details class="text-xs">
                          <summary class="cursor-pointer text-muted-foreground">Recent import results</summary>
                          <div class="mt-2 space-y-1.5 rounded-md bg-black/20 p-3 text-[11px] text-muted-foreground">
                            <p v-for="batch in historyStatus.batches.slice(0, 3)" :key="batch.id">{{ batch.status }} · {{ batch.conversationsImported }} conversations · {{ batch.errorCount }} errors</p>
                            <p v-for="file in historyStatus.files.slice(0, 3)" :key="file.id" class="truncate text-warning" :title="file.path">{{ file.status }} · {{ file.path }}</p>
                          </div>
                        </details>
                      </template>
                    </SettingsRow>
                    <SettingsRow label="Import notifications" description="Notify when imports start, complete, or fail." html-for="history-import-toasts" save-key="history.import.toasts" toggle>
                      <Switch id="history-import-toasts" :model-value="draft.historyImportToasts" @update:model-value="(value) => { draft.historyImportToasts = value; void saveAppearance('history.import.toasts'); }" />
                    </SettingsRow>
                    <SettingsRow label="Reset imported history" description="Clear imported conversations and import enabled sources again. Provider history files are not touched.">
                      <Button type="button" size="sm" variant="outline" class="text-destructive hover:text-destructive" :disabled="historyBusy" @click="resetAndReimportHistory">Reset and re-import…</Button>
                    </SettingsRow>
                  </SettingsSection>

                  <SemanticSearchSettings />
                  <p v-if="historyError" role="alert" class="text-xs text-destructive">{{ historyError }}</p>
                </SettingsPanel>
              </TabsContent>

              <TabsContent value="summaries" class="m-0">
                <AutoSummarySettings />
              </TabsContent>

              <TabsContent value="notifications" class="m-0">
                <NotificationSettings />
              </TabsContent>

              <TabsContent value="assistant" class="m-0">
                <AssistantSettings />
              </TabsContent>

              <TabsContent value="compaction" class="m-0">
                <IdleCompactionSettings />
              </TabsContent>

              <TabsContent value="figures" class="m-0">
                <FigureSettings />
              </TabsContent>

              <TabsContent value="harnesses" class="m-0">
                <HarnessPresetSettings />
              </TabsContent>

              <TabsContent value="mcp" class="m-0">
                <McpServerSettings />
              </TabsContent>

              <TabsContent value="hosts" class="m-0">
                <HostSettings />
              </TabsContent>

              <TabsContent v-if="serverAccess" value="access" class="m-0">
                <ServerAccessSettings />
              </TabsContent>

              <TabsContent value="about" class="m-0">
                <AboutSettings />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import AssistantButton from '../Components/Assistant/AssistantButton.vue';
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import { ArrowLeft, AudioLines, Bell, ChartColumn, ChevronDown, History, Info, KeyRound, Palette, Plug, Server, Shrink, Smile, Sparkles } from 'lucide-vue-next';
import {
  DIFF_VIEWER_OPTIONS,
  NAVIGATION_OPTIONS,
  UI_FONT_OPTIONS,
  TERMINAL_FONT_OPTIONS,
  applyUiFont,
  dispatchAppearanceSettingsChanged,
  normalizeAppearanceSettings,
  resolveTerminalFontFamily,
  resolveUiFontFamily,
  type AppearanceSettings
} from '../appearance/AppearanceSettings';
import { Button } from '../Components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../Components/ui/dropdown-menu';
import { Input } from '../Components/ui/input';
import { Switch } from '../Components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../Components/ui/tabs';
import AboutSettings from '../Components/AboutSettings.vue';
import AgentIcon from '../Components/AgentIcon.vue';
import AutoSummarySettings from '../Components/AutoSummarySettings.vue';
import SemanticSearchSettings from '../Components/SemanticSearchSettings.vue';
import FigureSettings from '../Components/FigureSettings.vue';
import HarnessPresetSettings from '../Components/HarnessPresetSettings.vue';
import IdleCompactionSettings from '../Components/IdleCompactionSettings.vue';
import AssistantSettings from '../Components/AssistantSettings.vue';
import McpServerSettings from '../Components/McpServerSettings.vue';
import NavigationPreview from '../Components/settings/NavigationPreview.vue';
import HostSettings from '../Components/HostSettings.vue';
import ServerAccessSettings from '../Components/ServerAccessSettings.vue';
import NotificationSettings from '../Components/NotificationSettings.vue';
import SettingsChoice from '../Components/settings/SettingsChoice.vue';
import { prefetchPreference, setPrefetchPreference, type PrefetchPreference } from '../lib/prefetch';
import SettingsItem from '../Components/settings/SettingsItem.vue';
import SettingsPanel from '../Components/settings/SettingsPanel.vue';
import SettingsRow from '../Components/settings/SettingsRow.vue';
import SettingsSection from '../Components/settings/SettingsSection.vue';
import { autosave, resetSettingsSaveStatus } from '../Composables/useSettingsAutosave';
import { useWorkbenchNavigation } from '../Composables/useWorkbenchNavigation';

const { router, activeProjectId } = useWorkbenchNavigation();

// Read ahead on this device. Context always prefetches; conversations follow
// this, and on Automatic, the connection.
const PREFETCH_OPTIONS: Array<{ value: PrefetchPreference; label: string; description: string }> = [
  { value: 'auto', label: 'Automatic', description: 'Fast connections read running agents’ conversations ahead. Mobile data reads the open project’s, a little at a time. Slow connections and data saver read none.' },
  { value: 'always', label: 'Always', description: 'Read running agents’ conversations ahead on any connection.' },
  { value: 'never', label: 'Never', description: 'Conversations load when you open them.' }
];
const prefetch = ref<PrefetchPreference>(prefetchPreference());

const NAV = [
  { value: 'appearance', label: 'Appearance', icon: Palette },
  { value: 'history', label: 'Conversation history', icon: History },
  { value: 'summaries', label: 'Auto-summaries', icon: Sparkles },
  { value: 'notifications', label: 'Notifications', icon: Bell },
  { value: 'assistant', label: 'Assistant', icon: AudioLines },
  { value: 'compaction', label: 'Idle compaction', icon: Shrink },
  { value: 'figures', label: 'Figures', icon: ChartColumn },
  { value: 'harnesses', label: 'Profiles', icon: Smile },
  { value: 'mcp', label: 'MCP servers', icon: Plug },
  { value: 'hosts', label: 'Hosts', icon: Server },
  { value: 'access', label: 'Remote access', icon: KeyRound },
  { value: 'about', label: 'About', icon: Info }
] as const;
type SettingsTab = typeof NAV[number]['value'];
// Only the server is reached from browsers; the desktop app has no password.
const serverAccess = Boolean(window.patterm.serverAccess);
const navItems = NAV.filter((item) => item.value !== 'access' || serverAccess);
// Links can open a tab directly, such as /settings?tab=notifications.
const requestedTab = router.currentRoute.value.query.tab;
const tab = ref<SettingsTab>(navItems.find((item) => item.value === requestedTab)?.value ?? 'appearance');
const navItemClass = 'settings-nav-item group relative flex h-9 w-auto shrink-0 items-center rounded-md px-3 text-[13px] font-normal text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground data-[state=active]:bg-white/[0.07] data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none sm:w-full';

resetSettingsSaveStatus();

const draft = reactive<AppearanceSettings>(normalizeAppearanceSettings(null));
const terminalFontSizeText = ref(String(draft.terminalFontSizePx));
const fontSizeError = ref('');
const loadError = ref('');

const uiPreviewFamily = computed(() => resolveUiFontFamily(draft));
const terminalPreviewFamily = computed(() => resolveTerminalFontFamily(draft));

void load();

async function load(): Promise<void> {
  loadError.value = '';
  try {
    const settings = normalizeAppearanceSettings((await window.patterm.appearanceSettings()) as Partial<AppearanceSettings> | null);
    assignDraft(settings);
    applyUiFont(settings);
  } catch (caught) {
    loadError.value = caught instanceof Error ? caught.message : String(caught);
  }
  await loadHistorySettings();
}

// Each save sends the whole draft. A response only replaces the draft when no
// newer change was made while it was in flight, so typing is never undone.
let appearanceRevision = 0;

async function saveAppearance(key: string): Promise<void> {
  const terminalFontSizePx = Number(terminalFontSizeText.value);
  if (!Number.isFinite(terminalFontSizePx) || terminalFontSizePx < 10 || terminalFontSizePx > 24) {
    fontSizeError.value = 'Use a size from 10 to 24.';
    return;
  }
  fontSizeError.value = '';
  const revision = ++appearanceRevision;
  await autosave(key, async () => {
    const response = await window.patterm.appearanceSettingsUpdate(normalizeAppearanceSettings({ ...draft, terminalFontSizePx }));
    if (!response) throw new Error('Settings were not saved.');
    const saved = normalizeAppearanceSettings(response as Partial<AppearanceSettings>);
    applyUiFont(saved);
    dispatchAppearanceSettingsChanged(saved);
    if (revision === appearanceRevision) assignDraft(saved);
  });
}

// Typed values save after a pause, or straight away when the field loses focus.
let typingTimer: ReturnType<typeof setTimeout> | undefined;
let typingKey = '';

function saveAfterTyping(key: string): void {
  clearTimeout(typingTimer);
  typingKey = key;
  typingTimer = setTimeout(flushTyping, 600);
}

function flushTyping(): void {
  if (!typingTimer) return;
  clearTimeout(typingTimer);
  typingTimer = undefined;
  void saveAppearance(typingKey);
}

onBeforeUnmount(flushTyping);

function assignDraft(settings: AppearanceSettings): void {
  draft.uiFont.preset = settings.uiFont.preset;
  draft.uiFont.customFamily = settings.uiFont.customFamily;
  draft.terminalFont.preset = settings.terminalFont.preset;
  draft.terminalFont.customFamily = settings.terminalFont.customFamily;
  draft.terminalFontSizePx = settings.terminalFontSizePx;
  draft.terminalContainer = settings.terminalContainer;
  draft.historyImportToasts = settings.historyImportToasts;
  draft.diffViewer = settings.diffViewer;
  draft.navigation = settings.navigation;
  draft.personalProject = settings.personalProject;
  draft.recentProjects = settings.recentProjects;
  terminalFontSizeText.value = String(settings.terminalFontSizePx);
}

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

const HISTORY_PROVIDERS: HistoryProvider[] = ['claude', 'codex', 'opencode'];
const historyBusy = ref(false);
const historyError = ref('');
const historySources = ref<HistorySource[]>([]);
const historyStatus = ref<HistoryStatus>({ batches: [], files: [] });

async function loadHistorySettings(): Promise<void> {
  const [sourcesResponse, statusResponse] = await Promise.all([
    window.patterm.call('history_sources', {}) as Promise<{ sources?: HistorySource[] }>,
    window.patterm.call('history_import_status', {}) as Promise<HistoryStatus>
  ]);
  historySources.value = sourcesResponse.sources ?? [];
  historyStatus.value = statusResponse ?? { batches: [], files: [] };
}

function sourceKey(source: HistorySource): string {
  return `history.sources.${source.provider}:${source.path}`;
}

async function addHistoryPath(provider: HistoryProvider): Promise<void> {
  const selected = await window.patterm.pickFileOrDirectory();
  if (!selected) return;
  historyBusy.value = true;
  try {
    await autosave(`history.sources.${provider}:${selected}`, async () => {
      await window.patterm.call('history_configure', { provider, path: selected, enabled: true, watch_enabled: true });
      await loadHistorySettings();
    });
  } finally {
    historyBusy.value = false;
  }
}

async function toggleHistorySource(source: HistorySource): Promise<void> {
  if (historyBusy.value) return;
  historyBusy.value = true;
  try {
    await autosave(sourceKey(source), async () => {
      await window.patterm.call('history_configure', {
        provider: source.provider,
        path: source.path,
        source_kind: source.sourceKind,
        enabled: !source.enabled,
        watch_enabled: !source.enabled
      });
      await loadHistorySettings();
    });
  } finally {
    historyBusy.value = false;
  }
}

async function importHistoryNow(): Promise<void> {
  historyBusy.value = true;
  historyError.value = '';
  try {
    await window.patterm.call('history_import', { trigger: 'manual' });
    await loadHistorySettings();
  } catch (caught) {
    historyError.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    historyBusy.value = false;
  }
}

async function resetAndReimportHistory(): Promise<void> {
  if (!window.confirm('Clear local imported conversation history and re-import enabled sources? Provider history files will not be touched.')) return;
  historyBusy.value = true;
  historyError.value = '';
  try {
    await window.patterm.call('history_reset_imports', { reimport: true });
    await loadHistorySettings();
  } catch (caught) {
    historyError.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    historyBusy.value = false;
  }
}

type HistoryProvider = 'claude' | 'codex' | 'opencode';

function providerLabel(provider: HistoryProvider): string {
  return { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }[provider];
}

interface HistorySource {
  provider: HistoryProvider;
  sourceKind: string;
  path: string;
  exists: boolean;
  enabled?: boolean;
  watch_enabled?: boolean;
}

interface HistoryStatus {
  batches: Array<{ id: string; status: string; conversationsImported: number; errorCount: number }>;
  files: Array<{ id: string; status: string; path: string }>;
}
</script>

<style scoped>
.settings-nav-item :deep(> span) {
  display: flex;
  width: 100%;
  align-items: center;
}

.settings-nav-item[data-state='active']::before {
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
