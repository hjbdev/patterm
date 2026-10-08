<template>
  <form class="flex items-center gap-2 rounded-md px-2 transition-colors focus-within:bg-muted/40 hover:bg-muted/30" :class="large ? 'h-11' : 'h-9'" @submit.prevent="submit">
    <Plus class="h-4 w-4 shrink-0 text-muted-foreground" />
    <input ref="input" v-model="title" :disabled="busy" maxlength="500" :placeholder="placeholder" aria-label="New todo title" class="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60" :class="large && 'text-base'" @keydown.esc="title = ''; input?.blur()" />
    <kbd v-if="title" class="shrink-0 text-[11px] text-muted-foreground">Enter</kbd>
  </form>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Plus } from 'lucide-vue-next';

const props = withDefaults(defineProps<{ placeholder?: string; large?: boolean; create: (title: string) => Promise<unknown> }>(), { placeholder: 'Add a todo', large: false });
const title = ref(''), busy = ref(false), input = ref<HTMLInputElement | null>(null);

async function submit() {
  if (!title.value.trim() || busy.value) return;
  busy.value = true;
  try {
    if (await props.create(title.value)) title.value = '';
  }
  finally {
    busy.value = false;
    requestAnimationFrame(() => input.value?.focus());
  }
}
</script>
