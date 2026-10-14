// Projection of Integrated conversations, for the conversation pane and for
// agents reading other agents. Native providers send different payload
// shapes; services normalise questions into one shared shape and this module
// keeps readers free of provider branching. Everything here is pure so the
// smoke tests can exercise it without a browser.

export type TranscriptToolFamily = 'shell' | 'read' | 'list' | 'glob' | 'grep' | 'edit' | 'write' | 'patch' | 'web' | 'task' | 'todo' | 'skill' | 'mcp' | 'generic';
export type TranscriptToolStatus = 'running' | 'completed' | 'failed' | 'pending';

export interface TranscriptToolFile {
  name?: string;
  uri?: string;
  mime?: string;
  // Per-file diff and counts. Bare hunks stay with their filename instead of
  // being concatenated into an unattributed blob.
  patch?: string;
  additions?: number;
  deletions?: number;
}

// A stored transcript image, fetched by hash when shown. Rows never carry
// image bytes.
export interface TranscriptImage {
  sha256: string;
  mime?: string;
  name?: string | undefined;
  width?: number;
  height?: number;
}

// One compact tool row, classified from the native tool name and its structured
// state. Families drive the transcript rendering; the raw input/state stay
// available so richer renderers never lose provider data.
export interface TranscriptTool {
  name: string;
  family: TranscriptToolFamily;
  status: TranscriptToolStatus;
  title: string;
  input?: unknown;
  state?: unknown;
  // Native structured tool result (for example a Claude Edit result with
  // filePath, originalFile, structuredPatch, and an optional gitDiff). Kept so
  // real diffs can be rendered instead of flattening every field away.
  result?: unknown;
  target?: string;
  args?: string[];
  command?: string;
  output?: string;
  error?: string;
  patch?: string;
  changes?: { additions: number; deletions: number };
  files?: TranscriptToolFile[];
  // Images the tool returned, such as a read screenshot.
  images?: TranscriptImage[];
  // A todo or plan tool's list, in order.
  checklist?: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }>;
}

export interface TranscriptMessage {
  id: string;
  clientMessageId?: string;
  delivery?: { state: 'sending' | 'accepted' | 'uncertain' | 'failed'; messageId: string; error?: string };
  role: 'user' | 'assistant';
  kind: 'text' | 'tool' | 'reasoning' | 'notice';
  // Notice severity: retries and compaction are info, warnings are warning.
  level?: 'info' | 'warning' | 'error';
  text: string;
  title?: string;
  tool?: TranscriptTool;
  // Preserved user-message attachments for later transcript display.
  attachments?: Array<Record<string, unknown>> | undefined;
  redactionCount?: number;
  fileReferences?: string[];
  // The tool row (a Task, Agent or collab call) whose subagent produced this
  // row. Nested rows render inside that row instead of the main transcript.
  parentId?: string;
  // Filled by nesting for display: this row's subagent transcript, in order.
  children?: TranscriptMessage[];
  // When the row began and finished, as ISO strings. Native provider times
  // win; otherwise the host's first-seen time. Either may be missing.
  createdAt?: string;
  completedAt?: string;
  approval?: {
    riskLevel: string | null;
    userAuthorization: string | null;
    outcome: string | null;
    rationale: string | null;
  };
  archived?: boolean;
}

export interface TranscriptAttachment {
  name: string;
  detail?: string;
  // Only a safe, already-resolvable URL is kept; data: payloads are never
  // expanded in the transcript and server paths are never read.
  url?: string;
  // A stored image, fetched by hash.
  sha256?: string;
  mime?: string;
  image: boolean;
}

export interface IntegratedPermission {
  id: string;
  action: string;
  resources: string[];
  // False when the provider cannot persist a rule for this request.
  always?: boolean;
  // Truthful scope label for the persistent action (for example a session rule).
  alwaysLabel?: string;
  // Native labels when a request's choices mean something else, such as
  // Claude's plan approval.
  onceLabel?: string;
  rejectLabel?: string;
  // Why the agent asks, and what exactly it wants to do.
  detail?: string;
  command?: string;
  cwd?: string;
  patch?: string;
  plan?: string;
  // The native deny reply carries feedback for the agent.
  feedback?: boolean;
}

export interface IntegratedFormOption {
  value: string;
  label: string;
  description?: string;
}

export interface IntegratedFormCondition {
  key: string;
  op: 'eq' | 'neq';
  value: string | number | boolean;
}

export interface IntegratedFormField {
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external';
  title?: string;
  description?: string;
  required: boolean;
  options: IntegratedFormOption[];
  custom: boolean;
  placeholder?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  defaultValue?: unknown;
  when: IntegratedFormCondition[];
  url?: string;
}

export interface IntegratedFormRequest {
  id: string;
  title: string;
  // Who asked, for example the MCP server behind an elicitation.
  detail?: string;
  // The native request can be declined without an answer.
  declinable?: boolean;
  fields: IntegratedFormField[];
}

export interface IntegratedQuestionOption {
  label: string;
  description?: string;
}

export interface IntegratedQuestion {
  // Stable identity for answer state and template keys. Providers supply it.
  key: string;
  question: string;
  header?: string;
  options: IntegratedQuestionOption[];
  multiple: boolean;
  custom: boolean;
  // A form field that may be left unanswered.
  optional?: boolean;
}

export interface IntegratedQuestionRequest {
  id: string;
  questions: IntegratedQuestion[];
}

export interface IntegratedUsage {
  contextTokens?: number;
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  limits?: Array<{ label: string; usedPercent: number; resetsAt?: string }>;
  lastModelActivityAt?: string;
}

export interface IntegratedTask {
  id: string;
  label: string;
  kind?: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  detail?: string;
  stoppable: boolean;
}

// A prompt the harness accepted but has not started yet. Providers report
// them as `queue`; `delivery: 'steer'` joins the running turn at its next step.
// `held` prompts are Patterm's: the agent could not take them during a turn of
// kind `reason` (for example `compact`), and they are sent when it ends.
// `error` is why the last attempt to send one failed.
export interface IntegratedQueuedMessage {
  id: string;
  text: string;
  delivery: 'queue' | 'steer' | 'held' | 'unconfirmed';
  reason?: string | undefined;
  error?: string | undefined;
}

// A `pending` event Patterm emits when its held queue changes. It sits outside
// the native revision order, so clients re-read the snapshot without
// advancing their revision.
export const HELD_QUEUE_EVENT_ID = 'patterm_held_queue';

export interface ConversationProjection {
  messages: TranscriptMessage[];
  permissions: IntegratedPermission[];
  questions: IntegratedQuestionRequest[];
  forms: IntegratedFormRequest[];
  usage: IntegratedUsage | null;
  tasks: IntegratedTask[];
  queue: IntegratedQueuedMessage[];
}

export interface IntegratedControlSelector { id: string; label: string; value: string; options: Array<{ value: string; label: string }> }
// Patterm commands run in the renderer and never reach the native agent.
export interface IntegratedNativeCommand { name: string; description?: string; source?: 'patterm' }
export interface IntegratedControls { selectors: IntegratedControlSelector[]; commands: IntegratedNativeCommand[] }

// The last state a pane showed for a process. Switching back paints it at once
// and the fresh snapshot replaces it; it is never treated as authoritative.
export interface CachedIntegratedConversation extends ConversationProjection {
  controls: IntegratedControls;
  provider: string | null;
  streaming: boolean;
  historyTruncated: boolean;
  historyUnavailable: boolean;
  historyCursor: string | null;
  historyLoaded: boolean;
}

// The one piece of module state here: a small LRU of recently shown panes.
// Entries hold the immutable arrays the pane already rendered, so remembering
// them copies nothing.
const CONVERSATION_CACHE_LIMIT = 8;
const conversationCache = new Map<string, CachedIntegratedConversation>();

export function cachedConversation(processId: string): CachedIntegratedConversation | undefined {
  const entry = conversationCache.get(processId);
  if (!entry) return undefined;
  conversationCache.delete(processId);
  conversationCache.set(processId, entry);
  return entry;
}

