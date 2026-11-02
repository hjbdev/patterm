import { FACE_HUES } from '../Harness/ProfileLook';

// What the renderer shares with app/Services/StatusLabels, without its zod.

// The face palette's hues and graphite, so labels match profile and bot faces.
export const STATUS_LABEL_COLORS = [...FACE_HUES, 'graphite'] as const;
export type StatusLabelColor = (typeof STATUS_LABEL_COLORS)[number];

// A stable id from a label's name, unique within the list.
export function statusLabelId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'label';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}
