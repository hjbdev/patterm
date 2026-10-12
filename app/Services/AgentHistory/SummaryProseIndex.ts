import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { SqliteConnection } from '../../Database/SqliteConnection';
import { SecretRedactor } from './SecretRedactor';

// A content-based projection of retained prose. It stores references and hashes,
// not another copy of transcripts. UUID replacement alone does not lose coverage.
export interface ProseMessage { id: string; role: string; kind: string; text: string; metadata: string; }

export function proseLabel(message: ProseMessage): string | null {
  if (message.kind !== 'message' || !['user', 'assistant'].includes(message.role)) return null;
  let metadata: Record<string, unknown>;
  try { metadata = JSON.parse(message.metadata); } catch { return null; }
  if (metadata.type === 'reasoning' || metadata.contentType === 'thinking' || metadata.isSidechain === true || metadata.subagent === true || metadata.parentId) return null;
  if (message.role === 'assistant') return 'Assistant';
  const text = message.text.trim();
  if (/^\[(?:report from|message from|agent message from)\b/i.test(text)) return 'Agent report';
  if (/^\[(?:Patterm\b|System notification\b|system\]|Attention (?:requested|needed) by|Failure reported by)/i.test(text)) return null;
  if (/^# AGENTS\.md instructions for\b/.test(text)) return null;
  if (/^<(?:environment_context|INSTRUCTIONS|system-reminder|command-name|local-command|task-notification)\b/i.test(text)) return null;
  if (/^\/(?:compact|clear|new|help|model|status)(?:\s|$)/i.test(text)) return null;
  return 'User';
}

export function proseText(text: string): string {
  return new SecretRedactor().redact(stripVTControlCharacters(text)).text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim();
}

export function proseHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export class SummaryProseIndex {
  private available: boolean;
  constructor(private readonly db: SqliteConnection) {
    this.available = Boolean(db.prepare("select 1 from sqlite_master where name = 'summary_prose'").get());
  }

  publish(conversationId: string): void {
    if (!this.available) return; // Legacy app.db imports have no prose projection.
    const messages = this.db.prepare(`select id, role, kind, text, metadata from conversation_messages
      where conversation_id = ? and kind = 'message' and role in ('user', 'assistant') order by seq`).all(conversationId) as ProseMessage[];
    let prefix = '', bytes = 0;
    const rows = messages.flatMap((message) => {
      const label = proseLabel(message), text = proseText(message.text);
      if (!label || !text) return [];
      const hash = proseHash(`${label}\n${text}`);
      prefix = proseHash(`${prefix}\n${hash}`);
      const size = Buffer.byteLength(text);
      bytes += size;
      return [{ id: message.id, label, hash, prefix, size }];
    });
    this.db.transaction(() => {
      this.db.prepare('delete from summary_prose where conversation_id = ?').run(conversationId);
      const insert = this.db.prepare(`insert into summary_prose values (?, ?, ?, ?, ?, ?, ?)`);
      rows.forEach((row, position) => insert.run(conversationId, position, row.id, row.label, row.size, row.hash, row.prefix));
      this.db.prepare(`insert into summary_prose_sources values (?, 1, ?, ?, ?)
        on conflict(conversation_id) do update set revision = revision + 1, message_count = excluded.message_count,
          total_bytes = excluded.total_bytes, content_hash = excluded.content_hash`).run(conversationId, rows.length, bytes, prefix);
    })();
  }

  // Existing, unchanged files still need their first projection after upgrade.
  missing(): string[] {
    if (!this.available) return [];
    return (this.db.prepare(`select c.id from conversations c left join summary_prose_sources s on s.conversation_id = c.id
      where c.session_id is not null and s.conversation_id is null`).all() as Array<{ id: string }>).map((row) => row.id);
  }
}
