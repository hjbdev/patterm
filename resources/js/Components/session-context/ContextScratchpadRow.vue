<template>
  <div class="group/row flex items-center rounded-md pr-1 transition-colors hover:bg-muted/40">
    <RouterLink :to="{ name: 'scratchpads', params: { projectId, recordId: note.id } }" class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-[13px] leading-5 outline-none focus-visible:ring-1 focus-visible:ring-ring" :class="dense ? 'py-1' : 'py-1.5'">
      <NotebookText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate" :class="note.status === 'archived' && 'text-muted-foreground'">{{ note.title }}</span>
      <span v-if="note.status === 'archived'" class="shrink-0 text-[11px] text-muted-foreground/80">Archived</span>
    </RouterLink>
    <Button size="icon" variant="ghost" :class="ROW_ACTION" :disabled="busy" :aria-label="`Detach ${note.title}`" title="Detach" @click="emit('detach')"><X class="h-3.5 w-3.5" /></Button>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { NotebookText, X } from 'lucide-vue-next';
import { Button } from '../ui/button';
import { ROW_ACTION } from './rowAction';
import type { Scratchpad } from '../../lib/projectContext';

withDefaults(defineProps<{ note: Scratchpad; projectId: string; busy?: boolean | undefined; dense?: boolean | undefined }>(), { busy: false, dense: false });
const emit = defineEmits<{ detach: [] }>();
</script>
