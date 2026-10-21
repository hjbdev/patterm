import { z } from 'zod';
import { HISTORY_IMPORT_STALE_MS } from './AgentHistoryTypes';
import type { AgentHistoryDb } from './AgentHistoryDb';

export const historyListInput = z.object({
  project_id: z.string().min(1).optional(),
  provider: z.enum(['claude', 'codex', 'opencode']).optional(),
  session_id: z.string().min(1).optional(),
  // The /resume picker: hides sub-agent and routine-run conversations and orders by the later
  // of last activity and when the session closed.
  resumable: z.boolean().default(false),
  limit: z.number().int().positive().max(100).default(30),
  offset: z.number().int().nonnegative().default(0)
});

export const historyGetInput = z.object({
  conversation_id: z.string().min(1),
  anchor_message_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).default(80),
  offset: z.number().int().nonnegative().default(0)
});

export const conversationHistorySearchInput = z.object({
  query: z.string().min(1),
  project_id: z.string().min(1),
  provider: z.enum(['claude', 'codex', 'opencode']).optional(),
  limit: z.number().int().positive().max(50).default(20)
});

export const conversationSearchInput = z.object({
  query: z.string().min(1),
  project_id: z.string().min(1),
  provider: z.enum(['claude', 'codex', 'opencode']).optional(),
  resumable: z.boolean().default(false),
  limit: z.number().int().positive().max(50).default(30)
});

// Snippet markers that cannot occur in indexed text, so the renderer can
// highlight matches without parsing brackets out of real content.
export const SEARCH_MATCH_START = '\u0002';
export const SEARCH_MATCH_END = '\u0003';

// What the app database knows about a conversation's Patterm session. History
// lives in its own database, so callers pass this in for resumable listings.
export interface ConversationSessionState { id: string; role: string; exitedAt: string | null }

// Sessions Patterm started on someone's behalf rather than the user's own.
const HIDDEN_RESUME_ROLES = new Set(['child', 'routine']);

// Both lookups are evaluated once per query: SQLite builds an ephemeral index
// for the uncorrelated IN list and the materialized close times. Reading the
// JSON per row made broad searches take seconds.
// Subagent and reviewer threads a harness started itself record their parent.
const NOT_HIDDEN = `coalesce(conversations.session_id, '') not in (select value from json_each(@hidden_sessions))
  and json_extract(conversations.metadata, '$.parentThreadId') is null and json_extract(conversations.metadata, '$.parentId') is null`;
const SESSION_CLOSED_CTE = `session_closed as materialized (
  select json_extract(value, '$[0]') as id, json_extract(value, '$[1]') as exited_at from json_each(@closed_sessions)
)`;

function resumeParams(sessions: readonly ConversationSessionState[]) {
  return {
    hidden_sessions: JSON.stringify(sessions.filter((session) => HIDDEN_RESUME_ROLES.has(session.role)).map((session) => session.id)),
    closed_sessions: JSON.stringify(sessions.filter((session) => session.exitedAt).map((session) => [session.id, session.exitedAt]))
  };
}

export class AgentHistoryReadService {
  constructor(private readonly database: AgentHistoryDb | null) {}

  // The imported conversation for a Patterm session, matched by the session
  // itself or by its native resume ID. The resume ID wins: other threads, such
  // as a harness's reviewers, link to the session by working directory.
  conversationIdForSession(input: { sessionId: string; provider: string | null; resumeId: string | null; projectId: string }): string | null {
    if (!this.database || !databaseAvailable(this.database)) return null;
    const row = this.database.connection.prepare(`
      select id from conversations
      where project_id = @project_id and (session_id = @session_id or (provider = @provider and provider_conversation_id = @resume_id))
      order by (provider = @provider and provider_conversation_id = @resume_id) desc, updated_at desc limit 1
    `).get({ project_id: input.projectId, session_id: input.sessionId, provider: input.provider ?? '', resume_id: input.resumeId ?? '' }) as { id: string } | undefined;
    return row?.id ?? null;
  }