export function rememberConversation(processId: string, entry: CachedIntegratedConversation): void {
  conversationCache.delete(processId);
  conversationCache.set(processId, entry);
  while (conversationCache.size > CONVERSATION_CACHE_LIMIT) conversationCache.delete(conversationCache.keys().next().value!);
}

export function forgetConversation(processId?: string): void {
  if (processId === undefined) conversationCache.clear();
  else conversationCache.delete(processId);
}

export function normaliseConversation(value: unknown): ConversationProjection {
  const envelope = record(value);
  return {
    messages: normaliseMessages(envelope.messages),
    permissions: normalisePermissions(envelope.permissions),
    questions: normaliseQuestions(envelope.questions),
    forms: normaliseForms(envelope.forms),
    usage: normaliseUsage(envelope.usage),
    tasks: normaliseTasks(envelope.tasks),
    queue: rows(envelope.queue).flatMap((raw) => {
      const row = record(raw);
      const id = stringField(row.id);
      if (!id) return [];
      const delivery = row.delivery === 'steer' || row.delivery === 'held' || row.delivery === 'unconfirmed' ? row.delivery : 'queue' as const;
      const reason = stringField(row.reason);
      const error = stringField(row.error);
      return [{ id, text: String(row.text ?? ''), delivery, ...(reason ? { reason } : {}), ...(error ? { error } : {}) }];
    })
  };
}

const TASK_STATUSES = new Set(['pending', 'running', 'paused', 'completed', 'failed', 'stopped']);

export function normaliseTasks(value: unknown): IntegratedTask[] {
  return rows(value).flatMap((raw) => {
    const row = record(raw);
    const id = stringField(row.id);
    if (!id) return [];
    const status = TASK_STATUSES.has(String(row.status)) ? row.status as IntegratedTask['status'] : 'running';
    const kind = stringField(row.kind);
    const detail = stringField(row.detail);
    return [{
      id,
      label: stringField(row.label) ?? 'Background task',
      ...(kind ? { kind } : {}),
      status,
      ...(detail ? { detail } : {}),
      stoppable: row.stoppable === true && (status === 'running' || status === 'pending' || status === 'paused')
    }];
  });
}

export function taskIsActive(task: IntegratedTask): boolean {
  return task.status === 'running' || task.status === 'pending' || task.status === 'paused';
}

export function normaliseUsage(value: unknown): IntegratedUsage | null {
  const row = record(value);
  const count = (candidate: unknown): number | undefined =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
  const limits = Array.isArray(row.limits) ? row.limits.flatMap((raw) => {
    const limit = record(raw);
    const used = count(limit.usedPercent);
    return typeof limit.label === 'string' && used !== undefined
      ? [{ label: limit.label, usedPercent: Math.min(100, used), ...(typeof limit.resetsAt === 'string' ? { resetsAt: limit.resetsAt } : {}) }]
      : [];
  }) : [];
  const usage: IntegratedUsage = {};
  for (const key of ['contextTokens', 'contextWindow', 'inputTokens', 'outputTokens', 'costUsd'] as const) {
    const number = count(row[key]);
    if (number !== undefined) usage[key] = number;
  }
  if (limits.length) usage.limits = limits;
  if (typeof row.lastModelActivityAt === 'string' && Number.isFinite(Date.parse(row.lastModelActivityAt))) usage.lastModelActivityAt = row.lastModelActivityAt;
  return Object.keys(usage).length ? usage : null;
}

// Time since the last model request, for example "42s", "3m 05s", or "1h 12m".
export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// A fresh native snapshot covers only the newest bounded window. Keep older
// pages already loaded by the user, while letting the fresh rows win by id.
export function mergeTranscriptWindows(older: TranscriptMessage[], newer: TranscriptMessage[]): TranscriptMessage[] {
  const byId = new Map(newer.map((message) => [message.id, message]));
  return [...older.filter((message) => !byId.has(message.id)), ...newer];
}

export function normaliseMessages(value: unknown): TranscriptMessage[] {
  const result: TranscriptMessage[] = [];
  for (const [rowIndex, raw] of rows(value).entries()) {
    const row = record(raw);
    const id = stringField(row.id) ?? `message-${rowIndex}`;
    // Services may project native items into the shared conversation shape
    // (id/role/kind/text/tool) directly. Accept it before provider-specific
    // snapshot rows so streamed and re-read messages are identical.
    if ((row.role === 'user' || row.role === 'assistant') && (row.kind === 'text' || row.kind === 'tool' || row.kind === 'reasoning' || row.kind === 'notice') && typeof row.text === 'string') {
      result.push(projectedMessage(row, id));
      continue;
    }
    // Native system scaffolding (for example tool-catalog notices) is not
    // assistant prose. Only explicit error signals survive into the transcript.
    if (row.type === 'system') {
      if (row.level === 'error' || row.is_error === true) {
        result.push({ id, role: 'assistant', kind: 'text', text: String(row.text ?? '') });
      }
      continue;
    }
    // Assistant content parts carry text and tool records; user content parts
    // keep their attachments available for later transcript display.
    const parent = stringField(row.parentId);
    const nested = parent ? { parentId: parent } : {};
    // Native OpenCode rows carry `time.created` and `time.completed` in ms.
    const messageTime = record(row.time);
    const times = rowTimes(messageTime.created, messageTime.completed);
    if (row.type === 'assistant' && Array.isArray(row.content)) {
      for (const [partIndex, rawPart] of row.content.entries()) {
        const part = record(rawPart);
        // Tool and reasoning parts carry their own native times. Other parts
        // begin with the message, and the last one finishes with it.
        const partTime = record(part.time);
        const last = partIndex === row.content.length - 1;
        const partTimes = rowTimes(partTime.created ?? partTime.start ?? messageTime.created, partTime.completed ?? partTime.end ?? (last ? messageTime.completed : undefined));
        if (part.type === 'text' && typeof part.text === 'string') {
          result.push({ id: `${id}-${partIndex}`, role: 'assistant', kind: 'text', text: part.text, ...partTimes, ...nested });
        } else if (part.type === 'reasoning' && typeof part.text === 'string') {
          result.push({ id: `${id}-${partIndex}`, role: 'assistant', kind: 'reasoning', text: part.text, ...partTimes, ...nested });
        } else if (part.type === 'tool') {
          result.push({ ...toolMessage(`${id}-${partIndex}`, stringField(part.name) ?? 'Tool', part.state, part), ...partTimes, ...nested });
        }
      }
      result.push(...assistantNotices(row, id, { ...rowTimes(messageTime.completed ?? messageTime.created, messageTime.completed), ...nested }));
      continue;
    }
    // Native compaction rows carry a summary, not text.
    if (row.type === 'compaction') {
      const failed = row.status === 'failed';
      result.push({
        id, role: 'assistant', kind: 'notice', level: failed ? 'error' : 'info',
        text: row.status === 'running' ? 'Compacting the conversation…' : failed ? `Compaction failed: ${stringField(record(row.error).message) ?? 'unknown error'}` : 'Conversation compacted',
        ...times, ...nested
      });
      continue;
    }
    if (row.type === 'user' && Array.isArray(row.content)) {
      const text = row.content.flatMap((part) => typeof record(part).text === 'string' ? [String(record(part).text)] : []).join('\n');
      const attachments = messageAttachments(row);
      result.push({ id, role: 'user', kind: 'text', text, ...(attachments.length ? { attachments } : {}), ...times, ...nested });
      continue;
    }
    // Claude Code and Codex report tool use as shell-like rows. A structured
    // name/input pair classifies into a real tool family; legacy command/output
    // rows stay readable.
    if (row.type === 'shell' || typeof row.command === 'string' || typeof row.output === 'string') {
      result.push({ ...toolMessage(id, stringField(row.name) ?? stringField(row.command) ?? 'Shell', row.output, row), ...times });
      continue;
    }
    if (typeof row.text === 'string') {
      const attachments = messageAttachments(row);
      result.push({ id, role: row.type === 'user' ? 'user' : 'assistant', kind: 'text', text: row.text, ...(attachments.length ? { attachments } : {}), ...times });
    }
  }
  return result;
}

