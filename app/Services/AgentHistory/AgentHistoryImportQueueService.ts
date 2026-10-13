import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { z } from 'zod';
import type { historyImportInput, HistoryImportProgress } from './AgentHistoryImportService';
import { HISTORY_IMPORT_STALE_MS } from './AgentHistoryTypes';
import type { DebugLogService } from '../DebugLogService';
import { HistoryDatabaseService } from '../HistoryDatabaseService';

type ImportInput = z.input<typeof historyImportInput>;
const RECENT_JOB_LIMIT = 20;
const LOG_SOURCE = 'history-import-queue';

export type HistoryImportJobAction = 'import' | 'reset_imports' | 'delete_conversation' | 'delete_project_history';
export type HistoryImportQueueJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale';

export interface HistoryImportWorkerMessage {
  action: HistoryImportJobAction;
  input: ImportInput;
  reimport?: boolean;
  conversation_id?: string;
  project_id?: string;
}

export interface HistoryImportQueueJobSnapshot {
  id: string;
  action: HistoryImportJobAction;
  status: HistoryImportQueueJobStatus;
  trigger: string | null;
  provider: string | null;
  path: string | null;
  projectId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  elapsedMs: number | null;
  position: number | null;
  error: string | null;
  progress: HistoryImportProgress | null;
  result: unknown | null;
}

export interface HistoryImportQueueSnapshot {
  running: HistoryImportQueueJobSnapshot | null;
  queued: HistoryImportQueueJobSnapshot[];
  recent: HistoryImportQueueJobSnapshot[];
  counts: {
    queued: number;
    running: number;
    recentFailures: number;
  };
}

export interface HistoryImportQueueEnqueueResult {
  job_id: string;
  status: 'queued';
  position: number | null;
  queue_depth: number;
}

export interface HistoryImportWorkerProcess extends EventEmitter {
  postMessage(message: unknown): void;
  kill(): void;
}

export type HistoryImportWorkerLauncher = (workerPath: string) => HistoryImportWorkerProcess;
export type HistoryImportQueueRunner = (message: HistoryImportWorkerMessage, reportProgress: (progress: HistoryImportProgress) => void) => Promise<unknown>;
export type HistoryImportResultHandler = (result: unknown) => void;

interface QueuedJob {
  id: string;
  message: HistoryImportWorkerMessage;
  status: HistoryImportQueueJobStatus;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  error: string | null;
  progress: HistoryImportProgress | null;
  result: unknown | null;
  followUpCount: number;
}

const WATCHER_FOLLOW_UP_LIMIT = 1;

export class AgentHistoryImportQueueService {
  private readonly queue: QueuedJob[] = [];
  private readonly recent: QueuedJob[] = [];
  private running = false;
  private disposed = false;
  private current: HistoryImportWorkerProcess | null = null;
  private active: QueuedJob | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private readonly staleMs: number;
  private readonly dirtyWatcherKeys = new Map<string, HistoryImportWorkerMessage>();

  constructor(
    private readonly appDataPath: string,
    private readonly onDone: () => void = () => {},
    private readonly launchWorker: HistoryImportWorkerLauncher = launchUtilityProcessWorker,
    private readonly debugLog: Pick<DebugLogService, 'write'> | null = null,
    options: { staleMs?: number; runJob?: HistoryImportQueueRunner; onResult?: HistoryImportResultHandler } = {}
  ) {
    this.staleMs = options.staleMs ?? HISTORY_IMPORT_STALE_MS;
    this.runJob = options.runJob;
    this.onResult = options.onResult;
  }

  private readonly runJob: HistoryImportQueueRunner | undefined;
  private readonly onResult: HistoryImportResultHandler | undefined;

  import(input: ImportInput): HistoryImportQueueEnqueueResult {
    return this.enqueue({ action: 'import', input });
  }

  resetImports(input: ImportInput = { trigger: 'manual' }, reimport = true): HistoryImportQueueEnqueueResult {
    return this.enqueue({ action: 'reset_imports', input, reimport });
  }

  deleteConversation(conversationId: string): HistoryImportQueueEnqueueResult {
    return this.enqueue({ action: 'delete_conversation', input: { trigger: 'manual' }, conversation_id: conversationId });
  }

  deleteProjectHistory(projectId: string): HistoryImportQueueEnqueueResult {
    return this.enqueue({ action: 'delete_project_history', input: { trigger: 'manual' }, project_id: projectId });
  }

