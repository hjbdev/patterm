import type { AgentHistoryDb } from './AgentHistoryDb';

const SEARCH_INDEX_CHUNK_SIZE = 500;

interface ArtifactRow {
  kind: string;
  owner_id: string;
  conversation_id: string | null;
  project_id: string | null;
  title: string;
  body: string;
}

export class HistorySearchIndexService {
  constructor(private readonly database: AgentHistoryDb) {}

  rebuildIndex(): void {
    const db = this.database.connection;
    db.transaction(() => {
      db.prepare(`delete from conversation_history_fts`).run();
      db.prepare(`delete from conversation_history_rows`).run();
      db.prepare(`delete from conversation_history_index_state`).run();
      const conversations = this.conversationRows();
      const artifacts = [...conversations.map(conversationArtifact), ...this.messageArtifactPage().artifacts];
      this.insertArtifacts(artifacts);
      const counts = new Map((db.prepare(`select conversation_id, count(*) as count from conversation_messages group by conversation_id`).all() as Array<{ conversation_id: string; count: number }>).map((row) => [row.conversation_id, row.count]));
      const insertState = db.prepare(`
        insert into conversation_history_index_state (conversation_id, message_count, project_id, title, body_signature)
        values (?, ?, ?, ?, ?)
      `);
      for (const conversation of conversations) {
        const header = conversationArtifact(conversation);
        insertState.run(conversation.id, counts.get(conversation.id) ?? 0, header.project_id, header.title, conversationHeaderSignature(conversation));
      }
    })();
  }

  indexConversation(conversationId: string): void {
    this.replaceConversationArtifacts(conversationId, this.conversationArtifacts(conversationId));
  }

