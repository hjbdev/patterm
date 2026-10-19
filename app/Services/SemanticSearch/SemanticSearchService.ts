import os from 'node:os';
import path from 'node:path';
import type { SqliteConnection } from '../../Database/SqliteConnection';
import { launchUtilityProcessWorker, type HistoryImportWorkerLauncher, type HistoryImportWorkerProcess } from '../AgentHistory/AgentHistoryImportQueueService';
import type { DebugLogService } from '../DebugLogService';
import { HistoryDatabaseService } from '../HistoryDatabaseService';
import type { SettingsService } from '../SettingsService';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EMBEDDING_MODEL_KEY } from './EmbeddingModel';
import { EmbeddingModelInstaller, type ModelInstallState } from './EmbeddingModelInstaller';
import { decodeVector, type EmbeddingWorkerEvent, type EmbeddingWorkerRequest } from './EmbeddingWorkerProtocol';
import { embeddingCounts, HistoryEmbeddingIndexer, type HistoryEmbeddingCounts } from './HistoryEmbeddingIndexer';

export type SemanticIndexState = 'off' | 'starting' | 'loading' | 'indexing' | 'waiting' | 'idle' | 'schema_missing' | 'error';

export interface SemanticSearchState {
  enabled: boolean;
  model: {
    label: string;
    quantization: string;
    bytes: number;
    license: string;
    modelCardUrl: string;
    dimensions: number;
    install: ModelInstallState;
  };
  index: { state: SemanticIndexState; counts: HistoryEmbeddingCounts | null; error: string | null };
  threads: number;
}

export interface SemanticSearchServiceOptions {
  appDataPath: string;
  settings: Pick<SettingsService, 'semanticSearchSettings' | 'saveSemanticSearchSettings'>;
  // The main process's read-only history connection.
  historyDatabase: { connection: SqliteConnection; ensureAvailable?: () => boolean } | null;
  launchWorker?: HistoryImportWorkerLauncher;
  requestMigration: () => void;
  onChanged: () => void;
  debugLog?: Pick<DebugLogService, 'write'> | null;
  installer?: EmbeddingModelInstaller;
  threads?: number;
  workerPath?: string;
}

const QUERY_TIMEOUT_MS = 4_000;
const STOP_TIMEOUT_MS = 5_000;
const RESTART_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];

// Settings, model installation, the embedding worker's lifecycle, and query
// embedding for this host. Semantic search is optional throughout: when it
// is off, missing, loading, or failing, every caller falls back to keyword
// search, and imports never depend on it.
export class SemanticSearchService {
  readonly installer: EmbeddingModelInstaller;
  private worker: HistoryImportWorkerProcess | null = null;
  private workerState: SemanticIndexState = 'off';
  private counts: HistoryEmbeddingCounts | null = null;
  private error: string | null = null;
  private fatal = false;
  private stopping: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restarts = 0;
  private migrationRequested = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, { resolve: (value: EmbeddingWorkerEvent) => void; timer: NodeJS.Timeout }>();
  private disposed = false;
  readonly threads: number;

