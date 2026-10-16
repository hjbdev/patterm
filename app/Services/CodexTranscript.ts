import { randomUUID } from 'node:crypto';
import type {
  IntegratedConversationEvent,
  IntegratedConversationMessage,
  IntegratedDeliveryStatus
} from './IntegratedConversation';
import type { TranscriptImageStore } from './TranscriptImageStore';

export type JsonRecord = Record<string, unknown>;

// Projected conversation messages use the same shape the renderer already
// consumes for snapshots, so streamed updates need no provider branching there.
export type CodexProjectedMessage = IntegratedConversationMessage;
export type CodexDeliveryStatus = IntegratedDeliveryStatus;
export type CodexConversationEvent = Omit<IntegratedConversationEvent, 'processId'>;

// One projected conversation per subscribed process. Snapshots are copied from
// this state under the same synchronous step that applies an event, so the
// revision on a snapshot describes exactly the messages it contains while
// native deltas keep arriving.
export interface CodexConversationState {
  revision: number;
  messages: IntegratedConversationMessage[];
  // The agent's effective status: its own turn, its running subagents, and
  // requests waiting for the user. `unknown` until a native read says.
  status: CodexDeliveryStatus;
  detail?: string | undefined;
  truncated: boolean;
  historyUnavailable?: boolean;
  // Native cursor for items older than the seeded window. Trimming the live
  // window makes it skip rows, so the next snapshot reads a fresh one.
  cursor?: string | null;
  cursorStale?: boolean;
}

export const CODEX_MESSAGE_WINDOW = 200;
// Subagent rows have their own budget, so busy subagents never push the
// agent's own rows out of the window.
export const CODEX_CHILD_WINDOW = 320;
// Title of a row holding a plan Codex proposed in Plan mode.
export const CODEX_PLAN_TITLE = 'Plan';

export function trimCodexWindow(state: CodexConversationState): void {
  const own = state.messages.filter((message) => !message.parentId).length;
  const nested = state.messages.length - own;
  let dropOwn = Math.max(0, own - CODEX_MESSAGE_WINDOW);
  let dropNested = Math.max(0, nested - CODEX_CHILD_WINDOW);
  if (!dropOwn && !dropNested) return;
  if (dropOwn) {
    state.truncated = true;
    state.cursorStale = true;
  }
  state.messages = state.messages.filter((message) => {
    if (!message.parentId && dropOwn > 0) { dropOwn--; return false; }
    if (message.parentId && dropNested > 0) { dropNested--; return false; }
    return true;
  });
}

// A refreshed cursor points before the oldest row of a fresh native listing.
// The live window can have lost rows the listing still holds, for example
// when synthetic notices push native rows out, so those rows are put back
// ahead of the window: the cursor and the window then meet with no gap. The
// listing is in chronological order.
export function restoreCodexWindowGap(state: CodexConversationState, listing: IntegratedConversationMessage[]): void {
  const present = new Set(state.messages.map((message) => message.id));
  const shared = listing.findIndex((message) => present.has(message.id));
  const gap = (shared < 0 ? listing : listing.slice(0, shared)).filter((message) => !present.has(message.id));
  if (gap.length) state.messages = [...gap, ...state.messages];
}

// Native item times in epoch milliseconds, as row times. Older items and
// builds report none.
export function codexTimes(startedAtMs: unknown, completedAtMs: unknown): Pick<CodexProjectedMessage, 'createdAt' | 'completedAt'> {
  const iso = (value: unknown): string | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;
  const createdAt = iso(startedAtMs);
  const completedAt = iso(completedAtMs);
  return { ...(createdAt ? { createdAt } : {}), ...(completedAt ? { completedAt } : {}) };
}

// A replaced row keeps the time it began, and its finish time when the
// replacement has none (item/completed carries no start time).
export function keepCodexTimes(current: CodexProjectedMessage | undefined, message: CodexProjectedMessage): CodexProjectedMessage {
  const createdAt = current?.createdAt ?? message.createdAt;
  const completedAt = message.completedAt ?? current?.completedAt;
  if (createdAt === message.createdAt && completedAt === message.completedAt) return message;
  return { ...message, ...(createdAt ? { createdAt } : {}), ...(completedAt ? { completedAt } : {}) };
}

