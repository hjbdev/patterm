<template>
  <Dialog :open="Boolean(draft)" @update:open="(open) => { if (!open) close() }">
    <DialogScrollContent class="max-w-2xl grid-cols-[minmax(0,1fr)] gap-0 border-white/[0.06] bg-background p-0" @open-auto-focus.prevent>
      <template v-if="draft">
        <DialogTitle class="sr-only">{{ draft.name }}</DialogTitle>
        <DialogDescription class="sr-only">Edit when this routine runs, which agent it starts, and what it asks.</DialogDescription>
        <header class="flex items-center gap-2 px-5 pb-2 pr-12 pt-4">
          <AgentIcon :harness="draft.harness" class="h-4 w-4 text-muted-foreground" />
          <Input :model-value="draft.name" aria-label="Name" maxlength="120" class="h-9 min-w-0 flex-1 rounded-sm border-0 px-1 text-base font-semibold shadow-none focus-visible:ring-1" @update:model-value="rename(String($event))" />
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 text-muted-foreground" aria-label="Routine actions"><MoreHorizontal class="h-4 w-4" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem @select="emit('duplicate', draft)">Duplicate</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem class="text-destructive focus:text-destructive" @select="confirmingDelete = true">Delete routine</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <div class="px-5 pb-5 pt-3">
          <RoutineSentenceEditor :routine="draft" :harnesses="harnesses" :projects="projects" :bots="bots" :presets="presets" :models="models" @change="change" />
          <p v-if="draft.created_by.type === 'agent'" class="mt-2 text-xs text-muted-foreground">Created by {{ draft.created_by.name ?? 'an agent' }}.</p>
          <section aria-label="Recent runs" class="mt-5 border-t border-white/[0.06] pt-4">
            <p class="mb-1 text-xs text-muted-foreground">Recent runs</p>
            <RoutineRunList :runs="runs" :now="now" @open="emit('openRun', $event)" />
          </section>
        </div>

        <div v-if="confirmingDelete" role="alertdialog" aria-label="Delete routine" class="flex flex-wrap items-center gap-3 border-t border-white/[0.06] px-5 py-3">
          <p class="min-w-0 flex-1 text-xs">Delete {{ draft.name }} and its run history? Running agents keep running.</p>
          <Button variant="ghost" size="sm" class="h-8 text-xs" @click="confirmingDelete = false">Cancel</Button>
          <Button variant="ghost" size="sm" class="h-8 text-xs text-destructive hover:text-destructive" @click="remove">Delete</Button>
        </div>
        <footer v-else class="flex flex-wrap items-center gap-3 border-t border-white/[0.06] px-5 py-3">
          <p class="min-w-0 flex-1 truncate text-xs" :class="error ? 'text-destructive' : 'text-muted-foreground'" role="status">
            {{ error || `${nextRunLabel(draft, now)} · ${draft.timezone}${saving ? ' · Saving…' : ''}` }}
          </p>
          <label class="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch :model-value="draft.enabled" @update:model-value="change({ enabled: Boolean($event) })" />On schedule
          </label>
          <Button variant="outline" size="sm" class="h-8 gap-1.5 text-xs" :disabled="starting" @click="runNow"><Play class="h-3.5 w-3.5" />Run now</Button>
        </footer>
      </template>
    </DialogScrollContent>
  </Dialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { MoreHorizontal, Play } from 'lucide-vue-next';
import AgentIcon from '../AgentIcon.vue';
import { Button } from '../ui/button';
import { Dialog, DialogDescription, DialogScrollContent, DialogTitle } from '../ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import RoutineRunList from './RoutineRunList.vue';
import RoutineSentenceEditor from './RoutineSentenceEditor.vue';
import { useRoutineAutosave } from '../../Composables/useRoutineAutosave';
import {
  deleteRoutine, nextRunLabel, routineRuns, runRoutineNow, updateRoutine,
  type RoutineDeliveryBot, type RoutineModelOption, type RoutinePatch, type RoutinePresetOption, type RoutineRecord, type RoutineRunRecord
} from '../../lib/routines';