// A native assistant row's error, retry, and unusual finish become notices
// after its content.
function assistantNotices(row: Record<string, unknown>, id: string, nested: Pick<TranscriptMessage, 'parentId' | 'createdAt' | 'completedAt'>): TranscriptMessage[] {
  const error = record(row.error);
  const retry = record(row.retry);
  if (stringField(error.message)) return [{ id: `${id}-error`, role: 'assistant', kind: 'notice', level: 'error', text: error.message as string, ...nested }];
  const notices: TranscriptMessage[] = [];
  if (typeof retry.attempt === 'number') {
    notices.push({ id: `${id}-retry`, role: 'assistant', kind: 'notice', level: 'warning', text: `${stringField(record(retry.error).message) ?? 'Request failed'}; retried (attempt ${retry.attempt})`, ...nested });
  }
  if (row.finish === 'length') notices.push({ id: `${id}-finish`, role: 'assistant', kind: 'notice', level: 'warning', text: 'The response stopped at the output token limit.', ...nested });
  if (row.finish === 'content-filter') notices.push({ id: `${id}-finish`, role: 'assistant', kind: 'notice', level: 'warning', text: 'The provider filtered the response.', ...nested });
  return notices;
}

function projectedMessage(row: Record<string, unknown>, id: string): TranscriptMessage {
  const tool = record(row.tool);
  const attachments = Array.isArray(row.attachments) ? row.attachments.map(record).filter((item) => Object.keys(item).length > 0) : [];
  const text = stripAnsi(String(row.text ?? ''));
  return {
    id,
    ...(typeof row.clientMessageId === 'string' ? { clientMessageId: row.clientMessageId } : {}),
    role: row.role as 'user' | 'assistant',
    kind: row.kind as TranscriptMessage['kind'],
    ...(row.kind === 'notice' ? { level: row.level === 'warning' || row.level === 'error' ? row.level : 'info' } : {}),
    text,
    ...(typeof row.title === 'string' ? { title: row.title } : {}),
    ...(typeof tool.name === 'string'
      ? { tool: buildTranscriptTool(tool.name, { input: tool.input, state: tool.state, result: tool.result, images: tool.images }, text) }
      : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(typeof row.parentId === 'string' && row.parentId ? { parentId: row.parentId } : {}),
    ...rowTimes(row.createdAt ?? row.created_at, row.completedAt ?? row.completed_at)
  };
}

// Native times arrive as epoch milliseconds or date strings; rows carry ISO
// strings. Unusable values are dropped rather than shown as 1970.
function isoTime(value: unknown): string | undefined {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined;
}

function rowTimes(created: unknown, completed: unknown): Pick<TranscriptMessage, 'createdAt' | 'completedAt'> {
  const createdAt = isoTime(created);
  const completedAt = isoTime(completed);
  return { ...(createdAt ? { createdAt } : {}), ...(completedAt ? { completedAt } : {}) };
}

function messageAttachments(row: Record<string, unknown>): Array<Record<string, unknown>> {
  const files = Array.isArray(row.files) ? row.files.map(record) : [];
  const parts = Array.isArray(row.content) ? row.content.flatMap((part) => record(part).type === 'file' ? [record(part)] : []) : [];
  return [...files, ...parts].filter((file) => Object.keys(file).length > 0);
}

export function normalisePermissions(value: unknown): IntegratedPermission[] {
  return rows(value).flatMap((raw) => {
    const row = record(raw);
    if (!stringField(row.id)) return [];
    const alwaysLabel = stringField(row.always_label);
    const optional = (key: 'detail' | 'command' | 'cwd' | 'patch' | 'plan' | 'onceLabel' | 'rejectLabel', source: unknown) => {
      const value = stringField(source);
      return value ? { [key]: value } : {};
    };
    return [{
      id: row.id as string,
      action: String(row.action ?? 'Request'),
      resources: Array.isArray(row.resources) ? row.resources.map(String) : [],
      ...(row.always === false ? { always: false } : {}),
      ...(alwaysLabel ? { alwaysLabel } : {}),
      ...optional('onceLabel', row.once_label),
      ...optional('rejectLabel', row.reject_label),
      ...optional('detail', row.detail),
      ...optional('command', row.command),
      ...optional('cwd', row.cwd),
      ...optional('patch', row.patch),
      ...optional('plan', row.plan),
      ...(row.feedback === true ? { feedback: true } : {})
    }];
  });
}

const FORM_FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'multiselect', 'external']);

// Installed OpenCode forms use typed fields. Normalise the native shape without
// inventing semantics: unsupported fields are dropped, native values and
// conditional `when` clauses are preserved for the composer dock.
export function normaliseForms(value: unknown): IntegratedFormRequest[] {
  return rows(value).flatMap((raw) => {
    const row = record(raw);
    const id = stringField(row.id);
    if (!id || !Array.isArray(row.fields)) return [];
    const fields = row.fields.flatMap((item): IntegratedFormField[] => {
      const field = record(item);
      const key = stringField(field.key);
      const type = stringField(field.type);
      if (!key || !type || !FORM_FIELD_TYPES.has(type)) return [];
      const numberField = (candidate: unknown): number | undefined =>
        typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
      const conditions = Array.isArray(field.when) ? field.when.flatMap((entry): IntegratedFormCondition[] => {
        const condition = record(entry);
        const op = condition.op;
        const value = condition.value;
        if ((op !== 'eq' && op !== 'neq') || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) return [];
        const conditionKey = stringField(condition.key);
        return conditionKey ? [{ key: conditionKey, op, value }] : [];
      }) : [];
      const minimum = numberField(field.minimum);
      const maximum = numberField(field.maximum);
      const minItems = numberField(field.minItems);
      const maxItems = numberField(field.maxItems);
      return [{
        key,
        type: type as IntegratedFormField['type'],
        ...(stringField(field.title) ? { title: field.title as string } : {}),
        ...(stringField(field.description) ? { description: field.description as string } : {}),
        required: field.required === true,
        options: Array.isArray(field.options) ? field.options.flatMap((option): IntegratedFormOption[] => {
          const value = record(option);
          return typeof value.value === 'string' && typeof value.label === 'string'
            ? [{ value: value.value, label: value.label, ...(typeof value.description === 'string' ? { description: value.description } : {}) }]
            : [];
        }) : [],
        custom: field.custom === true,
        ...(typeof field.placeholder === 'string' ? { placeholder: field.placeholder } : {}),
        ...(typeof field.format === 'string' ? { format: field.format } : {}),
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
        ...(minItems !== undefined ? { minItems } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
        ...(field.default !== undefined ? { defaultValue: field.default } : {}),
        when: conditions,
        ...(typeof field.url === 'string' ? { url: field.url } : {})
      }];
    });
    const declinable = row.declinable === true;
    const detail = stringField(row.detail);
    // A declinable request stays visible even when none of its fields are
    // supported, so it can still be declined instead of stalling the turn.
    return fields.length || declinable
      ? [{ id, title: stringField(row.title) ?? 'Request', ...(detail ? { detail } : {}), ...(declinable ? { declinable } : {}), fields }]
      : [];
  });
}

// A field is answerable only when every native `when` clause matches the
// current answers, so hidden fields are neither required nor submitted.
// A form made only of choices, as OpenCode sends its question tool, reads as
// questions. Answers stay in the form's own state, where option values are
// kept, while questions compare option labels.
export function formAsQuestions(form: IntegratedFormRequest, fields: IntegratedFormField[]): IntegratedQuestionRequest | null {
  if (!fields.length || !fields.every(isChoiceField)) return null;
  return {
    id: form.id,
    questions: fields.map((field) => ({
      key: field.key,
      question: field.description || field.title || field.key,
      ...(field.description && field.title ? { header: field.title } : {}),
      options: field.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
      multiple: field.type === 'multiselect',
      custom: field.custom,
      ...(field.required || (field.minItems ?? 0) > 0 ? {} : { optional: true })
    }))
  };
}

function isChoiceField(field: IntegratedFormField): boolean {
  return (field.type === 'string' || field.type === 'multiselect') && field.options.length > 0;
}

export interface FormQuestionState {
  multiple: Record<string, string[]>;
  single: Record<string, string>;
  custom: Record<string, string>;
}

// The question card's view of a choice form's answers. A single answer that
// matches no option is your own text.
export function formQuestionState(fields: IntegratedFormField[], answers: Record<string, unknown>): FormQuestionState {
  const state: FormQuestionState = { multiple: {}, single: {}, custom: {} };
  for (const field of fields) {
    const label = (value: unknown) => field.options.find((option) => option.value === value)?.label;
    const raw = answers[field.key];
    if (field.type === 'multiselect') {
      state.multiple[field.key] = (Array.isArray(raw) ? raw : []).flatMap((value) => label(value) ?? []);
      state.custom[field.key] = typeof answers[`${field.key}:custom`] === 'string' ? String(answers[`${field.key}:custom`]) : '';
    } else {
      state.single[field.key] = label(raw) ?? '';
      state.custom[field.key] = typeof raw === 'string' && label(raw) === undefined ? raw : '';
    }
  }
  return state;
}

// The form value of a chosen option label.
export function formOptionValue(field: IntegratedFormField, label: string): string {
  return field.options.find((option) => option.label === label)?.value ?? label;
}

export function formFieldVisible(field: IntegratedFormField, answers: Record<string, unknown>, fields: IntegratedFormField[] = []): boolean {
  return field.when.every((condition) => {
    const source = fields.find((candidate) => candidate.key === condition.key);
    const matches = conditionValue(source, answers[condition.key]) === condition.value;
    return condition.op === 'eq' ? matches : !matches;
  });
}

// The editor keeps raw input while the user types. A condition compares the
// typed value with the referenced field's native type, so '2' matches a numeric
// 2 for an integer field without rewriting the in-progress editor value.
function conditionValue(field: IntegratedFormField | undefined, raw: unknown): string | number | boolean | undefined {
  if (field?.type === 'number' || field?.type === 'integer') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    }
    return undefined;
  }
  if (field?.type === 'boolean') return raw === true;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw;
  return undefined;
}

