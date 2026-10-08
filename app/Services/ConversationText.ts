import { normaliseMessages } from './TranscriptProjection';

// Agent-facing text for a conversation. Integrated snapshots, native older
// pages, and imported history rows are reduced to the same rows, so readers
// see one shape and never snapshot metadata such as the command catalogue.

export type ConversationRowKind = 'text' | 'tool' | 'reasoning' | 'notice';

export interface ConversationRow {
  id: string;
  role: 'user' | 'assistant';
  kind: ConversationRowKind;
  title?: string;
  // Tools: a one-line input summary and status. The output is `text`.
  detail?: string;
  text: string;
  level?: string;
}

const TOOL_DETAIL_CHARS = 200;

// Top-level rows of an Integrated snapshot or native page, in whichever
// shape the provider sends (`messages: { data: [...] }`), projected as the
// transcript view projects them. Subagent rows nest under their tool call and
// are left out. Native rows are filtered before projection, which does not
// keep `parentId` for every native shape (OpenCode child prompts).
export function snapshotRows(conversation: unknown): ConversationRow[] {
  const messages = (conversation as { messages?: unknown } | null)?.messages;
  const data = Array.isArray(messages) ? messages : (messages as { data?: unknown } | null)?.data;
  const own = Array.isArray(data) ? data.filter((row) => !(row as { parentId?: unknown } | null)?.parentId) : [];
  return normaliseMessages(own).flatMap((message): ConversationRow[] => {
    if (message.parentId) return [];
    const tool = message.tool;
    // The native name says which tool ran; the family title (such as MCP) is a fallback.
    const title = message.title || tool?.name || tool?.title;
    const description = (tool?.input as { description?: unknown } | undefined)?.description;
    const summary = typeof description === 'string' && description.trim() ? description : tool?.command ?? tool?.target;
    const detail = tool ? toolDetail(summary === title ? null : summary, tool.status) : '';
    return [{
      id: message.id,
      role: message.role,
      kind: message.kind,
      ...(title ? { title } : {}),
      ...(detail ? { detail } : {}),
      text: message.kind === 'text' ? withAttachments(message.text, message.attachments) : message.text,
      ...(message.level ? { level: message.level } : {})
    }];
  });
}

// Imported history rows, as AgentHistoryReadService maps them.
export function historyRows(messages: Array<{ id: string; role: string; kind: string; text: string; toolName?: string | null; toolInputSummary?: string | null; toolOutputSummary?: string | null; toolStatus?: string | null; metadata?: Record<string, unknown> | null }>): ConversationRow[] {
  return messages.map((message) => {
    const tool = message.kind === 'tool_call' || message.kind === 'tool_result' || message.role === 'tool';
    // Importers mark reasoning in metadata, as the history view reads it.
    const reasoning = !tool && message.metadata?.type === 'reasoning';
    const kind: ConversationRowKind = tool ? 'tool' : reasoning ? 'reasoning' : message.kind === 'summary' || message.kind === 'event' || message.role === 'system' ? 'notice' : 'text';
    const detail = tool ? toolDetail(message.toolInputSummary, message.toolStatus) : '';
    return {
      id: message.id,
      role: message.role === 'user' ? 'user' : 'assistant',
      kind,
      ...(tool && message.toolName ? { title: message.toolName } : {}),
      ...(detail ? { detail } : {}),
      // Imported tool results keep their output in the summary field.
      text: tool ? [message.text, message.toolOutputSummary].filter(Boolean).join('\n') : message.text ?? ''
    };
  });
}

// A row's readable body: tools show their summary line, then their output.
export function rowBody(row: ConversationRow): string {
  if (row.kind !== 'tool') return row.text.trim();
  return [row.detail, row.text.trim()].filter(Boolean).join('\n');
}

export function renderRow(row: ConversationRow): string {
  const label = row.kind === 'tool' ? `tool${row.title ? ` ${row.title}` : ''}`
    : row.kind === 'notice' ? `notice${row.level ? ` ${row.level}` : ''}`
      : row.kind === 'reasoning' ? 'reasoning' : row.role;
  const body = rowBody(row);
  return body ? `[${label}] ${body}` : `[${label}]`;
}

// A snapshot as text for terminal-style reads and searches. Reasoning is left
// out: it is long, and not what the agent told anyone. Tool output stays, so
// searches and pattern waits still see command output.
export function snapshotText(conversation: unknown): string {
  return snapshotRows(conversation).filter((row) => row.kind !== 'reasoning').map(renderRow).join('\n\n');
}

// The end of `text` within `maxBytes` UTF-8 bytes, never splitting a character.
export function tailUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return { text: buffer.subarray(start).toString('utf8'), truncated: true };
}

// The start of `text` within `maxBytes` UTF-8 bytes, never splitting a character.
export function headUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

// A tool's one-line summary, with its status only when it is not plainly done.
function toolDetail(summary: string | null | undefined, status: string | null | undefined): string {
  const line = summary?.split('\n')[0]?.trim().slice(0, TOOL_DETAIL_CHARS);
  const notable = status === 'running' || status === 'failed' || status === 'error' ? status : null;
  return [line, notable].filter(Boolean).join(' · ');
}

function withAttachments(text: string, attachments: ReadonlyArray<Record<string, unknown>> | undefined): string {
  if (!attachments?.length) return text;
  const labels = attachments.map((attachment) => {
    const type = typeof attachment.type === 'string' ? attachment.type : 'attachment';
    const name = typeof attachment.name === 'string' ? attachment.name : null;
    return `[${type}${name ? `:${name}` : ''}]`;
  });
  return [text, labels.join(' ')].filter(Boolean).join(' ');
}
