import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue';
import { useWorkbench } from './useWorkbench';
import { launchableHarnesses } from '../lib/harnesses';
import { harnessPresets, latestQueryData, topicCall } from '../lib/serverQuery';
import {
  conversationRows,
  paletteTimers,
  resumableConversations,
  searchRows,
  timerRows,
  type HarnessPreset,
  type LaunchChoice,
  type WorkspaceSearchResult
} from '../lib/paletteSources';
import type { ConversationRecord } from '../types';

const RECENT_CONVERSATIONS = 20;
const SEARCH_LIMIT = 8;
const SEARCH_DEBOUNCE_MS = 200;
const LAST_HARNESS_KEY = 'patterm.palette.lastHarness';

interface PresetSettings {
  presets: HarnessPreset[];
  defaultPresetIdByHarness: Record<string, string | null | undefined>;
}

// What the palette reads while it is open: launch choices, recent
// conversations, timers, and workspace search results.
export function usePaletteSources(options: { open: Ref<boolean>; projectId: Ref<string | null>; query: Ref<string>; searchEnabled: Ref<boolean> }) {
  const { projects, harnesses } = useWorkbench();
  const presetSettings = ref<PresetSettings>(latestQueryData<PresetSettings>(['harness_presets']) ?? { presets: [], defaultPresetIdByHarness: {} });
  const launch = reactive<LaunchChoice>({ harness: '', presetId: null, worktreeId: null, prompt: '' });
  const launchHarnesses = computed(() => launchableHarnesses(harnesses.value));
  const launchPresets = computed(() => presetsFor(launch.harness));
  const launchWorktrees = computed(() => projects.value.find((project) => project.project.id === options.projectId.value)?.worktrees ?? []);
  const conversations = ref<ConversationRecord[]>([]);
  const searchResults = ref<WorkspaceSearchResult[]>([]);
  const searching = ref(false);
  const now = ref(Date.now());
  let clock: ReturnType<typeof setInterval> | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchToken = 0;
  let conversationToken = 0;

  const timers = computed(() => options.open.value ? paletteTimers(projects.value) : []);

  watch(options.open, (isOpen) => {
    if (!isOpen) {
      stopClock();
      return;
    }
    now.value = Date.now();
    resetLaunch();
    void loadLaunchSettings();
    void loadConversations();
  }, { immediate: true });
  // Tick every 15s only while the palette is open and timers exist, so the
  // open palette does not re-rank its full command list every second.
  watch(() => options.open.value && timers.value.length > 0, (needsClock) => {
    if (needsClock) {
      now.value = Date.now();
      clock ??= setInterval(() => { now.value = Date.now(); }, 15_000);
    } else {
      stopClock();
    }
  }, { immediate: true });
  watch(options.projectId, () => {
    if (options.open.value) void loadConversations();
  });
  watch([options.query, options.searchEnabled, options.open], () => {
    if (searchTimer) clearTimeout(searchTimer);
    const text = options.query.value.trim();
    if (!options.open.value || !options.searchEnabled.value || text.length < 2) {
      ++searchToken;
      searchResults.value = [];
      searching.value = false;
      return;
    }
    searching.value = true;
    searchTimer = setTimeout(() => void search(text), SEARCH_DEBOUNCE_MS);
  });
  onBeforeUnmount(() => {
    stopClock();
    if (searchTimer) clearTimeout(searchTimer);
  });

  function stopClock(): void {
    if (clock) clearInterval(clock);
    clock = null;
  }

  function lastHarness(): string | null {
    try {
      return window.localStorage.getItem(LAST_HARNESS_KEY);
    } catch {
      return null;
    }
  }

  // Remembered so the next launch offers the same agent first.
  function rememberHarness(harness: string): void {
    try {
      window.localStorage.setItem(LAST_HARNESS_KEY, harness);
    } catch { /* The default stays Claude Code. */ }
  }

  function presetsFor(harness: string): HarnessPreset[] {
    return presetSettings.value.presets.filter((preset) => preset.harness === harness);
  }

  function defaultPreset(harness: string): string | null {
    const id = presetSettings.value.defaultPresetIdByHarness[harness];
    return id && presetsFor(harness).some((preset) => preset.id === id) ? id : null;
  }

  function chooseHarness(harness: string): void {
    if (launch.harness === harness) return;
    launch.harness = harness;
    launch.presetId = defaultPreset(harness);
  }

  // Each opening starts from the defaults: the agent launched last (or Claude
  // Code), its default preset, and the project directory.
  function resetLaunch(): void {
    const available = launchHarnesses.value.map((item) => item.harness);
    const harness = [lastHarness(), 'claude', available[0]].find((candidate): candidate is string => Boolean(candidate && available.includes(candidate))) ?? '';
    launch.harness = harness;
    launch.presetId = defaultPreset(harness);
    launch.worktreeId = null;
    launch.prompt = '';
  }

  async function loadLaunchSettings(): Promise<void> {
    try {
      const presets = await harnessPresets<PresetSettings>();
      if (presets) presetSettings.value = presets;
    } catch { /* Presets are optional. */ }
    resetLaunch();
  }

  async function loadConversations(): Promise<void> {
    const token = ++conversationToken;
    const projectId = options.projectId.value;
    if (!projectId) {
      conversations.value = [];
      return;
    }
    const cached = latestQueryData<{ conversations?: ConversationRecord[] }>(['history_list', { project_id: projectId, limit: RECENT_CONVERSATIONS }]);
    if (cached?.conversations) conversations.value = cached.conversations;
    try {
      const result = await topicCall<{ conversations?: ConversationRecord[] }>('history', 'history_list', { project_id: projectId, limit: RECENT_CONVERSATIONS });
      if (token === conversationToken) conversations.value = result.conversations ?? [];
    } catch {
      // The palette still works without recent conversations.
      if (token === conversationToken && !cached?.conversations) conversations.value = [];
    }
  }

  async function search(text: string): Promise<void> {
    const token = ++searchToken;
    try {
      const result = await window.patterm.call('search', { query: text, limit: SEARCH_LIMIT }) as { results?: WorkspaceSearchResult[] };
      if (token === searchToken) searchResults.value = result.results ?? [];
    } catch {
      if (token === searchToken) searchResults.value = [];
    } finally {
      if (token === searchToken) searching.value = false;
    }
  }

  const conversationCommands = computed(() => options.open.value ? conversationRows(resumableConversations(conversations.value, options.projectId.value), now.value) : []);
  const timerCommands = computed(() => options.open.value ? timerRows(timers.value, now.value, options.projectId.value) : []);
  // Live agents are already listed, so search adds only what the list lacks.
  const liveSessionIds = computed(() => options.open.value ? new Set(projects.value.flatMap((project) => project.projectSessions.filter((session) => !session.exitedAt).map((session) => session.id))) : new Set<string>());
  const searchCommands = computed(() => options.open.value ? searchRows(searchResults.value.filter((result) => !(result.kind === 'session' && liveSessionIds.value.has(result.owner_id)))) : []);

  return { launch, launchHarnesses, launchPresets, launchWorktrees, presetSettings, chooseHarness, rememberHarness, presetsFor, conversationCommands, timers, timerCommands, searchCommands, searching, now };
}

export type PaletteSources = ReturnType<typeof usePaletteSources>;
