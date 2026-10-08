<template>
  <div ref="root" role="tree" aria-label="Changed files" class="py-1" @keydown="navigate">
    <button
      v-for="(row, index) in rows"
      :key="row.node.path"
      type="button"
      role="treeitem"
      :tabindex="row.node.path === focusPath ? 0 : -1"
      :aria-level="row.depth + 1"
      :aria-expanded="row.node.kind === 'directory' ? !collapsed.has(row.node.path) : undefined"
      :aria-selected="row.node.kind === 'file' ? row.node.path === selectedPath : undefined"
      :data-index="index"
      class="flex h-7 w-full min-w-0 items-center gap-1.5 pr-3 text-left text-[13px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      :class="row.node.kind === 'file' && row.node.path === selectedPath ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'"
      :style="{ paddingLeft: `${row.depth * 12 + 10}px` }"
      :title="row.node.kind === 'file' ? row.node.path : undefined"
      @focus="focusPath = row.node.path"
      @click="activate(row.node)"
    >
      <template v-if="row.node.kind === 'directory'">
        <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none" :class="{ 'rotate-90': !collapsed.has(row.node.path) }" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{{ row.node.name }}</span>
      </template>
      <template v-else>
        <DiffFileStatus :file="row.node.file" />
        <span class="min-w-0 flex-1 truncate" :class="{ 'line-through decoration-muted-foreground/60': row.node.file.status === 'deleted' }">{{ row.node.name }}</span>
        <DiffStat v-if="!row.node.file.binary" class="text-[11px] opacity-80" :additions="row.node.file.additions" :deletions="row.node.file.deletions" />
        <span v-else class="shrink-0 text-[11px] text-muted-foreground">binary</span>
      </template>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ChevronRight } from 'lucide-vue-next';
import DiffFileStatus from './DiffFileStatus.vue';
import DiffStat from './DiffStat.vue';
import { visibleDiffTreeRows, type DiffTreeNode } from '../lib/worktreeDiff';

const props = defineProps<{ tree: DiffTreeNode[]; selectedPath: string | null }>();
const emit = defineEmits<{ select: [path: string] }>();

const root = ref<HTMLElement>();
const collapsed = ref(new Set<string>());
const rows = computed(() => visibleDiffTreeRows(props.tree, collapsed.value));
const focusPath = ref<string | null>(null);

// One row stays tabbable: the focused one, else the selection, else the first.
watch([rows, () => props.selectedPath], () => {
  if (!rows.value.some((row) => row.node.path === focusPath.value)) {
    focusPath.value = rows.value.some((row) => row.node.path === props.selectedPath) ? props.selectedPath : rows.value[0]?.node.path ?? null;
  }
}, { immediate: true });

function toggle(path: string, open?: boolean): void {
  const next = new Set(collapsed.value);
  if (open ?? next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}

function activate(node: DiffTreeNode): void {
  if (node.kind === 'directory') toggle(node.path);
  else emit('select', node.path);
}

function focusRow(index: number): void {
  const row = rows.value[Math.max(0, Math.min(rows.value.length - 1, index))];
  if (!row) return;
  focusPath.value = row.node.path;
  void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-index="${rows.value.indexOf(row)}"]`)?.focus());
}

function navigate(event: KeyboardEvent): void {
  const index = rows.value.findIndex((row) => row.node.path === focusPath.value);
  const row = rows.value[index];
  if (!row) return;
  if (event.key === 'ArrowDown') focusRow(index + 1);
  else if (event.key === 'ArrowUp') focusRow(index - 1);
  else if (event.key === 'Home') focusRow(0);
  else if (event.key === 'End') focusRow(rows.value.length - 1);
  else if (event.key === 'ArrowRight' && row.node.kind === 'directory') toggle(row.node.path, true);
  else if (event.key === 'ArrowLeft' && row.node.kind === 'directory' && !collapsed.value.has(row.node.path)) toggle(row.node.path, false);
  else return;
  event.preventDefault();
}

// Reveal the selected file when it changes from outside the tree.
watch(() => props.selectedPath, async (path) => {
  if (!path) return;
  const hidden = [...collapsed.value].filter((directory) => path.startsWith(`${directory}/`));
  if (hidden.length) collapsed.value = new Set([...collapsed.value].filter((directory) => !hidden.includes(directory)));
  await nextTick();
  root.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
});
</script>