  status(): HistoryImportQueueSnapshot {
    const running = this.active?.status === 'running' ? this.snapshotJob(this.active, null) : null;
    const queued = this.queue.map((job, index) => this.snapshotJob(job, index + 1));
    const recent = this.recent.map((job) => this.snapshotJob(job, null));
    return {
      running,
      queued,
      recent,
      counts: {
        queued: queued.length,
        running: running ? 1 : 0,
        recentFailures: recent.filter((job) => job.status === 'failed' || job.status === 'stale').length
      }
    };
  }

  private enqueue(message: HistoryImportWorkerMessage): HistoryImportQueueEnqueueResult {
    const coalesceKey = watcherCoalesceKey(message);
    if (coalesceKey) {
      const existing = this.queue.find((job) => watcherCoalesceKey(job.message) === coalesceKey);
      if (existing) {
        const position = this.queue.findIndex((queuedJob) => queuedJob.id === existing.id);
        this.log('job.coalesced_queued', existing, { coalesce_key: coalesceKey, queue_depth: this.queue.length });
        return { job_id: existing.id, status: 'queued', position: position >= 0 ? position + 1 : null, queue_depth: this.queue.length + (this.active?.status === 'running' ? 1 : 0) };
      }
      if (this.active && watcherCoalesceKey(this.active.message) === coalesceKey) {
        this.dirtyWatcherKeys.set(coalesceKey, message);
        this.log('job.coalesced_running', this.active, { coalesce_key: coalesceKey, queue_depth: this.queue.length });
        return { job_id: this.active.id, status: 'queued', position: null, queue_depth: this.queue.length + 1 };
      }
    }
    const job: QueuedJob = { id: randomUUID(), message, status: 'queued', queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null, lastHeartbeatAt: null, error: null, progress: null, result: null, followUpCount: 0 };
    this.queue.push(job);
    this.log('job.enqueued', job, { position: this.queue.length, queue_depth: this.queue.length });
    this.drain();
    const position = this.queue.findIndex((queuedJob) => queuedJob.id === job.id);
    return { job_id: job.id, status: 'queued', position: position >= 0 ? position + 1 : null, queue_depth: this.queue.length + (this.active?.status === 'running' ? 1 : 0) };
  }

  dispose(): void {
    this.disposed = true;
    this.dirtyWatcherKeys.clear();
    this.clearStaleTimer();
    for (const job of this.queue.splice(0)) {
      this.finishJob(job, 'cancelled', 'queue disposed', null);
    }
    if (this.active && this.active.status === 'running') {
      this.finishJob(this.active, 'cancelled', 'queue disposed', null);
    }
    this.log('queue.disposed', null, { queue_depth: this.queue.length, had_current: Boolean(this.current) });
    const current = this.current;
    this.current = null;
    this.active = null;
    current?.kill();
  }

