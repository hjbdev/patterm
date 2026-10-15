import { computed, ref } from 'vue';
import { useWorkbenchNavigation } from './useWorkbenchNavigation';
import { useContextCollection } from './useContextRecord';
import { contextCall, useContextVersion, type Todo } from '../lib/projectContext';
import { TODO_STATUSES, updateTodoFields } from '../lib/todoStatus';

// List state and navigation shared by the todos page layouts.
export function useTodoPage() {
  const { route, router } = useWorkbenchNavigation();
  const projectId = computed(() => String(route.params.projectId));
  const recordId = computed(() => String(route.params.recordId || ''));
  const query = ref(''), assignee = ref(''), error = ref('');
  const filters = computed(() => ({ ...(query.value.trim() ? { query: query.value.trim() } : {}), ...(assignee.value ? { assignee_id: assignee.value } : {}) }));
  const collection = useContextCollection<Todo>('todo', projectId, filters);
  // Writes here and elsewhere change the project's context revision, which
  // refreshes the list.
  useContextVersion(() => projectId.value, () => void collection.refresh());

  function open(id: string) {
    return router.push({ name: 'todos', params: { projectId: projectId.value, recordId: id } });
  }
  function close() {
    return router.push({ name: 'todos', params: { projectId: projectId.value } });
  }
  async function create(title: string, fields: { status?: string; priority?: string } = {}, openAfter = false) {
    const text = title.trim();
    if (!text) return null;
    try {
      const todo = await contextCall<Todo>('todo_create', projectId.value, { title: text, ...fields });
      if (openAfter) await open(todo.id);
      return todo;
    }
    catch (cause) {
      error.value = String(cause);
      return null;
    }
  }
  async function update(todo: Todo, fields: { status?: string; priority?: string }) {
    try {
      await updateTodoFields(projectId.value, todo, fields);
    }
    catch (cause) {
      error.value = String(cause);
    }
  }
  // Status groups in working order. Completed starts collapsed. Within a group,
  // todos that can start come before waiting ones; the server sorts by priority.
  const collapsed = ref(new Set(['completed']));
  const groups = computed(() => ['in_progress', 'open', 'backlog', 'completed'].map(value => {
    const items = collection.items.value.filter(todo => todo.status === value);
    return { value, label: TODO_STATUSES.find(status => status.value === value)!.label, items: [...items.filter(todo => !todo.blocked), ...items.filter(todo => todo.blocked)] };
  }).filter(group => group.items.length));
  function toggleGroup(value: string) {
    const next = new Set(collapsed.value);
    if (!next.delete(value)) next.add(value);
    collapsed.value = next;
  }
  return { projectId, recordId, query, assignee, error, groups, collapsed, toggleGroup, todos: collection.items, loaded: collection.loaded, listError: collection.error, refresh: collection.refresh, open, close, create, update };
}
