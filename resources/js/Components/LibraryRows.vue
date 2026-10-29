<template>
  <!-- The project's pages, each saying what's new, then the canvas where
       there's room for it. `compact` sizes them for the sidebar's menu. -->
  <button v-for="row in rows" :key="row.page" type="button" :class="[classes.row, sidebar.page.value === row.page && 'bg-primary/10']" :aria-current="sidebar.page.value === row.page ? 'page' : undefined" @click="open(row.page)">
    <component :is="row.icon" :class="classes.icon" />
    <span class="min-w-0 flex-1">
      <span class="block truncate">{{ row.label }}</span>
      <span v-if="row.detail" :class="classes.detail">{{ row.detail }}</span>
    </span>
    <span v-if="row.page === 'media' && media.gallery.value.length" class="flex shrink-0 gap-1">
      <span v-for="image in media.gallery.value.slice(0, 3)" :key="image.key" :class="compact ? 'w-7' : 'w-9'"><MediaThumb :image="image" :project-id="projectId" decorative /></span>
    </span>
    <span v-else-if="row.count" :class="classes.count">{{ row.count }}</span>
  </button>
  <!-- Phones can't show the canvas. -->
  <button v-if="!phoneLayout" type="button" :class="classes.row" @click="openCanvas">
    <Workflow :class="classes.icon" />
    <span class="min-w-0 flex-1">
      <span class="block truncate">Canvas</span>
      <span :class="classes.detail">The project's agents laid out as cards</span>
    </span>
    <kbd class="shrink-0 rounded border border-border/70 px-1 text-[10px] text-muted-foreground">Ctrl ⇧ Space</kbd>
  </button>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Workflow } from 'lucide-vue-next';
import MediaThumb from './peek/MediaThumb.vue';
import { useSidebar, type SidebarPage } from './Sidebar/sidebarContext';
import { projectPages } from './Sidebar/sidebarPages';
import { useBoardRoute } from '../Composables/useBoard';
import { useMedia } from '../Composables/useMedia';
import { useWorkbench } from '../Composables/useWorkbench';
import { phoneLayout } from '../lib/phoneLayout';
import { contextRead, useContextVersion, type Page, type Scratchpad, type Todo } from '../lib/projectContext';

const props = defineProps<{ compact?: boolean }>();
const emit = defineEmits<{ navigate: [] }>();
const classes = computed(() => props.compact
  ? { row: 'flex min-h-10 w-full items-center gap-2.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', icon: 'h-4 w-4 shrink-0 text-muted-foreground', detail: 'block truncate text-xs text-muted-foreground', count: 'shrink-0 text-xs tabular-nums text-muted-foreground' }
  : { row: 'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-[15px] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:min-h-11 sm:text-[13.5px]', icon: 'h-[18px] w-[18px] shrink-0 text-muted-foreground sm:h-4 sm:w-4', detail: 'block truncate text-[13px] text-muted-foreground sm:text-xs', count: 'shrink-0 text-sm tabular-nums text-muted-foreground sm:text-xs' });

const sidebar = useSidebar();
const board = useBoardRoute();
const { projects } = useWorkbench();
const projectId = computed(() => sidebar.projectId.value);

// What's new on each page: the newest worktree, the next open todo, the
// latest scratchpad, and the newest images.
const todos = ref<Page<Todo> | null>(null), notes = ref<Page<Scratchpad> | null>(null);
function load(): void {
  const id = projectId.value;
  contextRead<Page<Todo>>('todo_list', id, { status: 'open', limit: 1 }).then((page) => { if (id === projectId.value) todos.value = page; }, () => undefined);
  contextRead<Page<Scratchpad>>('scratchpad_list', id, { status: 'active', limit: 1 }).then((page) => { if (id === projectId.value) notes.value = page; }, () => undefined);
}
watch(projectId, load, { immediate: true });
useContextVersion(() => projectId.value, load);
const media = useMedia({ get projectId() { return projectId.value; } }, { pageSize: 3 });
const newestWorktree = computed(() => projects.value.find((item) => item.project.id === projectId.value)?.worktrees.at(-1)?.branch ?? null);

const rows = computed(() => projectPages(sidebar).map((link) => {
  switch (link.page) {
    case 'worktrees': return { ...link, detail: newestWorktree.value };
    case 'history': return { ...link, detail: 'Every conversation, searchable' };
    case 'todos': return { ...link, detail: todos.value?.items[0]?.title ?? null, count: todos.value?.total };
    case 'scratchpads': return { ...link, detail: notes.value?.items[0]?.title ?? null, count: notes.value?.total };
    case 'media': return { ...link, detail: media.total.value ? `${media.total.value} ${media.total.value === 1 ? 'image' : 'images'}` : null };
    default: return { ...link, detail: null };
  }
}));

function open(page: SidebarPage): void {
  sidebar.navigate(page);
  emit('navigate');
}
function openCanvas(): void {
  board.toggle();
  emit('navigate');
}
</script>
