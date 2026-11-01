import { computed, ref } from 'vue';
import { assistant } from '../lib/assistant';
import { ASSISTANT_BOT_ID, assistantRow, botHidden, botRows, readBots, type BotSettings } from '../lib/bots';
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
    rows: computed(() => botRows(settings.value, projects.value, botProjects.value)),
    // The assistant's bot settings: its name and avatar.
    assistantBot: computed(() => settings.value.bots.find((bot) => bot.id === ASSISTANT_BOT_ID) ?? null),
    // The global assistant, which lists with the bots while it is on.
    assistantRow: computed(() => assistant.enabled ? assistantRow(assistantProject.value, assistant.processId) : null),
    // Bot sessions and their helpers, which agent lists leave out.
    hidden: computed(() => botHidden(projects.value, botProjects.value)),
    reload: load
  };
}
