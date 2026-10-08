import { z } from 'zod';
import type { DatabaseService } from './DatabaseService';
import type { AgentHistoryDb } from './AgentHistory/AgentHistoryDb';

const SEARCH_INDEX_CHUNK_SIZE = 500;
const APP_SEARCH_INDEX_VERSION_KEY = 'search.app_artifacts_fts.version';

export const searchInput = z.object({
  query: z.string().min(1),
  project_id: z.string().min(1).optional(),
  kinds: z.array(z.string().min(1)).optional(),
  limit: z.number().int().positive().max(100).default(25)
});

export type SearchInput = z.infer<typeof searchInput>;

export interface SearchResult {
  kind: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  preview: string;
  score: number;
  target: SearchResultTarget;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  groups: Record<string, SearchResult[]>;
}

export interface SearchResultTarget {
  project_id: string | null;
  tab: string | null;
  terminal_process_id: string | null;
  conversation_id?: string | null;
  conversation_message_id?: string | null;
}

interface SearchRow {
  kind: string;
  owner_id: string;
  conversation_id?: string | null;
  project_id: string | null;
  title: string | null;
  preview: string | null;
  score: number;
}

interface ArtifactRow {
  kind: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  body: string;
}

export class SearchService {
  constructor(private readonly database: DatabaseService, private readonly historyDatabase: AgentHistoryDb | null = null) {}

  search(input: SearchInput): SearchResponse {
    const query = buildFtsQuery(input.query);
    if (!query) {
      return { query: input.query, results: [], groups: {} };
    }

    const filters = ['app_artifacts_fts match @query'];
    const params: Record<string, unknown> = { query, limit: input.limit };

    if (input.project_id) {
      filters.push('project_id = @project_id');
      params.project_id = input.project_id;
    }
    if (input.kinds?.length) {
      filters.push(`kind in (${input.kinds.map((_, index) => `@kind_${index}`).join(', ')})`);
      input.kinds.forEach((kind, index) => {
        params[`kind_${index}`] = kind;
      });
    }

    const rows = this.database.connection
      .prepare(
        `
        select
          kind,
          owner_id,
          project_id,
          coalesce(title, '') as title,
          snippet(app_artifacts_fts, 4, '[', ']', '...', 24) as preview,
          bm25(app_artifacts_fts) as score
        from app_artifacts_fts
        where ${filters.join(' and ')}
        order by score asc
        limit @limit
      `
      )
      .all(params) as SearchRow[];
    const historyRows = this.historyDatabase
      ? this.historyDatabaseAvailable()
        ? this.searchHistory(input, query)
        : []
      : [];

    const results = [...rows, ...historyRows]
      .sort((a, b) => a.score - b.score)
      .slice(0, input.limit)
      .map((row) => ({
      kind: row.kind,
      owner_id: row.owner_id,
      project_id: row.project_id,
      title: row.title ?? '',
      preview: row.preview ?? '',
      score: row.score,
      target: this.targetFor(row.kind, row.owner_id, row.project_id, row.conversation_id ?? null)
    }));

    return {
      query: input.query,
      results,
      groups: groupResults(results)
    };
  }

  rebuildIndex(): void {
    const db = this.database.connection;
    const rebuild = db.transaction(() => {
      db.prepare(`delete from app_artifacts_fts`).run();
      const insert = db.prepare(
        `
        insert into app_artifacts_fts (kind, owner_id, project_id, title, body)
        values (@kind, @owner_id, @project_id, @title, @body)
      `
      );
      for (const row of this.artifacts()) {
        if (row.title.trim().length === 0 && row.body.trim().length === 0) {
          continue;
        }
        insert.run(row);
      }
      db.prepare(`
        insert into settings (key, value, updated_at) values (?, '1', ?)
        on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at
      `).run(APP_SEARCH_INDEX_VERSION_KEY, new Date().toISOString());
    });
    rebuild();
  }

  ensureIndex(): boolean {
    const row = this.database.connection.prepare(`select value from settings where key = ?`).get(APP_SEARCH_INDEX_VERSION_KEY) as { value: string } | undefined;
    if (row?.value === '1') return false;
    this.rebuildIndex();
    return true;
  }

  indexSession(sessionId: string): void {
    this.replaceArtifacts('session', sessionId, this.sessionArtifacts(sessionId));
  }

  indexTimelineEvent(eventId: string): void {
    this.replaceArtifacts('timeline', eventId, this.timelineArtifacts(eventId));
  }

  indexConversation(conversationId: string): void {
    this.replaceConversationArtifacts(conversationId, this.conversationArtifacts(conversationId));
  }

