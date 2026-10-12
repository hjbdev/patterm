import { completeHistoryBackup } from '../DatabaseBackupService';
import { ProviderHistoryDiscoveryService } from './ProviderHistoryDiscoveryService';
import { AgentHistoryImportService, type HistoryFileParser, type HistoryImportProgress } from './AgentHistoryImportService';
import { AgentHistoryDeleteService } from './AgentHistoryDeleteService';
import type { AgentHistoryProvider, HistorySourceCandidate, ParseHistoryFileOptions, ParsedHistoryFile } from './AgentHistoryTypes';
import { DatabaseService } from '../DatabaseService';
import { HistoryDatabaseService } from '../HistoryDatabaseService';
import { HistorySearchIndexService } from './HistorySearchIndexService';
import os from 'node:os';

interface WorkerInput {
  action?: 'parse_file' | 'import' | 'reset_imports' | 'delete_conversation';
  appDataPath?: string;
  input?: Parameters<AgentHistoryImportService['importWithParser']>[0];
  reimport?: boolean;
  provider?: AgentHistoryProvider;
  sourceKind?: HistorySourceCandidate['sourceKind'];
  sourcePath?: string;
  filePath?: string;
  options?: ParseHistoryFileOptions;
  conversation_id?: string;
}

interface ParentPort {
  once(event: 'message', listener: (event: { data: unknown }) => void): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

type WorkerResult = { ok: boolean; result?: unknown; error?: string };
type ProgressReporter = (progress: HistoryImportProgress) => void;

if (require.main === module) startWorker();

function startWorker(): void {
  lowerWorkerPriority();
  const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
  if (parentPort) {
    parentPort.once('message', (event) => {
      const heartbeat = setInterval(() => parentPort.postMessage({ type: 'heartbeat' }), 5_000);
      void runHistoryImportWorker(event.data, (progress) => parentPort.postMessage({ type: 'progress', progress }))
        .then((result) => parentPort.postMessage(resultMessage(result)))
        .finally(() => {
          clearInterval(heartbeat);
          waitForAck(parentPort);
        });
    });
    return;
  }
  process.once('message', (message) => {
    const heartbeat = setInterval(() => process.send?.({ type: 'heartbeat' }), 5_000);
    void runHistoryImportWorker(message, (progress) => process.send?.({ type: 'progress', progress }))
      .then((result) => process.send?.(resultMessage(result)))
      .finally(() => {
        clearInterval(heartbeat);
        process.disconnect?.();
      });
  });
}

function lowerWorkerPriority(): void {
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Import priority is best-effort on platforms that do not expose it.
  }
}

