<template>
  <SettingsPanel title="Status labels" description="A status label says why an agent is waiting, such as for a review or for CI. Agents pin one on themselves while they wait, and you can pin one from an agent's menu. Idle detection still shows whether an agent is working.">
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>

    <SettingsSection list title="Labels" scope="status_labels" :description="`Agents choose from these, guided by each description. They add their own only when you ask them to. Up to ${STATUS_LABEL_LIMIT}.`">
      <template #actions>
        <Button type="button" size="sm" variant="outline" :disabled="!loaded || labels.length >= STATUS_LABEL_LIMIT" @click="addLabel">Add label</Button>
      </template>

      <SettingsItem v-for="label in labels" :key="label.id" :save-key="`status_labels.${label.id}`">
        <template #title>
          <StatusLabelPill :label="label" />
          <Badge v-if="label.createdBy === 'agent'" variant="secondary" class="h-4 px-1.5 text-[10px] font-medium">Added by an agent</Badge>
        </template>
        <template v-if="label.description" #meta>
          <span :title="label.description">{{ label.description }}</span>
        </template>
        <template #actions>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2" @click="editLabel(label)">Edit</Button>
          <Button type="button" size="sm" variant="ghost" class="h-7 px-2 text-destructive hover:text-destructive" @click="removeLabel(label)">Delete</Button>
        </template>
      </SettingsItem>
      <p v-if="loaded && !labels.length" class="px-3.5 py-3 text-xs text-muted-foreground">No labels. Agents can't set a status until you add one.</p>
    </SettingsSection>

    <Dialog v-model:open="editorOpen">
      <DialogContent class="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ editor?.id ? 'Edit status label' : 'Add status label' }}</DialogTitle>
          <DialogDescription>Shown beside an agent's name while it is pinned.</DialogDescription>
        </DialogHeader>
        <form v-if="editor" class="space-y-4" @submit.prevent="applyEditor">
          <div class="grid items-center gap-3 sm:grid-cols-[90px_minmax(0,1fr)]">
            <label class="text-xs text-muted-foreground" for="status-label-name">Name</label>
            <Input id="status-label-name" v-model="editor.name" class="h-8 text-xs" placeholder="Waiting for review" maxlength="40" autocomplete="off" />
            <span class="self-start pt-1 text-xs text-muted-foreground" id="status-label-color">Colour</span>
            <div role="radiogroup" aria-labelledby="status-label-color" class="flex flex-wrap gap-1.5">
              <button
                v-for="color in STATUS_LABEL_COLORS"
                :key="color"
                type="button"
                role="radio"
                :aria-checked="editor.color === color"
                :aria-label="color"
                :title="color"
                :class="cn('flex h-6 w-6 items-center justify-center rounded-full border transition-[box-shadow] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', editor.color === color && 'ring-2 ring-foreground/80 ring-offset-2 ring-offset-background')"
                :style="statusLabelStyle(color)"
                @click="editor.color = color"
              >
                <span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: statusLabelDot(color) }" />
              </button>
            </div>
            <label class="self-start pt-1.5 text-xs text-muted-foreground" for="status-label-description">When to use</label>
            <Textarea id="status-label-description" v-model="editor.description" class="min-h-16 text-xs" maxlength="200" placeholder="A review of your work is running and you are waiting for its findings." />
            <span class="text-xs text-muted-foreground">Preview</span>
            <span class="flex"><StatusLabelPill :label="{ name: editor.name.trim() || 'Label', color: editor.color }" /></span>
          </div>
          <p v-if="editorError" role="alert" class="text-xs text-destructive">{{ editorError }}</p>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" @click="editorOpen = false">Cancel</Button>
            <Button type="submit" size="sm">{{ editor.id ? 'Save' : 'Add label' }}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </SettingsPanel>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { cn } from '@/lib/utils';
import { autosave, settingSaveStatus } from '../Composables/useSettingsAutosave';
import { STATUS_LABEL_COLORS, STATUS_LABEL_LIMIT, fetchStatusLabels, readStatusLabels, saveStatusLabels, statusLabelDot, statusLabelId, statusLabelStyle, type StatusLabel, type StatusLabelColor } from '../lib/statusLabels';
import { useTopicRefresh } from '../lib/serverQuery';
import { errorMessage } from '../lib/utils';
import SettingsItem from './settings/SettingsItem.vue';
import SettingsPanel from './settings/SettingsPanel.vue';
import SettingsSection from './settings/SettingsSection.vue';
import StatusLabelPill from './StatusLabelPill.vue';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

interface EditorState { id: string | null; name: string; color: StatusLabelColor; description: string }

const labels = ref<StatusLabel[]>([]);
const loaded = ref(false);
const error = ref('');
const editor = ref<EditorState | null>(null);
const editorOpen = ref(false);
const editorError = ref('');

onMounted(() => void load());

async function load(): Promise<void> {
  error.value = '';
  try {
    labels.value = (await readStatusLabels()).labels ?? [];
    loaded.value = true;
  } catch (caught) {
    error.value = errorMessage(caught);
  }
}

// Each edit applies here first, then to the saved list as it is now, so a
// label an agent added meanwhile survives. Edits save one at a time, and
// changes from elsewhere reload the list while none is pending.
type Edit = (labels: StatusLabel[]) => StatusLabel[];
let pending = 0;
let saving: Promise<unknown> = Promise.resolve();

useTopicRefresh(['settings'], () => { if (!pending) void load(); });

function persist(key: string, edit: Edit): void {
  labels.value = edit(labels.value);
  pending++;
  saving = saving.then(() => autosave(key, async () => {
    const latest = (await fetchStatusLabels()).labels;
    // Electron IPC cannot clone Vue's reactive proxies.
    const saved = await saveStatusLabels({ labels: edit(latest).map((label) => ({ ...label })) });
    if (pending === 1) labels.value = saved.labels;
  })).then(() => {
    pending--;
    if (settingSaveStatus(key)?.state === 'error' && !pending) void load();
  });
}

function addLabel(): void {
  editorError.value = '';
  // A colour no label uses yet, so a new label stands apart.
  const used = new Set(labels.value.map((label) => label.color));
  editor.value = { id: null, name: '', color: STATUS_LABEL_COLORS.find((color) => !used.has(color)) ?? 'blue', description: '' };
  editorOpen.value = true;
}

function editLabel(label: StatusLabel): void {
  editorError.value = '';
  editor.value = { id: label.id, name: label.name, color: label.color, description: label.description };
  editorOpen.value = true;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function applyEditor(): void {
  const current = editor.value;
  if (!current) return;
  const name = current.name.trim();
  if (!name) {
    editorError.value = 'Give the label a name.';
    return;
  }
  if (labels.value.some((label) => label.id !== current.id && sameName(label.name, name))) {
    editorError.value = `There is already a label called ${name}.`;
    return;
  }
  const description = current.description.trim();
  const { id, color } = current;
  if (id) {
    persist(`status_labels.${id}`, (list) => list.map((label) => label.id === id ? { ...label, name, color, description } : label));
  } else {
    persist('status_labels.list', (list) => list.some((label) => sameName(label.name, name)) ? list
      : [...list, { id: statusLabelId(name, list.map((label) => label.id)), name, color, description, createdBy: 'user' }]);
  }
  editorOpen.value = false;
}

// Agents showing a deleted label lose it.
function removeLabel(label: StatusLabel): void {
  persist('status_labels.list', (list) => list.filter((item) => item.id !== label.id));
}
</script>
