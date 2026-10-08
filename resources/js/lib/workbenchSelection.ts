import type { ProjectWorkbench } from '../types';

export interface WorkbenchSelectionState {
  activeProjectId: string | null;
}

export function resolveWorkbenchSelection(projects: ProjectWorkbench[], active: WorkbenchSelectionState): WorkbenchSelectionState {
  return { activeProjectId: projects.some((group) => group.project.id === active.activeProjectId) ? active.activeProjectId : null };
}
