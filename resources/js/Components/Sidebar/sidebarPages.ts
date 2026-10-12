import type { Component } from 'vue';
import { FolderGit2, History, Images, ListTodo, NotebookPen } from 'lucide-vue-next';
import type { SidebarContext, SidebarPage } from './sidebarContext';

// The project pages linked from the sidebar footer and the collapsed rail.
export function projectPages(sidebar: SidebarContext): { page: SidebarPage; label: string; icon: Component; count?: number }[] {
  return [
    // The Personal project is not a repository, so it has no worktrees.
    ...(sidebar.repository.value ? [{ page: 'worktrees' as const, label: 'Worktrees', icon: FolderGit2, count: sidebar.worktreeCount.value }] : []),
    { page: 'history', label: 'History', icon: History },
    { page: 'todos', label: 'Todos', icon: ListTodo },
    { page: 'scratchpads', label: 'Scratchpads', icon: NotebookPen },
    { page: 'media', label: 'Media', icon: Images }
  ];
}
