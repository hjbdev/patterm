<template>
  <div class="h-full min-h-0 overflow-y-auto bg-background p-4 md:p-6">
    <div v-if="!recordId" class="mx-auto w-full max-w-3xl pb-16">
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex h-8 items-center rounded-md bg-muted/40 p-0.5" role="tablist" aria-label="Show scratchpads">
          <button v-for="view in views" :key="view.value" type="button" role="tab" :aria-selected="tab === view.value" class="h-7 rounded-[5px] px-2.5 text-xs transition-colors" :class="tab === view.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="tab = view.value">
            {{ view.label }}<span v-if="loaded" class="ml-1.5 text-muted-foreground/70">{{ view.value === 'active' ? active.length : archived.length }}</span>
          </button>
        </div>
        <SearchField v-model="query" label="Search scratchpads" placeholder="Search" class="ml-auto h-8 w-56 max-sm:order-last max-sm:w-full" />
        <Button size="sm" variant="ghost" class="h-8 gap-1.5 px-2.5 text-muted-foreground max-sm:ml-auto" @click="create"><Plus class="h-4 w-4" />New</Button>
      </div>
      <div class="mt-4">
        <div v-for="pad in shown" :key="pad.id" class="group/row flex items-center gap-3 rounded-md px-2 transition-colors hover:bg-muted/40">
          <button type="button" class="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left outline-none focus-visible:underline" @click="open(pad.id)">
            <NotebookText class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate text-sm" :class="pad.status === 'archived' && 'text-muted-foreground'">{{ pad.title }}</span>
            <span class="shrink-0 text-xs text-muted-foreground">{{ relativeTime(pad.updated_at ?? null, now) }}</span>
          </button>
          <Button size="icon" variant="ghost" :class="ROW_ACTION" :aria-label="pad.status === 'archived' ? `Restore ${pad.title}` : `Archive ${pad.title}`" :title="pad.status === 'archived' ? 'Restore' : 'Archive'" @click="setArchived(pad, pad.status !== 'archived')">
            <component :is="pad.status === 'archived' ? ArchiveRestore : Archive" class="h-3.5 w-3.5" />
          </Button>
        </div>
        <p v-if="loaded && !shown.length" class="px-2 py-10 text-center text-sm text-muted-foreground">{{ query.trim() ? 'No matching scratchpads.' : tab === 'archived' ? 'Nothing archived.' : 'No scratchpads yet.' }}</p>
      </div>
      <p v-if="error || listError" role="alert" class="mt-2 px-2 text-xs text-destructive">{{ error || listError }}</p>
    </div>

    <article v-else class="mx-auto w-full max-w-[72ch] pb-16">
      <div class="flex h-8 items-center gap-1">
        <Button variant="ghost" size="sm" class="-ml-2 h-8 gap-1 px-2 text-muted-foreground" @click="back"><ChevronLeft class="h-4 w-4" />Scratchpads</Button>
        <span v-if="record" role="status" class="ml-auto text-xs text-muted-foreground/80">{{ saveLabel !== 'Saved' ? saveLabel : editing ? 'Editing' : '' }}</span>
        <ScratchpadMenu v-if="record" v-model:status="status" @copy="copyDraft" @delete="destroy" />
      </div>
      <template v-if="record">
        <div v-if="status === 'archived'" class="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Archive class="h-3.5 w-3.5" />Archived ·
          <button type="button" class="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline" @click="status = 'active'">Restore</button>
        </div>
        <textarea ref="titleInput" v-model="title" aria-label="Title" maxlength="500" rows="1" placeholder="Untitled" class="doc-title w-full resize-none bg-transparent text-3xl font-semibold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/60" :class="status === 'archived' ? 'mt-3' : 'mt-6'" @keydown.enter.prevent="field?.start()" @keydown.esc.prevent="titleInput?.blur()" />
        <p class="mt-2 text-xs text-muted-foreground">Edited {{ relativeTime(record.updated_at ?? null, now) }}<template v-if="lineCount"> · {{ lineCount }} {{ lineCount === 1 ? 'line' : 'lines' }}</template></p>
        <div v-if="saveError" role="alert" class="mt-4 space-y-2 rounded-md border border-destructive p-3 text-sm">
          <p>{{ saveError }} Keep this tab open or copy your draft before closing it.</p>
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" @click="copyDraft">Copy draft</Button>
            <Button size="sm" variant="outline" @click="reload">Reload latest</Button>
            <Button size="sm" variant="outline" @click="save">Retry save</Button>
          </div>
        </div>
        <div class="mt-8">
          <MarkdownField ref="field" v-model="body" v-model:editing="editing" mono label="Content" placeholder="Click to start writing…" min-height-class="min-h-64" />
        </div>
        <div class="mt-12 border-t border-border/60 pt-5">
          <ExternalReferences :key="record.id" :project-id="projectId" target-type="scratchpad" :target-id="record.id" />
        </div>
      </template>
      <p v-if="recordError" role="alert" class="mt-6 text-sm text-destructive">{{ recordError }}</p>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Archive, ArchiveRestore, ChevronLeft, NotebookText, Plus } from 'lucide-vue-next';
import { Button } from '../Components/ui/button';
import MarkdownField from '../Components/MarkdownField.vue';
import SearchField from '../Components/SearchField.vue';
import ExternalReferences from '../Components/ExternalReferences.vue';
import ScratchpadMenu from '../Components/scratchpads/ScratchpadMenu.vue';
import { ROW_ACTION } from '../Components/session-context/rowAction';
import { useScratchpadPage } from '../Composables/useScratchpadPage';
import { useContextRecord } from '../Composables/useContextRecord';
import { useContextClock, useContextVersion } from '../lib/projectContext';
import { relativeTime } from '../lib/format';

const { projectId, recordId, query, error, active, archived, loaded, listError, refresh, open, close, create, setArchived } = useScratchpadPage();
const { record, title, body, status, error: recordError, saveError, saveLabel, save, remove, reload, copyDraft, refresh: refreshRecord } = useContextRecord(ref<'scratchpad'>('scratchpad'), projectId, recordId, { onChanged: () => void refresh() });
useContextVersion(() => projectId.value, refreshRecord);
const now = useContextClock();
const views = [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }] as const;
const tab = ref<'active' | 'archived'>('active'), editing = ref(false);
const field = ref<InstanceType<typeof MarkdownField> | null>(null), titleInput = ref<HTMLTextAreaElement | null>(null);
const shown = computed(() => tab.value === 'active' ? active.value : archived.value);
const lineCount = computed(() => body.value.trim() ? body.value.split('\n').length : 0);

// A new, empty scratchpad opens ready to write: a placeholder title is selected
// so typing replaces it, otherwise the body opens for editing.
watch(record, async (value, previous) => {
  if (!value || value.id === previous?.id) return;
  editing.value = false;
  if (body.value.trim()) return;
  if (!/^Untitled( scratchpad)?$/.test(title.value)) {
    editing.value = true;
    return;
  }
  await nextTick();
  titleInput.value?.focus();
  titleInput.value?.select();
});

// Going back shows the list the scratchpad belongs to.
function back() {
  tab.value = status.value === 'archived' ? 'archived' : 'active';
  void close();
}

async function destroy() {
  if (await remove()) await close();
}
</script>

<style scoped>
.doc-title { field-sizing: content; }
</style>
