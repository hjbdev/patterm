import { z } from 'zod';
import { STATUS_LABEL_COLORS } from './StatusLabelCommon';

// Status labels: a short state an agent or the user pins on an agent, such as
// "Waiting for review". They sit beside its activity, which idle detection
// still reports. The owner keeps the list in Settings; colours come from the
// face palette, so labels match profile and bot faces.
export { STATUS_LABEL_COLORS, statusLabelId, type StatusLabelColor } from './StatusLabelCommon';
export const STATUS_LABEL_LIMIT = 30;

export const statusLabelColorInput = z.enum(STATUS_LABEL_COLORS);
export const statusLabelNameInput = z.string().trim().min(1).max(40);
const descriptionInput = z.string().trim().max(200);

export const statusLabelInput = z.object({
  id: z.string().trim().min(1).max(80),
  name: statusLabelNameInput,
  color: statusLabelColorInput,
  // When agents should use it, shown to them by status_label_list.
  description: descriptionInput.default(''),
  // Labels an agent made at the user's request say so in Settings.
  createdBy: z.enum(['user', 'agent']).default('user')
}).strict();

export type StatusLabel = z.infer<typeof statusLabelInput>;

export const statusLabelSettingsInput = z.object({
  labels: z.array(statusLabelInput).max(STATUS_LABEL_LIMIT)
}).strict().superRefine((settings, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  settings.labels.forEach((label, index) => {
    if (ids.has(label.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['labels', index, 'id'], message: `Duplicate status label id ${label.id}` });
    const name = label.name.toLowerCase();
    if (names.has(name)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['labels', index, 'name'], message: `Duplicate status label ${label.name}` });
    ids.add(label.id);
    names.add(name);
  });
});

export type StatusLabelSettings = z.infer<typeof statusLabelSettingsInput>;

// What a fresh install starts with; the owner can edit or delete each one.
export const DEFAULT_STATUS_LABELS: StatusLabelSettings = {
  labels: [
    { id: 'waiting-for-review', name: 'Waiting for review', color: 'amber', description: 'A review of your work is running, such as a review loop, and you are waiting for its findings.', createdBy: 'user' },
    { id: 'waiting-on-ci', name: 'Waiting on CI', color: 'sky', description: 'Your change is pushed and you are waiting for CI checks.', createdBy: 'user' },
    { id: 'blocked', name: 'Blocked', color: 'red', description: 'You cannot go on until something outside your control changes.', createdBy: 'user' },
    { id: 'needs-input', name: 'Needs input', color: 'violet', description: 'You need a decision or information from the user before going on.', createdBy: 'user' },
    { id: 'ready-to-merge', name: 'Ready to merge', color: 'green', description: 'Your work is reviewed and green, waiting for the user to merge or ship it.', createdBy: 'user' }
  ]
};

export const createStatusLabelInput = z.object({
  name: statusLabelNameInput,
  color: statusLabelColorInput,
  description: descriptionInput.optional()
}).strict();

// A label named by id or by name, ignoring case and surrounding spaces.
export function findStatusLabel(labels: StatusLabel[], wanted: string): StatusLabel | null {
  const key = wanted.trim().toLowerCase();
  return labels.find((label) => label.id === wanted.trim()) ?? labels.find((label) => label.name.toLowerCase() === key) ?? null;
}
