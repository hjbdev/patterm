import type { ReorderDrop } from '../../Composables/useSidebarReorder';
import { isFolderKey } from '../../lib/tabStrip';
import type { SidebarContext } from './sidebarContext';

const folderId = (key: string) => key.slice('folder:'.length);

const groupProject = (group: string | undefined) => group?.startsWith('project:') ? group.slice('project:'.length) : undefined;

// Alt+arrows and drags move folders too, within the group they show in:
// grouped by project, a folder keeps that project.
export function moveSidebarRow(sidebar: SidebarContext, key: string, beforeKey: string | null, afterKey: string | null, group?: string): void {
  if (isFolderKey(key)) sidebar.moveFolder(folderId(key), beforeKey, afterKey, groupProject(group));
  else sidebar.moveTab(key, beforeKey, afterKey);
}

// A drag's drop: a folder moves among the rows; a tab moves beside other
// rows, into a folder dropped on, or among a folder's rows. A line drawn just
// under an open folder's row is the top of the folder: `firstIn` names its
// first row.
export function dropSidebarRow(sidebar: SidebarContext, key: string, { group, beforeKey, afterKey, into, line }: ReorderDrop, firstIn: (folder: string) => string | null): void {
  if (isFolderKey(key)) return moveSidebarRow(sidebar, key, beforeKey, afterKey, group);
  if (into) return sidebar.placeTab(key, folderId(into));
  if (isFolderKey(group)) return sidebar.placeTab(key, folderId(group), beforeKey, afterKey);
  const below = line?.edge === 'after' && isFolderKey(line.key) ? line.key : null;
  const first = below ? firstIn(below) : null;
  if (below && first && first !== key) return sidebar.placeTab(key, folderId(below), first, null);
  sidebar.placeTab(key, null, beforeKey, afterKey);
}
