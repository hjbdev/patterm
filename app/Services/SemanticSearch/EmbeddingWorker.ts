import os from 'node:os';
import type { SqliteConnection } from '../../Database/SqliteConnection';
import { HistoryDatabaseService } from '../HistoryDatabaseService';
import { blobToVector, EMBEDDING_DIMENSIONS } from './EmbeddingModel';
import { HistoryEmbeddingIndexer, isBusy, type DocumentEmbedder, type IndexStep } from './HistoryEmbeddingIndexer';
import { LlamaEmbedder } from './LlamaEmbedder';
import {
  encodeVector,
  type EmbeddingWorkerEvent,
  type EmbeddingWorkerRequest,
  type EmbeddingWorkerSearchRequest,
  type EmbeddingWorkerStart,
  type SemanticPassageHit
} from './EmbeddingWorkerProtocol';

export interface QueryEmbedder extends DocumentEmbedder {
  readonly loaded: boolean;
  load(): Promise<void>;
  embedQuery(text: string): Promise<Float32Array | null>;
  dispose(): Promise<void>;
}

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const IDLE_POLL_MS = 15_000;
const WAITING_POLL_MS = 5_000;
const SCHEMA_POLL_MS = 30_000;
const BUSY_RETRY_MS = 2_000;
const STATUS_INTERVAL_MS = 1_000;
// The model holds several hundred MB. With no backfill or query for this
// long it is released and loaded again on the next one.
const UNLOAD_AFTER_MS = 10 * 60_000;
// Bounds the cached Int8-quantized search matrix (~516 bytes per passage,
// 4x less RAM than Float32: ~129 MB at 250k passages).
const MAX_CACHED_PASSAGES = 250_000;
const SEARCH_CACHE_IDLE_EVICT_MS = 5 * 60_000;

interface QuantizedSearchMatrix {
  key: string;
  indexRevision: number;
  dataVersion: number;
  dbRevision: string;
  conversationIds: string[];
  sessionIds: Array<string | null>;
  messageIds: string[];
  chunks: number[];
  vectors: Int8Array;
  scales: Float32Array;
}

function startWorker(): void {
  try {
    os.setPriority(os.constants.priority.PRIORITY_LOW);
  } catch {
    // Priority is best-effort on platforms that do not expose it.
  }
  const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
  const send = (event: EmbeddingWorkerEvent) => {
    if (parentPort) parentPort.postMessage(event);
    // A send after the parent has gone is dropped rather than thrown.
    else if (process.connected) process.send?.(event, () => undefined);
  };
  const runtime = new EmbeddingWorkerRuntime(send, () => setTimeout(() => process.exit(0), 100));
  if (parentPort) {
    parentPort.on('message', (event) => runtime.handle(event.data as EmbeddingWorkerRequest));
  } else {
    process.on('message', (message) => runtime.handle(message as EmbeddingWorkerRequest));
    // A server that exits without stopping the worker must not leave the
    // model loaded in an orphan.
    process.once('disconnect', () => void runtime.stop());
  }
}

