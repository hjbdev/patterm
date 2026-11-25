import { computed, ref, watch } from 'vue';
import { readStatusLabels, type StatusLabel } from '../lib/statusLabels';
import { useTopicRefresh } from '../lib/serverQuery';

// Shared across components: the configured status labels, read again when
// settings change. Agents' pinned labels arrive with the workbench; this list
// is for menus that pin one.
const localLabels = ref<StatusLabel[]>([]);
const remoteLabels = ref<Record<string, StatusLabel[]>>({});

async function loadLocal(): Promise<void> {
  try { localLabels.value = (await readStatusLabels()).labels ?? []; }
  catch { /* Without the list, menus offer only clearing. */ }
}

async function loadRemote(host: string): Promise<void> {
  try {
    const result = await readStatusLabels(host);
    remoteLabels.value = { ...remoteLabels.value, [host]: result.labels ?? [] };
  } catch { /* Without the list, menus offer only clearing. */ }
}

// Call during a component's setup. Pass a host getter to read a paired host's labels.
export function useStatusLabels(host?: () => string | null | undefined) {
  const targetHost = computed(() => host?.() ?? null);
  const reload = async (): Promise<void> => {
    const current = targetHost.value;
    if (current) await loadRemote(current);
    else await loadLocal();
  };
  useTopicRefresh(['settings'], () => void reload());
  watch(targetHost, (current) => {
    if (current) {
      if (!(current in remoteLabels.value)) void loadRemote(current);
    } else {
      void loadLocal();
    }
  }, { immediate: true });
  const labels = computed(() => targetHost.value ? remoteLabels.value[targetHost.value] ?? [] : localLabels.value);
  return { labels, reload };
}