export type FormAnswerResult =
  | { ok: true; answer: Record<string, unknown> }
  | { ok: false; error: string };

// Native form answers keep the field's own type: string, number, boolean, or
// string[] for multiselect. Custom multiselect values are typed separately.
export function buildFormAnswer(form: IntegratedFormRequest, answers: Record<string, unknown>): FormAnswerResult {
  const answer: Record<string, unknown> = {};
  for (const field of form.fields) {
    if (!formFieldVisible(field, answers, form.fields)) continue;
    if (field.type === 'external') continue;
    const label = field.title ?? field.key;
    const raw = answers[field.key];
    if (field.type === 'boolean') {
      answer[field.key] = raw === true;
      continue;
    }
    if (field.type === 'number' || field.type === 'integer') {
      if (raw === undefined || raw === null || raw === '') {
        if (field.required) return { ok: false, error: `Answer "${label}" before submitting.` };
        continue;
      }
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(value)) return { ok: false, error: `"${label}" must be a number.` };
      if (field.type === 'integer' && !Number.isInteger(value)) return { ok: false, error: `"${label}" must be a whole number.` };
      if (field.minimum !== undefined && value < field.minimum) return { ok: false, error: `"${label}" must be at least ${field.minimum}.` };
      if (field.maximum !== undefined && value > field.maximum) return { ok: false, error: `"${label}" must be at most ${field.maximum}.` };
      answer[field.key] = value;
      continue;
    }
    if (field.type === 'multiselect') {
      const selected = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
      const custom = typeof answers[`${field.key}:custom`] === 'string' ? String(answers[`${field.key}:custom`]).trim() : '';
      const values = custom && !selected.includes(custom) ? [...selected, custom] : selected;
      if (!values.length) {
        if (field.required || (field.minItems ?? 0) > 0) return { ok: false, error: `Answer "${label}" before submitting.` };
        continue;
      }
      if (field.minItems !== undefined && values.length < field.minItems) return { ok: false, error: `Choose at least ${field.minItems} for "${label}".` };
      if (field.maxItems !== undefined && values.length > field.maxItems) return { ok: false, error: `Choose at most ${field.maxItems} for "${label}".` };
      answer[field.key] = values;
      continue;
    }
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      if (field.required) return { ok: false, error: `Answer "${label}" before submitting.` };
      continue;
    }
    if (field.options.length && !field.custom && !field.options.some((option) => option.value === value)) {
      return { ok: false, error: `Choose a listed value for "${label}".` };
    }
    answer[field.key] = value;
  }
  return { ok: true, answer };
}

export function normaliseQuestions(value: unknown): IntegratedQuestionRequest[] {
  return rows(value).flatMap((raw) => {
    const row = record(raw);
    if (!stringField(row.id) || !Array.isArray(row.questions)) return [];
    const requestId = row.id as string;
    const questions = row.questions.flatMap((item, index): IntegratedQuestion[] => {
      const question = record(item);
      if (typeof question.question !== 'string') return [];
      const header = stringField(question.header);
      const questionId = stringField(question.id) ?? header ?? `${index}:${question.question}`;
      return [{
        // Namespace by request so two distinct pending requests that reuse a
        // question id never share answer state.
        key: `${requestId}:${questionId}`,
        question: question.question,
        ...(header ? { header } : {}),
        options: Array.isArray(question.options) ? question.options.flatMap((option) => {
          const value = record(option);
          return typeof value.label === 'string'
            ? [{ label: value.label, ...(typeof value.description === 'string' ? { description: value.description } : {}) }]
            : [];
        }) : [],
        multiple: question.multiple === true,
        custom: question.custom === true
      }];
    });
    return [{ id: requestId, questions }];
  });
}

export interface QuestionAnswerState {
  multiple: Record<string, string[]>;
  single: Record<string, string>;
  custom: Record<string, string>;
}

export type QuestionAnswerResult =
  | { ok: true; answers: string[][] }
  | { ok: false; error: string };

// Answers must align with the provider's question order, and every question
// needs a selection or a typed answer before the reply is accepted. A typed
// answer replaces a single choice; a multi-select answer may combine both.
export function buildQuestionAnswers(questions: IntegratedQuestion[], state: QuestionAnswerState): QuestionAnswerResult {
  const answers: string[][] = [];
  for (const question of questions) {
    const selected = question.multiple
      ? [...(state.multiple[question.key] ?? [])]
      : [state.single[question.key] ?? ''].filter(Boolean);
    const custom = (state.custom[question.key] ?? '').trim();
    const values = question.multiple
      ? (custom && !selected.includes(custom) ? [...selected, custom] : selected)
      : (custom ? [custom] : selected);
    if (!values.length) return { ok: false, error: `Answer "${question.question}" before replying.` };
    answers.push(values);
  }
  return { ok: true, answers };
}

// Provider conversation stream events, projected by backend services into the
// same row shape as snapshots. Applying an event touches one row instead of
// reparsing the transcript.
export interface ConversationStreamMessage {
  id: string;
  role: 'user' | 'assistant';
  kind: 'text' | 'tool' | 'reasoning' | 'notice';
  level?: 'info' | 'warning' | 'error' | undefined;
  text: string;
  title?: string | undefined;
  tool?: { name: string; input?: unknown; state?: unknown; result?: unknown } | undefined;
  attachments?: Array<Record<string, unknown>> | undefined;
  parentId?: string | undefined;
  createdAt?: string | undefined;
  completedAt?: string | undefined;
}

export interface ConversationStreamEvent {
  processId: string;
  revision: number;
  kind: 'replace' | 'append' | 'status' | 'pending' | 'error' | 'reconnecting';
  message?: ConversationStreamMessage | undefined;
  id?: string | undefined;
  delta?: string | undefined;
  status?: 'working' | 'idle' | 'error' | 'unknown' | undefined;
  detail?: string | undefined;
}