  async indexConversationAsync(conversationId: string): Promise<void> {
    this.replaceConversationHeader(conversationId);
    let nextSeq = 0;
    while (true) {
      const page = this.messageArtifactPage(conversationId, SEARCH_INDEX_CHUNK_SIZE, nextSeq);
      if (page.artifacts.length === 0) break;
      this.database.connection.transaction(() => this.insertArtifacts(page.artifacts))();
      nextSeq = page.nextSeq;
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.updateIndexState(conversationId);
  }

  async indexConversationAppend(conversationId: string, previousMessageCount: number, currentMessageCount?: number): Promise<void> {
    const currentConversation = this.conversationRows(conversationId)[0];
    const currentHeader = currentConversation ? conversationArtifact(currentConversation) : undefined;
    const indexed = this.database.connection.prepare(`
      select message_count, project_id, title, body_signature
      from conversation_history_index_state
      where conversation_id = ?
    `).get(conversationId) as IndexStateRow | undefined;
    if (!currentConversation || !currentHeader || !indexed || indexed.message_count !== previousMessageCount ||
      indexed.project_id !== currentHeader.project_id ||
      indexed.title !== currentHeader.title ||
      indexed.body_signature !== conversationHeaderSignature(currentConversation)) {
      await this.indexConversationAsync(conversationId);
      return;
    }

    this.database.connection.prepare(`delete from conversation_history_index_state where conversation_id = ?`).run(conversationId);
    let nextSeq = previousMessageCount;
    while (true) {
      const page = this.messageArtifactPage(conversationId, SEARCH_INDEX_CHUNK_SIZE, nextSeq);
      if (page.artifacts.length === 0) break;
      this.database.connection.transaction(() => this.insertArtifacts(page.artifacts))();
      nextSeq = page.nextSeq;
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.updateIndexState(conversationId, currentConversation, currentMessageCount);
  }

  removeConversation(conversationId: string): void {
    this.database.connection.transaction(() => {
      this.database.connection
        .prepare(`delete from conversation_history_fts where rowid in (
          select fts_rowid from conversation_history_rows where conversation_id = ?
        )`)
        .run(conversationId);
      this.database.connection.prepare(`delete from conversation_history_rows where conversation_id = ?`).run(conversationId);
      this.database.connection.prepare(`delete from conversation_history_index_state where conversation_id = ?`).run(conversationId);
    })();
  }

  private replaceConversationHeader(conversationId: string): void {
    const rows = this.conversationRows(conversationId).map(conversationArtifact);
    this.database.connection.transaction(() => {
      this.removeConversation(conversationId);
      this.insertArtifacts(rows);
    })();
  }

  private replaceConversationArtifacts(conversationId: string, rows: ArtifactRow[]): void {
    this.database.connection.transaction(() => {
      this.removeConversation(conversationId);
      this.insertArtifacts(rows);
      this.updateIndexState(conversationId);
    })();
  }

  private updateIndexState(conversationId: string, conversation = this.conversationRows(conversationId)[0], messageCount?: number): void {
    if (!conversation) {
      this.database.connection.prepare(`delete from conversation_history_index_state where conversation_id = ?`).run(conversationId);
      return;
    }
    const header = conversationArtifact(conversation);
    const messages = messageCount === undefined
      ? this.database.connection.prepare(`select count(*) as count from conversation_messages where conversation_id = ?`).get(conversationId) as { count: number }
      : { count: messageCount };
    this.database.connection.prepare(`
      insert into conversation_history_index_state (conversation_id, message_count, project_id, title, body_signature)
      values (?, ?, ?, ?, ?)
      on conflict(conversation_id) do update set message_count = excluded.message_count, project_id = excluded.project_id,
        title = excluded.title, body_signature = excluded.body_signature
    `).run(conversationId, messages.count, header.project_id, header.title, conversationHeaderSignature(conversation));
  }

  private insertArtifacts(rows: ArtifactRow[]): void {
    const insert = this.database.connection.prepare(`
      insert into conversation_history_fts (kind, owner_id, conversation_id, project_id, title, body)
      values (@kind, @owner_id, @conversation_id, @project_id, @title, @body)
    `);
    const rememberRow = this.database.connection.prepare(`
      insert or replace into conversation_history_rows (fts_rowid, conversation_id) values (?, ?)
    `);
    for (const row of rows) {
      if (row.title.trim().length === 0 && row.body.trim().length === 0) continue;
      const result = insert.run(row);
      rememberRow.run(result.lastInsertRowid, row.conversation_id ?? row.owner_id);
    }
  }

  private conversationArtifacts(conversationId?: string): ArtifactRow[] {
    return [
      ...this.conversationRows(conversationId).map(conversationArtifact),
      ...this.messageArtifactPage(conversationId).artifacts
    ];
  }

  private conversationRows(conversationId?: string): ConversationRow[] {
    const where = conversationId ? 'where id = @conversation_id' : '';
    return this.database.connection.prepare(`
      select id, provider, provider_conversation_id, project_id, title, cwd, provider_version, status, link_reason, metadata
      from conversations ${where}
    `).all(conversationId ? { conversation_id: conversationId } : {}) as ConversationRow[];
  }

  private messageArtifactPage(conversationId?: string, limit?: number, startSeq = 0): MessageArtifactPage {
    const filters = conversationId ? ['conversation_messages.conversation_id = @conversation_id'] : [];
    const params: Record<string, unknown> = {};
    if (conversationId) params.conversation_id = conversationId;
    if (startSeq > 0) {
      filters.push('conversation_messages.seq >= @start_seq');
      params.start_seq = startSeq;
    }
    let suffix = '';
    if (limit !== undefined) {
      suffix = 'limit @limit';
      params.limit = limit;
    }
    const where = filters.length ? `where ${filters.join(' and ')}` : '';
    const rows = this.database.connection.prepare(`
      select conversation_messages.id, conversation_messages.conversation_id, conversation_messages.seq, conversation_messages.role, conversation_messages.kind,
        conversation_messages.text, conversation_messages.tool_name, conversation_messages.tool_status,
        conversation_messages.tool_input_summary, conversation_messages.tool_output_summary,
        conversations.provider, conversations.title, conversations.project_id
      from conversation_messages
      join conversations on conversations.id = conversation_messages.conversation_id
      ${where}
      order by conversation_messages.seq asc
      ${suffix}
    `).all(params) as MessageRow[];
    const artifacts = rows.map((row) => ({
      kind: 'conversation_message',
      owner_id: row.id,
      conversation_id: row.conversation_id,
      project_id: row.project_id,
      title: `${row.provider} ${row.role}${row.title ? `: ${row.title}` : ''}`,
      body: [row.role, row.kind, row.text, row.tool_name, row.tool_status, row.tool_input_summary, row.tool_output_summary].filter(Boolean).join('\n')
    }));
    return { artifacts, nextSeq: rows.length > 0 ? rows[rows.length - 1]!.seq + 1 : startSeq };
  }
}

interface ConversationRow { id: string; provider: string; provider_conversation_id: string | null; project_id: string | null; title: string | null; cwd: string | null; provider_version: string | null; status: string; link_reason: string | null; metadata: string; }
interface MessageRow { id: string; conversation_id: string; seq: number; role: string; kind: string; text: string; tool_name: string | null; tool_status: string | null; tool_input_summary: string | null; tool_output_summary: string | null; provider: string; title: string | null; project_id: string | null; }
interface MessageArtifactPage { artifacts: ArtifactRow[]; nextSeq: number; }
interface IndexStateRow { message_count: number; project_id: string | null; title: string; body_signature: string; }

function conversationArtifact(row: ConversationRow): ArtifactRow {
  return {
    kind: 'conversation',
    owner_id: row.id,
    conversation_id: row.id,
    project_id: row.project_id,
    title: row.title ?? `${row.provider} conversation`,
    body: [row.provider, row.provider_conversation_id, row.cwd, row.provider_version, row.status, row.link_reason, ...metadataText(row.metadata)].filter(Boolean).join('\n')
  };
}

function conversationHeaderSignature(row: ConversationRow): string {
  return JSON.stringify([row.provider, row.provider_conversation_id, row.cwd, row.provider_version, row.status, row.link_reason, row.metadata]);
}

function metadataText(metadata: string): string[] {
  try {
    return flattenJson(JSON.parse(metadata) as unknown);
  } catch {
    return [metadata];
  }
}

function flattenJson(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(flattenJson);
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [key, ...flattenJson(nested)]);
  return [];
}
