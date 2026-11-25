import type { Component } from 'vue';
import { FolderGit2, Globe, Image as ImageIcon, Images, KeyRound, Link2, ListTodo, MonitorPlay, Network, NotebookPen, PanelRight } from 'lucide-vue-next';
import type { PinKind } from '../../lib/tiling';

// How each pinned panel is named in its tile's header and tabs.
export const PIN_META: Record<PinKind, { title: string; icon: Component }> = {
  browser: { title: 'Browser', icon: Globe },
  servers: { title: 'Servers', icon: MonitorPlay },
  agents: { title: 'Agents', icon: Network },
  todos: { title: 'Todos', icon: ListTodo },
  scratchpads: { title: 'Scratchpads', icon: NotebookPen },
  worktrees: { title: 'Worktrees', icon: FolderGit2 },
  links: { title: 'Links', icon: Link2 },
  secrets: { title: 'Secrets', icon: KeyRound },
  media: { title: 'Media', icon: Images },
  context: { title: 'Session context', icon: PanelRight },
  image: { title: 'Image', icon: ImageIcon }
};
