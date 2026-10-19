import { reactive } from 'vue';
import { toast } from 'vue-sonner';
import type { ProjectSummary } from '../types';

// Menus open the one project snooze dialog the workbench renders.
export const projectSnoozeDialog = reactive({
  open: false,
  busy: false,
  projectId: '',
  name: ''
});

// A paired host's projects are its own to snooze.
export function canSnoozeProject(project: ProjectSummary): boolean {
  return !project.host;
}

export function openProjectSnooze(project: ProjectSummary): void {
  Object.assign(projectSnoozeDialog, { open: true, busy: false, projectId: project.id, name: project.name });
}

export async function snoozeProjectUntil(until: Date): Promise<void> {
  if (projectSnoozeDialog.busy) return;
  projectSnoozeDialog.busy = true;
  try {
    await window.patterm.call('project_snooze', { project_id: projectSnoozeDialog.projectId, until: until.toISOString() });
    projectSnoozeDialog.open = false;
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : 'Could not snooze the project');
  } finally {
    projectSnoozeDialog.busy = false;
  }
}

export function wakeProject(projectId: string): void {
  void window.patterm.call('project_wake', { project_id: projectId })
    .catch((caught: unknown) => toast.error(caught instanceof Error ? caught.message : 'Could not wake the project'));
}
