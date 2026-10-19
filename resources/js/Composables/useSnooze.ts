import { reactive, ref } from 'vue';
import { toast } from 'vue-sonner';
import { agentLabel } from '../lib/agentTabs';
import type { SessionRecord } from '../types';

const SHOW_SNOOZED_KEY = 'patterm.showSnoozed.v1';

// Whether snoozed agents show in the tab strip and sidebar, remembered on
// this device. Hidden by default: snoozing is for getting them out of the way.
export const showSnoozed = ref(readShowSnoozed());

export function setShowSnoozed(value: boolean): void {
  showSnoozed.value = value;
  try {
    localStorage.setItem(SHOW_SNOOZED_KEY, String(value));
  } catch {
    // Kept for this session only.
  }
}

function readShowSnoozed(): boolean {
  try {
    return localStorage.getItem(SHOW_SNOOZED_KEY) === 'true';
  } catch {
    return false;
  }
}

// Snoozing tucks an agent away until its next message. Menus open the one
// dialog the workbench renders, which takes an optional reminder.
export const snoozeDialog = reactive({
  open: false,
  busy: false,
  processId: '',
  name: '',
  reminder: ''
});

// A paired host's agents are its own to snooze.
export function canSnooze(session: SessionRecord): boolean {
  return Boolean(session.processId && !session.host && !session.exitedAt);
}

export function openSnooze(session: SessionRecord): void {
  if (!session.processId) return;
  Object.assign(snoozeDialog, { open: true, busy: false, processId: session.processId, name: agentLabel(session), reminder: '' });
}

export async function snoozeConfirmed(): Promise<void> {
  if (snoozeDialog.busy) return;
  snoozeDialog.busy = true;
  try {
    await window.patterm.call('agent_snooze', { process_id: snoozeDialog.processId, ...(snoozeDialog.reminder.trim() ? { reminder: snoozeDialog.reminder } : {}) });
    snoozeDialog.open = false;
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : 'Could not snooze the agent');
  } finally {
    snoozeDialog.busy = false;
  }
}

export function unsnooze(processId: string): void {
  void window.patterm.call('agent_unsnooze', { process_id: processId })
    .catch((caught: unknown) => toast.error(caught instanceof Error ? caught.message : 'Could not wake the agent'));
}

export function dismissReminder(processId: string): void {
  void window.patterm.call('agent_snooze_reminder_dismiss', { process_id: processId })
    .catch((caught: unknown) => toast.error(caught instanceof Error ? caught.message : 'Could not dismiss the reminder'));
}
