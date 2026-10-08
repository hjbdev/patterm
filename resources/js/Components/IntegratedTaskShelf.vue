<template>
  <!-- A shelf docked to the composer's top edge that opens upwards. The
       negative margin overlaps the composer's padding so the shelf sits on
       its border; it stacks above the form so that padding does not take its
       clicks. A row opens the task's drawer, which has its output. -->
  <section class="relative z-10 mx-auto -mb-4 w-full max-w-[50rem] px-4 text-xs 2xl:max-w-[1000px]" aria-label="Background tasks" data-component="integrated-tasks">
    <div class="mx-3 overflow-hidden rounded-t-lg border border-b-0 border-border bg-muted/25">
      <!-- The list slides up out of the composer. Its height animates from a
           measurement, then goes back to auto so it follows tasks that start
           or finish while it is open. -->
      <Transition
        enter-active-class="transition-[height,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
        leave-active-class="transition-[height,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
        @enter="slideOpen"
        @after-enter="releaseHeight"
        @leave="slideClosed"
      >
        <div v-if="expanded" class="overflow-hidden">
          <ul class="max-h-48 overflow-y-auto overscroll-contain border-b border-border/60 py-1">
            <li v-for="task in tasks" :key="task.id" class="group/task flex min-w-0 items-center gap-2 px-3 hover:bg-muted/40">
              <component
                :is="canOpen ? 'button' : 'div'"
                :type="canOpen ? 'button' : undefined"
                class="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left outline-none"
                :class="canOpen ? 'focus-visible:ring-2 focus-visible:ring-ring/50' : ''"
                :aria-label="canOpen ? `Open ${task.label}` : undefined"
                :data-task-id="task.id"
                @click="canOpen && emit('open', task)"
              >
                <IntegratedTaskStatusIcon :status="task.status" />
                <component :is="kindIcon(task)" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="min-w-0 truncate font-[440]" :class="taskIsFinished(task) ? 'text-muted-foreground' : 'text-foreground'">{{ task.label }}</span>
                <span v-if="taskInlineDetail(task)" class="min-w-0 flex-1 truncate" :class="task.status === 'failed' ? 'text-destructive/90' : 'text-muted-foreground'">{{ taskInlineDetail(task) }}</span>
                <span class="sr-only">{{ taskKindLabel(task) }}, {{ taskStatusLabel(task) }}</span>
              </component>
              <Button
                v-if="task.stoppable"
                size="sm"
                variant="ghost"
                class="h-6 shrink-0 px-2 text-xs text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover/task:opacity-100 [@media(hover:none)]:opacity-100"
                :disabled="!canStop || stopping(task.id)"
                :aria-label="`Stop ${task.label}`"
                @click="emit('stop', task.id)"
              >Stop</Button>
              <ChevronRight v-else-if="canOpen" class="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/task:opacity-100" aria-hidden="true" />
            </li>
          </ul>
        </div>
      </Transition>
      <button
        type="button"
        class="flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
        :aria-expanded="expanded"
        data-tasks-trigger
        @click="expanded = !expanded"
      >
        <IntegratedTaskStatusIcon :status="summaryStatus" />
        <span class="shrink-0 font-[440] text-foreground">Background tasks</span>
        <span v-if="latest" class="min-w-0 flex-1 truncate text-muted-foreground transition-opacity duration-200 motion-reduce:transition-none" :class="expanded ? 'opacity-0' : ''" :aria-hidden="expanded ? 'true' : undefined">{{ latest }}</span>
        <span class="ml-auto shrink-0 text-muted-foreground">{{ taskCountParts(counts).join(' · ') }}</span>
        <ChevronUp class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none" :class="expanded ? 'rotate-180' : ''" aria-hidden="true" />
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, type Component } from 'vue';
import { Activity, Bot, ChevronRight, ChevronUp, CircleDashed, SquareTerminal, Workflow } from 'lucide-vue-next';
import { Button } from './ui/button';
import IntegratedTaskStatusIcon from './IntegratedTaskStatusIcon.vue';
import { taskIsActive, type IntegratedTask } from '../lib/integratedConversation';
import { countTasks, taskCountParts, taskInlineDetail, taskIsFinished, taskKindLabel, taskStatusLabel } from '../lib/integratedTasks';

const props = defineProps<{ tasks: IntegratedTask[]; canOpen: boolean; canStop: boolean; stopping: (taskId: string) => boolean }>();
const emit = defineEmits<{ open: [task: IntegratedTask]; stop: [taskId: string] }>();

const KIND_ICONS: Record<string, Component> = {
  Agent: Bot,
  'Remote agent': Bot,
  Teammate: Bot,
  Shell: SquareTerminal,
  Workflow,
  Monitor: Activity
};

const counts = computed(() => countTasks(props.tasks));
const expanded = ref(false);
const summaryStatus = computed<IntegratedTask['status']>(() => counts.value.active ? 'running' : counts.value.failed ? 'failed' : 'completed');
// The collapsed shelf previews the newest live progress.
const latest = computed(() => {
  const live = [...props.tasks].reverse().filter(taskIsActive);
  const task = live.find((item) => taskInlineDetail(item)) ?? live[0];
  if (!task) return '';
  const detail = taskInlineDetail(task);
  return detail ? `${task.label} · ${detail}` : task.label;
});

function slideOpen(element: Element): void {
  const list = element as HTMLElement;
  const height = list.scrollHeight;
  list.style.height = '0px';
  void list.offsetHeight;
  list.style.height = `${height}px`;
}

function releaseHeight(element: Element): void {
  (element as HTMLElement).style.height = '';
}

// Starts from the rendered height, so closing mid-open does not jump.
function slideClosed(element: Element): void {
  const list = element as HTMLElement;
  list.style.height = `${list.offsetHeight}px`;
  void list.offsetHeight;
  list.style.height = '0px';
}

function kindIcon(task: IntegratedTask): Component {
  return KIND_ICONS[taskKindLabel(task)] ?? CircleDashed;
}
</script>
