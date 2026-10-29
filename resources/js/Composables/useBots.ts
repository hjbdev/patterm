import { computed, ref } from 'vue';
import { botHidden, botRows, readBots, type BotSettings } from '../lib/bots';
import { useTopicRefresh } from '../lib/serverQuery';
import { useWorkbench } from './useWorkbench';

// Shared across components: the bots in settings, read again when settings change.
const settings = ref<BotSettings>({ bots: [] });

async function load(): Promise<void> {
  try {
    const result = await readBots();
    settings.value = { bots: result.bots ?? [] };
  } catch {
    // Without the list, the sidebar simply shows no bots.
  }
}

// Call during a component's setup.
export function useBots() {
  const { projects, botProjects } = useWorkbench();
  useTopicRefresh(['settings'], () => void load());
  void load();
  return {
    settings,
    rows: computed(() => botRows(settings.value, projects.value, botProjects.value)),
    // Bot sessions and their helpers, which agent lists leave out.
    hidden: computed(() => botHidden(projects.value, botProjects.value)),
    reload: load
  };
}
