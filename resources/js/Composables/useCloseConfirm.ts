import { reactive } from 'vue';
import { toast } from 'vue-sonner';

// Closing an agent or process stops it, so every close button and menu item
// asks first. The workbench renders the one dialog.
export const closeConfirm = reactive({
  open: false,
  busy: false,
  processId: '',
  name: '',
  kind: 'agent' as 'agent' | 'process'
});

export function confirmClose(processId: string, name: string, kind: 'agent' | 'process'): void {
  Object.assign(closeConfirm, { open: true, busy: false, processId, name, kind });
}

export async function closeConfirmed(): Promise<void> {
  if (closeConfirm.busy) return;
  closeConfirm.busy = true;
  try {
    await window.patterm.call('close_process', { process_id: closeConfirm.processId });
    closeConfirm.open = false;
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : `Could not close ${closeConfirm.kind}`);
  } finally {
    closeConfirm.busy = false;
  }
}