  // Imported rows of a native conversation from before `before`, used to show
  // turns an Integrated session cannot read back from its native runtime.
  archive(provider: string, resumeId: string, projectId: string, before: string, offset: number, limit: number) {
    if (!this.database || !databaseAvailable(this.database)) return { count: 0, messages: [] };
    const conversation = this.database.connection.prepare(`
      select id from conversations where provider = ? and provider_conversation_id = ? and project_id = ?
    `).get(provider, resumeId, projectId) as { id: string } | undefined;
    if (!conversation) return { count: 0, messages: [] };
    const predicate = `conversation_id = ? and (provider_created_at is null or provider_created_at < ?)`;
    const count = (this.database.connection.prepare(`select count(*) as count from conversation_messages where ${predicate}`).get(conversation.id, before) as { count: number }).count;
    const messages = this.database.connection.prepare(`
      select * from conversation_messages where ${predicate} order by seq asc limit ? offset ?
    `).all(conversation.id, before, limit, offset) as MessageRow[];
    return { count, messages: messages.map(mapMessage) };
  }

  // One row per conversation, ranked by its best-matching title, path, or
  // message. The last term matches as a prefix so results follow typing.
  searchConversations(raw: z.input<typeof conversationSearchInput>, sessions: readonly ConversationSessionState[] = []) {
    const input = conversationSearchInput.parse(raw);
    if (!this.database || !databaseAvailable(this.database)) return { conversations: [] };
    const terms = searchTerms(input.query);
    const query = buildFtsQuery(input.query, { prefix: true });
    if (!query) return { conversations: [] };
    const params: Record<string, unknown> = { query, project_id: input.project_id, limit: input.limit };
    const provider = input.provider ? 'and conversations.provider = @provider' : '';
    if (input.provider) params.provider = input.provider;
    const notHidden = input.resumable ? `and ${NOT_HIDDEN}` : '';
    if (input.resumable) params.hidden_sessions = resumeParams(sessions).hidden_sessions;
    // FTS5 scoring cannot run inside an aggregate, so hits are materialized
    // first; SQLite then takes the bare columns from each best-scoring row.
    // Snippets are built afterwards for the winners only: computing one for
    // every matching row made broad queries take seconds on real history.
    const hits = this.database.connection.prepare(`
      with hits as materialized (
        select conversation_history_fts.conversation_id, conversation_history_fts.kind, conversation_history_fts.owner_id,
          bm25(conversation_history_fts, 0, 0, 0, 0, 4, 1) as score
        from conversation_history_fts
        join conversations on conversations.id = conversation_history_fts.conversation_id
        where conversation_history_fts match @query and conversations.project_id = @project_id ${provider} ${notHidden}
          and exists (select 1 from conversation_messages where conversation_id = conversations.id)
      )
      select conversation_id, min(score) as score, kind, owner_id from hits
      group by conversation_id
      order by score asc
      limit @limit
    `).all(params) as Array<{ conversation_id: string; score: number; kind: string; owner_id: string }>;
    if (!hits.length) return { conversations: [] };
    const rows = this.database.connection.prepare(`
      select conversations.*,
        (select count(*) from conversation_messages where conversation_id = conversations.id) as message_count
      from conversations where id in (${hits.map(() => '?').join(', ')})
    `).all(...hits.map((hit) => hit.conversation_id)) as ConversationRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    // A title or path hit is already visible in the row; only message hits
    // carry a preview.
    const messageIds = hits.filter((hit) => hit.kind === 'conversation_message').map((hit) => hit.owner_id);
    const texts = new Map((messageIds.length ? this.database.connection.prepare(`
      select id, text, tool_input_summary, tool_output_summary from conversation_messages where id in (${messageIds.map(() => '?').join(', ')})
    `).all(...messageIds) as Array<{ id: string; text: string; tool_input_summary: string | null; tool_output_summary: string | null }> : [])
      .map((row) => [row.id, [row.text, row.tool_input_summary, row.tool_output_summary].filter(Boolean).join(' ')]));
    return {
      conversations: hits.flatMap((hit) => {
        const row = byId.get(hit.conversation_id);
        if (!row) return [];
        const text = hit.kind === 'conversation_message' ? texts.get(hit.owner_id) : undefined;
        return [{ ...mapConversation(row), match: { messageId: text === undefined ? null : hit.owner_id, preview: text === undefined ? null : matchPreview(text, terms) } }];
      })
    };
  }

  // Rows for results that semantic search found and the keyword queries
  // above did not return.
  conversationsByIds(ids: readonly string[]) {
    if (!ids.length || !this.database || !databaseAvailable(this.database)) return [];
    const rows = this.database.connection.prepare(`
      select conversations.*,
        (select count(*) from conversation_messages where conversation_id = conversations.id) as message_count
      from conversations where id in (${ids.map(() => '?').join(', ')})
    `).all(...ids) as ConversationRow[];
    return rows.map(mapConversation);
  }

