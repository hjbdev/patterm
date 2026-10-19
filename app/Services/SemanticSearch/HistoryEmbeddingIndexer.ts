import type { SqliteConnection } from '../../Database/SqliteConnection';
import { HISTORY_IMPORT_STALE_MS } from '../AgentHistory/AgentHistoryTypes';
import { DOCUMENT_PROMPT, vectorToBlob } from './EmbeddingModel';
import { EMBEDDED_MESSAGE_FILTER, messagePassages, type HistoryPassage } from './HistoryPassages';

export interface DocumentEmbedder {
  // One vector per text, or null for a text the model could not embed.
  embedDocuments(texts: string[]): Promise<Array<Float32Array | null>>;
}

export interface HistoryEmbeddingCounts {
  conversations: number;
  indexed: number;
  pending: number;
  failed: number;
  passages: number;
  lastError: string | null;
}

export type IndexStep = 'indexed' | 'stale' | 'removed' | 'failed' | 'interrupted' | 'idle' | 'waiting';

// Messages are written by an import and settle for this long before they
// are read, so a conversation is not embedded while its import is still
// appending chunks.
const SETTLE_MS = 10_000;
// Reconciliation queues history that is already stored, so it needs no settling.
const SETTLED_LONG_AGO = '1970-01-01T00:00:00.000Z';
const BATCH_SIZE = 8;
const MAX_MESSAGE_CHARS = 4_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;

// Turns dirty conversations into published passages. Every step reads the
// stored, redacted history; nothing here re-parses provider files. Work is
// checked against the queue generation before it is published, so an edit,
// reimport, or deletion during inference is never overwritten by older text.
export class HistoryEmbeddingIndexer {
  constructor(
    private readonly db: SqliteConnection,
    private readonly embedder: DocumentEmbedder,
    private readonly modelKey: string,
    private readonly now: () => number = Date.now
  ) {}

  static schemaReady(db: SqliteConnection): boolean {
    return Boolean(db.prepare(`select 1 from sqlite_master where type = 'table' and name = 'history_embedding_queue'`).get());
  }

  // Catches work the triggers could not see: history imported before this
  // feature, a model or chunker change, and queue rows for deleted
  // conversations. Vectors of another model key are dropped.
  reconcile(): { queued: number } {
    return this.db.transaction(() => {
      this.db.prepare(`delete from history_embedding_passages where model_key != ?`).run(this.modelKey);
      this.db.prepare(`delete from history_embedding_state where model_key != ?`).run(this.modelKey);
      this.db.prepare(`delete from history_embedding_vectors where model_key != ?`).run(this.modelKey);
      this.db.prepare(`delete from history_embedding_queue where conversation_id not in (select id from conversations)`).run();
      const queued = this.db.prepare(`
        insert into history_embedding_queue (conversation_id, marked_at)
        select id, @settled from conversations
        where not exists (select 1 from history_embedding_state where conversation_id = conversations.id)
        on conflict(conversation_id) do nothing
      `).run({ settled: SETTLED_LONG_AGO }).changes;
      return { queued: Number(queued) };
    })();
  }

  // Drops every published passage and vector and queues all history again.
  // Queued generations advance too, so a step already embedding against the
  // old vectors goes stale instead of publishing a partial conversation.
  rebuild(): { queued: number } {
    this.db.transaction(() => {
      this.db.prepare(`delete from history_embedding_passages`).run();
      this.db.prepare(`delete from history_embedding_state`).run();
      this.db.prepare(`delete from history_embedding_vectors`).run();
      this.db.prepare(`update history_embedding_queue set generation = generation + 1, attempts = 0, retry_after = null, last_error = null`).run();
    })();
    return this.reconcile();
  }

  clear(): void {
    this.db.transaction(() => {
      this.db.prepare(`delete from history_embedding_passages`).run();
      this.db.prepare(`delete from history_embedding_state`).run();
      this.db.prepare(`delete from history_embedding_vectors`).run();
      this.db.prepare(`insert into history_embedding_queue (conversation_id, marked_at) select id, ? from conversations where true on conflict(conversation_id) do update set generation = generation + 1`).run(SETTLED_LONG_AGO);
    })();
  }

