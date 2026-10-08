// Shared conversation stream contract. Providers project native notifications
// into these events; presentation applies them to an existing snapshot without
// reparsing the whole transcript. Snapshot rows use the same message shape, so
// a service-side snapshot and a stream event never disagree about one row.

import { createHash } from 'node:crypto';
import type { TranscriptImageRef } from './TranscriptImageStore';

export type IntegratedNoticeLevel = 'info' | 'warning' | 'error';

export interface IntegratedConversationTool {
  name: string;
  input?: unknown;
  state?: unknown;
  // Stored images the tool returned, shown by hash (see TranscriptImageStore).
  images?: TranscriptImageRef[] | undefined;
}

export interface IntegratedConversationMessage {
  id: string;
  // Correlates a native user row with the prompt submitted by this client.
  clientMessageId?: string | undefined;
  role: 'user' | 'assistant';
  // A notice is harness state rather than conversation: a retry, a
  // compaction, a warning, or a turn error.
  kind: 'text' | 'tool' | 'reasoning' | 'notice';
  level?: IntegratedNoticeLevel | undefined;
  text: string;
  title?: string | undefined;
  tool?: IntegratedConversationTool | undefined;
  // Native user content parts that are not text (images, mentions, skills).
  attachments?: Array<Record<string, unknown>> | undefined;
  // The tool row whose subagent produced this row (a Task, Agent or collab
  // call). The renderer nests it there.
  parentId?: string | undefined;
  // When the row began and finished, as ISO strings. Native provider times
  // win; otherwise the host's first-seen time.
  createdAt?: string | undefined;
  completedAt?: string | undefined;
}

// Session telemetry every provider projects into its snapshot as `usage`.
// Fields are optional: each harness reports a different subset, and a missing
// value is shown as unknown rather than zero.
export interface IntegratedUsage {
  // Tokens in the model's context for the latest request, and its window.
  contextTokens?: number;
  contextWindow?: number;
  // Totals for the native session (or for this run where the harness only
  // counts the running process).
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  // Account quota windows, for example Claude's five-hour limit, with when
  // the provider reported each one.
  limits?: Array<{ label: string; usedPercent: number; resetsAt?: string; observedAt?: string }>;
  // When the main agent last sent a model request (ISO time). Prompt caches
  // expire after a quiet period, so the renderer shows the time since then.
  lastModelActivityAt?: string;
}

// Work that runs alongside or after a turn: background shells, workflows,
// monitors, and subagents. Providers report it in their snapshot as `tasks`.
export interface IntegratedTask {
  id: string;
  label: string;
  // Native classification, for example local_bash, workflow, or subagent.
  kind?: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  // Latest progress or the final summary.
  detail?: string;
  // The provider can stop it through stopTask.
  stoppable?: boolean;
}

// Output of one background task, read on demand by the task drawer. A
// subagent returns its newest rows as `messages`, in the same shapes as the
// provider's snapshot, with a `cursor` for the page before them; reading with
// that cursor returns the older page. A shell returns the end of its output as
// `text`. `version` lets a poll skip unchanged output.
export type IntegratedTaskOutput =
  | { format: 'missing'; version: null }
  | { format: 'unchanged'; version: string }
  | { format: 'messages'; version: string; messages: unknown[]; cursor: string | null }
  | { format: 'text'; version: string; text: string; truncated: boolean };

export function messagesTaskOutput(messages: unknown[], cursor: string | null, since?: string | null): IntegratedTaskOutput {
  const version = outputVersion([messages, cursor]);
  return since === version ? { format: 'unchanged', version } : { format: 'messages', version, messages, cursor };
}

export function textTaskOutput(text: string, truncated: boolean, since?: string | null): IntegratedTaskOutput {
  const version = outputVersion([text, truncated]);
  return since === version ? { format: 'unchanged', version } : { format: 'text', version, text, truncated };
}

function outputVersion(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

// The queue shape is shared with the renderer's projection.
export { HELD_QUEUE_EVENT_ID, type IntegratedQueuedMessage } from './TranscriptProjection';

export type IntegratedDeliveryStatus = 'working' | 'idle' | 'error' | 'unknown';

export interface IntegratedConversationEvent {
  processId: string;
  revision: number;
  kind: 'replace' | 'append' | 'status' | 'pending' | 'error' | 'reconnecting';
  message?: IntegratedConversationMessage | undefined;
  id?: string | undefined;
  delta?: string | undefined;
  status?: IntegratedDeliveryStatus | undefined;
  detail?: string | undefined;
}

export type IntegratedConversationListener = (event: IntegratedConversationEvent) => void;

export interface IntegratedConversationSource {
  subscribe(processId: string, listener: IntegratedConversationListener): Promise<() => void>;
}
