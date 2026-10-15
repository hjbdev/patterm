import { computed, ref } from 'vue';
import { useWorkbenchNavigation } from './useWorkbenchNavigation';
import { hasContextDraft, useContextCollection } from './useContextRecord';
import { contextCall, useContextVersion, type Scratchpad } from '../lib/projectContext';

// List state and navigation shared by the scratchpads page.
export function useScratchpadPage() {
  const { route, router } = useWorkbenchNavigation();
  const projectId = computed(() => String(route.params.projectId));
  const recordId = computed(() => String(route.params.recordId || ''));
  const query = ref(''), error = ref('');
  const filters = computed(() => query.value.trim() ? { query: query.value.trim() } : {});
  const collection = useContextCollection<Scratchpad>('scratchpad', projectId, filters);
  // Writes here and elsewhere change the project's context revision, which
  // refreshes the list.
  useContextVersion(() => projectId.value, () => void collection.refresh());
  const active = computed(() => collection.items.value.filter(item => item.status === 'active'));
  const archived = computed(() => collection.items.value.filter(item => item.status === 'archived'));

  function open(id: string) {
    return router.push({ name: 'scratchpads', params: { projectId: projectId.value, recordId: id } });
  }
  function close() {
    return router.push({ name: 'scratchpads', params: { projectId: projectId.value } });
  }
  async function create() {
    try {
      const pad = await contextCall<Scratchpad>('scratchpad_create', projectId.value, { title: 'Untitled' });
      await open(pad.id);
      return pad;
    }
    catch (cause) {
      error.value = String(cause);
      return null;
    }
  }
  // A pending draft would go out of date, so open the scratchpad to recover it instead.
  async function setArchived(pad: Scratchpad, archive: boolean) {
    if (hasContextDraft(projectId.value, 'scratchpad', pad.id)) {
      await open(pad.id);
      return;
    }
    try {
      await contextCall('scratchpad_update', projectId.value, { scratchpad_id: pad.id, revision: pad.revision, status: archive ? 'archived' : 'active' });
    }
    catch (cause) {
      error.value = String(cause);
    }
  }
  return { projectId, recordId, query, error, active, archived, loaded: collection.loaded, listError: collection.error, refresh: collection.refresh, open, close, create, setArchived };
}

