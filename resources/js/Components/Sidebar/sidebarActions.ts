import { reactive } from 'vue';
import { toast } from 'vue-sonner';
import { agentLabel } from '../../lib/agentTabs';
import type { ProcessRecord, SessionRecord } from '../../types';

// The tab strip's context-menu actions, shared by every sidebar row. The host
// renders the rename and timer dialogs once.
export const sidebarDialogs = reactive({
  renameOpen: false,
  renameTargetId: '',
  renameKind: 'agent' as 'agent' | 'process',
  renameName: '',
  timerOpen: false,
  timerTargetId: null as string | null,
  timerTargetName: null as string | null
});

function lifecycleId(session: SessionRecord): string {
  return session.processId ?? session.id;
}

export function openRename(target: { session: SessionRecord } | { process: ProcessRecord }): void {
  if ('session' in target) Object.assign(sidebarDialogs, { renameKind: 'agent', renameTargetId: lifecycleId(target.session), renameName: agentLabel(target.session) });
  else Object.assign(sidebarDialogs, { renameKind: 'process', renameTargetId: target.process.id, renameName: target.process.name });
  sidebarDialogs.renameOpen = true;
}

export function openTimer(session: SessionRecord): void {
  Object.assign(sidebarDialogs, { timerTargetId: lifecycleId(session), timerTargetName: agentLabel(session), timerOpen: true });
}

export function copyId(id: string | null | undefined): void {
  if (id) void navigator.clipboard.writeText(id).catch(() => toast.error('Could not copy process ID'));
}

export async function closeTarget(id: string, noun: string): Promise<void> {
  try {
    await window.patterm.call('close_process', { process_id: id });
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : `Could not close ${noun}`);
  }
}

export function closeSession(session: SessionRecord): Promise<void> {
  return closeTarget(lifecycleId(session), 'agent');
}
