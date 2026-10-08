// Client-visible data that a change can affect. Clients update or refetch only
// the views that depend on a changed topic. Workbench changes reach clients as
// versioned snapshot patches; the other topics are refetch signals.
export const CHANGE_TOPICS = ['workbench', 'context', 'settings', 'mcp-servers', 'routines'] as const;

export type ChangeTopic = typeof CHANGE_TOPICS[number];

// Writes that do not declare their effects may change any workbench or
// project context data.
export const DEFAULT_CHANGE_TOPICS: readonly ChangeTopic[] = ['workbench', 'context'];

export function isChangeTopic(value: unknown): value is ChangeTopic {
  return typeof value === 'string' && (CHANGE_TOPICS as readonly string[]).includes(value);
}