  constructor(private readonly options: SemanticSearchServiceOptions) {
    this.installer = options.installer ?? new EmbeddingModelInstaller(options.appDataPath, () => this.installChanged());
    this.threads = options.threads ?? Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 4)));
  }

  get enabled(): boolean {
    return this.options.settings.semanticSearchSettings().enabled;
  }

  // True while queries can be embedded; callers still handle a null vector.
  get active(): boolean {
    return this.worker !== null && !this.fatal && this.enabled;
  }

  start(): void {
    if (this.enabled && this.installer.installed) this.startWorker();
  }

  state(): SemanticSearchState {
    return {
      enabled: this.enabled,
      model: {
        label: EMBEDDING_MODEL.label,
        quantization: EMBEDDING_MODEL.quantization,
        bytes: EMBEDDING_MODEL.bytes,
        license: EMBEDDING_MODEL.license,
        modelCardUrl: EMBEDDING_MODEL.modelCardUrl,
        dimensions: EMBEDDING_DIMENSIONS,
        install: this.installer.state()
      },
      index: { state: this.indexState(), counts: this.worker ? this.counts : this.readCounts(), error: this.error },
      threads: this.threads
    };
  }

  async setEnabled(enabled: boolean): Promise<SemanticSearchState> {
    if (enabled && !this.installer.installed) throw new Error('Install the embedding model before turning on semantic search');
    this.options.settings.saveSemanticSearchSettings({ enabled });
    if (enabled) {
      this.fatal = false;
      this.error = null;
      this.restarts = 0;
      this.startWorker();
    } else {
      await this.stopWorker();
    }
    this.options.onChanged();
    return this.state();
  }

  installModel(): SemanticSearchState {
    this.installer.install();
    return this.state();
  }

  cancelInstall(): SemanticSearchState {
    this.installer.cancel();
    return this.state();
  }

  // Removes the model and every stored vector. Search turns off with them;
  // imported history is untouched.
  async removeModel(): Promise<SemanticSearchState> {
    this.options.settings.saveSemanticSearchSettings({ enabled: false });
    await this.stopWorker();
    await this.installer.remove();
    this.clearIndexDirectly();
    this.error = null;
    this.fatal = false;
    this.options.onChanged();
    return this.state();
  }

  async rebuild(): Promise<SemanticSearchState> {
    if (!this.worker) throw new Error('Turn on semantic search to rebuild its index');
    await this.maintain('rebuild');
    return this.state();
  }

  // An import or deletion finished; the worker checks its queue now rather
  // than at its next poll.
  historyChanged(): void {
    this.post({ type: 'wake' });
  }

  // The normalised query vector, or null when semantic search cannot answer
  // in time. Never throws: keyword search is always the fallback.
  async embedQuery(text: string, timeoutMs = QUERY_TIMEOUT_MS): Promise<Float32Array | null> {
    if (!this.active) return null;
    const event = await this.request({ type: 'query', id: this.nextRequestId++, text }, timeoutMs);
    if (!event || event.type !== 'query_result') return null;
    if (event.error || !event.vector) {
      this.options.debugLog?.write('semantic', 'query.failed', { error: event.error ?? 'empty vector' });
      return null;
    }
    const vector = decodeVector(event.vector);
    return vector.length === EMBEDDING_DIMENSIONS ? vector : null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.installer.cancel();
    await this.stopWorker();
    await this.installer.settled();
  }

  private indexState(): SemanticIndexState {
    if (this.fatal) return 'error';
    if (!this.worker) return 'off';
    return this.workerState;
  }

  private readCounts(): HistoryEmbeddingCounts | null {
    const history = this.options.historyDatabase;
    try {
      if (!history || (history.ensureAvailable && !history.ensureAvailable())) return null;
      if (!HistoryEmbeddingIndexer.schemaReady(history.connection)) return null;
      return embeddingCounts(history.connection, EMBEDDING_MODEL_KEY);
    } catch {
      return null;
    }
  }

  private installChanged(): void {
    // A finished download starts search only if the owner already turned it on.
    if (this.installer.installed && this.enabled && !this.worker && !this.disposed) this.startWorker();
    this.options.onChanged();
  }

  private startWorker(): void {
    if (this.worker || this.disposed || this.stopping || !this.installer.installed) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const launch = this.options.launchWorker ?? ((workerPath: string) => launchUtilityProcessWorker(workerPath, 'Patterm Semantic Search'));
    let worker: HistoryImportWorkerProcess;
    try {
      worker = launch(this.options.workerPath ?? path.join(__dirname, 'EmbeddingWorker.js'));
    } catch (error) {
      this.fail(`The semantic search worker could not start: ${errorMessage(error)}`, true);
      return;
    }
    this.worker = worker;
    this.workerState = 'starting';
    this.migrationRequested = false;
    this.counts = this.readCounts();
    worker.on('message', (message: unknown) => this.onWorkerEvent(message as EmbeddingWorkerEvent));
    worker.on('error', (error: unknown) => this.options.debugLog?.write('semantic', 'worker.error', { error: errorMessage(error) }));
    worker.once('exit', (code: unknown) => this.onWorkerExit(worker, code));
    worker.postMessage({ type: 'start', appDataPath: this.options.appDataPath, modelPath: this.installer.modelPath, modelKey: EMBEDDING_MODEL_KEY, threads: this.threads } satisfies EmbeddingWorkerRequest);
    this.options.debugLog?.write('semantic', 'worker.started', { threads: this.threads });
  }

  private async stopWorker(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const worker = this.worker;
    if (!worker) return;
    this.stopping ??= new Promise<void>((resolve) => {
      const timer = setTimeout(() => worker.kill(), STOP_TIMEOUT_MS);
      worker.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      worker.postMessage({ type: 'stop' } satisfies EmbeddingWorkerRequest);
    }).finally(() => { this.stopping = null; });
    await this.stopping;
  }

  private onWorkerEvent(event: EmbeddingWorkerEvent): void {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'query_result' || event.type === 'maintain_result') {
      const waiter = this.pending.get(event.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.pending.delete(event.id);
        waiter.resolve(event);
      }
      return;
    }
    if (event.type === 'status') {
      const changed = this.workerState !== event.state || JSON.stringify(this.counts) !== JSON.stringify(event.counts);
      this.workerState = event.state;
      if (event.counts) this.counts = event.counts;
      if (event.state === 'indexing') this.restarts = 0;
      if (event.state === 'schema_missing' && !this.migrationRequested) {
        this.migrationRequested = true;
        this.options.requestMigration();
      }
      if (changed) this.options.onChanged();
      return;
    }
    if (event.type === 'error') {
      this.fail(event.error, event.fatal);
      if (event.fatal) void this.stopWorker();
    }
  }

  private onWorkerExit(worker: HistoryImportWorkerProcess, code: unknown): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.workerState = 'off';
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.resolve({ type: 'query_result', id, error: 'the semantic search worker stopped' });
    }
    this.pending.clear();
    const expected = this.stopping !== null || this.disposed || this.fatal || !this.enabled;
    if (!expected) {
      const delay = RESTART_DELAYS_MS[Math.min(this.restarts, RESTART_DELAYS_MS.length - 1)]!;
      this.restarts += 1;
      this.error = `The semantic search worker exited unexpectedly (code ${String(code)}); restarting`;
      this.options.debugLog?.write('semantic', 'worker.exited', { code: String(code), restart_in_ms: delay });
      this.restartTimer = setTimeout(() => this.startWorker(), delay);
      this.restartTimer.unref?.();
    }
    this.options.onChanged();
  }

  private fail(message: string, fatal: boolean): void {
    this.error = message;
    if (fatal) this.fatal = true;
    this.options.debugLog?.write('semantic', fatal ? 'worker.fatal' : 'worker.failed', { error: message });
    this.options.onChanged();
  }

  private async maintain(operation: 'reconcile' | 'rebuild' | 'clear'): Promise<void> {
    const event = await this.request({ type: 'maintain', id: this.nextRequestId++, operation }, 60_000);
    if (!event) throw new Error('The semantic search worker did not respond');
    if (event.type === 'maintain_result' && event.error) throw new Error(event.error);
    this.options.onChanged();
  }

  private request(message: Extract<EmbeddingWorkerRequest, { id: number }>, timeoutMs: number): Promise<EmbeddingWorkerEvent | null> {
    if (!this.worker) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(message.id, { resolve, timer });
      this.post(message);
    });
  }

  private post(message: EmbeddingWorkerRequest): void {
    try {
      this.worker?.postMessage(message);
    } catch (error) {
      this.options.debugLog?.write('semantic', 'worker.post_failed', { error: errorMessage(error) });
    }
  }

  // With no worker, removal clears the index through a short-lived writer,
  // the same way the import queue finalises an interrupted batch.
  private clearIndexDirectly(): void {
    const database = new HistoryDatabaseService(this.options.appDataPath, { busyTimeoutMs: 5_000 });
    try {
      database.initialize({ migrate: false });
      if (!HistoryEmbeddingIndexer.schemaReady(database.connection)) return;
      new HistoryEmbeddingIndexer(database.connection, { embedDocuments: async () => [] }, EMBEDDING_MODEL_KEY).clear();
    } catch (error) {
      this.options.debugLog?.write('semantic', 'index.clear_failed', { error: errorMessage(error) });
    } finally {
      database.dispose();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
