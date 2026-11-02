import { STATUS_LABEL_COLORS, type StatusLabelColor } from '../../../app/Services/StatusLabelCommon';
import { faceWash, facePalette } from './faces';
import { topicChanged, topicRead } from './serverQuery';

// Status labels: a short state pinned on an agent, such as "Waiting for
// review", configured in Settings › Status labels. These shapes mirror
// app/Services/StatusLabels, which the renderer can't import with its zod.

export { STATUS_LABEL_COLORS, type StatusLabelColor };

export interface StatusLabel {
  id: string;
  name: string;
  color: StatusLabelColor;
  description: string;
  createdBy: 'user' | 'agent';
}

export interface StatusLabelSettings { labels: StatusLabel[] }

export const STATUS_LABEL_LIMIT = 30;

export function readStatusLabels(): Promise<StatusLabelSettings> {
  return topicRead('settings', ['status_labels'], async () => await window.patterm.call('settings_status_labels_get', {}) as StatusLabelSettings);
}

// Settings edits one label at a time, so the server applies each edit to the
// list as it is then, keeping labels agents added meanwhile.
export async function saveStatusLabel(label: { id: string | null; name: string; color: StatusLabelColor; description: string }): Promise<StatusLabelSettings> {
  const saved = await window.patterm.call('settings_status_label_save', label) as StatusLabelSettings;
  topicChanged('settings');
  return saved;
}

export async function deleteStatusLabel(id: string): Promise<StatusLabelSettings> {
  const saved = await window.patterm.call('settings_status_label_delete', { id }) as StatusLabelSettings;
  topicChanged('settings');
  return saved;
}

// Pins a label on an agent, by id, or clears it with null.
export async function setAgentStatus(processId: string, labelId: string | null): Promise<void> {
  await window.patterm.call('process_status_set', { process_id: processId, label: labelId });
}

// A pill's wash and a dot's fill in the label's colour.
export function statusLabelStyle(color: StatusLabelColor): { backgroundColor: string; borderColor: string; color: string } {
  const { background, border } = faceWash(color);
  return { backgroundColor: background, borderColor: border, color: color === 'graphite' ? 'hsl(var(--muted-foreground))' : facePalette(color).acc2 };
}

export function statusLabelDot(color: StatusLabelColor): string {
  return color === 'graphite' ? facePalette('graphite').top : facePalette(color).acc;
}
