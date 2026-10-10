import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { AgentHistoryDb } from './AgentHistoryDb';
import type { MediaLocator } from './AgentHistoryTypes';
import { valueAt } from './HistoryAdapterUtils';

export const mediaListInput = z.object({
  project_id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  kind: z.enum(['pasted', 'viewed']).optional(),
  limit: z.number().int().positive().max(100).default(48),
  offset: z.number().int().nonnegative().default(0)
});

export const mediaGetInput = z.object({ project_id: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) });

// A transcript line holding an image is rarely more than a few megabytes.
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

export interface MediaItem {
  sha256: string;
  mime: string;
  sizeBytes: number;
  kind: 'pasted' | 'viewed';
  name: string | null;
  occurredAt: string | null;
  conversationId: string;
  conversationTitle: string | null;
  sessionId: string | null;
  messageId: string | null;
}

// Images indexed from imported conversations. The bytes are read back from
// the native transcript on request and checked against the indexed hash.
export class ConversationMediaService {
  constructor(private readonly database: AgentHistoryDb | null) {}

  // A session's images come from the conversations linked to it or to its
  // native resume ID. Each image is listed once per conversation, at its
  // first appearance, newest first.
  list(raw: z.input<typeof mediaListInput>, session?: { provider: string | null; resumeId: string | null }): { items: MediaItem[]; total: number } {
    const input = mediaListInput.parse(raw);
    if (!this.available()) return { items: [], total: 0 };
    const params: Record<string, unknown> = { project_id: input.project_id };
    const filters = ['conversations.project_id = @project_id'];
    if (input.session_id) {
      filters.push(`(conversations.session_id = @session_id or (conversations.provider = @provider and conversations.provider_conversation_id = @resume_id))`);
      Object.assign(params, { session_id: input.session_id, provider: session?.provider ?? '', resume_id: session?.resumeId ?? '' });
    }
    if (input.kind) {
      filters.push('conversation_media.kind = @kind');
      params.kind = input.kind;
    }
    const firsts = `
      select min(conversation_media.id) as id from conversation_media
      join conversations on conversations.id = conversation_media.conversation_id
      where ${filters.join(' and ')}
      group by conversation_media.conversation_id, conversation_media.sha256
    `;
    const total = (this.database!.connection.prepare(`select count(*) as count from (${firsts})`).get(params) as { count: number }).count;
    const rows = this.database!.connection.prepare(`
      select conversation_media.sha256, conversation_media.mime, conversation_media.size_bytes, conversation_media.kind, conversation_media.name,
        conversation_media.occurred_at, conversations.id as conversation_id, conversations.title, conversations.session_id, conversation_messages.id as message_id
      from (${firsts}) firsts
      join conversation_media on conversation_media.id = firsts.id
      join conversations on conversations.id = conversation_media.conversation_id
      left join conversation_messages on conversation_messages.conversation_id = conversation_media.conversation_id and conversation_messages.seq = conversation_media.message_seq
      order by coalesce(conversation_media.occurred_at, conversations.updated_at) desc, conversation_media.id desc
      limit @limit offset @offset
    `).all({ ...params, limit: input.limit, offset: input.offset }) as unknown as MediaRow[];
    return { total, items: rows.map(mapItem) };
  }

  // Tries each place the image was indexed until one still holds it.
  read(raw: z.input<typeof mediaGetInput>): { mime: string; data: string } {
    const input = mediaGetInput.parse(raw);
    if (!this.available()) throw new Error('This image is no longer stored');
    const sources = this.database!.connection.prepare(`
      select conversation_media.mime, conversation_media.source_path, conversation_media.locator from conversation_media
      join conversations on conversations.id = conversation_media.conversation_id
      where conversation_media.sha256 = ? and conversations.project_id = ?
      order by conversation_media.id desc limit 5
    `).all(input.sha256, input.project_id) as Array<{ mime: string; source_path: string; locator: string }>;
    for (const source of sources) {
      const bytes = readImage(source.source_path, JSON.parse(source.locator) as MediaLocator);
      if (bytes && crypto.createHash('sha256').update(bytes).digest('hex') === input.sha256) return { mime: source.mime, data: bytes.toString('base64') };
    }
    throw new Error('This image is no longer stored');
  }

  private available(): boolean {
    if (!this.database) return false;
    const maybeLazy = this.database as AgentHistoryDb & { ensureAvailable?: () => boolean };
    if (maybeLazy.ensureAvailable && !maybeLazy.ensureAvailable()) return false;
    return Boolean(this.database.connection.prepare(`select 1 from sqlite_master where type = 'table' and name = 'conversation_media'`).get());
  }
}

interface MediaRow {
  sha256: string;
  mime: string;
  size_bytes: number;
  kind: 'pasted' | 'viewed';
  name: string | null;
  occurred_at: string | null;
  conversation_id: string;
  title: string | null;
  session_id: string | null;
  message_id: string | null;
}

function mapItem(row: MediaRow): MediaItem {
  return { sha256: row.sha256, mime: row.mime, sizeBytes: row.size_bytes, kind: row.kind, name: row.name, occurredAt: row.occurred_at, conversationId: row.conversation_id, conversationTitle: row.title, sessionId: row.session_id, messageId: row.message_id };
}

// Returns null when the transcript has moved, shrunk, or been rewritten.
function readImage(sourcePath: string, locator: MediaLocator): Buffer | null {
  try {
    const record = locator.type === 'jsonl' ? readJsonlRecord(sourcePath, locator.offset, locator.length) : readSqliteRecord(sourcePath, locator.table, locator.rowId);
    const value = valueAt(record, locator.pointer);
    if (typeof value !== 'string') return null;
    return Buffer.from(value.replace(/^data:[^,]*,/, ''), 'base64');
  } catch {
    return null;
  }
}

function readJsonlRecord(filePath: string, offset: number, length: number): unknown {
  if (length <= 0 || length > MAX_RECORD_BYTES) return null;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, offset);
    return JSON.parse(buffer.subarray(0, read).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function readSqliteRecord(filePath: string, table: 'part' | 'session_message', rowId: string): unknown {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = db.prepare(`select data from ${table === 'part' ? 'part' : 'session_message'} where id = ?`).get(rowId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  } finally {
    db.close();
  }
}
