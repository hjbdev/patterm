<template>
  <ResponsiveMenu v-model:open="open" title="Set status" desktop-class="w-44">
    <template #trigger>
      <button type="button" class="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none" :disabled="disabled" :title="current.label" :aria-label="`Status: ${current.label}. Change status of ${todo.title}`">
        <component :is="current.icon" :class="['h-4 w-4', current.class]" />
      </button>
    </template>
    <template #desktop>
      <DropdownMenuRadioGroup :model-value="todo.status" @update:model-value="select(String($event))">
        <DropdownMenuRadioItem v-for="option in options" :key="option.value" :value="option.value" class="gap-2">
          <component :is="option.icon" :class="['h-4 w-4', option.class]" />{{ option.label }}
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </template>
    <template #mobile>
      <div class="space-y-1">
        <button v-for="option in options" :key="option.value" type="button" class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="option.value === todo.status ? 'bg-primary/10' : ''" @click="select(option.value)">
          <component :is="option.icon" :class="['h-4 w-4 shrink-0', option.class]" />
          <span class="min-w-0 flex-1">{{ option.label }}</span>
          <Check v-if="option.value === todo.status" class="h-4 w-4 shrink-0" />
        </button>
      </div>
    </template>
  </ResponsiveMenu>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Check } from 'lucide-vue-next';
import ResponsiveMenu from './ResponsiveMenu.vue';
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from './ui/dropdown-menu';
import type { Todo } from '../lib/projectContext';
import { TODO_STATUSES, todoStatusDisplay } from '../lib/todoStatus';

const props = defineProps<{ todo: Todo; disabled?: boolean }>();
const emit = defineEmits<{ select: [status: string] }>();
const open = ref(false);

const options = TODO_STATUSES;
const current = computed(() => todoStatusDisplay(props.todo));

function select(status: string) {
  open.value = false;
  if (status !== props.todo.status) emit('select', status);
}
</script>