export async function runHistoryImportWorker(message: unknown, reportProgress?: ProgressReporter): Promise<WorkerResult> {
  const payload = message as WorkerInput;
  try {
    if (payload.action === 'parse_file') {
      return { ok: true, result: parseHistoryFile(payload) };
    }
    if (payload.action === 'import' || payload.action === 'reset_imports' || payload.action === 'delete_conversation') {
      return { ok: true, result: await runQueuedHistoryImport(payload, reportProgress) };
    }
    throw new Error('unknown history worker action');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseHistoryFile(payload: WorkerInput): ParsedHistoryFile {
  if (!payload.provider || !payload.filePath) {
    throw new Error('parse_file is missing provider or filePath');
  }
  const adapter = new ProviderHistoryDiscoveryService().adapter(payload.provider);
  return adapter.parseFile(payload.filePath, payload.options);
}

async function runQueuedHistoryImport(payload: WorkerInput, reportProgress?: ProgressReporter): Promise<unknown> {
  if (!payload.appDataPath) {
    throw new Error('history import worker is missing appDataPath');
  }
  const input = payload.input ?? { trigger: 'manual' };
  const appDatabase = new DatabaseService(payload.appDataPath, { readOnly: true, busyTimeoutMs: 250 });
  const historyDatabase = new HistoryDatabaseService(payload.appDataPath);
  try {
    appDatabase.initialize({ migrate: false });
    completeHistoryBackup(payload.appDataPath);
    historyDatabase.initialize();
    // Legacy app.db rows are copied before new imports so existing local history survives the split.
    copyLegacyHistoryIfNeeded(appDatabase, historyDatabase);
    const search = new HistorySearchIndexService(historyDatabase);
    const discovery = new ProviderHistoryDiscoveryService();
    const imports = new AgentHistoryImportService(historyDatabase, discovery, null, search, appDatabase);
    if (payload.action === 'reset_imports') {
      const deleted = new AgentHistoryDeleteService(historyDatabase, search).resetImportedHistory();
      const imported = payload.reimport === false ? null : await imports.importWithParser(input, localParseFile(discovery), reportProgress);
      return { ...deleted, import: imported };
    }
    if (payload.action === 'import') {
      return await imports.importWithParser(input, localParseFile(discovery), reportProgress);
    }
    if (payload.action === 'delete_conversation') {
      if (!payload.conversation_id) throw new Error('history delete is missing conversation_id');
      return new AgentHistoryDeleteService(historyDatabase, search).deleteConversation(payload.conversation_id);
    }
    throw new Error('unknown history worker action');
  } finally {
    historyDatabase.dispose();
    appDatabase.dispose();
  }
}

function localParseFile(discovery: ProviderHistoryDiscoveryService): HistoryFileParser {
  return async (input) => {
    const adapter = discovery.adapter(input.candidate.provider);
    return adapter.parseFileStream?.(input.filePath, input.options) ?? adapter.parseFile(input.filePath, input.options);
  };
}

function resultMessage(result: WorkerResult): WorkerResult & { type: 'result' } {
  return { type: 'result', ...result };
}

function waitForAck(parentPort: ParentPort): void {
  const timer = setTimeout(() => process.exit(0), 5_000);
  parentPort.on('message', (event) => {
    if (event.data && typeof event.data === 'object' && (event.data as { type?: unknown }).type === 'result_ack') {
      clearTimeout(timer);
      process.exit(0);
    }
  });
}

function copyLegacyHistoryIfNeeded(appDatabase: DatabaseService, historyDatabase: HistoryDatabaseService): void {
  const historyCount = historyDatabase.connection.prepare(`select count(*) as count from conversations`).get() as { count: number };
  if (historyCount.count > 0) return;
  const legacy = appDatabase.connection.prepare(`select name from sqlite_master where type = 'table' and name = 'conversations'`).get();
  if (!legacy) return;
  const legacyCount = appDatabase.connection.prepare(`select count(*) as count from conversations`).get() as { count: number };
  if (legacyCount.count === 0) return;

  copyTable(appDatabase, historyDatabase, 'conversation_import_batches');
  copyTable(appDatabase, historyDatabase, 'conversation_import_files');
  copyTable(appDatabase, historyDatabase, 'conversation_import_watermarks');
  copyTable(appDatabase, historyDatabase, 'conversation_deletions');
  copyTable(appDatabase, historyDatabase, 'conversations');
  copyTable(appDatabase, historyDatabase, 'conversation_messages');
  new HistorySearchIndexService(historyDatabase).rebuildIndex();
}

function copyTable(appDatabase: DatabaseService, historyDatabase: HistoryDatabaseService, table: string): void {
  const exists = appDatabase.connection.prepare(`select name from sqlite_master where type = 'table' and name = ?`).get(table);
  if (!exists) return;
  const columns = (appDatabase.connection.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
  if (columns.length === 0) return;
  const placeholders = columns.map((column) => `@${column}`).join(', ');
  const insert = historyDatabase.connection.prepare(`insert or ignore into ${table} (${columns.join(', ')}) values (${placeholders})`);
  for (const row of appDatabase.connection.prepare(`select ${columns.join(', ')} from ${table}`).all() as Record<string, unknown>[]) {
    insert.run(row);
  }
}
