import { computed, ref, shallowRef, watch, type ComputedRef } from 'vue';
import { botHidden, botRows, readBots, type Bot, type BotRow, type BotSettings } from '../lib/bots';
import type { SessionRecord } from '../types';
import { topicGeneration } from '../lib/serverQuery';
import { useWorkbench } from './useWorkbench';

// Shared across components: the bots in settings, read again when settings change.
const settings = shallowRef<BotSettings>({ bots: [], userName: null });
// Paired hosts' bots, which list after this host's.
const remote = shallowRef<Bot[]>([]);
// GPT-Live voices the server offers.
const voices = shallowRef<string[]>([]);
// Whether the first read has finished, so callers can tell no bots from not yet known.
const loaded = ref(false);

let loadInFlight: Promise<void> | null = null;
let loadPending = false;

async function load(): Promise<void> {
  loadPending = true;
  if (loadInFlight) return loadInFlight;
  loadInFlight = (async () => {
    do {
      loadPending = false;
      try {
        const result = await readBots();
        settings.value = { bots: result.bots ?? [], userName: result.userName ?? null };
        remote.value = result.remote ?? [];
        voices.value = result.voices ?? [];
      } catch {
        // Without the list, the sidebar simply shows no bots.
      } finally {
        loaded.value = true;
      }
    } while (loadPending);
  })().finally(() => { loadInFlight = null; });
  return loadInFlight;
}

const SHOW_BOT_AGENTS_KEY = 'patterm.showBotAgents.v1';

// Whether agents a bot started list in their project's sidebar and tabs,
// remembered on this device. Shown by default.
export const showBotAgents = ref(readShowBotAgents());

export function setShowBotAgents(value: boolean): void {
  showBotAgents.value = value;
  try {
    localStorage.setItem(SHOW_BOT_AGENTS_KEY, String(value));
  } catch {
    // Kept for this session only.
  }
}

function readShowBotAgents(): boolean {
  try {
    return localStorage.getItem(SHOW_BOT_AGENTS_KEY) !== 'false';
  } catch {
    return true;
  }
}

const allBots = computed(() => [...settings.value.bots, ...remote.value]);
const botsById = computed(() => new Map(allBots.value.map((bot) => [bot.id, bot])));

// The bot that started an agent, such as a detached agent it opened, for
// rows that carry its face. Reads the shared list without loading it. A
// paired host's agents name its bots by qualified ID, so they find its bots.
export function ownerBotOf(session: SessionRecord): Bot | null {
  return session.ownerBotId ? botsById.value.get(session.ownerBotId) ?? null : null;
}

// Module-level shared reactive graph so all callers (WorkbenchLayout,
// WorkbenchTopBar, TerminalPage, BotPage, ProjectsPage) share one scan and one
// settings topic subscription.
let shared: {
  rows: ComputedRef<BotRow[]>;
  hidden: ComputedRef<ReturnType<typeof botHidden>>;
  uncounted: ComputedRef<ReturnType<typeof botHidden>>;
} | null = null;

function ensureShared() {
  if (shared) return shared;
  const { projects, botProjects, assistantProject, remoteAssistantProjects } = useWorkbench();
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  watch(() => topicGeneration('settings'), () => {
    reloadTimer ??= setTimeout(() => {
      reloadTimer = null;
      void load();
    }, 50);
  });
  shared = {
    // Every bot, the assistant first while it is on, then paired hosts'.
    rows: computed(() => botRows({ ...settings.value, bots: allBots.value }, projects.value, [
      ...(assistantProject.value ? [assistantProject.value] : []), ...botProjects.value, ...remoteAssistantProjects.value
    ])),
    // What agent lists leave out: bot sessions, and their helpers too while
    // you hide agents started by bots. The assistant's agents list with
    // everyone else's.
    hidden: computed(() => botHidden(projects.value, botProjects.value, { helpers: !showBotAgents.value })),
    // What agent counts leave out: only the bots' own sessions. Helpers count
    // as their project's agents even while hidden.
    uncounted: computed(() => botHidden(projects.value, botProjects.value, { helpers: false }))
  };
  void load();
  return shared;
}

// Call during a component's setup.
export function useBots() {
  const { rows, hidden, uncounted } = ensureShared();
  return {
    settings,
    // This host's bots and paired hosts'.
    all: allBots,
    voices,
    loaded,
    rows,
    hidden,
    uncounted,
    reload: load
  };
}