export function applyConversationStreamEvent(messages: TranscriptMessage[], event: ConversationStreamEvent): TranscriptMessage[] {
  if (event.kind === 'replace' && event.message) {
    const next = projectedMessage(event.message as unknown as Record<string, unknown>, event.message.id);
    const index = messages.findIndex((message) => message.id === next.id);
    if (index < 0) return [...messages, next];
    const copy = [...messages];
    // A row keeps the time it began; a replace without a finish time keeps
    // the one already known.
    const current = copy[index]!;
    const createdAt = current.createdAt ?? next.createdAt;
    const completedAt = next.completedAt ?? current.completedAt;
    copy[index] = { ...next, ...(createdAt ? { createdAt } : {}), ...(completedAt ? { completedAt } : {}) };
    return copy;
  }
  if ((event.kind === 'append' || event.kind === 'error') && event.id) {
    const delta = stripAnsi(event.delta ?? '');
    const index = messages.findIndex((message) => message.id === event.id);
    if (index < 0) return [...messages, { id: event.id, role: 'assistant', kind: 'text', text: delta }];
    const copy = [...messages];
    const current = copy[index]!;
    const text = `${current.text}${delta}`;
    // The rendered tool view reads tool.output, so an append must keep it
    // consistent with the source content. Only the affected row is replaced.
    copy[index] = {
      ...current,
      text,
      ...(current.tool ? { tool: { ...current.tool, output: `${current.tool.output ?? ''}${delta}` } } : {})
    };
    return copy;
  }
  return messages;
}

// Provider services reject reads once the native session is gone. Treat those
// as a terminal state instead of retrying forever with a raw error.
export function isSessionUnavailableError(message: string): boolean {
  return /integrated session is not active|integrated session not found|integrated agent session not found/i.test(message);
}

function toolMessage(id: string, name: string, output: unknown, row: Record<string, unknown>): TranscriptMessage {
  const text = stripAnsi(toolText(output, row));
  return {
    id,
    role: 'assistant',
    kind: 'tool',
    title: name,
    text,
    tool: buildTranscriptTool(name, { input: row.input, state: row.state, row }, text)
  };
}

const TOOL_FAMILY_BY_NAME: Record<string, TranscriptToolFamily> = {
  commandexecution: 'shell', bash: 'shell', shell: 'shell', exec: 'shell', command: 'shell', run: 'shell', terminal: 'shell', shellcommand: 'shell',
  read: 'read', readfile: 'read', fileread: 'read', cat: 'read', view: 'read',
  list: 'list', ls: 'list', listdir: 'list', listfiles: 'list', listdirectory: 'list',
  glob: 'glob', findfiles: 'glob', fileglob: 'glob',
  grep: 'grep', ripgrep: 'grep', search: 'grep', searchfiles: 'grep',
  edit: 'edit', editfile: 'edit', strreplace: 'edit', multiedit: 'edit', replace: 'edit',
  write: 'write', writefile: 'write', createfile: 'write', create: 'write', save: 'write',
  patch: 'patch', applypatch: 'patch', filechange: 'patch', diff: 'patch',
  webfetch: 'web', websearch: 'web', fetch: 'web', browse: 'web', readwebpage: 'web',
  task: 'task', agent: 'task', subagent: 'task', delegate: 'task',
  todowrite: 'todo', todoread: 'todo', todo: 'todo', updateplan: 'todo', taskcreate: 'todo', taskupdate: 'todo', tasklist: 'todo', taskget: 'todo',
  skill: 'skill', useskill: 'skill',
  mcptoolcall: 'mcp', dynamictoolcall: 'mcp'
};

const TOOL_TITLES: Record<TranscriptToolFamily, string> = {
  shell: 'Bash', read: 'Read', list: 'List', glob: 'Glob', grep: 'Search',
  edit: 'Edit', write: 'Write', patch: 'File changes', web: 'Fetch',
  task: 'Task', todo: 'Todos', skill: 'Skill', mcp: 'MCP', generic: 'Tool'
};

export function buildTranscriptTool(name: string, detail: { input?: unknown; state?: unknown; result?: unknown; images?: unknown; row?: Record<string, unknown> }, output: string): TranscriptTool {
  const rawInput = detail.input ?? record(detail.state).input;
  const input = record(rawInput);
  const state = detail.state;
  const row = detail.row ?? {};
  const family = toolFamily(name, input, row);
  const status = toolStatus(state, output);
  const changeSet = toolChangeSet(family, input, state, detail.result);
  const target = toolTarget(family, name, input, row, detail.result);
  const args = toolArgs(family, input);
  const command = family === 'shell' ? firstString(input.command, input.cmd, row.command) : undefined;
  const error = toolError(state, row, output);
  const title = family === 'generic' && name ? name : TOOL_TITLES[family];
  const checklist = family === 'todo' ? toolChecklist(input) : [];
  // Projected rows name their images; native rows (OpenCode) keep them as
  // stored file parts of the tool result.
  const images = transcriptImages([...(Array.isArray(detail.images) ? detail.images : []), ...(Array.isArray(record(state).content) ? record(state).content as unknown[] : [])]);
  return {
    name,
    family,
    status,
    title,
    ...(rawInput !== undefined ? { input: rawInput } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(detail.result !== undefined ? { result: detail.result } : {}),
    ...(target ? { target } : {}),
    ...(args.length ? { args } : {}),
    ...(command ? { command } : {}),
    ...(output ? { output } : {}),
    ...(error ? { error } : {}),
    ...(images.length ? { images } : {}),
    ...(checklist.length ? { checklist, target: checklistSummary(checklist) } : {}),
    ...(changeSet ? { patch: changeSet.patch, changes: { additions: changeSet.additions, deletions: changeSet.deletions }, ...(changeSet.files.length ? { files: changeSet.files } : {}) } : {})
  };
}

function transcriptImages(values: unknown[]): TranscriptImage[] {
  return values.slice(0, 20).flatMap((value): TranscriptImage[] => {
    const row = record(value);
    const sha256 = imageHash(row.sha256);
    if (!sha256) return [];
    const width = typeof row.width === 'number' && row.width > 0 ? row.width : undefined;
    const height = typeof row.height === 'number' && row.height > 0 ? row.height : undefined;
    return [{
      sha256,
      ...(typeof row.mime === 'string' ? { mime: row.mime } : {}),
      ...(typeof row.name === 'string' && row.name ? { name: row.name } : {}),
      ...(width && height ? { width, height } : {})
    }];
  });
}

function imageHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

// Claude's TodoWrite (todos: content/status/activeForm) and Codex update_plan
// (plan: step/status) share one checklist shape.
function toolChecklist(input: Record<string, unknown>): NonNullable<TranscriptTool['checklist']> {
  const items = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan) ? input.plan : [];
  return items.map(record).flatMap((item) => {
    const text = firstString(item.content, item.step, item.subject, item.text);
    if (!text) return [];
    const raw = String(item.status ?? '').replace(/[^a-z]/gi, '').toLowerCase();
    const status = raw === 'completed' || raw === 'done' ? 'completed' as const : raw === 'inprogress' ? 'in_progress' as const : 'pending' as const;
    return [{ text: status === 'in_progress' ? firstString(item.activeForm) ?? text : text, status }];
  });
}

function checklistSummary(checklist: NonNullable<TranscriptTool['checklist']>): string {
  const done = checklist.filter((item) => item.status === 'completed').length;
  const current = checklist.find((item) => item.status === 'in_progress');
  return `${done}/${checklist.length} done${current ? ` · ${current.text}` : ''}`;
}

function toolFamily(name: string, input: Record<string, unknown>, row: Record<string, unknown>): TranscriptToolFamily {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key.startsWith('mcp') || name.includes('__') || OPENCODE_BRIDGE.test(name)) return 'mcp';
  const family = TOOL_FAMILY_BY_NAME[key];
  if (family) return family;
  if (typeof row.server === 'string' || typeof input.server === 'string') return 'mcp';
  return 'generic';
}

