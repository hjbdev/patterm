<template>
  <div class="flex min-h-0 flex-col gap-2">
    <Input
      ref="queryInput"
      v-model="query"
      class="font-mono text-xs"
      spellcheck="false"
      autocomplete="off"
      aria-label="Server path"
      :placeholder="placeholder"
      @keydown="onKeydown"
    />

    <div ref="list" class="h-72 overflow-y-auto rounded-md border border-border/70 p-1" role="listbox" aria-label="Folders">
      <button
        v-if="current?.parent && !filter"
        type="button"
        class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/45"
        @click="open(current.parent)"
      >
        <CornerLeftUp class="size-3.5 shrink-0" />
        <span>..</span>
      </button>
      <button
        v-for="(entry, index) in visible"
        :key="entry.path"
        type="button"
        role="option"
        :aria-selected="index === highlighted"
        :data-index="index"
        :class="['flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors', index === highlighted ? 'bg-muted/60' : '']"
        @click="open(entry.path)"
        @mousemove="highlighted = index"
      >
        <Folder class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate">{{ entry.name }}</span>
        <span v-if="entry.git" class="text-[11px] text-muted-foreground">git</span>
      </button>
      <p v-if="current && visible.length === 0" class="px-2 py-1.5 text-sm text-muted-foreground">{{ filter ? 'No matching folders' : 'No folders' }}</p>
      <p v-if="current?.truncated" class="px-2 py-1.5 text-xs text-muted-foreground">Showing the first {{ current.entries.length }} matches. Type to narrow.</p>
    </div>

    <p v-if="error" class="text-xs text-destructive">{{ error }}</p>

    <div class="flex items-center justify-between gap-3">
      <span class="min-w-0 truncate font-mono text-xs text-muted-foreground" :title="current?.path">{{ current && !drives ? displayServerPath(current.path, current.home) : '' }}</span>
      <div class="flex shrink-0 gap-2">
        <Button type="button" variant="ghost" size="sm" @click="emit('cancel')">Cancel</Button>
        <Button type="button" size="sm" :disabled="!current || drives" @click="current && !drives && emit('select', current.path)">Select folder</Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { CornerLeftUp, Folder } from 'lucide-vue-next';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { focusElement } from '../Composables/useAutofocus';
import { DRIVES_PATH, directoryPlaceholder, displayServerPath, splitDirectoryQuery, withTrailingSlash, type DirectoryListing } from '../lib/directoryPicker';

const props = defineProps<{ initial?: string }>();
const emit = defineEmits<{ select: [path: string]; cancel: [] }>();

const queryInput = ref<{ $el?: unknown } | null>(null);
const list = ref<HTMLElement | null>(null);
const query = ref('');
const listing = ref<DirectoryListing | null>(null);
const error = ref('');
const highlighted = ref(0);
// The listing request in flight, and the folder the shown listing is for.
let requested = '';
const loadedDirectory = ref<string | null>(null);

const split = computed(() => splitDirectoryQuery(query.value));
const filter = computed(() => split.value.filter);
// Rows, completion and picking only use a listing for the folder typed now,
// never one left over from an earlier folder while the next loads or after it
// failed.
const current = computed(() => listing.value && loadedDirectory.value === directoryKey(split.value.directory, filter.value) ? listing.value : null);
// A Windows server lists its drive letters above each drive root; they only navigate.
const drives = computed(() => current.value?.path === DRIVES_PATH);
const placeholder = computed(() => directoryPlaceholder(listing.value?.home));
const visible = computed(() => {
  const needle = filter.value.toLowerCase();
  const entries = current.value?.entries ?? [];
  return needle ? entries.filter((entry) => entry.name.toLowerCase().includes(needle)) : entries;
});

function directoryKey(directory: string, typed: string): string {
  return `${directory}\0${typed.startsWith('.')}`;
}

// The server filters too, so folders past its entry cap stay reachable by typing.
async function load(directory: string, typed: string): Promise<void> {
  const key = `${directoryKey(directory, typed)}\0${typed}`;
  if (key === requested) return;
  requested = key;
  try {
    const result = await window.patterm.call('fs_directories', { path: directory, filter: typed, show_hidden: typed.startsWith('.') }) as DirectoryListing;
    if (requested !== key) return;
    listing.value = result;
    loadedDirectory.value = directoryKey(directory, typed);
    error.value = '';
    if (!query.value) query.value = withTrailingSlash(result.path);
  } catch (caught) {
    if (requested !== key) return;
    loadedDirectory.value = null;
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

watch(query, (value) => {
  const { directory, filter: typed } = splitDirectoryQuery(value);
  highlighted.value = 0;
  void load(directory, typed);
});

watch(highlighted, async (index) => {
  await nextTick();
  list.value?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
});

function open(path: string): void {
  query.value = withTrailingSlash(path);
  focusElement(queryInput);
}

function onKeydown(event: KeyboardEvent): void {
  const count = visible.value.length;
  if (event.key === 'ArrowDown' && count) {
    event.preventDefault();
    highlighted.value = (highlighted.value + 1) % count;
  } else if (event.key === 'ArrowUp' && count) {
    event.preventDefault();
    highlighted.value = (highlighted.value - 1 + count) % count;
  } else if (event.key === 'Tab' && !event.shiftKey && filter.value && count) {
    event.preventDefault();
    open(visible.value[highlighted.value]!.path);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    // Enter opens the highlighted match, or picks the listed folder when
    // nothing is typed after the slash. Ctrl/Cmd+Enter picks either directly.
    const entry = filter.value ? visible.value[highlighted.value] : undefined;
    if (filter.value && !entry) return;
    if (entry && !(event.metaKey || event.ctrlKey)) open(entry.path);
    else if (current.value && (entry || !drives.value)) emit('select', entry?.path ?? current.value.path);
  }
}

onMounted(() => {
  query.value = props.initial?.trim() ? withTrailingSlash(props.initial.trim()) : '';
  if (!query.value) void load('', '');
  focusElement(queryInput);
});
</script>
