import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { contextCall, type Page, type Scratchpad, type Todo } from '../lib/projectContext';
import { useWorkbenchNavigation } from './useWorkbenchNavigation';

export type ContextKind = 'todo' | 'scratchpad';

const draftKeyFor = (projectId: string, kind: ContextKind, id: string) => `patterm.context.draft.${projectId}.${kind}.${id}`;
// Saves still in flight, by draft key. A save started as an editor closes can
// finish after the record is reopened, so loads wait for it.
const pendingSaves = new Map<string, Promise<void>>();

// True when this tab holds an unsaved draft of the record, which a separate
// status change would put out of date.
export function hasContextDraft(projectId: string, kind: ContextKind, id: string) {
  try { return sessionStorage.getItem(draftKeyFor(projectId, kind, id)) !== null; }
  catch { return false; }
}

// Loads one todo or scratchpad and autosaves edits with a revision guard. Unsaved
// edits are mirrored to sessionStorage so a reload or failed save keeps the draft.
export function useContextRecord(kind: Ref<ContextKind>, projectId: Ref<string>, recordId: Ref<string>, options: { onChanged?: () => void } = {}) {
  const record = ref<Todo | Scratchpad | null>(null), title = ref(''), body = ref(''), status = ref(''), priority = ref('medium');
  const error = ref(''), saveError = ref(''), saving = ref(false), dirty = ref(false);
  const todo = computed(() => record.value && 'notes' in record.value ? record.value : null);
  const isTodo = computed(() => kind.value === 'todo');
  // `edits` counts changes made in this tab, so a refresh that started before
  // one can tell its response is out of date.
  let readGeneration = 0, timer: ReturnType<typeof setTimeout> | undefined, loading = false, edits = 0, disposed = false;
  // Where the shown record was loaded from; the route may already point elsewhere.
  let loadedFrom = { project: '', namespace: 'todo' as ContextKind };
  const draftKey = () => draftKeyFor(projectId.value, kind.value, recordId.value);
  // sessionStorage survives reloads but is isolated between tabs, including tabs
  // opened by duplicating another tab. A save must only clear this tab's draft.
  function readDraft() {
    try { return sessionStorage.getItem(draftKey()); }
    catch {
      error.value = 'Local draft storage is unavailable. Keep this page open until saving completes.';
      return null;
    }
  }
  function removeDraft(key = draftKey()) {
    try { sessionStorage.removeItem(key); }
    catch { error.value = 'Could not clear the locally saved draft.'; }
  }
  function readStoredDraft(key: string) {
    try { return sessionStorage.getItem(key); }
    catch { return null; }
  }
  function draftMatches(stored: string | null, values: { title: string; status: string; notes?: string; body?: string; priority?: string }) {
    if (!stored) return false;
    const draft = JSON.parse(stored) as { title: string; body: string; status: string; priority: string };
    return draft.title === values.title && draft.body === (values.notes ?? values.body) && draft.status === values.status && (values.priority === undefined || draft.priority === values.priority);
  }
  function preserveDraft() {
    if (!record.value) return;
    try {
      sessionStorage.setItem(draftKey(), JSON.stringify({ title: title.value, body: body.value, status: status.value, priority: priority.value, revision: record.value.revision }));
    }
    catch { error.value = 'Could not store this draft locally. Keep this page open until saving completes, or copy the content.'; }
  }
  async function load() {
    const generation = ++readGeneration;
    // Refreshing the same record keeps it shown, so editors stay mounted and
    // focused. Edits or saves made meanwhile win over the refresh.
    const refreshing = record.value?.id === recordId.value, startEdits = edits, startRevision = record.value?.revision;
    if (!refreshing) record.value = null;
    dirty.value = false;
    saveError.value = '';
    clearTimeout(timer);
    if (!recordId.value) return;
    const project = projectId.value, namespace = kind.value, id = recordId.value;
    // Read after any save of this record lands, so a saved draft isn't recovered.
    await pendingSaves.get(draftKeyFor(project, namespace, id));
    if (generation !== readGeneration) return;
    try {
      const result = await contextCall<Todo | Scratchpad>(`${namespace}_get`, project, { [`${namespace}_id`]: id, ...(namespace === 'scratchpad' ? { mode: 'full', limit: 1000 } : {}) });
      if (!('notes' in result) && result.total_lines && result.total_lines > 1000) {
        const chunks = [result.body ?? ''];
        for (let start = 1000; start < result.total_lines; start += 1000) {
          if (generation !== readGeneration) return;
          const part = await contextCall<Scratchpad>('scratchpad_get', project, { scratchpad_id: result.id, mode: 'content', offset: start, limit: 1000 });
          if (part.revision !== result.revision) throw new Error('The note changed while loading. Reopen it to load the latest revision.');
          chunks.push(part.body ?? '');
        }
        result.body = chunks.join('\n');
      }
      if (generation !== readGeneration) return;
      if (refreshing && (edits !== startEdits || dirty.value || saving.value || record.value?.revision !== startRevision)) return;
      loading = true;
      loadedFrom = { project, namespace };
      record.value = result;
      title.value = result.title;
      body.value = 'notes' in result ? result.notes : result.body ?? '';
      status.value = result.status;
      priority.value = 'priority' in result ? result.priority : 'medium';
      const draft = readDraft();
      if (draft) {
        const saved = JSON.parse(draft) as { title: string; body: string; status: string; priority: string; revision?: number };
        if (saved.title === title.value && saved.body === body.value && saved.status === status.value && (!isTodo.value || saved.priority === priority.value)) {
          removeDraft();
        } else {
          title.value = saved.title;
          body.value = saved.body;
          status.value = saved.status;
          priority.value = saved.priority;
          record.value.revision = saved.revision ?? 0;
          dirty.value = true;
          saveError.value = 'Recovered an unsaved draft. Copy it before reloading, or retry to save against its original revision.';
        }
      }
      loading = false;
    }
    catch (cause) {
      if (generation === readGeneration) error.value = String(cause);
      loading = false;
    }
  }
  watch([title, body, status, priority], () => {
    if (loading || !record.value) return;
    edits++;
    const original = record.value;
    dirty.value = title.value !== original.title || body.value !== ('notes' in original ? original.notes : original.body ?? '') || status.value !== original.status || ('priority' in original && priority.value !== original.priority);
    if (!dirty.value) {
      removeDraft();
      clearTimeout(timer);
      return;
    }
    preserveDraft();
    clearTimeout(timer);
    if (!saveError.value) timer = setTimeout(() => void save(), 650);
  }, { flush: 'sync' });
  async function save() {
    if (disposed || !record.value || !dirty.value || saving.value) return;
    const generation = readGeneration, id = record.value.id, { project, namespace } = loadedFrom, key = draftKeyFor(project, namespace, id);
    const values = { title: title.value, status: status.value, ...(isTodo.value ? { notes: body.value, priority: priority.value } : { body: body.value }) };
    saving.value = true;
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    pendingSaves.set(key, pending);
    try {
      const result = await contextCall<Todo | Scratchpad>(`${namespace}_update`, project, { [`${namespace}_id`]: id, revision: record.value.revision, ...values });
      if (generation === readGeneration) {
        record.value = result;
        saveError.value = '';
        dirty.value = title.value !== values.title || status.value !== values.status || body.value !== ('notes' in values ? values.notes : values.body) || ('priority' in values && priority.value !== values.priority);
        if (!dirty.value) removeDraft(key);
        else {
          preserveDraft();
          timer = setTimeout(() => void save(), 650);
        }
      }
      // A save flushed while leaving the record clears its draft if nothing changed since.
      else if (draftMatches(readStoredDraft(key), values)) removeDraft(key);
      options.onChanged?.();
    }
    catch (cause) {
      if (generation === readGeneration) saveError.value = String(cause);
    }
    finally {
      saving.value = false;
      if (pendingSaves.get(key) === pending) pendingSaves.delete(key);
      settle();
      // A closed editor never retries; its draft stays for the next visit to recover.
      if (!disposed && generation !== readGeneration && dirty.value && !saveError.value) timer = setTimeout(() => void save(), 650);
    }
  }
  // Assignment, dependency and lease changes save pending edits first, then reload.
  async function relation(operation: string, args: Record<string, unknown>) {
    const generation = readGeneration, project = projectId.value, id = recordId.value;
    const isCurrent = () => generation === readGeneration && project === projectId.value && id === recordId.value && isTodo.value;
    try {
      await save();
      if (!isCurrent() || dirty.value) return;
      await contextCall(`todo_${operation}`, project, { todo_id: id, ...args });
      if (isCurrent() && !dirty.value && !saving.value) await load();
      options.onChanged?.();
    }
    catch (cause) {
      if (isCurrent()) error.value = String(cause);
    }
  }
  async function remove() {
    if (!record.value || !window.confirm(`Delete “${record.value.title}”?`)) return false;
    try {
      await contextCall(`${kind.value}_delete`, projectId.value, { [`${kind.value}_id`]: recordId.value, revision: record.value.revision });
      removeDraft();
      options.onChanged?.();
      return true;
    }
    catch (cause) {
      error.value = String(cause);
      return false;
    }
  }
  function reload() {
    removeDraft();
    return load();
  }
  function copyDraft() {
    return window.patterm.writeClipboardText(`# ${title.value}\n\n${body.value}`);
  }
  // Refreshes from the server unless this tab holds unsaved edits.
  function refresh() {
    if (!dirty.value && !saving.value) void load();
  }
  // Leaving a record saves its pending edits instead of waiting for the next visit.
  function flush() {
    if (dirty.value && !saveError.value && !saving.value) void save();
  }
  watch([projectId, kind, recordId], () => {
    error.value = '';
    flush();
    void load();
  }, { immediate: true });
  onBeforeUnmount(() => {
    clearTimeout(timer);
    flush();
    disposed = true;
    ++readGeneration;
  });
  const saveLabel = computed(() => saving.value ? 'Saving…' : dirty.value ? 'Unsaved' : 'Saved');
  return { record, todo, title, body, status, priority, error, saveError, saving, dirty, saveLabel, save, relation, remove, reload, copyDraft, refresh };
}