  async indexConversationAsync(conversationId: string): Promise<void> {
    await this.replaceConversationArtifactsForConversationAsync(conversationId);
  }

  removeConversation(conversationId: string): void {
    this.database.connection
      .prepare(`delete from app_artifacts_fts where (kind = 'conversation' and owner_id = ?) or (kind = 'conversation_message' and owner_id in (select id from conversation_messages where conversation_id = ?))`)
      .run(conversationId, conversationId);
  }

  private artifacts(): ArtifactRow[] {
    return [
      ...this.sessionArtifacts(),
      ...this.timelineArtifacts(),
      ...(!this.historyDatabaseAvailable() ? this.conversationArtifacts() : [])
    ];
  }

  private sessionArtifacts(sessionId?: string): ArtifactRow[] {
    const where = sessionId ? 'where id = @session_id' : '';
    return this.database.connection
      .prepare(
        `
        select id, project_id, harness, session_role, resume_id, resume_status, cwd, last_title, last_summary
        from sessions
        ${where}
      `
      )
      .all(sessionId ? { session_id: sessionId } : {})
      .map((row) => {
        const session = row as {
          id: string;
          project_id: string;
          harness: string | null;
          session_role: string;
          resume_id: string | null;
          resume_status: string;
          cwd: string | null;
          last_title: string | null;
          last_summary: string | null;
        };
        return {
          kind: 'session',
          owner_id: session.id,
          project_id: session.project_id,
          title: session.last_title ?? `${session.harness ?? 'agent'} ${session.session_role}`,
          body: [
            session.harness,
            session.session_role,
            session.resume_id,
            session.resume_status,
            session.cwd,
            session.last_summary
          ].filter(Boolean).join('\n')
        };
      });
  }

  private timelineArtifacts(eventId?: string): ArtifactRow[] {
    const where = eventId ? 'where id = @event_id' : '';
    return this.database.connection
      .prepare(`select id, event_type, project_id, actor_type, metadata from timeline_events ${where}`)
      .all(eventId ? { event_id: eventId } : {})
      .map((row) => {
        const event = row as {
          id: string;
          event_type: string;
          project_id: string | null;
          actor_type: string;
          metadata: string;
        };
        return {
          kind: 'timeline',
          owner_id: event.id,
          project_id: event.project_id,
          title: event.event_type,
          body: `${event.actor_type}\n${metadataText(event.metadata).join('\n')}`
        };
      });
  }

  private conversationArtifacts(conversationId?: string): ArtifactRow[] {
    const conversationWhere = conversationId ? 'where id = @conversation_id' : '';
    const conversationRows = this.database.connection
      .prepare(
        `select id, provider, provider_conversation_id, project_id, title, cwd, provider_version, status, link_reason, metadata
         from conversations ${conversationWhere}`
      )
      .all(conversationId ? { conversation_id: conversationId } : {}) as Array<{
        id: string;
        provider: string;
        provider_conversation_id: string | null;
        project_id: string | null;
        title: string | null;
        cwd: string | null;
        provider_version: string | null;
        status: string;
        link_reason: string | null;
        metadata: string;
      }>;
    const messageWhere = conversationId ? 'where conversation_messages.conversation_id = @conversation_id' : '';
    const messageRows = this.database.connection
      .prepare(
        `select conversation_messages.id, conversation_messages.conversation_id, conversation_messages.role, conversation_messages.kind,
          conversation_messages.text, conversation_messages.tool_name, conversation_messages.tool_status,
          conversation_messages.tool_input_summary, conversation_messages.tool_output_summary,
          conversations.provider, conversations.title, conversations.project_id
         from conversation_messages
         join conversations on conversations.id = conversation_messages.conversation_id
         ${messageWhere}`
      )
      .all(conversationId ? { conversation_id: conversationId } : {}) as Array<{
        id: string;
        conversation_id: string;
        role: string;
        kind: string;
        text: string;
        tool_name: string | null;
        tool_status: string | null;
        tool_input_summary: string | null;
        tool_output_summary: string | null;
        provider: string;
        title: string | null;
        project_id: string | null;
      }>;

    return [
      ...conversationRows.map((row) => ({
        kind: 'conversation',
        owner_id: row.id,
        project_id: row.project_id,
        title: row.title ?? `${row.provider} conversation`,
        body: [row.provider, row.provider_conversation_id, row.cwd, row.provider_version, row.status, row.link_reason, ...metadataText(row.metadata)].filter(Boolean).join('\n')
      })),
      ...messageRows.map((row) => ({
        kind: 'conversation_message',
        owner_id: row.id,
        project_id: row.project_id,
        title: `${row.provider} ${row.role}${row.title ? `: ${row.title}` : ''}`,
        body: [row.role, row.kind, row.text, row.tool_name, row.tool_status, row.tool_input_summary, row.tool_output_summary].filter(Boolean).join('\n')
      }))
    ];
  }