export function applyCodexConversationEvent(state: CodexConversationState, event: CodexConversationEvent): void {
  if (event.kind === 'replace' && event.message) {
    const index = state.messages.findIndex((current) => current.id === event.message!.id);
    const message = keepCodexTimes(state.messages[index], event.message);
    if (index < 0) state.messages.push(message);
    else state.messages[index] = message;
    trimCodexWindow(state);
    return;
  }
  if ((event.kind === 'append' || event.kind === 'error') && event.id) {
    const delta = event.delta ?? '';
    const index = state.messages.findIndex((message) => message.id === event.id);
    if (index < 0) state.messages.push({ id: event.id, role: 'assistant', kind: 'text', text: delta });
    else state.messages[index] = { ...state.messages[index]!, text: `${state.messages[index]!.text}${delta}` };
    return;
  }
  if (event.kind === 'status' && event.status) {
    state.status = event.status;
    state.detail = event.detail;
  }
}

// Text from a native item only ever appends, so a snapshot and the deltas that
// were in flight around it overlap on one side. Merge at the largest
// suffix/prefix overlap so the snapshot never regresses and deltas it already
// contains are not replayed; a completion replace settles any ambiguity. The
// overlap scan is capped because deltas are small.
export function mergeCodexText(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current.endsWith(incoming)) return current;
  const max = Math.min(current.length, incoming.length, 4096);
  for (let length = max; length > 0; length--) {
    if (current.endsWith(incoming.slice(0, length))) return current + incoming.slice(length);
  }
  return current + incoming;
}

// Events received while the initial native read was in flight are reconciled
// into the read instead of being dropped. Replaces merge their text so an
// earlier `item/started` cannot regress the snapshot, and accumulated deltas
// extend the snapshot only by the part it does not already contain. Completion
// is not required for the partial text to be correct.
export function mergeCodexSeedEvents(state: CodexConversationState, events: CodexConversationEvent[]): void {
  const pending = new Map<string, string>();
  for (const event of events) {
    if (event.kind === 'append' && event.id) {
      pending.set(event.id, (pending.get(event.id) ?? '') + (event.delta ?? ''));
      continue;
    }
    if (event.kind === 'replace' && event.message) {
      const message = event.message;
      const index = state.messages.findIndex((current) => current.id === message.id);
      if (index < 0) state.messages.push(message);
      else state.messages[index] = { ...keepCodexTimes(state.messages[index], message), text: mergeCodexText(state.messages[index]!.text, message.text) };
      continue;
    }
    applyCodexConversationEvent(state, event);
  }
  for (const [id, delta] of pending) {
    const index = state.messages.findIndex((message) => message.id === id);
    if (index < 0) state.messages.push({ id, role: 'assistant', kind: 'text', text: delta });
    else state.messages[index] = { ...state.messages[index]!, text: mergeCodexText(state.messages[index]!.text, delta) };
  }
}

