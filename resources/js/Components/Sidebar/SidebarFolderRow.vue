<template>
  <!-- A folder's row, shaped like an agent's: a folder in the status slot, its
       name, and over the end a dot per member while folded, or their count
       while open. Clicking it opens or folds it. -->
  <div class="group/row relative">
    <ContextMenu>
      <ContextMenuTrigger as-child>
        <button
          type="button"
          data-sidebar-row
          :data-row-key="key"
          :data-node="key"
          data-expandable="true"
          :data-expanded="String(open)"
          :aria-expanded="open"
          :aria-label="`${folder.name}, folder, ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`"
          :class="cn(
            'relative isolate flex h-7 w-full min-w-0 select-none items-center gap-2 rounded-tab pl-2 text-left text-[13px] transition-[color,background-color,box-shadow] hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            holdsSelection ? 'bg-primary/10 text-foreground' : 'text-foreground/85',
            dropTarget && 'bg-primary/15 ring-1 ring-inset ring-primary/60'
          )"
          :style="{ paddingRight: `${reserve}px` }"
          @click="emit('toggle')"
        >
          <span class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
            <FolderOpen v-if="open" class="h-[15px] w-[15px]" :stroke-width="1.75" aria-hidden="true" />
            <Folder v-else class="h-[15px] w-[15px]" :stroke-width="1.75" aria-hidden="true" />
          </span>
          <span class="min-w-0 truncate">{{ folder.name }}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent class="w-52">
        <ContextMenuItem @select="openRenameFolder(folder)">
          <Pencil class="h-4 w-4" /><span>Rename</span>
        </ContextMenuItem>
        <ContextMenuItem @select="openNewFolder()">
          <FolderPlus class="h-4 w-4" /><span>New folder…</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem @select="sidebar.deleteFolder(folder.id)">
          <FolderX class="h-4 w-4" /><span>Delete folder</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    <span class="pointer-events-none absolute right-2 top-1 flex h-5 items-center text-muted-foreground">
      <FolderDots v-if="!open && tabs.length" :tabs="tabs" />
      <MemberCount v-else-if="tabs.length" :count="tabs.length" open />
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Folder, FolderOpen, FolderPlus, FolderX, Pencil } from 'lucide-vue-next';
import { cn } from '@/lib/utils';
import { folderKey, type StripTab, type TabFolder } from '../../lib/tabStrip';
import FolderDots from '../FolderDots.vue';
import MemberCount from '../MemberCount.vue';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu';
import { openNewFolder, openRenameFolder } from './sidebarActions';
import { useSidebar } from './sidebarContext';

// Deleting a folder leaves its agents where it was.
const props = defineProps<{ folder: TabFolder; tabs: readonly StripTab[]; open: boolean; dropTarget?: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
const sidebar = useSidebar();
const key = computed(() => folderKey(props.folder.id));
// A folded folder holding the selection is highlighted, so you can see where you are.
const holdsSelection = computed(() => !props.open && props.tabs.some((tab) => tab.kind === 'agent' ? sidebar.familyActive(tab.family) : sidebar.processActive(tab.process)));
// The name keeps clear of the dots laid over the end.
const reserve = computed(() => 12 + (props.open ? 10 : Math.min(props.tabs.length, 6) * 8 + (props.tabs.length > 6 ? 14 : 0)));
</script>