  private drain(): void {
    if (this.running || this.disposed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = true;
    this.active = job;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.lastHeartbeatAt = job.startedAt;
    this.log('job.started', job, { queue_depth: this.queue.length });

    if (this.runJob) {
      this.drainMainJob(job);
      return;
    }

    let worker: HistoryImportWorkerProcess;
    const workerPath = path.join(__dirname, 'AgentHistoryImportWorker.js');
    let receivedMessage = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.clearStaleTimer();
      this.current = null;
      this.running = false;
      const finished = this.active;
      this.active = null;
      if (finished) this.enqueueWatcherFollowUp(finished);
      this.onDone();
      this.drain();
    };
    try {
      worker = this.launchWorker(workerPath);
      this.log('worker.spawned', job, { worker_path: workerPath });
    } catch (error) {
      this.finishJob(job, 'failed', errorMessage(error), null);
      release();
      return;
    }
    this.current = worker;
    const markStale = () => {
      if (job.status !== 'running') return;
      this.finishJob(job, 'stale', `history import worker stale: no heartbeat for ${formatDuration(this.staleMs)}`, job.progress ? { progress: job.progress } : null);
      this.log('worker.stale', job, { stale_ms: this.staleMs, last_heartbeat_at: job.lastHeartbeatAt });
      try {
        worker.kill();
      } catch {
        // Releasing the queue is more important than preserving a wedged worker.
      }
      release();
    };
    const scheduleStaleCheck = () => {
      this.clearStaleTimer();
      const lastHeartbeatAt = job.lastHeartbeatAt ?? job.startedAt;
      const lastHeartbeatMs = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : Date.now();
      const elapsed = Number.isFinite(lastHeartbeatMs) ? Date.now() - lastHeartbeatMs : this.staleMs;
      this.staleTimer = setTimeout(markStale, Math.max(0, this.staleMs - elapsed));
    };
    scheduleStaleCheck();
    worker.on('message', (message: unknown) => {
      if (isWorkerHeartbeat(message)) {
        if (job.status === 'running') {
          job.lastHeartbeatAt = new Date().toISOString();
          scheduleStaleCheck();
        }
        return;
      }
      const progress = progressFromWorkerMessage(message);
      if (progress) {
        if (job.status === 'running') {
          job.lastHeartbeatAt = new Date().toISOString();
          job.progress = progress;
          scheduleStaleCheck();
        }
        return;
      }

      const resultMessage = resultFromWorkerMessage(message);
      if (!resultMessage) return;
      receivedMessage = true;
      this.log('worker.message', job, { ok: resultMessage.ok === true, error: resultMessage.error ?? null, result: summarizeResult(resultMessage.result) });
      if (resultMessage.ok) {
        this.applyResultEffects(resultMessage.result);
        this.finishJob(job, 'succeeded', null, summarizeResult(resultMessage.result));
      } else this.finishJob(job, 'failed', resultMessage.error ?? 'history import worker failed', null);
      try {
        worker.postMessage({ type: 'result_ack' });
      } catch {
        // The parent has already handled the result; ack is best-effort.
      }
      release();
    });
    worker.once('error', (error: Error) => {
      this.log('worker.error', job, { error: error.message });
      this.finishJob(job, 'failed', error.message, null);
      release();
    });
    worker.once('exit', (code?: number, signal?: string) => {
      this.log('worker.exit', job, { code: code ?? null, signal: signal ?? null, received_message: receivedMessage });
      if (!receivedMessage && job.status === 'running') {
        this.finishJob(job, 'failed', `history import worker exited before reporting a result${code === undefined ? '' : ` (code ${code})`}`, null);
      }
      if (!receivedMessage) this.finalizeInterruptedBatch(job);
      release();
    });
    try {
      worker.postMessage({ appDataPath: this.appDataPath, ...job.message });
    } catch (error) {
      this.finishJob(job, 'failed', errorMessage(error), null);
      try {
        worker.kill();
      } catch {
        // If the worker cannot be killed, still release the queue for later jobs.
      }
      release();
    }
  }

  private drainMainJob(job: QueuedJob): void {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.clearStaleTimer();
      this.running = false;
      const finished = this.active;
      this.active = null;
      if (finished) this.enqueueWatcherFollowUp(finished);
      this.onDone();
      this.drain();
    };
    const markStale = () => {
      if (job.status !== 'running') return;
      this.finishJob(job, 'stale', `history import stale: no heartbeat for ${formatDuration(this.staleMs)}`, job.progress ? { progress: job.progress } : null);
      this.log('job.stale', job, { stale_ms: this.staleMs, last_heartbeat_at: job.lastHeartbeatAt });
      release();
    };
    const scheduleStaleCheck = () => {
      this.clearStaleTimer();
      const lastHeartbeatAt = job.lastHeartbeatAt ?? job.startedAt;
      const lastHeartbeatMs = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : Date.now();
      const elapsed = Number.isFinite(lastHeartbeatMs) ? Date.now() - lastHeartbeatMs : this.staleMs;
      this.staleTimer = setTimeout(markStale, Math.max(0, this.staleMs - elapsed));
    };
    scheduleStaleCheck();
    const reportProgress = (progress: HistoryImportProgress) => {
      if (job.status !== 'running') return;
      job.lastHeartbeatAt = new Date().toISOString();
      job.progress = progress;
      scheduleStaleCheck();
    };