  messageTexts(ids: readonly string[]): Map<string, { conversationId: string; seq: number; text: string }> {
    if (!ids.length || !this.database || !databaseAvailable(this.database)) return new Map();
    const rows = this.database.connection.prepare(`
      select id, conversation_id, seq, text from conversation_messages where id in (${ids.map(() => '?').join(', ')})
    `).all(...ids) as Array<{ id: string; conversation_id: string; seq: number; text: string }>;
    return new Map(rows.map((row) => [row.id, { conversationId: row.conversation_id, seq: row.seq, text: row.text }]));
  }

  findConversation(conversationId: string) {
    if (!this.database) return null;
    if (!databaseAvailable(this.database)) return null;
    const conversation = this.database.connection
      .prepare(`select *, (select count(*) from conversation_messages where conversation_id = conversations.id) as message_count from conversations where id = ?`)
      .get(conversationId) as ConversationRow | undefined;
    return conversation ? mapConversation(conversation) : null;
  }

  list(raw: z.input<typeof historyListInput>, sessions: readonly ConversationSessionState[] = []) {
    const input = historyListInput.parse(raw);
    if (!this.database) return { conversations: [] };
    if (!databaseAvailable(this.database)) return { conversations: [] };
    const filters: string[] = ['exists (select 1 from conversation_messages where conversation_id = conversations.id)'];
    const params: Record<string, unknown> = { limit: input.limit, offset: input.offset };
    if (input.project_id) {
      filters.push('project_id = @project_id');
      params.project_id = input.project_id;
    }
    if (input.provider) {
      filters.push('provider = @provider');
      params.provider = input.provider;
    }
    if (input.session_id) {
      filters.push('session_id = @session_id');
      params.session_id = input.session_id;
    }
    let order = 'coalesce(updated_at, imported_at)';
    let join = '';
    if (input.resumable) {
      Object.assign(params, resumeParams(sessions));
      join = 'left join session_closed on session_closed.id = conversations.session_id';
      filters.push(NOT_HIDDEN);
      order = `max(coalesce(updated_at, imported_at), coalesce(session_closed.exited_at, ''))`;
    }
    const where = filters.length ? `where ${filters.join(' and ')}` : '';
    const rows = this.database.connection.prepare(`
      ${input.resumable ? `with ${SESSION_CLOSED_CTE}` : ''}
      select conversations.*,
        (select count(*) from conversation_messages where conversation_id = conversations.id) as message_count
        ${input.resumable ? ', session_closed.exited_at as session_closed_at' : ''}
      from conversations
      ${join}
      ${where}
      order by ${order} desc
      limit @limit offset @offset
    `).all(params) as Array<ConversationRow & { session_closed_at?: string | null }>;
    return { conversations: rows.map((row) => input.resumable ? { ...mapConversation(row), sessionClosedAt: row.session_closed_at ?? null } : mapConversation(row)) };
  }

  get(raw: z.input<typeof historyGetInput>) {
    const input = historyGetInput.parse(raw);
    if (!this.database) return { conversation: null, messages: [] };
    if (!databaseAvailable(this.database)) return { conversation: null, messages: [] };
    let offset = input.offset;
    if (input.anchor_message_id) {
      const anchor = this.database.connection
        .prepare(`select seq from conversation_messages where id = ? and conversation_id = ?`)
        .get(input.anchor_message_id, input.conversation_id) as { seq: number } | undefined;
      if (anchor) offset = Math.max(0, anchor.seq - Math.floor(input.limit / 2));
    }
    const conversation = this.findConversation(input.conversation_id);
    if (!conversation) return { conversation: null, messages: [] };
    const messages = this.database.connection.prepare(`
      select * from conversation_messages where conversation_id = ? order by seq asc limit ? offset ?
    `).all(input.conversation_id, input.limit, offset) as MessageRow[];
    return { conversation, messages: messages.map(mapMessage), offset };
  }

  // The newest messages of a conversation, oldest first, before a sequence
  // number when given. Readers page backwards from the latest turn with it.
  tail(conversationId: string, limit: number, beforeSeq?: number) {
    if (!this.database || !databaseAvailable(this.database)) return { conversation: null, messages: [], has_more: false };
    const conversation = this.findConversation(conversationId);
    if (!conversation) return { conversation: null, messages: [], has_more: false };
    const rows = this.database.connection.prepare(`
      select * from conversation_messages where conversation_id = ? and seq < ? order by seq desc limit ?
    `).all(conversationId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1) as MessageRow[];
    return { conversation, messages: rows.slice(0, limit).reverse().map(mapMessage), has_more: rows.length > limit };
  }