// With a store, image parts and viewed images become stored references.
export function projectCodexItem(value: unknown, images?: TranscriptImageStore | null): CodexProjectedMessage | null {
  const item = record(value);
  const type = typeof item.type === 'string' ? item.type : '';
  const id = typeof item.id === 'string' ? item.id : randomUUID();
  if (type === 'userMessage') {
    const content = Array.isArray(item.content) ? item.content.map(record) : [];
    const text = content.filter((part) => part.type === 'text').map((part) => String(part.text ?? '')).join('\n');
    const attachments = content.flatMap((part) => {
      const attachment = userAttachment(part, images);
      return attachment ? [attachment] : [];
    });
    return { id, role: 'user', kind: 'text', text, ...(typeof item.clientId === 'string' ? { clientMessageId: item.clientId } : {}), ...(attachments.length ? { attachments } : {}) };
  }
  if (type === 'agentMessage') return { id, role: 'assistant', kind: 'text', text: text(item.text) };
  // A plan proposed in Plan mode. The title marks it for the approval card;
  // text rows do not show titles.
  if (type === 'plan') return { id, role: 'assistant', kind: 'text', title: CODEX_PLAN_TITLE, text: text(item.text) };
  if (type === 'reasoning') {
    const parts = [...strings(item.summary), ...strings(item.content)].filter(Boolean);
    return { id, role: 'assistant', kind: 'reasoning', text: parts.join('\n\n') };
  }
  if (type === 'commandExecution') {
    return {
      id,
      role: 'assistant',
      kind: 'tool',
      title: text(item.command) || 'Command',
      text: text(item.aggregatedOutput),
      tool: {
        name: 'commandExecution',
        input: {
          command: item.command, cwd: item.cwd, processId: item.processId, source: item.source,
          exitCode: item.exitCode, durationMs: item.durationMs
        },
        state: item.status
      }
    };
  }
  if (type === 'fileChange') {
    const { text: body, changes } = fileChanges(item);
    return {
      id, role: 'assistant', kind: 'tool', title: 'File changes', text: body,
      tool: { name: 'fileChange', input: { changes }, state: item.status }
    };
  }
  if (type === 'mcpToolCall') {
    const server = text(item.server);
    const tool = text(item.tool) || 'MCP tool';
    return {
      id, role: 'assistant', kind: 'tool', title: server ? `${server}: ${tool}` : tool,
      text: toolResultText(item.result, item.error),
      tool: {
        name: 'mcpToolCall',
        input: { server: item.server, tool: item.tool, arguments: item.arguments, durationMs: item.durationMs },
        state: item.status
      }
    };
  }
  if (type === 'dynamicToolCall') {
    const namespace = text(item.namespace);
    const tool = text(item.tool) || 'Tool';
    return {
      id, role: 'assistant', kind: 'tool', title: namespace ? `${namespace}/${tool}` : tool,
      text: outputBody(item.contentItems),
      tool: {
        name: 'dynamicToolCall',
        input: { namespace: item.namespace, tool: item.tool, arguments: item.arguments, success: item.success, durationMs: item.durationMs },
        state: item.status
      }
    };
  }
  if (type === 'functionCallOutput') {
    return {
      id, role: 'assistant', kind: 'tool', title: text(item.name) || 'Function output',
      text: outputBody(item.output),
      tool: { name: 'functionCallOutput', input: { name: item.name, namespace: item.namespace } }
    };
  }
  if (type === 'contextCompaction') {
    return { id, role: 'assistant', kind: 'notice', level: 'info', text: 'Context compacted' };
  }
  if (type === 'collabAgentToolCall') {
    // Codex's native subagent tools (spawn, wait, send input, close). Spawned
    // threads nest their own rows under the spawnAgent row.
    const tool = text(item.tool) || 'agent';
    const states = Object.entries(record(item.agentsStates)).map(([thread, value]) => {
      const state = record(value);
      return [thread, text(state.status), text(state.message)].filter(Boolean).join(' · ');
    });
    return {
      id, role: 'assistant', kind: 'tool', title: COLLAB_TITLES[tool] ?? tool,
      text: states.join('\n'),
      tool: {
        name: 'agent',
        input: {
          tool, description: item.prompt ?? undefined, subagent_type: item.model ?? undefined,
          reasoningEffort: item.reasoningEffort, receiverThreadIds: item.receiverThreadIds, agentsStates: item.agentsStates
        },
        state: item.status
      }
    };
  }
  if (type === 'subAgentActivity') {
    const kind = text(item.kind) || 'activity';
    return {
      id, role: 'assistant', kind: 'tool', title: `Agent ${kind}`, text: '',
      tool: { name: 'subAgentActivity', input: { path: item.agentPath, agentThreadId: item.agentThreadId, kind }, state: kind === 'interrupted' ? 'failed' : 'completed' }
    };
  }
  if (type === 'webSearch') {
    const action = record(item.action);
    return {
      id, role: 'assistant', kind: 'tool', title: 'Web search', text: '',
      tool: { name: 'webSearch', input: { query: text(item.query) || text(action.query) || undefined, url: text(action.url) || undefined, action: item.action }, state: 'completed' }
    };
  }
  if (type === 'imageView') {
    const image = images?.fromFile(item.path);
    return { id, role: 'assistant', kind: 'tool', title: 'View image', text: '', tool: { name: 'read', input: { path: item.path }, state: 'completed', ...(image ? { images: [image] } : {}) } };
  }
  if (type === 'enteredReviewMode' || type === 'exitedReviewMode') {
    const review = text(item.review);
    return { id, role: 'assistant', kind: 'text', text: type === 'enteredReviewMode' ? `Reviewing ${review || 'changes'}` : review || 'Review finished' };
  }
  // Unknown and uncommon items stay inspectable instead of being dropped or
  // rendered as assistant prose.
  if (type) return { id, role: 'assistant', kind: 'tool', title: type, text: JSON.stringify(item, null, 2) };
  return null;
}

