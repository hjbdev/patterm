<template>
  <div class="group/row flex items-start gap-[7px] rounded-md pl-[5px] pr-1 transition-colors hover:bg-muted/40" :class="dense ? 'py-1' : 'py-1.5'">
    <TodoStatusMenu :todo="todo" :disabled="busy ?? false" @select="emit('status', $event)" />
    <div class="min-w-0 flex-1">
      <RouterLink :to="{ name: 'todos', params: { projectId, recordId: todo.id } }" class="block break-words text-[13px] leading-5 outline-none hover:underline focus-visible:underline" :class="todo.status === 'completed' && 'text-muted-foreground line-through decoration-muted-foreground/40'">{{ todo.title }}</RouterLink>
      <p v-for="blocker in waitingFor" :key="blocker.id" class="truncate text-[11px] leading-4 text-muted-foreground">Waiting for {{ blocker.title }}</p>
      <p v-if="todo.lease && todo.lease.expires_at > now" class="text-[11px] leading-4 text-muted-foreground">Owned until {{ new Date(todo.lease.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }}</p>
    </div>
    <Button size="icon" variant="ghost" :class="ROW_ACTION" class="-my-0.5" :disabled="busy" :aria-label="`Unassign ${todo.title}`" title="Unassign" @click="emit('unassign')"><X class="h-3.5 w-3.5" /></Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { X } from 'lucide-vue-next';
import TodoStatusMenu from '../TodoStatusMenu.vue';
import { Button } from '../ui/button';
import { ROW_ACTION } from './rowAction';
import type { Todo } from '../../lib/projectContext';

const props = withDefaults(defineProps<{ todo: Todo; projectId: string; now: number; busy?: boolean | undefined; dense?: boolean | undefined }>(), { busy: false, dense: false });
const emit = defineEmits<{ status: [status: string]; unassign: [] }>();
const waitingFor = computed(() => props.todo.blockers.filter(item => item.status !== 'completed'));
</script>
