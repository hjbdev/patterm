import type { z } from 'zod';
import type { SqliteConnection } from '../../Database/SqliteConnection';
import { AgentHistoryReadService, conversationHistorySearchInput, conversationSearchInput, type ConversationSessionState } from '../AgentHistory/AgentHistoryReadService';
import { blobToVector, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_KEY } from './EmbeddingModel';
import { messagePassages } from './HistoryPassages';
import { HistoryEmbeddingIndexer } from './HistoryEmbeddingIndexer';

// Keyword candidates fused with semantic ones. Reciprocal rank fusion needs
// both lists deeper than the page the caller asked for.
const CANDIDATES = 50;
const PASSAGE_CANDIDATES = 400;
const RRF_K = 60;
// EmbeddingGemma 2 scores unrelated text highly: on real history the median
// similarity of a query to a random message was 0.64, and of a query to the
// message it described 0.74 (tenth percentile 0.68). The floor drops most
// unrelated passages and keeps nearly every intended one.
export const MIN_SIMILARITY = 0.65;
// Bounds the cached search matrix, about 2 KB per passage.
const MAX_CACHED_PASSAGES = 250_000;

export interface QueryEmbedding { embedQuery(text: string): Promise<Float32Array | null>; readonly active: boolean; }

interface Scope { projectId: string; provider?: string | undefined; hiddenSessions?: readonly string[] | undefined; }
interface PassageHit { conversationId: string; messageId: string; chunk: number; score: number; }
interface CachedMatrix { key: string; revision: string; conversationIds: string[]; messageIds: string[]; chunks: number[]; vectors: Float32Array; }

// Hybrid conversation-history search: the existing FTS/BM25 ranking fused
// with nearest passages by reciprocal rank. Keyword results are returned
// unchanged whenever semantic search is off, still loading, or failing.
export class HybridHistorySearchService {
  private cache: CachedMatrix | null = null;

  constructor(
    private readonly read: AgentHistoryReadService,
    private readonly history: { connection: SqliteConnection; ensureAvailable?: () => boolean } | null,
    private readonly semantic: QueryEmbedding | null
  ) {}

  // One row per conversation for the resume picker.
  async searchConversations(raw: z.input<typeof conversationSearchInput>, sessions: readonly ConversationSessionState[] = []) {
    const input = conversationSearchInput.parse(raw);
    // Keyword rows are read after the wait so they reflect the same moment
    // as the live checks below; a conversation can move while a query embeds.
    const vector = await this.queryVector(input.query);
    const keyword = this.read.searchConversations({ ...input, limit: Math.max(input.limit, CANDIDATES) }, sessions).conversations;
    if (!vector) return { conversations: keyword.slice(0, input.limit), semantic: false };
    const hidden = input.resumable ? sessions.filter((session) => session.role === 'child' || session.role === 'routine').map((session) => session.id) : undefined;
    const scope = { projectId: input.project_id, provider: input.provider, hiddenSessions: hidden };
    const best = new Map<string, PassageHit>();
    for (const hit of this.nearest(vector, scope, PASSAGE_CANDIDATES)) if (!best.has(hit.conversationId)) best.set(hit.conversationId, hit);
    const semanticIds = [...best.keys()].slice(0, CANDIDATES);
    const fused = fuse([keyword.map((row) => row.id), semanticIds]).slice(0, input.limit);
    const byKeyword = new Map(keyword.map((row) => [row.id, row]));
    const missing = fused.filter((id) => !byKeyword.has(id));
    const rows = new Map(this.read.conversationsByIds(missing).map((row) => [row.id, row]));
    const texts = this.read.messageTexts(missing.map((id) => best.get(id)!.messageId));
    const hiddenSet = new Set(hidden ?? []);
    return {
      semantic: true,
      conversations: fused.flatMap((id) => {
        const found = byKeyword.get(id);
        if (found) return [found];
        const row = rows.get(id);
        const hit = best.get(id)!;
        // The cached matrix can trail a project move; the live row decides.
        if (!row || row.projectId !== input.project_id || (input.provider && row.provider !== input.provider) || hiddenSet.has(row.sessionId ?? '')) return [];
        const text = texts.get(hit.messageId);
        return [{ ...row, match: { messageId: text ? hit.messageId : null, preview: text ? passagePreview(text.text, hit.chunk) : null, semantic: true } }];
      })
    };
  }

  // Message-level results for the search_conversation_history agent tool.
  async search(raw: z.input<typeof conversationHistorySearchInput>) {
    const input = conversationHistorySearchInput.parse(raw);
    const vector = await this.queryVector(input.query);
    const keyword = this.read.search({ ...input, limit: Math.max(input.limit, CANDIDATES) });
    if (!vector) return { query: input.query, semantic: false, results: keyword.results.slice(0, input.limit).map((row) => ({ ...row, match: 'keyword' })) };
    const best = new Map<string, PassageHit>();
    for (const hit of this.nearest(vector, { projectId: input.project_id, provider: input.provider }, PASSAGE_CANDIDATES)) if (!best.has(hit.messageId)) best.set(hit.messageId, hit);
    const keyOf = (row: { kind: string; conversationId: string; messageId: string | null }) => row.messageId ?? `conversation:${row.conversationId}`;
    const fused = fuse([keyword.results.map(keyOf), [...best.keys()].slice(0, CANDIDATES)]).slice(0, input.limit);
    const byKeyword = new Map(keyword.results.map((row) => [keyOf(row), row]));
    const semanticOnly = fused.filter((key) => !byKeyword.has(key));
    const texts = this.read.messageTexts(semanticOnly);
    const rows = new Map(this.read.conversationsByIds([...new Set(semanticOnly.map((key) => best.get(key)!.conversationId))]).map((row) => [row.id, row]));
    return {
      query: input.query,
      semantic: true,
      results: fused.flatMap((key, index) => {
        const found = byKeyword.get(key);
        const score = -1 / (RRF_K + index + 1);
        if (found) return [{ ...found, score, match: best.has(key) ? 'both' : 'keyword' }];
        const hit = best.get(key)!;
        const row = rows.get(hit.conversationId);
        const text = texts.get(hit.messageId);
        if (!row || !text || row.projectId !== input.project_id || (input.provider && row.provider !== input.provider)) return [];
        return [{ kind: 'conversation_message', conversationId: row.id, messageId: hit.messageId, provider: row.provider, title: row.title, sessionId: row.sessionId,
          processId: row.processId, startedAt: row.startedAt, updatedAt: row.updatedAt, preview: passagePreview(text.text, hit.chunk), score, match: 'semantic', similarity: Number(hit.score.toFixed(4)) }];
      })
    };
  }

