import { Circle, CircleCheck, CircleDashed, CircleDot, CircleSlash } from 'lucide-vue-next';
import { contextCall, type Todo } from './projectContext';

export const TODO_STATUSES = [
  { value: 'backlog', label: 'Backlog', icon: CircleDashed, class: 'text-muted-foreground' },
  { value: 'open', label: 'Open', icon: Circle, class: 'text-muted-foreground' },
  { value: 'in_progress', label: 'In progress', icon: CircleDot, class: 'text-primary' },
  { value: 'completed', label: 'Completed', icon: CircleCheck, class: 'text-success' }
] as const;
export const TODO_BLOCKED = { value: 'blocked', label: 'Blocked', icon: CircleSlash, class: 'text-warning' } as const;

export const TODO_PRIORITIES = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' }
] as const;

export function todoStatusOption(status: string) {
  return TODO_STATUSES.find(option => option.value === status) ?? TODO_STATUSES[1];
}

// Blocked is derived from dependencies, so it changes the icon but is not a selectable status.
export function todoStatusDisplay(todo: Pick<Todo, 'status' | 'blocked'>) {
  return todo.blocked && todo.status !== 'completed' ? TODO_BLOCKED : todoStatusOption(todo.status);
}

export function todoPriorityOption(priority: string) {
  return TODO_PRIORITIES.find(option => option.value === priority) ?? TODO_PRIORITIES[1];
}

export function waitingFor(todo: Pick<Todo, 'blockers'>) {
  return todo.blockers.filter(blocker => blocker.status !== 'completed');
}

// Quick edits from a list row use the row's revision; a conflict surfaces as an error.
export function updateTodoFields(projectId: string, todo: Pick<Todo, 'id' | 'revision'>, fields: { status?: string; priority?: string; title?: string }) {
  return contextCall<Todo>('todo.update', projectId, { todo_id: todo.id, revision: todo.revision, ...fields });
}