function toolStatus(state: unknown, output: string): TranscriptToolStatus {
  const raw = typeof state === 'string' ? state : typeof record(state).status === 'string' ? String(record(state).status) : '';
  const value = raw.toLowerCase();
  if (!value) return output ? 'completed' : 'pending';
  if (value.includes('progress') || value === 'running' || value === 'streaming' || value === 'pending' || value === 'started') return 'running';
  if (value.includes('fail') || value.includes('error')) return 'failed';
  if (value.includes('complete') || value.includes('success') || value === 'done' || value === 'ended') return 'completed';
  return output ? 'completed' : 'pending';
}

// Claude names MCP tools mcp__<server>__<tool>; OpenCode prefixes Patterm's
// bridge as patterm_<socket hash>_<tool>.
const CLAUDE_MCP = /^mcp__(.+?)__(.+)$/;
const OPENCODE_BRIDGE = /^patterm_[0-9a-f]{12}_(.+)$/;

function mcpNameParts(name: string): { server?: string | undefined; tool?: string | undefined } {
  const claude = CLAUDE_MCP.exec(name);
  if (claude) return { server: claude[1], tool: claude[2] };
  const bridge = OPENCODE_BRIDGE.exec(name);
  return bridge ? { server: 'patterm', tool: bridge[1] } : {};
}

function toolTarget(family: TranscriptToolFamily, name: string, input: Record<string, unknown>, row: Record<string, unknown>, result?: unknown): string | undefined {
  const resultRow = record(result);
  if (family === 'shell') return firstString(input.command, input.cmd, row.command);
  if (family === 'read' || family === 'list' || family === 'edit' || family === 'write' || family === 'patch') {
    return firstString(input.file_path, input.filePath, input.path, input.file, input.target_file, resultRow.filePath, row.path);
  }
  if (family === 'glob' || family === 'grep') return firstString(input.pattern, input.query, input.glob, input.regex);
  if (family === 'web') return firstString(input.url, input.query);
  if (family === 'task') return firstString(input.description, input.prompt, input.task);
  if (family === 'skill') return firstString(input.skill, input.name, input.id);
  if (family === 'mcp') {
    const parts = mcpNameParts(name);
    const server = firstString(input.server, row.server, parts.server);
    const tool = firstString(input.tool, row.tool, parts.tool, input.name);
    return [server, tool].filter(Boolean).join(': ') || undefined;
  }
  return firstString(input.path, input.name, input.query, input.command, input.description, input.target, input.reason, input.task_id)
    ?? firstString(record(Array.isArray(input.questions) ? input.questions[0] : undefined).question);
}

function toolArgs(family: TranscriptToolFamily, input: Record<string, unknown>): string[] {
  const args: string[] = [];
  if (family === 'read') {
    const offset = typeof input.offset === 'number' ? input.offset : typeof input.line === 'number' ? input.line : undefined;
    const limit = typeof input.limit === 'number' ? input.limit : undefined;
    if (offset !== undefined && limit !== undefined) args.push(`lines ${offset}-${offset + limit}`);
    else if (offset !== undefined) args.push(`from line ${offset}`);
  }
  if (family === 'grep' || family === 'glob') {
    const include = firstString(input.include, input.path);
    if (include) args.push(include);
  }
  if (family === 'task') {
    const agent = firstString(input.agent, input.subagent_type);
    if (agent) args.push(agent);
  }
  return args;
}

function toolChangeSet(family: TranscriptToolFamily, input: Record<string, unknown>, state: unknown, result?: unknown): { patch: string; additions: number; deletions: number; files: TranscriptToolFile[] } | null {
  if (family !== 'edit' && family !== 'write' && family !== 'patch') return null;
  const stateRecord = record(state);
  const metadata = record(stateRecord.metadata);
  const files: TranscriptToolFile[] = [];
  const entry = (name: string | undefined, candidate: string | undefined): void => {
    const patch = candidate ? extractUnifiedDiff(candidate) : null;
    const counts = patch ? diffChangeCounts(patch) : null;
    if (!name && !patch) return;
    files.push({
      ...(name ? { name, uri: name, mime: 'text/x-diff' } : {}),
      ...(patch ? { patch } : {}),
      ...(counts ? { additions: counts.additions, deletions: counts.deletions } : {})
    });
  };
  const changes = Array.isArray(input.changes) ? input.changes.map(record) : [];
  if (changes.length) {
    for (const change of changes) entry(firstString(change.path, change.file), firstString(change.diff, change.patch));
  } else {
    entry(
      firstString(input.file_path, input.filePath, input.path, input.file),
      firstString(input.diff, input.patch, metadata.diff, metadata.patch)
    );
  }
  // Native tool results carry the authoritative diff even when the input has
  // none: a Claude Edit result has filePath, structuredPatch, and sometimes
  // gitDiff. Only a recognised diff shape is turned into a patch.
  if (!files.some((file) => file.patch)) {
    const resultRow = record(result);
    const name = firstString(resultRow.filePath, input.file_path, input.filePath, input.path, input.file);
    const direct = firstString(resultRow.gitDiff, typeof resultRow.structuredPatch === 'string' ? resultRow.structuredPatch : undefined);
    const structured = Array.isArray(resultRow.structuredPatch) ? synthesizePatch(resultRow.structuredPatch) : null;
    const patch = direct ? extractUnifiedDiff(direct) : structured;
    if (patch) {
      const counts = diffChangeCounts(patch);
      const existing = name ? files.find((file) => file.name === name) : undefined;
      if (existing) {
        existing.patch = patch;
        existing.additions = counts.additions;
        existing.deletions = counts.deletions;
      } else {
        files.push({ ...(name ? { name, uri: name, mime: 'text/x-diff' } : {}), patch, ...counts });
      }
    } else if (name && !files.some((file) => file.name === name)) {
      files.push({ name, uri: name, mime: 'text/x-diff' });
    }
  }
  if (!files.length) return null;
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  // A combined patch is only safe when every diff carries its own filename
  // (git format). Bare hunks are rendered per file with their filename.
  const patched = files.filter((file) => file.patch);
  const combined = patched.length > 0 && patched.every((file) => file.patch!.includes('diff --git'))
    ? patched.map((file) => file.patch!).join('\n')
    : '';
  return { patch: combined, additions, deletions, files };
}

// Claude's structuredPatch is an array of hunks with line arrays. Convert only
// the recognised shape; anything else is left untouched rather than guessed.
function synthesizePatch(hunks: unknown[]): string | null {
  const lines: string[] = [];
  for (const raw of hunks) {
    const hunk = record(raw);
    const oldStart = typeof hunk.oldStart === 'number' ? hunk.oldStart : null;
    const oldLines = typeof hunk.oldLines === 'number' ? hunk.oldLines : null;
    const newStart = typeof hunk.newStart === 'number' ? hunk.newStart : null;
    const newLines = typeof hunk.newLines === 'number' ? hunk.newLines : null;
    const body = Array.isArray(hunk.lines) ? hunk.lines.filter((line): line is string => typeof line === 'string') : [];
    if (oldStart === null || oldLines === null || newStart === null || newLines === null || !body.length) return null;
    lines.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    for (const line of body) lines.push(/^[ +\\-]/.test(line) ? line : ` ${line}`);
  }
  return lines.length ? lines.join('\n') : null;
}

// A unified diff must contain a hunk header; a stray `---` line is not a diff.
export function extractUnifiedDiff(value: string): string | null {
  const lines = value.split('\n');
  const start = lines.findIndex((line) => line.startsWith('@@') || line.startsWith('diff --git '));
  if (start < 0 || !lines.some((line) => line.startsWith('@@'))) return null;
  return lines.slice(start).join('\n').trim();
}

export function diffChangeCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

function toolError(state: unknown, row: Record<string, unknown>, output: string): string | undefined {
  const stateRecord = record(state);
  const error = record(stateRecord.error);
  const message = firstString(error.message, stateRecord.error, row.error);
  if (message) return stripAnsi(message);
  if (toolStatus(state, output) === 'failed' && output) return output;
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value) return value;
  return undefined;
}

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

// Terminal output can carry colour and cursor sequences; the transcript shows
// readable text only.
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

