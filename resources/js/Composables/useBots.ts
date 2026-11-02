import { computed, ref } from 'vue';
import { botHidden, botRows, readBots, type BotSettings } from '../lib/bots';
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
