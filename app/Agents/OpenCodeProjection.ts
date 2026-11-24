import type { IntegratedConversationMessage, IntegratedConversationTool } from '../Services/IntegratedConversation';
import type { TranscriptImageRef } from '../Services/TranscriptImageStore';

const OPENCODE_BRIDGE_TOOL = /^patterm_[0-9a-f]{12}_(.+)$/;

export function resolveOpenCodeToolIdentity(name: string): { server?: string; tool?: string } {
  const match = name.match(OPENCODE_BRIDGE_TOOL);
  return match?.[1] ? { server: 'patterm', tool: match[1] } : {};
}

export function clientMessageIdFromOpenCodeId(id: string): string | undefined {
  return id.startsWith('msg_') && id.length > 4 ? id.slice(4) : undefined;
}

// Projects raw OpenCode v2 REST session/page/subagent rows into canonical
// IntegratedConversationMessage rows inside the OpenCode adapter boundary.
export function projectOpenCodeRows(rows: readonly unknown[]): IntegratedConversationMessage[] {
  const result: IntegratedConversationMessage[] = [];
  for (const [rowIndex, raw] of rows.entries()) {
    const row = record(raw);
    const id = stringField(row.id) ?? `message-${rowIndex}`;

    // Already projected rows pass through unchanged.
    if ((row.role === 'user' || row.role === 'assistant')
      && (row.kind === 'text' || row.kind === 'tool' || row.kind === 'reasoning' || row.kind === 'notice')
      && typeof row.text === 'string') {
      result.push(row as unknown as IntegratedConversationMessage);
      continue;
    }

    if (row.type === 'system') {
      if (row.level === 'error' || row.is_error === true) {
        result.push({ id, role: 'assistant', kind: 'text', text: String(row.text ?? '') });
      }
      continue;
    }

    if (row.type === 'synthetic' || row.type === 'agent-switched' || row.type === 'model-switched' || row.type === 'idle') {
      continue;
    }

    const parentId = stringField(row.parentId);
    const nested = parentId ? { parentId } : {};
    const messageTime = record(row.time);
    const times = rowTimes(messageTime.created, messageTime.completed);

    if (row.type === 'assistant' && Array.isArray(row.content)) {
      for (const [partIndex, rawPart] of row.content.entries()) {
        const part = record(rawPart);
        const partTime = record(part.time);
        const last = partIndex === row.content.length - 1;
        const partTimes = rowTimes(
          partTime.created ?? partTime.start ?? messageTime.created,
          partTime.completed ?? partTime.end ?? (last ? messageTime.completed : undefined)
        );
        if (part.type === 'text' && typeof part.text === 'string') {
          result.push({ id: `${id}-${partIndex}`, role: 'assistant', kind: 'text', text: part.text, ...partTimes, ...nested });
        } else if (part.type === 'reasoning' && typeof part.text === 'string') {
          result.push({ id: `${id}-${partIndex}`, role: 'assistant', kind: 'reasoning', text: part.text, ...partTimes, ...nested });
        } else if (part.type === 'tool') {
          result.push({ ...projectToolPart(`${id}-${partIndex}`, part), ...partTimes, ...nested });
        }
      }
      result.push(...assistantNotices(row, id, { ...rowTimes(messageTime.completed ?? messageTime.created, messageTime.completed), ...nested }));
      continue;
    }

    if (row.type === 'compaction') {
      const failed = row.status === 'failed';
      result.push({
        id,
        role: 'assistant',
        kind: 'notice',
        level: failed ? 'error' : 'info',
        text: row.status === 'running'
          ? 'Compacting the conversation…'
          : failed
            ? `Compaction failed: ${stringField(record(row.error).message) ?? 'unknown error'}`
            : 'Conversation compacted',
        ...times,
        ...nested
      });
      continue;
    }

    if (row.type === 'user' && Array.isArray(row.content)) {
      const text = row.content.flatMap((part) => typeof record(part).text === 'string' ? [String(record(part).text)] : []).join('\n');
      const attachments = messageAttachments(row);
      const clientMessageId = clientMessageIdFromOpenCodeId(id);
      result.push({
        id,
        ...(clientMessageId ? { clientMessageId } : {}),
        role: 'user',
        kind: 'text',
        text,
        ...(attachments.length ? { attachments } : {}),
        ...times,
        ...nested
      });
      continue;
    }

    if (row.type === 'shell' || typeof row.command === 'string' || typeof row.output === 'string') {
      const name = stringField(row.name) ?? stringField(row.command) ?? 'Shell';
      const output = typeof row.output === 'string' ? row.output : '';
      result.push({
        id,
        role: 'assistant',
        kind: 'tool',
        title: name,
        text: output,
        tool: {
          name,
          input: row.command !== undefined ? { command: row.command } : row.input,
          state: { status: stringField(row.status) ?? 'completed', output }
        },
        ...times,
        ...nested
      });
      continue;
    }

    if (typeof row.text === 'string') {
      const attachments = messageAttachments(row);
      const role = row.type === 'user' ? 'user' : 'assistant';
      const clientMessageId = role === 'user' ? clientMessageIdFromOpenCodeId(id) : undefined;
      result.push({
        id,
        ...(clientMessageId ? { clientMessageId } : {}),
        role,
        kind: 'text',
        text: row.text,
        ...(attachments.length ? { attachments } : {}),
        ...times,
        ...nested
      });
    }
  }
  return result;
}

