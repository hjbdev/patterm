import { ref } from 'vue';
import { readStatusLabels, type StatusLabel } from '../lib/statusLabels';
import { useTopicRefresh } from '../lib/serverQuery';

// Shared across components: the configured status labels, read again when
// settings change. Agents' pinned labels arrive with the workbench; this list
// is for menus that pin one.
const labels = ref<StatusLabel[]>([]);

async function load(): Promise<void> {
  try { labels.value = (await readStatusLabels()).labels ?? []; }
  catch { /* Without the list, menus offer only clearing. */ }
}

// Call during a component's setup.
export function useStatusLabels() {
  useTopicRefresh(['settings'], () => void load());
  void load();
  return { labels, reload: load };
}