  private replaceArtifacts(kind: string | null, ownerId: string | null, rows: ArtifactRow[]): void {
    const db = this.database.connection;
    const replace = db.transaction(() => {
      if (kind && ownerId) {
        db.prepare(`delete from app_artifacts_fts where kind = ? and owner_id = ?`).run(kind, ownerId);
      } else if (ownerId) {
        db.prepare(`delete from app_artifacts_fts where owner_id = ?`).run(ownerId);
      } else if (kind) {
        db.prepare(`delete from app_artifacts_fts where kind = ?`).run(kind);
      }
      const insert = db.prepare(
        `insert into app_artifacts_fts (kind, owner_id, project_id, title, body)
         values (@kind, @owner_id, @project_id, @title, @body)`
      );
      for (const row of rows) {
        if (row.title.trim().length === 0 && row.body.trim().length === 0) continue;
        insert.run(row);
      }
    });
    replace();
  }

  private replaceConversationArtifacts(conversationId: string, rows: ArtifactRow[]): void {
    const db = this.database.connection;
    const replace = db.transaction(() => {
      db.prepare(`delete from app_artifacts_fts where kind = 'conversation' and owner_id = ?`).run(conversationId);
      db.prepare(`delete from app_artifacts_fts where kind = 'conversation_message' and owner_id in (select id from conversation_messages where conversation_id = ?)`).run(conversationId);
      const insert = db.prepare(
        `insert into app_artifacts_fts (kind, owner_id, project_id, title, body)
         values (@kind, @owner_id, @project_id, @title, @body)`
      );
      for (const row of rows) {
        if (row.title.trim().length === 0 && row.body.trim().length === 0) continue;
        insert.run(row);
      }
    });
    replace();
  }

  private async replaceConversationArtifactsForConversationAsync(conversationId: string): Promise<void> {
    const db = this.database.connection;
    const insert = db.prepare(
      `insert into app_artifacts_fts (kind, owner_id, project_id, title, body)
       values (@kind, @owner_id, @project_id, @title, @body)`
    );
    const conversationRows = db
      .prepare(
        `select id, provider, provider_conversation_id, project_id, title, cwd, provider_version, status, link_reason, metadata
         from conversations where id = ?`
      )
      .all(conversationId) as Array<{
        id: string;
        provider: string;
        provider_conversation_id: string | null;
        project_id: string | null;
        title: string | null;
        cwd: string | null;
        provider_version: string | null;
        status: string;
        link_reason: string | null;
        metadata: string;
      }>;
    const conversationArtifacts = conversationRows.map((row) => ({
      kind: 'conversation',
      owner_id: row.id,
      project_id: row.project_id,
      title: row.title ?? `${row.provider} conversation`,
      body: [row.provider, row.provider_conversation_id, row.cwd, row.provider_version, row.status, row.link_reason, ...metadataText(row.metadata)].filter(Boolean).join('\n')
    }));

    db.transaction(() => {
      db.prepare(`delete from app_artifacts_fts where kind = 'conversation' and owner_id = ?`).run(conversationId);
      db.prepare(`delete from app_artifacts_fts where kind = 'conversation_message' and owner_id in (select id from conversation_messages where conversation_id = ?)`).run(conversationId);
      for (const row of conversationArtifacts) {
        if (row.title.trim().length === 0 && row.body.trim().length === 0) continue;
        insert.run(row);
      }
    })();

    let offset = 0;
    while (true) {
      const messageRows = db
        .prepare(
          `select conversation_messages.id, conversation_messages.conversation_id, conversation_messages.role, conversation_messages.kind,
            conversation_messages.text, conversation_messages.tool_name, conversation_messages.tool_status,
            conversation_messages.tool_input_summary, conversation_messages.tool_output_summary,
            conversations.provider, conversations.title, conversations.project_id
           from conversation_messages
           join conversations on conversations.id = conversation_messages.conversation_id
           where conversation_messages.conversation_id = ?
           order by conversation_messages.seq asc
           limit ? offset ?`
        )
        .all(conversationId, SEARCH_INDEX_CHUNK_SIZE, offset) as Array<{
          id: string;
          conversation_id: string;
          role: string;
          kind: string;
          text: string;
          tool_name: string | null;
          tool_status: string | null;
          tool_input_summary: string | null;
          tool_output_summary: string | null;
          provider: string;
          title: string | null;
          project_id: string | null;
        }>;
      if (messageRows.length === 0) break;
      const chunk = messageRows.map((row) => ({
        kind: 'conversation_message',
        owner_id: row.id,
        project_id: row.project_id,
        title: `${row.provider} ${row.role}${row.title ? `: ${row.title}` : ''}`,
        body: [row.role, row.kind, row.text, row.tool_name, row.tool_status, row.tool_input_summary, row.tool_output_summary].filter(Boolean).join('\n')
      }));
      db.transaction(() => {
        for (const row of chunk) {
          if (row.title.trim().length === 0 && row.body.trim().length === 0) continue;
          insert.run(row);
        }
      })();
      offset += messageRows.length;
      await yieldToMain();
    }
  }