export type TranscriptRow =
  | { kind: 'message'; id: string; message: TranscriptMessage; origin?: TranscriptOrigin }
  | { kind: 'tools'; id: string; messages: TranscriptMessage[]; targets: string[] };

// Who wrote a user turn that Patterm typed in: another agent's message or
// report, or Patterm itself (timers, notifications, focus digests). `body` is
// the text without Patterm's header or reply hint; `status` is a report's, and
// `name` is the sender's name when the header carries one.
export type TranscriptOrigin =
  | { kind: 'agent'; processId: string; status?: string; name?: string; body: string }
  | { kind: 'patterm'; label: string; detail: string; body: string };

const AGENT_MESSAGE = /^\[message from ([^\s\]]+)\]\r?\n/;
const AGENT_REPORT = /^\[report from ([^\s\]:]+): ([^\]]+)\](?:\r?\n|$)/;
const ASSISTANT_MESSAGE = /^\[agent message from ([^\s\],]+)(?: \(([^\n]*?)\))?, not the user\]\r?\n/;
const PATTERM_MESSAGE = /^\[Patterm (timer|notifications|focus digest)\b([^\n]*?)\](?:\r?\n|$)/;
const PATTERM_LABELS: Record<string, string> = { timer: 'Timer', notifications: 'Notifications', 'focus digest': 'Focus digest' };
const REPLY_HINT = /\s*\(Reply with send_message target_process_id "assistant"\.\)\s*$/;

// Reads the headers Patterm puts on text it types into an agent. The headers
// stay in the agent's transcript so the agent knows the user did not write
// them; the transcript shows the sender instead.
export function transcriptMessageOrigin(message: TranscriptMessage): TranscriptOrigin | undefined {
  if (message.role !== 'user' || message.kind !== 'text') return undefined;
  const text = message.text;
  let match = AGENT_MESSAGE.exec(text);
  if (match) return { kind: 'agent', processId: match[1]!, body: text.slice(match[0].length).replace(REPLY_HINT, '') };
  match = AGENT_REPORT.exec(text);
  if (match) return { kind: 'agent', processId: match[1]!, status: match[2]!.trim(), body: text.slice(match[0].length) };
  match = ASSISTANT_MESSAGE.exec(text);
  if (match) return { kind: 'agent', processId: match[1]!, ...(match[2] ? { name: match[2] } : {}), body: text.slice(match[0].length) };
  match = PATTERM_MESSAGE.exec(text);
  if (match) return { kind: 'patterm', label: PATTERM_LABELS[match[1]!]!, detail: match[2]!.trim(), body: text.slice(match[0].length) };
  return undefined;
}

// Subagent rows move under the tool row that spawned them. A row whose parent
// is outside the loaded window stays in the main transcript rather than
// disappearing.
export function nestSubagentMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  if (!messages.some((message) => message.parentId)) return messages;
  const ids = new Set(messages.map((message) => message.id));
  const children = new Map<string, TranscriptMessage[]>();
  const top: TranscriptMessage[] = [];
  for (const message of messages) {
    const parent = message.parentId;
    if (parent && parent !== message.id && ids.has(parent)) {
      const siblings = children.get(parent);
      if (siblings) siblings.push(message);
      else children.set(parent, [message]);
    } else top.push(message);
  }
  const visiting = new Set<string>();
  const attach = (message: TranscriptMessage): TranscriptMessage => {
    const nested = children.get(message.id);
    // A malformed parent cycle is broken instead of recursing forever.
    if (!nested || visiting.has(message.id)) return message;
    visiting.add(message.id);
    const result = { ...message, children: nested.map(attach) };
    visiting.delete(message.id);
    return result;
  };
  return top.map(attach);
}

// Tool calls and the thinking between them collapse into one compact row,
// even a single call. Order is kept, failures and subagents break the group
// and stay visible, and a lone thought stays a normal row. The group id
// follows its first member so live appends keep the row, its expansion, and
// its counters stable.
export function groupTranscriptMessages(input: TranscriptMessage[]): TranscriptRow[] {
  const messages = nestSubagentMessages(input);
  const result: TranscriptRow[] = [];
  let group: TranscriptMessage[] = [];
  const flush = (): void => {
    if (!group.length) return;
    if (group.length === 1 && group[0]!.kind !== 'tool') result.push({ kind: 'message', id: group[0]!.id, message: group[0]! });
    else {
      const targets = group.flatMap((message) => message.tool?.target ? [message.tool.target] : []);
      result.push({ kind: 'tools', id: `tools:${group[0]!.id}`, messages: group, targets });
    }
    group = [];
  };
  for (const message of messages) {
    // Native providers may send an empty/redacted thinking block before the
    // next content block. Keep it in the stream state, but not as a blank row.
    if (message.role === 'assistant' && message.kind !== 'tool' && !message.text.trim()) continue;
    const tool = message.tool;
    // A subagent row keeps its own row so its nested transcript stays visible.
    // An html_render call is a step like any other, rejected or not: its page
    // appears only where the reply places it.
    if (message.kind === 'reasoning' || (message.kind === 'tool' && tool && (tool.status !== 'failed' || isFigureTool(tool)) && !message.children?.length)) {
      group.push(message);
      continue;
    }
    flush();
    const origin = transcriptMessageOrigin(message);
    result.push({ kind: 'message', id: transcriptMessageKey(message), message, ...(origin ? { origin } : {}) });
  }
  flush();
  return result;
}

// A call to Patterm's html_render. Claude shows mcp__patterm__html_render,
// OpenCode patterm_<hash>_html_render, and Codex server "patterm" with tool
// "html_render"; all reach the target "patterm: html_render" or similar.
export function isFigureTool(tool: TranscriptTool | undefined): boolean {
  return Boolean(tool && tool.family === 'mcp' && /^patterm[\w-]*:\s*html[._]render$/i.test(tool.target ?? ''));
}

// The page an agent sent. Codex nests MCP arguments, sometimes as JSON text.
export function figureToolInput(tool: TranscriptTool): unknown {
  const input = tool.input && typeof tool.input === 'object' ? tool.input as Record<string, unknown> : null;
  const args = input && typeof input.server === 'string' && 'arguments' in input ? input.arguments : tool.input;
  if (typeof args !== 'string') return args;
  try { return JSON.parse(args); } catch { return null; }
}

// Figure and answer ids: letters, digits, _ and -.
export const FIGURE_ID = '[A-Za-z0-9_][A-Za-z0-9_-]{0,47}';
const FIGURE_TOKEN = new RegExp(`\\[patterm_figure:(${FIGURE_ID})\\]`);
const ANSWER = new RegExp(`^Answer to (${FIGURE_ID}):`);

// Agents place a rendered page in their reply with this token.
export function figureToken(id: string): string {
  return `[patterm_figure:${id}]`;
}

// An html_render call that went through; rejected ones never draw.
export function isSavedFigure(tool: TranscriptTool | undefined): tool is TranscriptTool {
  return Boolean(tool && tool.status !== 'failed' && isFigureTool(tool));
}

// A rendered page's id: the one the agent chose, else the one html_render
// returned. Streamed appends keep other rows' tool objects, so this is cached
// per tool.
const figureIds = new WeakMap<TranscriptTool, string | null>();
export function figureId(tool: TranscriptTool): string | null {
  if (figureIds.has(tool)) return figureIds.get(tool)!;
  let id: string | null = null;
  const input = figureToolInput(tool);
  if (input && typeof input === 'object' && typeof (input as Record<string, unknown>).id === 'string') id = (input as Record<string, string>).id!;
  for (const reply of [tool.result, tool.output]) {
    if (id || reply === undefined || reply === null) continue;
    id = FIGURE_TOKEN.exec(typeof reply === 'string' ? reply : JSON.stringify(reply))?.[1] ?? null;
  }
  figureIds.set(tool, id);
  return id;
}

// A page's answer: one line per pick, so the agent reads the label and the value.
export function figureAnswerText(id: string, answers: Array<{ item?: string | undefined; label: string; value: string }>): string {
  if (answers.length === 1 && !answers[0]!.item) return `Answer to ${id}: ${answers[0]!.label} (${answers[0]!.value})`;
  return `Answer to ${id}:\n${answers.map((answer) => `- ${answer.item ? `${answer.item}: ` : ''}${answer.label} (${answer.value})`).join('\n')}`;
}