// Owns the model and the history.db writer for embeddings. It runs apart
// from the import worker, so inference never waits behind an import and an
// import never waits behind inference beyond one short publish transaction.
export class EmbeddingWorkerRuntime {
  private config: EmbeddingWorkerStart | null = null;
  private database: HistoryDatabaseService | null = null;
  private indexer: HistoryEmbeddingIndexer | null = null;
  private embedder: QueryEmbedder | null = null;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private lastUse = Date.now();
  private lastStatus = 0;
  private loadError: string | null = null;
  private indexRevision = 0;
  private searchCache: QuantizedSearchMatrix | null = null;
  private searchCacheEvictTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (event: EmbeddingWorkerEvent) => void,
    private readonly exit: () => void = () => undefined,
    private readonly createEmbedder: (config: EmbeddingWorkerStart) => QueryEmbedder = (config) => new LlamaEmbedder(config.modelPath, config.threads)
  ) {}

  handle(message: EmbeddingWorkerRequest): void {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'start') {
      if (this.config) return;
      this.config = message;
      this.embedder = this.createEmbedder(message);
      this.loop = this.run();
      return;
    }
    if (message.type === 'query') void this.query(message.id, message.text);
    else if (message.type === 'search') void this.search(message);
    else if (message.type === 'maintain') this.maintain(message.id, message.operation);
    else if (message.type === 'wake') this.wakeUp();
    else if (message.type === 'stop') void this.stop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearSearchCache();
    this.wakeUp();
    await this.loop?.catch(() => undefined);
    await this.embedder?.dispose().catch(() => undefined);
    this.database?.dispose();
    this.database = null;
    this.indexer = null;
    this.send({ type: 'stopped' });
    this.exit();
  }

  private async query(id: number, text: string): Promise<void> {
    this.lastUse = Date.now();
    try {
      if (!this.embedder) throw new Error('semantic search is not running');
      const vector = await (await this.loadedEmbedder()).embedQuery(text);
      if (!vector) throw new Error('the model returned no usable vector for this query');
      this.send({ type: 'query_result', id, vector: encodeVector(vector) });
    } catch (error) {
      this.send({ type: 'query_result', id, error: errorMessage(error) });
    }
  }

  private async search(request: EmbeddingWorkerSearchRequest): Promise<void> {
    this.lastUse = Date.now();
    try {
      if (!this.embedder) throw new Error('semantic search is not running');
      const vector = await (await this.loadedEmbedder()).embedQuery(request.text);
      if (!vector) throw new Error('the model returned no usable vector for this query');
      if (vector.length !== EMBEDDING_DIMENSIONS) throw new Error('unexpected query embedding dimensions');
      if (this.stopping) throw new Error('semantic search is stopping');
      if (!this.ensureIndexer() || !this.database) throw new Error('semantic search index is not ready');
      const matrix = this.loadSearchMatrix(this.database.connection, request.projectId, request.provider);
      const hidden = request.hiddenSessions.length > 0 ? new Set(request.hiddenSessions) : null;
      const hits: SemanticPassageHit[] = [];
      const count = matrix.conversationIds.length;
      for (let row = 0; row < count; row++) {
        if (hidden) {
          const sessionId = matrix.sessionIds[row];
          if (sessionId && hidden.has(sessionId)) continue;
        }
        let dot = 0;
        const offset = row * EMBEDDING_DIMENSIONS;
        for (let index = 0; index < EMBEDDING_DIMENSIONS; index++) {
          dot += vector[index]! * matrix.vectors[offset + index]!;
        }
        const score = dot * matrix.scales[row]!;
        if (score >= request.minScore) {
          hits.push({
            conversationId: matrix.conversationIds[row]!,
            messageId: matrix.messageIds[row]!,
            chunk: matrix.chunks[row]!,
            score
          });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      this.send({ type: 'search_result', id: request.id, hits: hits.slice(0, Math.max(0, request.limit)) });
    } catch (error) {
      this.send({ type: 'search_result', id: request.id, error: errorMessage(error) });
    }
  }

  private maintain(id: number, operation: 'reconcile' | 'rebuild' | 'clear'): void {
    try {
      const indexer = this.ensureIndexer();
      if (!indexer) throw new Error('Conversation history is still being prepared for semantic search. Try again in a moment.');
      if (operation === 'rebuild') indexer.rebuild();
      else if (operation === 'clear') indexer.clear();
      else indexer.reconcile();
      this.invalidateSearchCache();
      this.send({ type: 'maintain_result', id });
      this.lastStatus = 0;
      this.wakeUp();
    } catch (error) {
      this.send({ type: 'maintain_result', id, error: errorMessage(error) });
    }
  }

  private async run(): Promise<void> {
    let reconciled = false;
    while (!this.stopping) {
      const indexer = this.ensureIndexer();
      if (!indexer) {
        this.status('schema_missing', true);
        await this.sleep(SCHEMA_POLL_MS);
        continue;
      }
      if (!reconciled) {
        indexer.reconcile();
        reconciled = true;
      }
      if (this.loadError) {
        await this.sleep(IDLE_POLL_MS);
        continue;
      }
      let step: IndexStep;
      try {
        step = await indexer.step(() => !this.stopping);
      } catch (error) {
        if (isBusy(error)) {
          await this.sleep(BUSY_RETRY_MS);
          continue;
        }
        this.send({ type: 'error', error: errorMessage(error), fatal: false });
        await this.sleep(IDLE_POLL_MS);
        continue;
      }
      if (this.loadError) continue;
      if (step === 'indexed' || step === 'removed') this.invalidateSearchCache();
      if (step === 'idle' || step === 'waiting') {
        if (step === 'idle' && indexer.collectGarbage() > 0) this.invalidateSearchCache();
        this.status(step, true);
        await this.unloadWhenIdle();
        await this.sleep(step === 'idle' ? IDLE_POLL_MS : WAITING_POLL_MS);
        continue;
      }
      this.lastUse = Date.now();
      this.status('indexing');
    }
  }

  private invalidateSearchCache(): void {
    this.indexRevision += 1;
    this.clearSearchCache();
  }

  private clearSearchCache(): void {
    if (this.searchCacheEvictTimer) {
      clearTimeout(this.searchCacheEvictTimer);
      this.searchCacheEvictTimer = null;
    }
    this.searchCache = null;
  }

  private scheduleSearchCacheEviction(): void {
    if (this.searchCacheEvictTimer) clearTimeout(this.searchCacheEvictTimer);
    if (!this.searchCache) {
      this.searchCacheEvictTimer = null;
      return;
    }
    this.searchCacheEvictTimer = setTimeout(() => {
      this.searchCacheEvictTimer = null;
      this.searchCache = null;
    }, SEARCH_CACHE_IDLE_EVICT_MS);
    this.searchCacheEvictTimer.unref?.();
  }

  private loadSearchMatrix(db: SqliteConnection, projectId: string | null, provider: string | null): QuantizedSearchMatrix {
    const key = JSON.stringify([projectId, provider]);
    const dataVersion = (db.prepare('pragma data_version').get() as { data_version: number } | undefined)?.data_version ?? 0;
    if (
      this.searchCache
      && this.searchCache.key === key
      && this.searchCache.indexRevision === this.indexRevision
      && this.searchCache.dataVersion === dataVersion
    ) {
      this.scheduleSearchCacheEviction();
      return this.searchCache;
    }
    const dbRevision = JSON.stringify(
      projectId !== null
        ? db.prepare(`
            select (select count(*) from history_embedding_passages) as passages,
              (select max(id) from history_embedding_passages) as last_passage,
              (select max(indexed_at) from history_embedding_state) as indexed_at,
              (select count(*) from conversations where project_id = @project_id) as conversations,
              (select max(imported_at) from conversations where project_id = @project_id) as imported_at
          `).get({ project_id: projectId })
        : db.prepare(`
            select (select count(*) from history_embedding_passages) as passages,
              (select max(id) from history_embedding_passages) as last_passage,
              (select max(indexed_at) from history_embedding_state) as indexed_at,
              (select count(*) from conversations) as conversations,
              (select max(imported_at) from conversations) as imported_at
          `).get()
    );
    if (
      this.searchCache
      && this.searchCache.key === key
      && this.searchCache.indexRevision === this.indexRevision
      && this.searchCache.dbRevision === dbRevision
    ) {
      this.searchCache.dataVersion = dataVersion;
      this.scheduleSearchCacheEviction();
      return this.searchCache;
    }
    const modelKey = this.config!.modelKey;
    const filters = ['history_embedding_passages.model_key = @model_key'];
    const params: Record<string, unknown> = { model_key: modelKey };
    if (projectId !== null) {
      filters.push('conversations.project_id = @project_id');
      params.project_id = projectId;
    }
    if (provider !== null) {
      filters.push('conversations.provider = @provider');
      params.provider = provider;
    }
    const rows = db.prepare(`
      select history_embedding_passages.conversation_id, conversations.session_id, history_embedding_passages.message_id, history_embedding_passages.chunk, history_embedding_vectors.vector
      from history_embedding_passages
      join history_embedding_vectors on history_embedding_vectors.model_key = history_embedding_passages.model_key
        and history_embedding_vectors.content_hash = history_embedding_passages.content_hash
      join conversations on conversations.id = history_embedding_passages.conversation_id
      where ${filters.join(' and ')}
    `).all(params) as Array<{ conversation_id: string; session_id: string | null; message_id: string; chunk: number; vector: Uint8Array }>;

    const vectors = new Int8Array(rows.length * EMBEDDING_DIMENSIONS);
    const scales = new Float32Array(rows.length);
    const matrix: QuantizedSearchMatrix = {
      key,
      indexRevision: this.indexRevision,
      dataVersion,
      dbRevision,
      conversationIds: [],
      sessionIds: [],
      messageIds: [],
      chunks: [],
      vectors,
      scales
    };
    let used = 0;
    for (const row of rows) {
      const raw = blobToVector(row.vector);
      if (raw.length !== EMBEDDING_DIMENSIONS) continue;
      let maxAbs = 0;
      for (let index = 0; index < EMBEDDING_DIMENSIONS; index++) {
        const abs = Math.abs(raw[index]!);
        if (abs > maxAbs) maxAbs = abs;
      }
      const offset = used * EMBEDDING_DIMENSIONS;
      if (maxAbs > 0) {
        const invScale = 127 / maxAbs;
        for (let index = 0; index < EMBEDDING_DIMENSIONS; index++) {
          const quantized = Math.round(raw[index]! * invScale);
          vectors[offset + index] = quantized > 127 ? 127 : quantized < -127 ? -127 : quantized;
        }
        scales[used] = maxAbs / 127;
      } else {
        scales[used] = 0;
      }
      matrix.conversationIds.push(row.conversation_id);
      matrix.sessionIds.push(row.session_id);
      matrix.messageIds.push(row.message_id);
      matrix.chunks.push(row.chunk);
      used++;
    }
    matrix.vectors = vectors.subarray(0, used * EMBEDDING_DIMENSIONS);
    matrix.scales = scales.subarray(0, used);
    if (used <= MAX_CACHED_PASSAGES) {
      this.searchCache = matrix;
      this.scheduleSearchCacheEviction();
    } else {
      this.clearSearchCache();
    }
    return matrix;
  }

  private ensureIndexer(): HistoryEmbeddingIndexer | null {
    if (this.indexer) return this.indexer;
    const config = this.config!;
    if (!this.database) {
      // Migrations run only in the import worker, which the import queue
      // serialises; this writer never migrates.
      this.database = new HistoryDatabaseService(config.appDataPath, { busyTimeoutMs: 1_000 });
      try {
        this.database.initialize({ migrate: false });
      } catch {
        this.database.dispose();
        this.database = null;
        return null;
      }
    }
    if (!HistoryEmbeddingIndexer.schemaReady(this.database.connection)) return null;
    this.indexer = new HistoryEmbeddingIndexer(this.database.connection, this.trackedEmbedder(), config.modelKey);
    return this.indexer;
  }

  private trackedEmbedder(): DocumentEmbedder {
    return { embedDocuments: async (texts) => await (await this.loadedEmbedder()).embedDocuments(texts) };
  }

  // A model that cannot load is fatal for the worker, not a failure of the
  // conversation or query that happened to need it first.
  private async loadedEmbedder(): Promise<QueryEmbedder> {
    const embedder = this.embedder!;
    if (this.loadError) throw new Error(this.loadError);
    if (embedder.loaded) return embedder;
    this.status('loading', true);
    try {
      await embedder.load();
    } catch (error) {
      this.loadError = `The embedding model could not load: ${errorMessage(error)}`;
      this.send({ type: 'error', error: this.loadError, fatal: true });
      throw error;
    }
    return embedder;
  }

  private async unloadWhenIdle(): Promise<void> {
    if (this.embedder?.loaded && Date.now() - this.lastUse > UNLOAD_AFTER_MS) await this.embedder.dispose();
  }

  private status(state: 'loading' | 'indexing' | 'waiting' | 'idle' | 'schema_missing', force = false): void {
    const now = Date.now();
    if (!force && now - this.lastStatus < STATUS_INTERVAL_MS) return;
    this.lastStatus = now;
    let counts = null;
    try {
      counts = this.indexer?.counts() ?? null;
    } catch {
      // Counts are informational; a busy database skips this report.
    }
    this.send({ type: 'status', state, counts });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }

  private wakeUp(): void {
    this.wake?.();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Last, so the runtime class above is initialised before it is used.
if (require.main === module) startWorker();