  private searchHistory(input: SearchInput, query: string): SearchRow[] {
    if (!this.historyDatabase) return [];
    const filters = ['conversation_history_fts match @query'];
    const params: Record<string, unknown> = { query, limit: input.limit };
    if (input.project_id) {
      filters.push('project_id = @project_id');
      params.project_id = input.project_id;
    }
    if (input.kinds?.length) {
      const historyKinds = input.kinds.filter((kind) => kind === 'conversation' || kind === 'conversation_message');
      if (historyKinds.length === 0) return [];
      filters.push(`kind in (${historyKinds.map((_, index) => `@history_kind_${index}`).join(', ')})`);
      historyKinds.forEach((kind, index) => {
        params[`history_kind_${index}`] = kind;
      });
    }
    try {
      return this.historyDatabase.connection.prepare(`
        select
          kind,
          owner_id,
          conversation_id,
          project_id,
          coalesce(title, '') as title,
          snippet(conversation_history_fts, 5, '[', ']', '...', 24) as preview,
          bm25(conversation_history_fts) as score
        from conversation_history_fts
        where ${filters.join(' and ')}
        order by score asc
        limit @limit
      `).all(params) as SearchRow[];
    } catch {
      return [];
    }
  }

  private historyDatabaseAvailable(): boolean {
    if (!this.historyDatabase) return false;
    const maybeLazy = this.historyDatabase as AgentHistoryDb & { ensureAvailable?: () => boolean };
    return maybeLazy.ensureAvailable ? maybeLazy.ensureAvailable() : true;
  }

  private targetFor(kind: string, ownerId: string, projectId: string | null = null, conversationId: string | null = null): SearchResultTarget {
    const base = (tab: string | null): SearchResultTarget => ({ project_id: projectId, tab, terminal_process_id: null });
    if (kind === 'timeline') return base('timeline');
    if (kind === 'session') {
      const row = this.database.connection.prepare(`select process_id from sessions where id = ?`).get(ownerId) as { process_id: string | null } | undefined;
      return { project_id: projectId, tab: 'agents', terminal_process_id: row?.process_id ?? null };
    }
    if (kind === 'conversation') {
      return { project_id: projectId, tab: 'history', terminal_process_id: null, conversation_id: ownerId, conversation_message_id: null };
    }
    if (kind === 'conversation_message') {
      if (!conversationId) {
        const row = this.legacyConversationForMessage(ownerId);
        conversationId = row?.conversation_id ?? conversationId;
        projectId = row?.project_id ?? projectId;
      }
      return { project_id: projectId, tab: 'history', terminal_process_id: null, conversation_id: conversationId, conversation_message_id: ownerId };
    }
    return base(null);
  }

  private legacyConversationForMessage(ownerId: string): { conversation_id: string; project_id: string | null } | undefined {
    try {
      return this.database.connection.prepare(`select conversations.id as conversation_id, conversations.project_id from conversation_messages join conversations on conversations.id = conversation_messages.conversation_id where conversation_messages.id = ?`).get(ownerId) as { conversation_id: string; project_id: string | null } | undefined;
    } catch {
      return undefined;
    }
  }
}

function buildFtsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_./#@:-]+/gu) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' ');
}

function groupResults(results: SearchResult[]): Record<string, SearchResult[]> {
  return results.reduce<Record<string, SearchResult[]>>((groups, result) => {
    groups[result.kind] ??= [];
    groups[result.kind]!.push(result);
    return groups;
  }, {});
}

function metadataText(metadata: string): string[] {
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return flattenJson(parsed);
  } catch {
    return [metadata];
  }
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function flattenJson(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenJson);
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [key, ...flattenJson(nested)]);
  }
  return [];
}