// Which questions the user already answered, from the user messages after them.
// A failed send is not an answer; one still sending or unconfirmed is, so the
// page cannot send it twice while the message row offers its own retry.
export function figureAnswers(messages: Array<{ role: string; text: string; delivery?: { state: string } | undefined }>): Map<string, string> {
  const answers = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'user' || message.delivery?.state === 'failed') continue;
    const match = ANSWER.exec(message.text.trimStart());
    if (match) answers.set(match[1]!, message.text.trim());
  }
  return answers;
}


// Native Codex item IDs differ from the client ID used by the optimistic row.
export function transcriptMessageKey(message: TranscriptMessage): string {
  return message.role === 'user' && message.clientMessageId ? `user_${message.clientMessageId}` : message.id;
}

// A tool group's summary, such as "Read, 3 Shell, 2 Web Search": each tool
// title once, in first-seen order, with its own call count. Thoughts in the
// group are not counted. Skills and MCP calls share a title, so the summary
// names which ones ran: "7 Bash, 2 Skill (simplify, run), MCP (notify_user)".
export function transcriptToolGroupSummary(messages: TranscriptMessage[]): { count: number; tools: Array<{ title: string; count: number }>; label: string } {
  const tools = new Map<string, { count: number; names: Set<string> }>();
  let count = 0;
  for (const message of messages) {
    if (!message.tool) continue;
    count += 1;
    const entry = tools.get(message.tool.title) ?? { count: 0, names: new Set<string>() };
    tools.set(message.tool.title, entry);
    entry.count += 1;
    const name = groupName(message.tool);
    if (name) entry.names.add(name);
  }
  const named = [...tools].map(([title, entry]) => ({ title: entry.names.size ? `${title} (${[...entry.names].join(', ')})` : title, count: entry.count }));
  return { count, tools: named, label: named.map((tool) => tool.count > 1 ? `${tool.count} ${tool.title}` : tool.title).join(', ') };
}

function groupName(tool: TranscriptTool): string | undefined {
  if (tool.family === 'skill') return tool.target;
  if (tool.family === 'mcp') return tool.target?.replace(/^[^:]+:\s*/, '');
  return undefined;
}

function timeOf(value: string | undefined): number | null {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

// How long each thought took: its own start and finish, or else until the
// next row began. Thoughts without either time are left out.
export function transcriptThoughtDurations(messages: TranscriptMessage[]): Map<string, number> {
  const durations = new Map<string, number>();
  const visit = (rows: TranscriptMessage[]): void => {
    rows.forEach((message, index) => {
      if (message.children?.length) visit(message.children);
      if (message.kind !== 'reasoning') return;
      const start = timeOf(message.createdAt);
      let next = index + 1;
      while (next < rows.length && rows[next]!.parentId !== message.parentId) next++;
      const end = timeOf(message.completedAt) ?? timeOf(rows[next]?.createdAt);
      if (start !== null && end !== null && end >= start) durations.set(message.id, end - start);
    });
  };
  visit(messages);
  return durations;
}

// The reply that ends each turn gets a footer with the time the turn took to
// generate: from the prompt until its last row finished. A turn still running
// has no duration yet, and a turn without times has none at all.
export function transcriptTurnDurations(messages: TranscriptMessage[], working: boolean): Map<string, number | null> {
  const result = new Map<string, number | null>();
  let prompt: TranscriptMessage | null = null;
  let reply: TranscriptMessage | null = null;
  let end: number | null = null;
  const close = (finished: boolean): void => {
    if (!reply) return;
    const start = timeOf(prompt?.createdAt);
    result.set(reply.id, finished && start !== null && end !== null && end >= start ? end - start : null);
  };
  for (const message of messages) {
    if (message.parentId) continue;
    if (message.role === 'user') {
      close(true);
      prompt = message;
      reply = null;
      end = null;
      continue;
    }
    const finished = timeOf(message.completedAt) ?? timeOf(message.createdAt);
    if (finished !== null && (end === null || finished > end)) end = finished;
    if (message.kind === 'text' && message.text.trim()) reply = message;
  }
  close(!working);
  return result;
}

export function transcriptRowIndexForMessage(rows: TranscriptRow[], id: string | undefined): number {
  if (!id) return -1;
  const messageId = id.startsWith('tools:') ? id.slice('tools:'.length) : id;
  const contains = (message: TranscriptMessage): boolean => message.id === messageId || Boolean(message.children?.some(contains));
  return rows.findIndex((row) => row.id === id || (row.kind === 'tools' ? row.messages.some(contains) : contains(row.message)));
}

// What a tool call is doing in a few words, for activity lists: the MCP server
// and tool, the shell command, or the tool and what it acts on.
export function toolActivityLabel(tool: TranscriptTool): string {
  const clip = (value: string) => {
    const line = value.trim().split('\n')[0] ?? '';
    return line.length > 120 ? `${line.slice(0, 117)}…` : line;
  };
  if (tool.family === 'mcp') return tool.target ? clip(tool.target) : tool.title;
  if (tool.family === 'shell' && tool.command) return clip(`${tool.title}: ${tool.command}`);
  return tool.target ? clip(`${tool.title} ${tool.target}`) : tool.title;
}

// One-line summary of a subagent's latest step for its collapsed row.
export function subagentSummary(children: TranscriptMessage[]): string {
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index]!;
    if (child.kind === 'tool' && child.tool) return child.tool.target ? `${child.tool.title} ${child.tool.target}` : child.tool.title;
    if (child.kind === 'text' && child.role === 'assistant' && child.text.trim()) return child.text.trim().split('\n')[0]!;
  }
  return '';
}

// Tool-row and tool-group expansion is keyed by process and row id so it
// survives transcript refreshes and process switches instead of resetting on
// every delta.
const rowExpansion = new Map<string, boolean>();

export function transcriptRowOpen(processId: string, id: string): boolean {
  return rowExpansion.get(`${processId}:${id}`) === true;
}

export function toggleTranscriptRow(processId: string, id: string): boolean {
  const key = `${processId}:${id}`;
  const next = !rowExpansion.get(key);
  rowExpansion.set(key, next);
  return next;
}

// User attachments become safe chips: names, sizes, and an image preview when
// the descriptor carries a stored image hash or a resolvable URL. Server paths
// are never read and data: payloads are never expanded in the transcript.
export function normaliseTranscriptAttachments(attachments: Array<Record<string, unknown>> | undefined): TranscriptAttachment[] {
  if (!attachments) return [];
  return attachments.flatMap((raw): TranscriptAttachment[] => {
    const row = record(raw);
    const type = typeof row.type === 'string' ? row.type : '';
    const path = firstString(row.path, row.uri);
    const sha256 = imageHash(row.sha256);
    const name = firstString(row.name) ?? path?.split(/[\\/]/).pop() ?? (sha256 ? 'Image' : '');
    if (!name && !path) return [];
    const url = typeof row.url === 'string' && /^(https?:|blob:)/.test(row.url) ? row.url : undefined;
    const mime = firstString(row.mime);
    const detail = firstString(row.detail, path);
    const image = (mime?.startsWith('image/') ?? false) || type === 'image' || type === 'localImage';
    return [{
      name: name || 'Attachment',
      ...(detail ? { detail } : {}),
      ...(url ? { url } : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(mime ? { mime } : {}),
      image
    }];
  });
}

function toolText(output: unknown, fallback: unknown): string {
  if (typeof output === 'string') return output;
  const row = record(output);
  if (typeof row.output === 'string') return row.output;
  if (Array.isArray(row.content)) {
    const content = row.content.flatMap((part) => typeof record(part).text === 'string' ? [String(record(part).text)] : []).join('\n');
    if (content) return content;
  }
  const json = JSON.stringify(output ?? fallback, null, 2);
  return json ?? '';
}

function rows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const data = record(value).data;
  return Array.isArray(data) ? data : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