    this.runJob!(job.message, reportProgress)
      .then((result) => {
        this.log('job.runner.succeeded', job, { result: summarizeResult(result) });
        this.applyResultEffects(result);
        this.finishJob(job, 'succeeded', null, summarizeResult(result));
      })
      .catch((error: unknown) => {
        const message = errorMessage(error);
        this.log('job.runner.failed', job, { error: message });
        this.finishJob(job, 'failed', message, null);
      })
      .finally(release);
  }

  private finishJob(job: QueuedJob, status: Exclude<HistoryImportQueueJobStatus, 'queued' | 'running'>, error: string | null, result: unknown | null): void {
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'stale') return;
    job.status = status;
    job.finishedAt = new Date().toISOString();
    job.error = error;
    job.result = result;
    this.recent.unshift(job);
    this.recent.splice(RECENT_JOB_LIMIT);
    this.log(status === 'succeeded' ? 'job.succeeded' : status === 'cancelled' ? 'job.cancelled' : status === 'stale' ? 'job.stale' : 'job.failed', job, { error, result });
  }

  private applyResultEffects(result: unknown): void {
    if (!this.onResult) return;
    try {
      this.onResult(result);
    } catch (error) {
      this.log('job.result_effects_failed', this.active, { error: errorMessage(error) });
    }
  }

  private finalizeInterruptedBatch(job: QueuedJob): void {
    const progress = job.progress;
    if (!progress || !['failed', 'stale', 'cancelled'].includes(job.status)) return;
    // Wait for worker exit before opening this short-lived writer. The normal
    // main-process history connection remains read-only; no migrations run here.
    const database = new HistoryDatabaseService(this.appDataPath, { busyTimeoutMs: 250 });
    try {
      database.initialize({ migrate: false });
      database.connection.prepare(`
        update conversation_import_batches
        set status = ?, finished_at = ?, files_seen = ?, files_imported = ?,
          conversations_imported = ?, messages_imported = ?, skipped_count = ?, error_count = ?
        where id = ? and status = 'running'
      `).run(job.status, job.finishedAt, progress.filesSeen, progress.filesImported,
        progress.conversationsImported, progress.messagesImported, progress.skippedCount,
        progress.errorCount + 1, progress.batchId);
    } catch (error) {
      this.log('job.batch_finalize_failed', job, { error: errorMessage(error), batch_id: progress.batchId });
    } finally {
      database.dispose();
    }
  }

  private enqueueWatcherFollowUp(job: QueuedJob): void {
    const coalesceKey = watcherCoalesceKey(job.message);
    if (!coalesceKey) return;
    const dirty = this.dirtyWatcherKeys.get(coalesceKey);
    const retrySuggested = resultBoolean(job.result, 'retrySuggested') || (resultNumber(job.result, 'unstableFiles') ?? 0) > 0;
    if (!dirty && !retrySuggested) return;
    if (job.followUpCount >= WATCHER_FOLLOW_UP_LIMIT) {
      this.dirtyWatcherKeys.delete(coalesceKey);
      this.log('job.follow_up_suppressed', job, { coalesce_key: coalesceKey, retry_suggested: retrySuggested, follow_up_count: job.followUpCount });
      return;
    }
    this.dirtyWatcherKeys.delete(coalesceKey);
    const message = dirty ?? job.message;
    const followUp: QueuedJob = { id: randomUUID(), message, status: 'queued', queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null, lastHeartbeatAt: null, error: null, progress: null, result: null, followUpCount: job.followUpCount + 1 };
    this.queue.push(followUp);
    this.log('job.follow_up_enqueued', followUp, { coalesce_key: coalesceKey, retry_suggested: retrySuggested, queue_depth: this.queue.length });
  }

  private snapshotJob(job: QueuedJob, position: number | null): HistoryImportQueueJobSnapshot {
    return {
      id: job.id,
      action: job.message.action,
      status: job.status,
      trigger: job.message.input.trigger ?? null,
      provider: job.message.input.provider ?? null,
      path: job.message.input.path ?? null,
      projectId: job.message.input.project_id ?? null,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      lastHeartbeatAt: job.lastHeartbeatAt,
      elapsedMs: elapsedMs(job),
      position,
      error: job.error,
      progress: job.progress,
      result: job.result
    };
  }

  private clearStaleTimer(): void {
    if (!this.staleTimer) return;
    clearTimeout(this.staleTimer);
    this.staleTimer = null;
  }

  private log(event: string, job: QueuedJob | null, data: Record<string, unknown> = {}): void {
    this.debugLog?.write(LOG_SOURCE, event, {
      ...(job ? {
        job_id: job.id,
        action: job.message.action,
        trigger: job.message.input.trigger ?? null,
        provider: job.message.input.provider ?? null,
        path: job.message.input.path ?? null,
        project_id: job.message.input.project_id ?? null,
        status: job.status,
        elapsed_ms: elapsedMs(job)
      } : {}),
      ...data
    });
  }
}

