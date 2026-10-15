<template>
  <div v-if="record && todo" class="space-y-6">
    <header class="flex items-start gap-2">
      <textarea
        v-model="title"
        aria-label="Title"
        maxlength="500"
        rows="1"
        placeholder="Untitled todo"
        class="todo-title min-w-0 flex-1 resize-none bg-transparent text-xl font-semibold leading-snug outline-none placeholder:text-muted-foreground/60"
        @keydown.enter.prevent="($event.target as HTMLTextAreaElement).blur()"
      />
      <span role="status" class="mt-0.5 shrink-0 text-xs leading-6 text-muted-foreground/80">{{ saveLabel === 'Saved' ? '' : saveLabel }}</span>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-muted-foreground" aria-label="Todo actions"><MoreHorizontal class="h-4 w-4" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem @select="copyDraft">Copy as Markdown</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem class="text-destructive focus:text-destructive" @select="destroy">Delete todo</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <slot name="header-end" />
    </header>

    <dl class="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1 text-sm">
      <dt class="property-label">Status</dt>
      <dd>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button type="button" class="property-value" aria-label="Status">
              <component :is="statusDisplay.icon" :class="['h-4 w-4', statusDisplay.class]" />{{ statusDisplay.label }}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="w-44">
            <DropdownMenuRadioGroup v-model="status">
              <DropdownMenuRadioItem v-for="option in TODO_STATUSES" :key="option.value" :value="option.value" class="gap-2">
                <component :is="option.icon" :class="['h-4 w-4', option.class]" />{{ option.label }}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </dd>

      <dt class="property-label">Priority</dt>
      <dd>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button type="button" class="property-value" aria-label="Priority">
              <PriorityIcon :priority="priority" class="h-4 w-4 text-muted-foreground" />{{ priorityOption.label }}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="w-44">
            <DropdownMenuRadioGroup v-model="priority">
              <DropdownMenuRadioItem v-for="option in TODO_PRIORITIES" :key="option.value" :value="option.value" class="gap-2">
                <PriorityIcon :priority="option.value" class="h-4 w-4 text-muted-foreground" />{{ option.label }}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </dd>

      <dt class="property-label">Assignees</dt>
      <dd class="flex flex-wrap items-center gap-x-1">
        <span v-for="id in todo.assignments" :key="id" class="group/chip property-value pr-1">
          <span class="max-w-48 truncate">{{ assigneeName(id) }}</span>
          <button type="button" class="rounded-sm p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/chip:opacity-100 [@media(hover:none)]:opacity-100" :aria-label="`Remove assignment: ${assigneeName(id)}`" @click="relation('unassign', { assignee_id: id })"><X class="h-3 w-3" /></button>
        </span>
        <Popover v-model:open="assigning">
          <PopoverTrigger as-child>
            <button type="button" class="property-value text-muted-foreground" aria-label="Add an assignee" :disabled="saving">
              <Plus v-if="todo.assignments.length" class="h-3.5 w-3.5" /><span v-else>Unassigned</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" class="w-72 max-w-[calc(100vw-2rem)] p-0">
            <Command>
              <CommandInput placeholder="Assign to…" aria-label="Search assignees" />
              <CommandList>
                <CommandEmpty>No assignees found.</CommandEmpty>
                <CommandGroup>
                  <CommandItem value="user" :disabled="todo.assignments.includes('user')" @select="assigning = false; relation('assign', { assignee_id: 'user' })">You</CommandItem>
                  <CommandItem v-for="session in sessions" :key="session.id" :value="session.id" :disabled="todo.assignments.includes(session.id)" @select="assigning = false; relation('assign', { assignee_id: session.id })">
                    <span class="truncate">{{ assigneeName(session.id) }}</span>
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </dd>

      <dt class="property-label">Waiting on</dt>
      <dd class="min-w-0 space-y-0.5">
        <div v-for="blocker in todo.blockers" :key="blocker.id" class="group/chip flex min-w-0 items-center">
          <button type="button" class="property-value min-w-0" :title="blocker.title" @click="emit('open', blocker.id)">
            <component :is="todoStatusOption(blocker.status).icon" :class="['h-4 w-4 shrink-0', todoStatusOption(blocker.status).class]" />
            <span class="truncate" :class="blocker.status === 'completed' && 'text-muted-foreground line-through decoration-muted-foreground/40'">{{ blocker.title }}</span>
          </button>
          <button type="button" class="ml-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/chip:opacity-100 [@media(hover:none)]:opacity-100" :aria-label="`Remove dependency: ${blocker.title}`" @click="relation('dependency_remove', { blocker_id: blocker.id })"><X class="h-3 w-3" /></button>
        </div>
        <Popover v-model:open="blocking">
          <PopoverTrigger as-child>
            <button type="button" class="property-value text-muted-foreground" aria-label="Add a dependency" :disabled="saving">
              <template v-if="todo.blockers.length"><Plus class="h-3.5 w-3.5" /><span class="text-xs">Add</span></template><span v-else>Nothing</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" class="w-80 max-w-[calc(100vw-2rem)] p-0">
            <Command>
              <CommandInput v-model="blockerQuery" placeholder="Wait for…" aria-label="Search todos" />
              <CommandList>
                <CommandEmpty>No todos found.</CommandEmpty>
                <CommandGroup>
                  <CommandItem v-for="item in blockerOptions" :key="item.id" :value="item.id" :disabled="todo.blockers.some(blocker => blocker.id === item.id)" @select="blocking = false; relation('dependency_add', { blocker_id: item.id })">
                    <component :is="todoStatusOption(item.status).icon" :class="['h-4 w-4 shrink-0', todoStatusOption(item.status).class]" />
                    <span class="truncate">{{ item.title }}</span>
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </dd>

      <template v-if="todo.lease && todo.lease.expires_at > now">
        <dt class="property-label">Claimed by</dt>
        <dd class="flex flex-wrap items-center gap-2 px-2 py-1">
          <span>{{ assigneeName(todo.lease.holder_session_id || todo.lease.holder_actor) }}</span>
          <span class="text-xs text-muted-foreground">until {{ new Date(todo.lease.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }}</span>
          <Button variant="ghost" size="sm" class="h-6 px-2 text-xs text-muted-foreground" @click="relation('lease_revoke', {})">Release</Button>
        </dd>
      </template>
    </dl>

    <div v-if="saveError" role="alert" class="space-y-2 rounded-md border border-destructive p-3 text-sm">
      <p>{{ saveError }} Keep this tab open or copy your draft before closing it.</p>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" @click="copyDraft">Copy draft</Button>
        <Button size="sm" variant="outline" @click="reload">Reload latest</Button>
        <Button size="sm" variant="outline" @click="save">Retry save</Button>
      </div>
    </div>

    <section class="border-t border-border/60 pt-5">
      <MarkdownField v-model="body" label="Notes" placeholder="Add notes…" min-height-class="min-h-16" />
    </section>

    <ExternalReferences :key="record.id" :project-id="projectId" target-type="todo" :target-id="record.id" />
    <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
  </div>
  <div v-else-if="error" role="alert" class="text-sm text-destructive">{{ error }}</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from 'vue';
import { MoreHorizontal, Plus, X } from 'lucide-vue-next';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command';
import PriorityIcon from './PriorityIcon.vue';
import MarkdownField from '../MarkdownField.vue';
import ExternalReferences from '../ExternalReferences.vue';
import { useAssignees, useContextRecord } from '../../Composables/useContextRecord';
import { contextRead, useContextClock, useContextVersion, type Page, type Todo } from '../../lib/projectContext';
import { TODO_PRIORITIES, TODO_STATUSES, todoPriorityOption, todoStatusDisplay, todoStatusOption } from '../../lib/todoStatus';

const props = defineProps<{ projectId: string; recordId: string }>();
const emit = defineEmits<{ open: [id: string]; changed: []; deleted: [] }>();
const now = useContextClock();
const { sessions, assigneeName } = useAssignees();
const { record, todo, title, body, status, priority, error, saveError, saving, saveLabel, save, relation, remove, reload, copyDraft, refresh } = useContextRecord(ref<'todo'>('todo'), toRef(props, 'projectId'), toRef(props, 'recordId'), { onChanged: () => emit('changed') });
useContextVersion(() => props.projectId, refresh);

const statusDisplay = computed(() => todoStatusDisplay({ status: status.value, blocked: todo.value?.blocked ?? false }));
const priorityOption = computed(() => todoPriorityOption(priority.value));
const assigning = ref(false), blocking = ref(false), blockerQuery = ref(''), blockerOptions = ref<Todo[]>([]);

let blockerGeneration = 0, blockerTimer: ReturnType<typeof setTimeout> | undefined;
async function refreshBlockers() {
  const generation = ++blockerGeneration;
  try {
    const options = await contextRead<Page<Todo>>('todo_list', props.projectId, { limit: 100, query: blockerQuery.value });
    if (generation === blockerGeneration) blockerOptions.value = options.items.filter(item => item.id !== props.recordId);
  }
  catch (cause) { if (generation === blockerGeneration) error.value = String(cause); }
}
watch(blockerQuery, () => {
  clearTimeout(blockerTimer);
  blockerTimer = setTimeout(() => void refreshBlockers(), 150);
});
watch(blocking, (open) => { if (open) void refreshBlockers(); });
watch(() => props.recordId, () => { assigning.value = false; blocking.value = false; });
onBeforeUnmount(() => { clearTimeout(blockerTimer); ++blockerGeneration; });

async function destroy() {
  if (await remove()) emit('deleted');
}
</script>

<style scoped>
.todo-title { field-sizing: content; }
.property-label { @apply py-1 text-xs leading-5 text-muted-foreground; }
.property-value { @apply inline-flex h-7 max-w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none; }
dd { @apply -ml-2 min-w-0; }
</style>
