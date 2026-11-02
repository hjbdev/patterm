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
    // Bot sessions and their helpers, which agent lists leave out. The
    // assistant's agents list with everyone else's.
    hidden: computed(() => botHidden(projects.value, botProjects.value)),
    reload: load
  };
}