  search(raw: z.input<typeof conversationHistorySearchInput>) {
    const input = conversationHistorySearchInput.parse(raw);
    if (!this.database) return { query: input.query, results: [] };
    if (!databaseAvailable(this.database)) return { query: input.query, results: [] };
    const query = buildFtsQuery(input.query);
    if (!query) return { query: input.query, results: [] };
    const filters = ['conversation_history_fts match @query', 'conversations.project_id = @project_id'];
    const params: Record<string, unknown> = { query, project_id: input.project_id, limit: input.limit };
    if (input.provider) {
      filters.push('conversations.provider = @provider');
      params.provider = input.provider;
    }
    const rows = this.database.connection.prepare(`
      select conversation_history_fts.kind, conversation_history_fts.owner_id,
        conversations.*, conversations.id as conversation_id,
        snippet(conversation_history_fts, 5, '[', ']', '...', 24) as preview,
        bm25(conversation_history_fts) as score
      from conversation_history_fts
      join conversations on conversations.id = conversation_history_fts.conversation_id
      where ${filters.join(' and ')}
      order by score asc
      limit @limit
    `).all(params) as ConversationSearchRow[];
    return { query: input.query, results: rows.map(mapConversationSearchResult) };
  }

  importStatus(limit = 20, activeBatchIds: readonly string[] = []) {
    if (!this.database) return { batches: [], files: [] };
    if (!databaseAvailable(this.database)) return { batches: [], files: [] };
    const batches = this.database.connection.prepare(`select * from conversation_import_batches order by started_at desc limit ?`).all(limit) as ImportBatchRow[];
    const files = this.database.connection.prepare(`select * from conversation_import_files where status = 'error' or (status = 'skipped' and warning is not null) order by last_imported_at desc limit ?`).all(limit) as ImportFileRow[];
    const active = new Set(activeBatchIds);
    return { batches: batches.map((row) => mapBatch(row, active)), files: files.map(mapImportFile) };
  }
}

interface ConversationRow { id: string; provider: string; provider_conversation_id: string | null; project_id: string | null; session_id: string | null; process_id: string | null; worktree_id: string | null; source_file_id: string | null; title: string | null; session_title?: string | null; cwd: string | null; provider_version: string | null; started_at: string | null; updated_at: string | null; ended_at: string | null; status: string; link_confidence: number | null; link_reason: string | null; metadata: string; created_at: string; imported_at: string; message_count: number; }
interface MessageRow { id: string; conversation_id: string; provider_message_id: string | null; parent_provider_message_id: string | null; turn_id: string | null; seq: number; role: string; kind: string; text: string; tool_name: string | null; tool_status: string | null; tool_input_summary: string | null; tool_output_summary: string | null; redaction_count: number; token_count: number | null; provider_created_at: string | null; metadata: string; created_at: string; }
interface ImportBatchRow { id: string; trigger: string; provider: string | null; source_id: string | null; project_id: string | null; started_at: string; finished_at: string | null; status: string; files_seen: number; files_imported: number; conversations_imported: number; messages_imported: number; skipped_count: number; error_count: number; }
interface ImportFileRow { id: string; source_id: string | null; batch_id: string | null; provider: string; path: string; source_kind: string; status: string; warning: string | null; error: string | null; last_imported_at: string | null; }
interface ConversationSearchRow { kind: string; owner_id: string; conversation_id: string; provider: string; title: string | null; session_title?: string | null; session_id: string | null; process_id: string | null; started_at: string | null; updated_at: string | null; preview: string; score: number; }

