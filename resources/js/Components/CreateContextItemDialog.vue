<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ isTodo ? 'New todo' : 'New scratchpad' }}</DialogTitle>
        <DialogDescription>{{ isTodo ? 'The todo is assigned to this session.' : 'The scratchpad is attached to this session.' }}</DialogDescription>
      </DialogHeader>
      <form class="flex flex-col gap-4" @submit.prevent="submit">
        <div class="flex flex-col gap-1.5">
          <label for="context-item-title" class="text-xs font-medium text-muted-foreground">Title</label>
          <Input id="context-item-title" ref="titleInput" v-model="title" maxlength="500" :placeholder="isTodo ? 'Fix the resize flicker' : 'Release plan'" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label for="context-item-body" class="text-xs font-medium text-muted-foreground">{{ isTodo ? 'Notes' : 'Content' }} <span class="font-normal">(optional)</span></label>
          <Textarea id="context-item-body" v-model="body" class="min-h-32 resize-y text-sm" placeholder="Markdown is supported." />
        </div>
        <div v-if="isTodo" class="flex flex-wrap gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button type="button" variant="ghost" size="sm" class="h-8 gap-2 text-xs text-muted-foreground" aria-label="Status">{{ optionLabel(status) }}<ChevronDown class="h-3.5 w-3.5" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup v-model="status">
                <DropdownMenuRadioItem v-for="item in statuses" :key="item" :value="item">{{ optionLabel(item) }}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button type="button" variant="ghost" size="sm" class="h-8 gap-2 text-xs text-muted-foreground" aria-label="Priority">{{ optionLabel(priority) }} priority<ChevronDown class="h-3.5 w-3.5" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup v-model="priority">
                <DropdownMenuRadioItem v-for="item in priorities" :key="item" :value="item">{{ optionLabel(item) }}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <DialogFooter>
          <Button type="submit" :disabled="busy || !title.trim()">{{ busy ? 'Creating…' : isTodo ? 'Create todo' : 'Create scratchpad' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ChevronDown } from 'lucide-vue-next';
import { useAutofocus } from '../Composables/useAutofocus';
import { contextCall } from '../lib/projectContext';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
// A title typed into a picker search starts the draft when the draft is empty.
const props = defineProps<{ kind: 'todo' | 'scratchpad'; projectId: string; sessionId: string; initialTitle?: string }>();
const emit = defineEmits<{ created: [] }>();
const open = defineModel<boolean>('open', { default: false });
const isTodo = computed(() => props.kind === 'todo');
const statuses = ['backlog', 'open', 'in_progress', 'completed'], priorities = ['high', 'medium', 'low'];
const titleInput = ref<{ $el?: unknown } | null>(null);
const title = ref(''), body = ref(''), status = ref('open'), priority = ref('medium'), busy = ref(false), error = ref('');
useAutofocus(open, titleInput);
function optionLabel(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1).replace('_', ' ');
}
// Keep the draft when the dialog is dismissed; clear it only after a successful create.
watch(open, (isOpen) => {
  if (!isOpen) return;
  error.value = '';
  if (props.initialTitle && !title.value) title.value = props.initialTitle;
});
watch(() => [props.kind, props.projectId, props.sessionId], reset);
function reset() {
  title.value = '';
  body.value = '';
  status.value = 'open';
  priority.value = 'medium';
  error.value = '';
}
async function submit() {
  if (busy.value || !title.value.trim()) return;
  busy.value = true;
  error.value = '';
  try {
    await contextCall(`${props.kind}.create`, props.projectId, isTodo.value
      ? { title: title.value, notes: body.value, status: status.value, priority: priority.value, assignee_id: props.sessionId }
      : { title: title.value, body: body.value, session_id: props.sessionId });
    open.value = false;
    reset();
    emit('created');
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
  finally {
    busy.value = false;
  }
}
</script>
