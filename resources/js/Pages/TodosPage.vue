<template>
  <div class="h-full min-h-0 overflow-y-auto bg-background p-4 md:p-6">
    <div class="mx-auto w-full max-w-[var(--patterm-terminal-max-width,960px)] pb-10">
      <div class="flex items-center gap-2">
        <TodoQuickAdd class="min-w-0 flex-1" :create="title => create(title)" />
        <SearchField v-model="query" label="Search todos" placeholder="Search" class="h-9 w-48 max-sm:hidden" />
        <TodoAssigneeFilter v-model="assignee" />
      </div>

      <p v-if="loaded && !todos.length" class="px-2 py-10 text-center text-sm text-muted-foreground">{{ query || assignee ? 'No matching todos.' : 'No todos yet.' }}</p>
      <section v-for="group in groups" :key="group.value" class="mt-5">
        <button type="button" class="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground" :aria-expanded="!collapsed.has(group.value)" @click="toggleGroup(group.value)">
          <ChevronRight class="h-3 w-3 transition-transform" :class="!collapsed.has(group.value) && 'rotate-90'" />
          <span>{{ group.label }}</span>
          <span class="text-muted-foreground/70">{{ group.items.length }}</span>
        </button>
        <div v-if="!collapsed.has(group.value)" role="list">
          <div v-for="todo in group.items" :key="todo.id" role="listitem" class="grid cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-2 transition-colors hover:bg-muted/40 md:grid-cols-[1.25rem_minmax(0,1fr)_10rem_4.5rem_5rem]" :class="todo.id === recordId && 'bg-muted/60 hover:bg-muted/60'" @click="open(todo.id)">
            <span class="flex" @click.stop><TodoStatusMenu :todo="todo" @select="update(todo, { status: $event })" /></span>
            <div class="min-w-0">
              <button type="button" class="block max-w-full truncate text-left text-sm outline-none focus-visible:underline" :class="todo.status === 'completed' && 'text-muted-foreground'" @click.stop="open(todo.id)">{{ todo.title }}</button>
              <p v-if="waitingFor(todo).length && todo.status !== 'completed'" class="truncate text-xs text-muted-foreground">Waiting on {{ waitingFor(todo).map(item => item.title).join(', ') }}</p>
            </div>
            <span class="truncate text-xs text-muted-foreground max-md:hidden">{{ todo.assignments.map(assigneeName).join(', ') }}</span>
            <span class="flex items-center gap-1.5 text-xs text-muted-foreground max-md:hidden">
              <template v-if="todo.priority !== 'medium'"><PriorityIcon :priority="todo.priority" class="h-3.5 w-3.5" :class="todo.priority === 'high' && 'text-foreground/80'" />{{ todoPriorityOption(todo.priority).label }}</template>
            </span>
            <span class="text-right text-xs text-muted-foreground/80">{{ shortTime(todo.updated_at) }}</span>
          </div>
        </div>
      </section>
      <p v-if="error || listError" role="alert" class="mt-2 px-2 text-xs text-destructive">{{ error || listError }}</p>
    </div>

    <Dialog :open="!!recordId" @update:open="value => { if (!value) close(); }">
      <DialogContent hide-close class="block max-h-[85dvh] overflow-y-auto p-6 outline-none sm:max-w-2xl">
        <DialogTitle class="sr-only">Todo</DialogTitle>
        <DialogDescription class="sr-only">Edit this todo.</DialogDescription>
        <TodoDetail v-if="shownId" :key="shownId" :project-id="projectId" :record-id="shownId" @open="open" @changed="refresh" @deleted="close">
          <template #header-end>
            <DialogClose as-child>
              <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-muted-foreground" aria-label="Close"><X class="h-4 w-4" /></Button>
            </DialogClose>
          </template>
        </TodoDetail>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { ChevronRight, X } from 'lucide-vue-next';
import { Button } from '../Components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../Components/ui/dialog';
import SearchField from '../Components/SearchField.vue';
import TodoStatusMenu from '../Components/TodoStatusMenu.vue';
import PriorityIcon from '../Components/todos/PriorityIcon.vue';
import TodoDetail from '../Components/todos/TodoDetail.vue';
import TodoQuickAdd from '../Components/todos/TodoQuickAdd.vue';
import TodoAssigneeFilter from '../Components/todos/TodoAssigneeFilter.vue';
import { useTodoPage } from '../Composables/useTodoPage';
import { useAssignees } from '../Composables/useContextRecord';
import { todoPriorityOption, waitingFor } from '../lib/todoStatus';

const { projectId, recordId, query, assignee, error, groups, collapsed, toggleGroup, todos, loaded, listError, refresh, open, close, create, update } = useTodoPage();
const { assigneeName } = useAssignees();
// The route drops the id as soon as the dialog closes; keep showing the last
// todo so the content stays put while the dialog animates out.
const shownId = ref(recordId.value);
watch(recordId, id => { if (id) shownId.value = id; });
function shortTime(value: string | undefined) {
  if (!value) return '';
  const date = new Date(value), days = (Date.now() - date.getTime()) / 86_400_000;
  if (days < 1) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
</script>
