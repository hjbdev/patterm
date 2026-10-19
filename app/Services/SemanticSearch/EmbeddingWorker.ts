import os from 'node:os';
import { HistoryDatabaseService } from '../HistoryDatabaseService';
import { HistoryEmbeddingIndexer, isBusy, type DocumentEmbedder, type IndexStep } from './HistoryEmbeddingIndexer';
import { LlamaEmbedder } from './LlamaEmbedder';
import { encodeVector, type EmbeddingWorkerEvent, type EmbeddingWorkerRequest, type EmbeddingWorkerStart } from './EmbeddingWorkerProtocol';

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
    else if (message.type === 'maintain') this.maintain(message.id, message.operation);
    else if (message.type === 'wake') this.wakeUp();
    else if (message.type === 'stop') void this.stop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
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
      if (this.loadError) throw new Error(this.loadError);
      const vector = await this.embedder.embedQuery(text);
      if (!vector) throw new Error('the model returned no usable vector for this query');
      this.send({ type: 'query_result', id, vector: encodeVector(vector) });
    } catch (error) {
      this.send({ type: 'query_result', id, error: errorMessage(error) });
    }
  }

  private maintain(id: number, operation: 'reconcile' | 'rebuild' | 'clear'): void {
    try {
      const indexer = this.ensureIndexer();
      if (!indexer) throw new Error('conversation history has not been upgraded for semantic search yet');
      if (operation === 'rebuild') indexer.rebuild();
      else if (operation === 'clear') indexer.clear();
      else indexer.reconcile();
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
      if (this.loadError) {
        this.send({ type: 'error', error: this.loadError, fatal: true });
        continue;
      }
      if (step === 'idle' || step === 'waiting') {
        if (step === 'idle') indexer.collectGarbage();
        this.status(step, true);
        await this.unloadWhenIdle();
        await this.sleep(step === 'idle' ? IDLE_POLL_MS : WAITING_POLL_MS);
        continue;
      }
      this.lastUse = Date.now();
      this.status('indexing');
    }
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

  // A model that cannot load is fatal for the worker, not a failure of the
  // conversation that happened to need it first.
  private trackedEmbedder(): DocumentEmbedder {
    return {
      embedDocuments: async (texts) => {
        const embedder = this.embedder!;
        if (!embedder.loaded) {
          this.status('loading', true);
          try {
            await embedder.load();
          } catch (error) {
            this.loadError = `The embedding model could not load: ${errorMessage(error)}`;
            throw error;
          }
        }
        return await embedder.embedDocuments(texts);
      }
    };
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
