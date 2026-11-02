import { computed, ref } from 'vue';
import { botHidden, botRows, readBots, type Bot, type BotSettings } from '../lib/bots';
import type { SessionRecord } from '../types';
import { useTopicRefresh } from '../lib/serverQuery';
import { useWorkbench } from './useWorkbench';

// Shared across components: the bots in settings, read again when settings change.
const settings = ref<BotSettings>({ bots: [], userName: null });
// GPT-Live voices the server offers.
const voices = ref<string[]>([]);
// Whether the first read has finished, so callers can tell no bots from not yet known.
const loaded = ref(false);

async function load(): Promise<void> {
  try {
    const result = await readBots();
    settings.value = { bots: result.bots ?? [], userName: result.userName ?? null };
    voices.value = result.voices ?? [];
  } catch {
    // Without the list, the sidebar simply shows no bots.
  } finally {
    loaded.value = true;
  }
}

const botsById = computed(() => new Map(settings.value.bots.map((bot) => [bot.id, bot])));

// The bot that started an agent, such as a detached agent it opened, for
// rows that carry its face. Reads the shared list without loading it. A
// paired host's bots aren't ours, so its agents show none.
export function ownerBotOf(session: SessionRecord): Bot | null {
  return session.ownerBotId && !session.host ? botsById.value.get(session.ownerBotId) ?? null : null;
}

// Call during a component's setup.
export function useBots() {
  const { projects, botProjects, assistantProject } = useWorkbench();
  useTopicRefresh(['settings'], () => void load());
  void load();
  return {
    settings,
    voices,
    loaded,
    // Every bot, the assistant first while it is on.
    rows: computed(() => botRows(settings.value, projects.value, assistantProject.value ? [assistantProject.value, ...botProjects.value] : botProjects.value)),
    // Bot sessions and their helpers, which agent lists leave out. The
    // assistant's agents list with everyone else's.
    hidden: computed(() => botHidden(projects.value, botProjects.value)),
    reload: load
  };
}
