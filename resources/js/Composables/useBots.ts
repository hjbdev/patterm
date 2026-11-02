import { computed, ref } from 'vue';
import { botHidden, botRows, readBots, type Bot, type BotSettings } from '../lib/bots';
import type { SessionRecord } from '../types';
import { useTopicRefresh } from '../lib/serverQuery';
import { useWorkbench } from './useWorkbench';

// Shared across components: the bots in settings, read again when settings change.
const settings = ref<BotSettings>({ bots: [], userName: null });
// Paired hosts' bots, which list after this host's.
const remote = ref<Bot[]>([]);
// GPT-Live voices the server offers.
const voices = ref<string[]>([]);
// Whether the first read has finished, so callers can tell no bots from not yet known.
const loaded = ref(false);

async function load(): Promise<void> {
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

// Call during a component's setup.
export function useBots() {
  const { projects, botProjects, assistantProject, remoteAssistantProjects } = useWorkbench();
  useTopicRefresh(['settings'], () => void load());
  void load();
  return {
    settings,
    // This host's bots and paired hosts'.
    all: allBots,
    voices,
    loaded,
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
    uncounted: computed(() => botHidden(projects.value, botProjects.value, { helpers: false })),
    reload: load
  };
}