function mapConversation(row: ConversationRow) { return { id: row.id, provider: row.provider, providerConversationId: row.provider_conversation_id, projectId: row.project_id, sessionId: row.session_id, processId: row.process_id, worktreeId: row.worktree_id, sourceFileId: row.source_file_id, title: displayTitle(row), nativeTitle: row.title, cwd: row.cwd, providerVersion: row.provider_version, startedAt: row.started_at, updatedAt: row.updated_at, endedAt: row.ended_at, status: row.status, linkConfidence: row.link_confidence, linkReason: row.link_reason, metadata: parseJson(row.metadata), createdAt: row.created_at, importedAt: row.imported_at, messageCount: row.message_count }; }
function mapMessage(row: MessageRow) { return { id: row.id, conversationId: row.conversation_id, providerMessageId: row.provider_message_id, parentProviderMessageId: row.parent_provider_message_id, turnId: row.turn_id, seq: row.seq, role: row.role, kind: row.kind, text: row.text, toolName: row.tool_name, toolStatus: row.tool_status, toolInputSummary: row.tool_input_summary, toolOutputSummary: row.tool_output_summary, redactionCount: row.redaction_count, tokenCount: row.token_count, providerCreatedAt: row.provider_created_at, metadata: parseJson(row.metadata), createdAt: row.created_at }; }
function mapBatch(row: ImportBatchRow, activeBatchIds: Set<string>) { return { id: row.id, trigger: row.trigger, provider: row.provider, sourceId: row.source_id, projectId: row.project_id, startedAt: row.started_at, finishedAt: row.finished_at, status: importBatchStatus(row, activeBatchIds), filesSeen: row.files_seen, filesImported: row.files_imported, conversationsImported: row.conversations_imported, messagesImported: row.messages_imported, skippedCount: row.skipped_count, errorCount: row.error_count }; }
function mapImportFile(row: ImportFileRow) { return { id: row.id, sourceId: row.source_id, batchId: row.batch_id, provider: row.provider, path: row.path, sourceKind: row.source_kind, status: row.status, warning: row.warning, error: row.error, lastImportedAt: row.last_imported_at }; }
function mapConversationSearchResult(row: ConversationSearchRow) { return { kind: row.kind, conversationId: row.conversation_id, messageId: row.kind === 'conversation_message' ? row.owner_id : null, provider: row.provider, title: displayTitle(row), sessionId: row.session_id, processId: row.process_id, startedAt: row.started_at, updatedAt: row.updated_at, preview: row.preview, score: row.score }; }
// The session's title wins over the native one, usually the first prompt. The
// column is optional so reads keep working before the worker migrates.
function displayTitle(row: { title: string | null; session_title?: string | null }): string | null { return row.session_title || row.title; }
function parseJson(value: string) { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
function importBatchStatus(row: ImportBatchRow, activeBatchIds: Set<string>): string {
  if (row.status !== 'running' || activeBatchIds.has(row.id)) return row.status;
  const startedAt = Date.parse(row.started_at);
  if (!Number.isFinite(startedAt)) return 'stale';
  return Date.now() - startedAt > HISTORY_IMPORT_STALE_MS ? 'stale' : row.status;
}

function databaseAvailable(database: AgentHistoryDb): boolean {
  const maybeLazy = database as AgentHistoryDb & { ensureAvailable?: () => boolean };
  return maybeLazy.ensureAvailable ? maybeLazy.ensureAvailable() : true;
}

function searchTerms(query: string): string[] {
  return query.match(/[\p{L}\p{N}_./#@:-]+/gu) ?? [];
}

// Prefix matching a one- or two-character term expands to most of the index.
const MIN_PREFIX_LENGTH = 3;

function buildFtsQuery(query: string, options: { prefix?: boolean } = {}): string {
  const terms = searchTerms(query);
  return terms.map((term, index) => {
    const phrase = `"${term.replaceAll('"', '""')}"`;
    return options.prefix && index === terms.length - 1 && term.length >= MIN_PREFIX_LENGTH ? `${phrase}*` : phrase;
  }).join(' ');
}

// A short excerpt around the first match, with each match marked the way FTS
// matched it: whole words, and a prefix only for a long last term.
function matchPreview(text: string, terms: string[]): string | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const pattern = terms.length ? new RegExp(terms.map((term, index) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = index === terms.length - 1 && term.length >= MIN_PREFIX_LENGTH;
    return `(?<![\\p{L}\\p{N}])${escaped}${prefix ? '' : '(?![\\p{L}\\p{N}])'}`;
  }).join('|'), 'giu') : null;
  const at = pattern ? Math.max(0, flat.search(pattern)) : 0;
  const start = Math.max(0, at - 40);
  const end = Math.min(flat.length, at + 120);
  const excerpt = `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
  return pattern ? excerpt.replace(pattern, (match) => `${SEARCH_MATCH_START}${match}${SEARCH_MATCH_END}`) : excerpt;
}
