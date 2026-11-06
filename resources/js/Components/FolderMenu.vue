<template>
  <!-- A menu's Folder submenu: file the tab in a folder, a new one, or none.
       `dropdown` builds it from dropdown parts, for a ⋯ menu. -->
  <component :is="parts.Sub">
    <component :is="parts.SubTrigger">
      <FolderInput class="h-4 w-4" />
      <span>Move to folder</span>
    </component>
    <component :is="parts.SubContent" class="w-52">
      <component :is="parts.Item" v-for="folder in sidebar.layout.value.folders" :key="folder.id" @select="sidebar.placeTab(tab.key, folder.id)">
        <Folder class="h-4 w-4" />
        <span class="min-w-0 flex-1 truncate">{{ folder.name }}</span>
        <Check v-if="tab.folder === folder.id" class="h-4 w-4" />
      </component>
      <component :is="parts.Item" @select="openNewFolder([tab.key])">
        <FolderPlus class="h-4 w-4" />
        <span>New folder…</span>
      </component>
      <template v-if="tab.folder">
        <component :is="parts.Separator" />
        <component :is="parts.Item" @select="sidebar.placeTab(tab.key, null, null, folderKey(tab.folder))">
          <FolderOutput class="h-4 w-4" />
          <span>Remove from folder</span>
        </component>
      </template>
    </component>
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Check, Folder, FolderInput, FolderOutput, FolderPlus } from 'lucide-vue-next';
import { folderKey, type StripTab } from '../lib/tabStrip';
import { openNewFolder } from './Sidebar/sidebarActions';
import { useSidebar } from './Sidebar/sidebarContext';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from './ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from './ui/dropdown-menu';

// A tab taken out of its folder sits just after it.
const props = defineProps<{ tab: StripTab; dropdown?: boolean }>();
const sidebar = useSidebar();
const parts = computed(() => props.dropdown
  ? { Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent, Item: DropdownMenuItem, Separator: DropdownMenuSeparator }
  : { Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent, Item: ContextMenuItem, Separator: ContextMenuSeparator });
</script>