const props = defineProps<{
  routine: RoutineRecord | null;
  now: number;
  host?: string | null;
  harnesses: readonly string[];
  projects: ReadonlyArray<{ id: string; name: string }>;
  bots?: readonly RoutineDeliveryBot[] | undefined;
  presets: RoutinePresetOption[];
  models: Record<string, RoutineModelOption[]>;
  // Bumped by the page when routine data changes, so open runs refresh.
  revision: number;
}>();
const emit = defineEmits<{ close: []; saved: [routine: RoutineRecord]; deleted: [routineId: string]; duplicate: [routine: RoutineRecord]; openRun: [run: RoutineRunRecord] }>();

// Edits apply to the draft at once and save shortly after, like Settings.
const draft = ref<RoutineRecord | null>(null);
const runs = ref<RoutineRunRecord[]>([]);
const starting = ref(false);
const error = ref('');
const confirmingDelete = ref(false);
let activeHost: string | null = props.host ?? null;
const editKey = (host: string | null, routineId: string) => `${host ?? ''}\0${routineId}`;
const splitEditKey = (key: string): { host: string | null; routineId: string } => {
  const split = key.indexOf('\0');
  return split < 0 ? { host: null, routineId: key } : { host: split > 0 ? key.slice(0, split) : null, routineId: key.slice(split + 1) };
};
const autosave = useRoutineAutosave({
  save: (key, patch) => {
    const { host, routineId } = splitEditKey(key);
    return updateRoutine(routineId, patch, host);
  },
  onSaved: (saved, key) => {
    const { host } = splitEditKey(key);
    if (host !== activeHost) return;
    if (draft.value?.routine_id === saved.routine_id && !autosave.hasPending(key)) draft.value = { ...saved };
    emit('saved', saved);
  },
  onError: (key, message) => {
    const { host, routineId } = splitEditKey(key);
    if (host === activeHost && draft.value?.routine_id === routineId) error.value = message ?? '';
  }
});
const saving = autosave.saving;

watch(() => [props.routine?.routine_id, props.host ?? null] as const, ([, nextHost]) => {
  void autosave.flush();
  activeHost = nextHost;
  draft.value = props.routine ? { ...props.routine } : null;
  error.value = '';
  confirmingDelete.value = false;
  runs.value = [];
  void loadRuns();
}, { immediate: true });

// Server copies replace the draft only while nothing is waiting to save.
watch(() => props.routine, (routine) => {
  if (routine && draft.value?.routine_id === routine.routine_id && !autosave.hasPending(editKey(activeHost, routine.routine_id)) && !saving.value) draft.value = { ...routine };
});
watch(() => props.revision, () => void loadRuns());

async function loadRuns(): Promise<void> {
  const id = draft.value?.routine_id;
  const host = activeHost;
  if (!id) return;
  try {
    const loaded = await routineRuns(id, 10, host);
    if (draft.value?.routine_id === id && activeHost === host) runs.value = loaded;
  } catch {
    // The routine may have just been deleted.
  }
}

function change(patch: RoutinePatch): void {
  if (!draft.value) return;
  draft.value = { ...draft.value, ...patch };
  autosave.change(editKey(activeHost, draft.value.routine_id), patch);
}

function rename(name: string): void {
  if (name.trim()) change({ name });
  else if (draft.value) draft.value = { ...draft.value, name };
}

// Run now uses the routine it was clicked on, after its edits have saved.
async function runNow(): Promise<void> {
  if (!draft.value) return;
  const routineId = draft.value.routine_id;
  const host = activeHost;
  starting.value = true;
  try {
    if (!(await autosave.flush(editKey(host, routineId)))) return;
    await runRoutineNow(routineId, host);
    if (draft.value?.routine_id === routineId && activeHost === host) await loadRuns();
  } catch (cause) {
    if (draft.value?.routine_id === routineId && activeHost === host) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    starting.value = false;
  }
}

async function remove(): Promise<void> {
  if (!draft.value) return;
  const id = draft.value.routine_id;
  const host = activeHost;
  autosave.discard(editKey(host, id));
  try {
    await deleteRoutine(id, host);
    if (activeHost === host) emit('deleted', id);
  } catch (cause) {
    if (activeHost === host) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      confirmingDelete.value = false;
    }
  }
}

function close(): void {
  void autosave.flush();
  emit('close');
}

onBeforeUnmount(() => void autosave.flush());
</script>