  counts(): HistoryEmbeddingCounts {
    return embeddingCounts(this.db, this.modelKey);
  }

  // An import batch that is still running and not yet stale holds back
  // embedding, so history is complete before it is read.
  importsActive(): boolean {
    const since = new Date(this.now() - HISTORY_IMPORT_STALE_MS).toISOString();
    return Boolean(this.db.prepare(`select 1 from conversation_import_batches where status = 'running' and started_at > ? limit 1`).get(since));
  }

  // Embeds and publishes one dirty conversation, newest first.
  async step(shouldContinue: () => boolean = () => true): Promise<IndexStep> {
    if (this.importsActive()) return 'waiting';
    const now = new Date(this.now());
    const next = this.db.prepare(`
      select history_embedding_queue.conversation_id, history_embedding_queue.generation, history_embedding_queue.attempts,
        conversations.id as existing_id
      from history_embedding_queue
      left join conversations on conversations.id = history_embedding_queue.conversation_id
      where (history_embedding_queue.retry_after is null or history_embedding_queue.retry_after <= @now)
        and history_embedding_queue.marked_at <= @settled
      order by conversations.updated_at is null, conversations.updated_at desc
      limit 1
    `).get({ now: now.toISOString(), settled: new Date(now.getTime() - SETTLE_MS).toISOString() }) as
      { conversation_id: string; generation: number; attempts: number; existing_id: string | null } | undefined;
    if (!next) {
      const waiting = this.db.prepare(`select 1 from history_embedding_queue limit 1`).get();
      return waiting ? 'waiting' : 'idle';
    }
    if (!next.existing_id) {
      // Passages and state went with the conversation through cascades.
      this.db.prepare(`delete from history_embedding_queue where conversation_id = ? and generation = ?`).run(next.conversation_id, next.generation);
      return 'removed';
    }

    try {
      const passages = this.passages(next.conversation_id);
      const embedded = await this.embedMissing(passages, shouldContinue);
      if (!embedded) return 'interrupted';
      return this.publish(next.conversation_id, next.generation, passages) ? 'indexed' : 'stale';
    } catch (error) {
      // A locked database is contention with an import, not a failure.
      if (isBusy(error)) throw error;
      this.recordFailure(next.conversation_id, next.generation, next.attempts, error);
      return 'failed';
    }
  }

  // Removes vectors no published passage uses. Only run with an empty queue:
  // a reimported conversation waits there to reuse its old vectors.
  collectGarbage(): number {
    if (this.db.prepare(`select 1 from history_embedding_queue limit 1`).get()) return 0;
    return Number(this.db.prepare(`
      delete from history_embedding_vectors
      where model_key = @model_key and not exists (
        select 1 from history_embedding_passages
        where history_embedding_passages.model_key = @model_key and history_embedding_passages.content_hash = history_embedding_vectors.content_hash
      )
    `).run({ model_key: this.modelKey }).changes);
  }

  private passages(conversationId: string): HistoryPassage[] {
    const messages = this.db.prepare(`
      select id, seq, substr(text, 1, ${MAX_MESSAGE_CHARS}) as text
      from conversation_messages
      where conversation_id = ? and ${EMBEDDED_MESSAGE_FILTER}
      order by seq
    `).all(conversationId) as Array<{ id: string; seq: number; text: string }>;
    return messages.flatMap(messagePassages);
  }

