// Projects this device visited, newest first. The top bar shows a few beside
// the project switcher.
const RECENT_PROJECTS_KEY = 'patterm.projects.recent';
const RECENT_PROJECTS_LIMIT = 10;
export const RECENT_PROJECTS_SHOWN = 3;

export function readRecentProjectIds(storage: Pick<Storage, 'getItem'> | undefined): string[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(RECENT_PROJECTS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, RECENT_PROJECTS_LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberRecentProject(recentIds: string[], id: string, storage: Pick<Storage, 'setItem'> | undefined): string[] {
  if (recentIds[0] === id) return recentIds;
  const next = [id, ...recentIds.filter((item) => item !== id)].slice(0, RECENT_PROJECTS_LIMIT);
  try {
    storage?.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
  } catch { /* Recent projects still last until reload. */ }
  return next;
}

// The recent projects to show: ones that still exist, other than the active one.
export function shownRecentProjects<T extends { project: { id: string } }>(recentIds: string[], projects: T[], activeProjectId: string | null): T[] {
  return recentIds
    .filter((id) => id !== activeProjectId)
    .flatMap((id) => projects.find((project) => project.project.id === id) ?? [])
    .slice(0, RECENT_PROJECTS_SHOWN);
}