const COLLAB_TITLES: Record<string, string> = {
  spawnAgent: 'Spawn agent', sendInput: 'Message agent', sendMessage: 'Message agent', resumeAgent: 'Resume agent',
  wait: 'Wait for agents', closeAgent: 'Close agent', followupTask: 'Follow-up task', interruptAgent: 'Interrupt agent', listAgents: 'List agents'
};

// Native delta methods map to an existing projected message id. Absent
// `item/started` frames are handled by the caller as partial upserts.
export function projectCodexDelta(method: string, value: unknown): { id: string; delta: string } | null {
  const params = record(value);
  const id = typeof params.itemId === 'string' ? params.itemId : null;
  const delta = typeof params.delta === 'string' ? params.delta : null;
  if (!id || delta === null) return null;
  if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta' || method === 'item/plan/delta') {
    return { id, delta };
  }
  if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') return { id, delta };
  return null;
}

// `item/fileChange/patchUpdated` replaces the whole change set for one item.
export function projectCodexPatchUpdated(value: unknown): CodexProjectedMessage | null {
  const params = record(value);
  const id = typeof params.itemId === 'string' ? params.itemId : null;
  if (!id) return null;
  const { text: body, changes } = fileChanges(params);
  return {
    id, role: 'assistant', kind: 'tool', title: 'File changes', text: body,
    tool: { name: 'fileChange', input: { changes } }
  };
}

// update_plan's checklist, as the shared todo shape. One row per turn that the
// next update replaces.
export function projectCodexPlan(value: unknown): CodexProjectedMessage | null {
  const params = record(value);
  if (!Array.isArray(params.plan)) return null;
  const todos = params.plan.map(record).map((step) => ({ content: text(step.step), status: text(step.status) }));
  return {
    id: `plan_${text(params.turnId) || randomUUID()}`, role: 'assistant', kind: 'tool', title: 'Plan', text: text(params.explanation),
    tool: { name: 'todowrite', input: { todos }, state: 'completed' }
  };
}

export interface CodexStatus {
  status: CodexDeliveryStatus;
  detail?: string | undefined;
}

export function projectCodexStatus(method: string, value: unknown): CodexStatus | null {
  const params = record(value);
  if (method === 'turn/started') return { status: 'working' };
  if (method === 'turn/completed') {
    const turn = record(params.turn);
    const status = text(turn.status) || 'completed';
    if (status === 'failed') {
      const detail = text(record(turn.error).message);
      return { status: 'error', ...(detail ? { detail } : {}) };
    }
    if (status === 'interrupted') return { status: 'idle', detail: 'Interrupted' };
    return { status: 'idle' };
  }
  if (method === 'thread/status/changed') {
    const status = codexThreadStatus(params.status);
    return status ? { status } : null;
  }
  return null;
}

// A native thread status. An active thread waiting on an approval or on
// input is waiting for the user, not working; an approval comes first.
export function codexThreadStatus(value: unknown): CodexDeliveryStatus | null {
  const status = record(value);
  if (status.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    if (flags.includes('waitingOnApproval')) return 'permission';
    return flags.includes('waitingOnUserInput') ? 'question' : 'working';
  }
  if (status.type === 'systemError') return 'error';
  if (status.type === 'idle' || status.type === 'notLoaded') return 'idle';
  return null;
}

