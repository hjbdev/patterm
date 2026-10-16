import type { AgentHistoryDb } from './AgentHistoryDb';
import type { HistorySearchIndexService } from './HistorySearchIndexService';
import { randomUUID } from 'node:crypto';

export class AgentHistoryDeleteService {
  constructor(
    private readonly database: AgentHistoryDb,
    private readonly search?: Pick<HistorySearchIndexService, 'removeConversation'>
  ) {}

  deleteConversation(conversationId: string): { deleted: boolean } {
    const db = this.database.connection;
    const deleted = db.transaction(() => {
      const row = db.prepare(`select provider, provider_conversation_id, source_file_id from conversations where id = ?`).get(conversationId) as
        | { provider: string; provider_conversation_id: string | null; source_file_id: string | null }
        | undefined;
      if (row?.provider_conversation_id) {
        db.prepare(`
          insert into conversation_deletions (id, provider, provider_conversation_id, source_file_id, deleted_at, reason)
          values (?, ?, ?, ?, ?, 'user_deleted_local_copy')
          on conflict(provider, provider_conversation_id) do update set source_file_id = excluded.source_file_id, deleted_at = excluded.deleted_at, reason = excluded.reason
        `).run(randomUUID(), row.provider, row.provider_conversation_id, row.source_file_id, new Date().toISOString());
      }
      if (this.search) this.search.removeConversation(conversationId);
      else deleteHistoryFts(db, conversationId);
      db.prepare(`delete from conversations where id = ?`).run(conversationId);
    });
    deleted();
    return { deleted: true };
  }

  // Each conversation leaves a tombstone, so a later import does not bring it back.
  deleteProjectConversations(projectId: string): { deletedConversations: number } {
    const ids = this.database.connection.prepare(`select id from conversations where project_id = ?`).all(projectId) as Array<{ id: string }>;
    for (const { id } of ids) this.deleteConversation(id);
    this.database.connection.prepare(`delete from conversation_import_batches where project_id = ?`).run(projectId);
    return { deletedConversations: ids.length };
  }

  resetImportedHistory(): { deletedConversations: number } {
    const db = this.database.connection;
    const deletedConversations = db.transaction(() => {
      const row = db.prepare(`select count(*) as count from conversations`).get() as { count: number };
      clearHistoryFts(db);
      db.prepare(`delete from conversations`).run();
      db.prepare(`delete from conversation_deletions`).run();
      db.prepare(`delete from conversation_import_watermarks`).run();
      db.prepare(`delete from conversation_import_files`).run();
      db.prepare(`delete from conversation_import_batches`).run();
      // Usage rows cascade with their conversations; quota windows stand alone.
      if (db.prepare(`select 1 from sqlite_master where type = 'table' and name = 'provider_rate_limits'`).get()) db.prepare(`delete from provider_rate_limits`).run();
      if (db.prepare(`select 1 from sqlite_master where type = 'table' and name = 'provider_rate_limit_readings'`).get()) db.prepare(`delete from provider_rate_limit_readings`).run();
      return row.count;
    })();
    return { deletedConversations };
  }
}

function deleteHistoryFts(db: AgentHistoryDb['connection'], conversationId: string): void {
  try {
    db.prepare(`delete from conversation_history_fts where conversation_id = ? or (kind = 'conversation' and owner_id = ?)`).run(conversationId, conversationId);
  } catch {
    // Legacy app.db-only direct tests do not have the split history FTS table.
  }
}

function clearHistoryFts(db: AgentHistoryDb['connection']): void {
  try {
    db.prepare(`delete from conversation_history_fts`).run();
    db.prepare(`delete from conversation_history_rows`).run();
  } catch {
    // Legacy app.db-only direct tests do not have the split history FTS table.
  }
}