  private async queryVector(query: string): Promise<Float32Array | null> {
    if (!this.semantic?.active || !this.indexAvailable()) return null;
    return await this.semantic.embedQuery(query);
  }

  private indexAvailable(): boolean {
    try {
      if (!this.history || (this.history.ensureAvailable && !this.history.ensureAvailable())) return false;
      return HistoryEmbeddingIndexer.schemaReady(this.history.connection);
    } catch {
      return false;
    }
  }

  // Exact nearest passages in scope, best first. A brute-force scan over the
  // project's vectors: tens of milliseconds at the sizes real history reaches.
  private nearest(vector: Float32Array, scope: Scope, limit: number): PassageHit[] {
    const matrix = this.matrix(scope);
    const hits: PassageHit[] = [];
    const count = matrix.conversationIds.length;
    for (let row = 0; row < count; row++) {
      let score = 0;
      const offset = row * EMBEDDING_DIMENSIONS;
      for (let index = 0; index < EMBEDDING_DIMENSIONS; index++) score += vector[index]! * matrix.vectors[offset + index]!;
      if (score >= MIN_SIMILARITY) hits.push({ conversationId: matrix.conversationIds[row]!, messageId: matrix.messageIds[row]!, chunk: matrix.chunks[row]!, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private matrix(scope: Scope): CachedMatrix {
    const db = this.history!.connection;
    const key = JSON.stringify([scope.projectId, scope.provider ?? null, scope.hiddenSessions ?? null]);
    const revision = JSON.stringify(db.prepare(`
      select (select count(*) from history_embedding_passages) as passages, (select max(id) from history_embedding_passages) as last_passage,
        (select max(indexed_at) from history_embedding_state) as indexed_at,
        (select count(*) from conversations where project_id = @project_id) as conversations,
        (select max(imported_at) from conversations where project_id = @project_id) as imported_at
    `).get({ project_id: scope.projectId }));
    if (this.cache?.key === key && this.cache.revision === revision) return this.cache;
    const filters = ['history_embedding_passages.model_key = @model_key', 'conversations.project_id = @project_id'];
    const params: Record<string, unknown> = { model_key: EMBEDDING_MODEL_KEY, project_id: scope.projectId };
    if (scope.provider) {
      filters.push('conversations.provider = @provider');
      params.provider = scope.provider;
    }
    if (scope.hiddenSessions) {
      filters.push(`coalesce(conversations.session_id, '') not in (select value from json_each(@hidden_sessions))`);
      params.hidden_sessions = JSON.stringify(scope.hiddenSessions);
    }
    const rows = db.prepare(`
      select history_embedding_passages.conversation_id, history_embedding_passages.message_id, history_embedding_passages.chunk, history_embedding_vectors.vector
      from history_embedding_passages
      join history_embedding_vectors on history_embedding_vectors.model_key = history_embedding_passages.model_key
        and history_embedding_vectors.content_hash = history_embedding_passages.content_hash
      join conversations on conversations.id = history_embedding_passages.conversation_id
      where ${filters.join(' and ')}
    `).all(params) as Array<{ conversation_id: string; message_id: string; chunk: number; vector: Uint8Array }>;
    const vectors = new Float32Array(rows.length * EMBEDDING_DIMENSIONS);
    const matrix: CachedMatrix = { key, revision, conversationIds: [], messageIds: [], chunks: [], vectors };
    let used = 0;
    for (const row of rows) {
      const vector = blobToVector(row.vector);
      if (vector.length !== EMBEDDING_DIMENSIONS) continue;
      vectors.set(vector, used * EMBEDDING_DIMENSIONS);
      matrix.conversationIds.push(row.conversation_id);
      matrix.messageIds.push(row.message_id);
      matrix.chunks.push(row.chunk);
      used++;
    }
    matrix.vectors = vectors.subarray(0, used * EMBEDDING_DIMENSIONS);
    this.cache = used <= MAX_CACHED_PASSAGES ? matrix : null;
    return matrix;
  }
}

function fuse(lists: string[][]): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// The matched passage's opening, without match markers: a semantic match
// need not share any word with the query.
function passagePreview(text: string, chunk: number): string {
  const passage = messagePassages({ id: '', seq: 0, text })[chunk]?.text ?? text.replace(/\s+/g, ' ').trim();
  return passage.length > 160 ? `${passage.slice(0, 160)}…` : passage;
}