// A turn error is a notice. One that Codex will retry is a warning that the
// next attempt replaces, not a failed turn.
export function projectCodexError(value: unknown): CodexProjectedMessage | null {
  const params = record(value);
  const error = record(params.error);
  const message = text(error.message).trim();
  if (!message) return null;
  const turnId = typeof params.turnId === 'string' ? params.turnId : randomUUID();
  const details = text(error.additionalDetails).trim();
  if (params.willRetry === true) {
    return { id: `retry_${turnId}`, role: 'assistant', kind: 'notice', level: 'warning', text: `${message}; retrying` };
  }
  return { id: `error_${turnId}`, role: 'assistant', kind: 'notice', level: 'error', text: details ? `${message}\n${details}` : message };
}

// Codex warnings and reroutes that are not tied to one item.
export function projectCodexNotice(method: string, value: unknown): CodexProjectedMessage | null {
  const params = record(value);
  if (method === 'warning' && text(params.message)) {
    return { id: `warning_${randomUUID()}`, role: 'assistant', kind: 'notice', level: 'warning', text: text(params.message) };
  }
  if (method === 'configWarning' || method === 'deprecationNotice') {
    const summary = text(params.summary);
    if (!summary) return null;
    const detail = [text(params.details), text(params.path)].filter(Boolean).join('\n');
    return { id: `${method}_${randomUUID()}`, role: 'assistant', kind: 'notice', level: 'warning', text: detail ? `${summary}\n${detail}` : summary };
  }
  if (method === 'model/rerouted' && text(params.toModel)) {
    const reason = text(params.reason);
    return {
      id: `reroute_${text(params.turnId) || randomUUID()}`, role: 'assistant', kind: 'notice', level: 'info',
      text: `Switched from ${text(params.fromModel) || 'the selected model'} to ${text(params.toModel)}${reason ? ` (${reason})` : ''}`
    };
  }
  return null;
}

function userAttachment(part: JsonRecord, images?: TranscriptImageStore | null): JsonRecord | null {
  const type = text(part.type);
  if (!type || type === 'text') return null;
  if (type === 'localImage') {
    const filename = text(part.path).split(/[\\/]/).pop() || 'Image';
    const image = images?.fromFile(part.path);
    return { type, name: filename.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, ''), ...(image ? { sha256: image.sha256 } : {}) };
  }
  const attachment: JsonRecord = { type };
  if (typeof part.detail === 'string') attachment.detail = part.detail;
  if (typeof part.path === 'string') attachment.path = part.path;
  if (typeof part.name === 'string') attachment.name = part.name;
  // Inline data URLs can hold megabytes of base64. Keep the descriptor without
  // pushing the payload through the event channel; richer display can resolve
  // the local upload path instead.
  if (typeof part.url === 'string' && part.url.length <= 4096 && !part.url.startsWith('data:')) attachment.url = part.url;
  const image = type === 'image' ? images?.fromDataUrl(part.url) : null;
  if (image) attachment.sha256 = image.sha256;
  return attachment;
}

function fileChanges(item: JsonRecord): { text: string; changes: JsonRecord[] } {
  const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
  const body = changes.map((change) => {
    const header = [text(change.kind), text(change.path)].filter(Boolean).join(' ');
    const diff = text(change.diff);
    return diff ? `${header}\n${diff}` : header;
  }).filter(Boolean).join('\n\n');
  return { text: body, changes };
}

function toolResultText(result: unknown, error: unknown): string {
  const body = outputBody(result);
  if (body) return body;
  const message = text(record(error).message);
  if (message) return message;
  return JSON.stringify(result ?? error ?? '', null, 2) ?? '';
}

function outputBody(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.flatMap((item) => typeof record(item).text === 'string' ? [String(record(item).text)] : []);
    if (parts.length) return parts.join('\n');
  }
  const json = JSON.stringify(value ?? '', null, 2);
  return json ?? '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