function elapsedMs(job: QueuedJob): number | null {
  if (!job.startedAt) return null;
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return Math.max(0, end - Date.parse(job.startedAt));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result ?? null;
  const row = result as Record<string, unknown>;
  return {
    batch_id: typeof row.batch_id === 'string' ? row.batch_id : null,
    status: typeof row.status === 'string' ? row.status : null,
    filesSeen: numberValue(row.filesSeen),
    filesImported: numberValue(row.filesImported),
    conversationsImported: numberValue(row.conversationsImported),
    messagesImported: numberValue(row.messagesImported),
    skippedCount: numberValue(row.skippedCount),
    errorCount: numberValue(row.errorCount),
    unstableFiles: numberValue(row.unstableFiles),
    retrySuggested: typeof row.retrySuggested === 'boolean' ? row.retrySuggested : null,
    deletedConversations: numberValue(row.deletedConversations),
    import: row.import && typeof row.import === 'object' ? summarizeResult(row.import) : null
  };
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function progressFromWorkerMessage(message: unknown): HistoryImportProgress | null {
  if (!message || typeof message !== 'object') return null;
  const row = message as Record<string, unknown>;
  if (row.type !== 'progress' || !row.progress || typeof row.progress !== 'object') return null;
  const progress = row.progress as Record<string, unknown>;
  const batchId = typeof progress.batchId === 'string' ? progress.batchId : null;
  const filesSeen = numberValue(progress.filesSeen);
  const filesImported = numberValue(progress.filesImported);
  const conversationsImported = numberValue(progress.conversationsImported);
  const messagesImported = numberValue(progress.messagesImported);
  const skippedCount = numberValue(progress.skippedCount);
  const errorCount = numberValue(progress.errorCount);
  if (!batchId || filesSeen === null || filesImported === null || conversationsImported === null || messagesImported === null || skippedCount === null || errorCount === null) return null;
  return {
    batchId,
    currentFile: typeof progress.currentFile === 'string' ? progress.currentFile : null,
    filesSeen,
    filesImported,
    conversationsImported,
    messagesImported,
    skippedCount,
    errorCount
  };
}

function isWorkerHeartbeat(message: unknown): boolean {
  return Boolean(message && typeof message === 'object' && (message as { type?: unknown }).type === 'heartbeat');
}

function resultFromWorkerMessage(message: unknown): { ok: boolean; result?: unknown; error?: string } | null {
  if (!message || typeof message !== 'object') return null;
  const row = message as Record<string, unknown>;
  if (row.type && row.type !== 'result') return null;
  if (typeof row.ok !== 'boolean') return null;
  const result: { ok: boolean; result?: unknown; error?: string } = { ok: row.ok };
  if ('result' in row) result.result = row.result;
  if (typeof row.error === 'string') result.error = row.error;
  return result;
}

function formatDuration(value: number): string {
  const seconds = Math.max(1, Math.round(value / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function resultNumber(result: unknown, key: string): number | null {
  return result && typeof result === 'object' ? numberValue((result as Record<string, unknown>)[key]) : null;
}

function resultBoolean(result: unknown, key: string): boolean {
  return Boolean(result && typeof result === 'object' && (result as Record<string, unknown>)[key] === true);
}

function watcherCoalesceKey(message: HistoryImportWorkerMessage): string | null {
  if (message.action !== 'import' || message.input.trigger !== 'watcher') return null;
  return `${message.action}:${message.input.trigger}:${message.input.provider ?? '*'}:${message.input.path ?? '*'}`;
}

function launchUtilityProcessWorker(workerPath: string): HistoryImportWorkerProcess {
  const electron = require('electron') as { utilityProcess?: { fork?: (modulePath: string, args?: string[], options?: Record<string, unknown>) => HistoryImportWorkerProcess } } | string;
  if (typeof electron === 'string' || !electron.utilityProcess?.fork) {
    throw new Error('Electron utilityProcess is unavailable; conversation history imports must run in an Electron utility process');
  }
  return electron.utilityProcess.fork(workerPath, [], {
    serviceName: 'Patterm Conversation History Importer',
    stdio: 'inherit'
  });
}