function projectToolPart(id: string, part: Record<string, unknown>): IntegratedConversationMessage {
  const name = stringField(part.name) ?? 'Tool';
  const state = record(part.state);
  const output = toolOutputText(part.state);
  const images = storedToolImages(state);
  const identity = resolveOpenCodeToolIdentity(name);
  const tool: IntegratedConversationTool = {
    name,
    ...(part.input !== undefined ? { input: part.input } : state.input !== undefined ? { input: state.input } : {}),
    ...(part.state !== undefined ? { state: part.state } : {}),
    ...identity,
    ...(images.length ? { images } : {})
  };
  return {
    id,
    role: 'assistant',
    kind: 'tool',
    title: name,
    text: output,
    tool
  };
}

function toolOutputText(value: unknown): string {
  if (typeof value === 'string') return value;
  const state = record(value);
  if (typeof state.output === 'string') return state.output;
  if (typeof state.error === 'string') return state.error;
  if (typeof state.text === 'string') return state.text;
  return '';
}

function storedToolImages(state: Record<string, unknown>): TranscriptImageRef[] {
  if (!Array.isArray(state.content)) return [];
  const images: TranscriptImageRef[] = [];
  for (const item of state.content) {
    const entry = record(item);
    const sha256 = stringField(entry.sha256);
    const mime = stringField(entry.mime) ?? stringField(entry.mimeType);
    if (sha256 && mime) {
      const name = stringField(entry.name);
      const size = typeof entry.size === 'number' && Number.isFinite(entry.size)
        ? entry.size
        : typeof entry.bytes === 'number' && Number.isFinite(entry.bytes)
          ? entry.bytes
          : 0;
      images.push({
        type: 'image',
        sha256,
        mime,
        size,
        ...(name ? { name } : {})
      });
    }
  }
  return images;
}

function assistantNotices(
  row: Record<string, unknown>,
  id: string,
  meta: Pick<IntegratedConversationMessage, 'parentId' | 'createdAt' | 'completedAt'>
): IntegratedConversationMessage[] {
  const error = record(row.error);
  const retry = record(row.retry);
  if (stringField(error.message)) {
    return [{ id: `${id}-error`, role: 'assistant', kind: 'notice', level: 'error', text: error.message as string, ...meta }];
  }
  const notices: IntegratedConversationMessage[] = [];
  if (typeof retry.attempt === 'number') {
    notices.push({
      id: `${id}-retry`,
      role: 'assistant',
      kind: 'notice',
      level: 'warning',
      text: `${stringField(record(retry.error).message) ?? 'Request failed'}; retried (attempt ${retry.attempt})`,
      ...meta
    });
  }
  if (row.finish === 'length') {
    notices.push({ id: `${id}-finish`, role: 'assistant', kind: 'notice', level: 'warning', text: 'The response stopped at the output token limit.', ...meta });
  }
  if (row.finish === 'content-filter') {
    notices.push({ id: `${id}-finish`, role: 'assistant', kind: 'notice', level: 'warning', text: 'The provider filtered the response.', ...meta });
  }
  return notices;
}

function messageAttachments(row: Record<string, unknown>): Array<Record<string, unknown>> {
  const files = Array.isArray(row.files) ? row.files.map(record) : [];
  const parts = Array.isArray(row.content) ? row.content.flatMap((part) => record(part).type === 'file' ? [record(part)] : []) : [];
  return [...files, ...parts].filter((file) => Object.keys(file).length > 0);
}

function isoTime(value: unknown): string | undefined {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined;
}

function rowTimes(created: unknown, completed: unknown): Pick<IntegratedConversationMessage, 'createdAt' | 'completedAt'> {
  const createdAt = isoTime(created);
  const completedAt = isoTime(completed);
  return { ...(createdAt ? { createdAt } : {}), ...(completedAt ? { completedAt } : {}) };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