// Loads every record that matches the filters, a page of 100 at a time, so
// views can group and sort them client-side.
export function useContextCollection<T extends Todo | Scratchpad>(kind: ContextKind, projectId: Ref<string>, filters: Ref<Record<string, unknown>> = ref({})) {
  const items = ref<T[]>([]) as Ref<T[]>, error = ref(''), loaded = ref(false);
  let generation = 0;
  async function refresh() {
    const current = ++generation, project = projectId.value, args = filters.value;
    try {
      const all: T[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await contextCall<Page<T>>(`${kind}_list`, project, { limit: 100, offset, ...args });
        if (current !== generation) return;
        all.push(...page.items);
        if (offset + 100 >= page.total) break;
      }
      items.value = all;
      loaded.value = true;
      error.value = '';
    }
    catch (cause) {
      if (current === generation) error.value = String(cause);
    }
  }
  watch([projectId, filters], () => void refresh(), { immediate: true, deep: true });
  onBeforeUnmount(() => { ++generation; });
  return { items, error, loaded, refresh };
}

// Todo assignees are the user or one of the project's sessions.
export function useAssignees() {
  const { activeProject } = useWorkbenchNavigation();
  const sessions = computed(() => activeProject.value?.projectSessions ?? []);
  function assigneeName(id: string) {
    const session = sessions.value.find(item => item.id === id);
    return id === 'user' ? 'You' : session?.displayName || session?.lastTitle || id;
  }
  return { sessions, assigneeName };
}