  private async embedMissing(passages: HistoryPassage[], shouldContinue: () => boolean): Promise<boolean> {
    const byHash = new Map<string, string>();
    for (const passage of passages) byHash.set(passage.contentHash, passage.text);
    const hashes = [...byHash.keys()];
    const known = new Set<string>();
    const lookup = (chunk: string[]) => this.db.prepare(`
      select content_hash from history_embedding_vectors where model_key = ? and content_hash in (${chunk.map(() => '?').join(', ')})
    `).all(this.modelKey, ...chunk) as Array<{ content_hash: string }>;
    for (let start = 0; start < hashes.length; start += 500) {
      for (const row of lookup(hashes.slice(start, start + 500))) known.add(row.content_hash);
    }
    const missing = hashes.filter((hash) => !known.has(hash));
    const insert = this.db.prepare(`insert or ignore into history_embedding_vectors (model_key, content_hash, vector) values (?, ?, ?)`);
    for (let start = 0; start < missing.length; start += BATCH_SIZE) {
      if (!shouldContinue()) return false;
      const batch = missing.slice(start, start + BATCH_SIZE);
      const vectors = await this.embedder.embedDocuments(batch.map((hash) => DOCUMENT_PROMPT + byHash.get(hash)!));
      // Content-addressed vectors are valid whatever happens to the
      // conversation, so they are kept even if this job goes stale.
      this.db.transaction(() => {
        batch.forEach((hash, index) => {
          const vector = vectors[index];
          if (vector) insert.run(this.modelKey, hash, vectorToBlob(vector));
        });
      })();
    }
    return true;
  }

  private publish(conversationId: string, generation: number, passages: HistoryPassage[]): boolean {
    return this.db.transaction(() => {
      const current = this.db.prepare(`select generation from history_embedding_queue where conversation_id = ?`).get(conversationId) as { generation: number } | undefined;
      if (!current || current.generation !== generation) return false;
      this.db.prepare(`delete from history_embedding_passages where conversation_id = ?`).run(conversationId);
      const insert = this.db.prepare(`
        insert into history_embedding_passages (conversation_id, message_id, seq, chunk, model_key, content_hash)
        select ?, ?, ?, ?, ?, ? where exists (select 1 from history_embedding_vectors where model_key = ? and content_hash = ?)
      `);
      let count = 0;
      for (const passage of passages) {
        count += Number(insert.run(conversationId, passage.messageId, passage.seq, passage.chunk, this.modelKey, passage.contentHash, this.modelKey, passage.contentHash).changes);
      }
      this.db.prepare(`
        insert into history_embedding_state (conversation_id, model_key, passage_count, indexed_at) values (?, ?, ?, ?)
        on conflict(conversation_id) do update set model_key = excluded.model_key, passage_count = excluded.passage_count, indexed_at = excluded.indexed_at
      `).run(conversationId, this.modelKey, count, new Date(this.now()).toISOString());
      this.db.prepare(`delete from history_embedding_queue where conversation_id = ? and generation = ?`).run(conversationId, generation);
      return true;
    })();
  }

  private recordFailure(conversationId: string, generation: number, attempts: number, error: unknown): void {
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempts);
    this.db.prepare(`
      update history_embedding_queue set attempts = attempts + 1, last_error = ?, retry_after = ?
      where conversation_id = ? and generation = ?
    `).run(errorMessage(error).slice(0, 500), new Date(this.now() + delay).toISOString(), conversationId, generation);
  }
}

export function embeddingCounts(db: SqliteConnection, modelKey: string): HistoryEmbeddingCounts {
  const row = db.prepare(`
    select
      (select count(*) from conversations) as conversations,
      (select count(*) from history_embedding_state where model_key = @model_key) as indexed,
      (select count(*) from history_embedding_queue) as pending,
      (select count(*) from history_embedding_queue where last_error is not null) as failed,
      (select count(*) from history_embedding_passages where model_key = @model_key) as passages,
      (select last_error from history_embedding_queue where last_error is not null order by retry_after desc limit 1) as last_error
  `).get({ model_key: modelKey }) as { conversations: number; indexed: number; pending: number; failed: number; passages: number; last_error: string | null };
  return { conversations: row.conversations, indexed: row.indexed, pending: row.pending, failed: row.failed, passages: row.passages, lastError: row.last_error };
}

export function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: number } | null)?.errcode;
  return code === 5 || code === 6 || /database is (locked|busy)/i.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
