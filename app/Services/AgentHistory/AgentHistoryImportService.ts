import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentHistoryDb } from './AgentHistoryDb';
import type { HistorySearchIndexService } from './HistorySearchIndexService';
import type { TimelineService } from '../TimelineService';
import { ConversationLinker, type ConversationLink } from './ConversationLinker';
import { MESSAGE_TEXT_CAP, TOOL_INPUT_CAP, TOOL_OUTPUT_CAP, type AgentHistoryProvider, type HistoryFileFingerprint, type HistoryImportScope, type HistorySourceCandidate, type ParseHistoryFileOptions, type ParsedConversation, type ParsedHistoryStream, type ParsedMessage, type ProviderHistoryAdapter } from './AgentHistoryTypes';
import { defaultFileFingerprint, digestJson, stableJson, statDigest, statOnlyFingerprint } from './HistoryAdapterUtils';
import { ProviderHistoryDiscoveryService } from './ProviderHistoryDiscoveryService';
import { SecretRedactor } from './SecretRedactor';
import { AgentHistoryWatermarkService, type HistoryWatermarkPlan } from './AgentHistoryWatermarkService';
import { AgentHistorySourceService, historyConfigureInput } from './AgentHistorySourceService';

export { historyConfigureInput } from './AgentHistorySourceService';

const IMPORT_MESSAGE_CHUNK_SIZE = 500;

export const historyImportInput = z.object({
  provider: z.enum(['claude', 'codex', 'opencode', 'amp']).optional(),
  path: z.string().min(1).optional(),
  project_id: z.string().min(1).nullable().optional(),
  trigger: z.enum(['manual', 'startup', 'watcher', 'session_exit']).default('manual')
});

export interface HistoryImportProgress {
  batchId: string;
  currentFile: string | null;
  filesSeen: number;
  filesImported: number;
  conversationsImported: number;
  messagesImported: number;
  skippedCount: number;
  errorCount: number;
}

export type HistoryImportProgressReporter = (progress: HistoryImportProgress) => void;
export type HistoryFileParser = (input: { candidate: HistorySourceCandidate; filePath: string; parserVersion: string; options?: ParseHistoryFileOptions }) => Promise<ParsedHistoryStream>;

export class AgentHistoryImportService {
  private readonly linker: ConversationLinker;
  private readonly redactor = new SecretRedactor();
  private readonly watermarks: AgentHistoryWatermarkService;
  private resumeMarks: ResumeMark[] = [];
  private usageTables: boolean | null = null;

  constructor(
    private readonly database: AgentHistoryDb,
    private readonly discovery: ProviderHistoryDiscoveryService,
    private readonly timeline: TimelineService | null,
    private readonly search?: Pick<HistorySearchIndexService, 'indexConversation' | 'indexConversationAsync' | 'removeConversation'> & Partial<Pick<HistorySearchIndexService, 'indexConversationAppend'>>,
    private readonly appDatabase: AgentHistoryDb = database,
    private readonly sourcesService = new AgentHistorySourceService(appDatabase, discovery)
  ) {
    this.linker = new ConversationLinker(appDatabase);
    this.watermarks = new AgentHistoryWatermarkService(database, sourcesService);
  }

  sources() {
    return this.sourcesService.sources();
  }

  configure(raw: z.input<typeof historyConfigureInput>) {
    return this.sourcesService.configure(raw);
  }

  import(raw: z.input<typeof historyImportInput>, report?: HistoryImportProgressReporter) {
    const input = historyImportInput.parse(raw);
    const candidates = this.importCandidates(input);
    this.resumeMarks = [];
    const batchId = randomUUID();
    const startedAt = new Date().toISOString();
    this.database.connection.prepare(`insert into conversation_import_batches (id, trigger, provider, project_id, started_at, status) values (?, ?, ?, ?, ?, 'running')`).run(batchId, input.trigger, input.provider ?? null, input.project_id ?? null, startedAt);

    const totals = { filesSeen: 0, filesImported: 0, conversationsImported: 0, messagesImported: 0, skippedCount: 0, errorCount: 0, unstableFiles: 0 };
    let failed = false;
    reportProgress(report, batchId, totals, null);
    try {
      for (const candidate of candidates) {
        if (!candidate.exists) {
          totals.skippedCount += 1;
          reportProgress(report, batchId, totals, candidate.path);
          continue;
        }
        const adapter = this.discovery.adapter(candidate.provider);
        const discovered = adapter.discoverFiles(candidate.path);
        this.retireUndiscoveredFiles(candidate, discovered);
        const files = this.filterDiscoveredFiles(adapter, discovered, input.project_id ?? null);
        for (const filePath of files) {
          totals.filesSeen += 1;
          reportProgress(report, batchId, totals, filePath);
          try {
            const previousFile = this.importFileState(candidate.provider, filePath);
            if (this.quickUnchangedFingerprint(adapter, candidate, filePath, previousFile)) {
              totals.skippedCount += 1;
              reportProgress(report, batchId, totals, filePath);
              continue;
            }
            const beforeFingerprint = this.fingerprintFile(adapter, filePath);
            if (this.isUnchanged(previousFile, adapter.parserVersion, beforeFingerprint)) {
              if (adapter.quickFingerprintFile || previousFile?.source_id !== this.sourcesService.sourceId(candidate)) {
                this.upsertImportFile(candidate, batchId, filePath, adapter.parserVersion, beforeFingerprint, [], null, false);
              }
              totals.skippedCount += 1;
              reportProgress(report, batchId, totals, filePath);
              continue;
            }
            const recovering = previousFile ? !completedImportFileStatus(previousFile.status) : false;
            const parsed = adapter.parseFile(filePath);
            const afterFingerprint = this.fingerprintFile(adapter, filePath);
            const changedDuringImport = beforeFingerprint.digest !== afterFingerprint.digest;
            const parserChanged = previousFile?.parser_version !== parsed.parserVersion;
            if (changedDuringImport) totals.unstableFiles += 1;
            const warnings = changedDuringImport ? [...parsed.warnings, 'source changed during import; queued retry will re-read'] : [...parsed.warnings];
            const importFileId = this.upsertImportFile(candidate, batchId, filePath, parsed.parserVersion, beforeFingerprint, warnings, null, false, 'importing');
            let importedFromFile = false;
            let scopeRejected = false;
            for (const parsedConversation of parsed.conversations) {
              const conversation = withUniqueMessageIds(parsedConversation, warnings);
              if (this.isDeleted(conversation)) {
                totals.skippedCount += 1;
                continue;
              }
              const linkScope = this.linkScope(conversation, input);
              const link = this.linker.link(conversation, linkScope);
              if (!this.conversationMatchesProject(conversation, link, input.project_id ?? null)) {
                scopeRejected = true;
                totals.skippedCount += 1;
                continue;
              }
              if (!parserChanged && !recovering && this.isConversationUnchanged(conversation, link)) {
                // Usage can grow without a new message, for example a late token count.
                this.syncUsage(conversation);
                totals.skippedCount += 1;
                continue;
              }
              const result = this.upsertConversation(conversation, importFileId, linkScope, true, link);
              this.syncUsage(conversation);
              totals.conversationsImported += 1;
              totals.messagesImported += result.messages;
              importedFromFile = true;
            }
            this.finalizeImportFile(candidate.provider, filePath, warnings, parsed.conversations.length > 0, scopeRejected);
            if (importedFromFile) totals.filesImported += 1;
            if (parsed.conversations.length === 0) totals.skippedCount += 1;
            reportProgress(report, batchId, totals, filePath);
          } catch (error) {
            totals.errorCount += 1;
            try {
              const fingerprint = this.errorFingerprint(adapter, filePath);
              this.upsertImportFile(candidate, batchId, filePath, adapter.parserVersion, fingerprint, [], error instanceof Error ? error.message : String(error), false);
            } catch {
              // The source may have disappeared during import; keep the batch moving.
            }
            reportProgress(report, batchId, totals, filePath);
          }
        }
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const finishedAt = new Date().toISOString();
      const status = failed ? 'failed' : totals.errorCount > 0 ? 'completed_with_errors' : 'completed';
      this.database.connection.prepare(`
        update conversation_import_batches
        set finished_at = ?, status = ?, files_seen = ?, files_imported = ?, conversations_imported = ?, messages_imported = ?, skipped_count = ?, error_count = ?
        where id = ?
      `).run(finishedAt, status, totals.filesSeen, totals.filesImported, totals.conversationsImported, totals.messagesImported, totals.skippedCount, totals.errorCount, batchId);
      this.timeline?.append({ event_type: 'conversation_history.imported', project_id: input.project_id ?? null, actor_type: 'system', metadata: { batch_id: batchId, trigger: input.trigger, ...totals, status } });
      reportProgress(report, batchId, totals, null);
    }
    return { batch_id: batchId, status: totals.errorCount > 0 ? 'completed_with_errors' : 'completed', retrySuggested: totals.unstableFiles > 0, resumeMarks: this.resumeMarks, timelineEvent: { event_type: 'conversation_history.imported', project_id: input.project_id ?? null, actor_type: 'system', metadata: { batch_id: batchId, trigger: input.trigger, ...totals, status: totals.errorCount > 0 ? 'completed_with_errors' : 'completed' } }, ...totals };
  }

  async importWithParser(raw: z.input<typeof historyImportInput>, parseFile: HistoryFileParser, report?: HistoryImportProgressReporter) {
    const input = historyImportInput.parse(raw);
    const candidates = this.importCandidates(input);
    this.resumeMarks = [];
    const batchId = randomUUID();
    const startedAt = new Date().toISOString();
    this.database.connection.prepare(`insert into conversation_import_batches (id, trigger, provider, project_id, started_at, status) values (?, ?, ?, ?, ?, 'running')`).run(batchId, input.trigger, input.provider ?? null, input.project_id ?? null, startedAt);

    const totals = { filesSeen: 0, filesImported: 0, conversationsImported: 0, messagesImported: 0, skippedCount: 0, errorCount: 0, unstableFiles: 0 };
    let failed = false;
    reportProgress(report, batchId, totals, null);
    try {
      for (const candidate of candidates) {
        if (!candidate.exists) {
          totals.skippedCount += 1;
          reportProgress(report, batchId, totals, candidate.path);
          await yieldToMain();
          continue;
        }
        const adapter = this.discovery.adapter(candidate.provider);
        const watermarkPlan = this.watermarks.plan(candidate, adapter.parserVersion, input.trigger);
        const files = await this.importFilePlans(candidate, adapter, watermarkPlan, input.project_id ?? null);
        let sourceUnstable = false;
        let sourceHasUnrecordedError = false;
        let sourceWatermarkMs: number | null = null;
        for (const file of files) {
          let parseOptions: ParseHistoryFileOptions | undefined;
          const filePath = file.filePath;
          totals.filesSeen += 1;
          reportProgress(report, batchId, totals, filePath);
          try {
            const previousFile = this.importFileState(candidate.provider, filePath);
            const quickFingerprint = this.quickUnchangedFingerprint(adapter, candidate, filePath, previousFile);
            if (quickFingerprint) {
              sourceWatermarkMs = maxWatermark(sourceWatermarkMs, watermarkFromFingerprint(candidate, quickFingerprint));
              totals.skippedCount += 1;
              reportProgress(report, batchId, totals, filePath);
              await yieldToMain();
              continue;
            }
            const beforeFingerprint = this.fingerprintFile(adapter, filePath);
            sourceWatermarkMs = maxWatermark(sourceWatermarkMs, watermarkFromFingerprint(candidate, beforeFingerprint));
            if (this.isUnchanged(previousFile, adapter.parserVersion, beforeFingerprint)) {
              if (adapter.quickFingerprintFile || previousFile?.source_id !== this.sourcesService.sourceId(candidate)) {
                this.upsertImportFile(candidate, batchId, filePath, adapter.parserVersion, beforeFingerprint, [], null, false);
              }
              totals.skippedCount += 1;
              reportProgress(report, batchId, totals, filePath);
              await yieldToMain();
              continue;
            }
            const recovering = previousFile ? !completedImportFileStatus(previousFile.status) : false;
            if (file.incremental && adapter.changedProviderConversationIds) {
              const providerConversationIds = adapter.changedProviderConversationIds(storedFingerprintMetadata(previousFile), beforeFingerprint.metadata);
              if (providerConversationIds !== null && providerConversationIds !== undefined) parseOptions = { providerConversationIds };
            }
            const parsed = await parseFile(parseOptions ? { candidate, filePath, parserVersion: adapter.parserVersion, options: parseOptions } : { candidate, filePath, parserVersion: adapter.parserVersion });
            const parserChanged = previousFile?.parser_version !== parsed.parserVersion;
            const importFileId = this.upsertImportFile(candidate, batchId, filePath, parsed.parserVersion, beforeFingerprint, parsed.warnings, null, false, 'importing');
            let importedFromFile = false;
            let conversationCount = 0;
            let scopeRejected = false;
            const repeatWarnings: string[] = [];
            for (const parsedConversation of parsed.conversations) {
              const conversation = withUniqueMessageIds(parsedConversation, repeatWarnings);
              conversationCount += 1;
              if (candidate.provider === 'opencode') sourceWatermarkMs = maxWatermark(sourceWatermarkMs, millis(conversation.updatedAt));
              reportProgress(report, batchId, totals, filePath);
              await yieldToMain();
              if (this.isDeleted(conversation)) {
                totals.skippedCount += 1;
                continue;
              }
              const linkScope = this.linkScope(conversation, input);
              const link = this.linker.link(conversation, linkScope);
              if (!this.conversationMatchesProject(conversation, link, input.project_id ?? null)) {
                scopeRejected = true;
                totals.skippedCount += 1;
                continue;
              }
              if (!parserChanged && !recovering && this.isConversationUnchanged(conversation, link)) {
                this.syncUsage(conversation);
                totals.skippedCount += 1;
                continue;
              }
              const result = await this.upsertConversationChunked(conversation, importFileId, linkScope, true, link);
              this.syncUsage(conversation);
              totals.conversationsImported += 1;
              totals.messagesImported += result.messages;
              importedFromFile = true;
            }
            const afterFingerprint = this.fingerprintFile(adapter, filePath);
            const changedDuringImport = beforeFingerprint.digest !== afterFingerprint.digest;
            if (changedDuringImport) {
              totals.unstableFiles += 1;
              sourceUnstable = true;
            }
            const warnings = [...parsed.warnings, ...repeatWarnings, ...(changedDuringImport ? ['source changed during import; queued retry will re-read'] : [])];
            this.finalizeImportFile(candidate.provider, filePath, warnings, conversationCount > 0, scopeRejected);
            if (importedFromFile) totals.filesImported += 1;
            if (conversationCount === 0) totals.skippedCount += 1;
            reportProgress(report, batchId, totals, filePath);
          } catch (error) {
            totals.errorCount += 1;
            try {
              const fingerprint = this.errorFingerprint(adapter, filePath);
              this.upsertImportFile(candidate, batchId, filePath, adapter.parserVersion, fingerprint, [], error instanceof Error ? error.message : String(error), false);
            } catch {
              // The source may have disappeared during import; keep the batch
              // moving, but without an error row nothing would retry the file.
              sourceHasUnrecordedError = true;
            }
            reportProgress(report, batchId, totals, filePath);
          }
          await yieldToMain();
        }
        // Failed files with an error row stay in the watermark's force list until
        // they import, so they need not hold the watermark back.
        if (candidate.provider !== 'amp' && !sourceUnstable && !sourceHasUnrecordedError) {
          this.watermarks.advance({ candidate, sourceId: watermarkPlan.sourceId, parserVersion: adapter.parserVersion, kind: watermarkPlan.kind, valueMs: sourceWatermarkMs, batchId, metadata: { mode: watermarkPlan.mode } });
        }
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const finishedAt = new Date().toISOString();
      const status = failed ? 'failed' : totals.errorCount > 0 ? 'completed_with_errors' : 'completed';
      this.database.connection.prepare(`
        update conversation_import_batches
        set finished_at = ?, status = ?, files_seen = ?, files_imported = ?, conversations_imported = ?, messages_imported = ?, skipped_count = ?, error_count = ?
        where id = ?
      `).run(finishedAt, status, totals.filesSeen, totals.filesImported, totals.conversationsImported, totals.messagesImported, totals.skippedCount, totals.errorCount, batchId);
      this.timeline?.append({ event_type: 'conversation_history.imported', project_id: input.project_id ?? null, actor_type: 'system', metadata: { batch_id: batchId, trigger: input.trigger, ...totals, status } });
      reportProgress(report, batchId, totals, null);
    }
    return { batch_id: batchId, status: totals.errorCount > 0 ? 'completed_with_errors' : 'completed', retrySuggested: totals.unstableFiles > 0, resumeMarks: this.resumeMarks, timelineEvent: { event_type: 'conversation_history.imported', project_id: input.project_id ?? null, actor_type: 'system', metadata: { batch_id: batchId, trigger: input.trigger, ...totals, status: totals.errorCount > 0 ? 'completed_with_errors' : 'completed' } }, ...totals };
  }

  enabledWatchSources(): HistorySourceCandidate[] {
    return this.sourcesService.enabledWatchSources();
  }

  private importCandidates(input: z.infer<typeof historyImportInput>): HistorySourceCandidate[] {
    return this.sourcesService.importCandidates({ ...(input.provider ? { provider: input.provider } : {}), ...(input.path ? { path: input.path } : {}) });
  }

  private async importFilePlans(candidate: HistorySourceCandidate, adapter: ProviderHistoryAdapter, watermarkPlan: HistoryWatermarkPlan, projectId: string | null): Promise<ImportFilePlan[]> {
    let plans: ImportFilePlan[];
    if (watermarkPlan.mode === 'incremental' && watermarkPlan.sinceMs !== null) {
      const sinceMs = watermarkPlan.sinceMs;
      if (candidate.provider === 'opencode') {
        const files = await this.discoverFiles(adapter, candidate.path);
        const forced = new Set(watermarkPlan.forcePaths);
        plans = files.map((filePath) => ({ filePath, incremental: !forced.has(filePath) }));
        return this.filterImportPlans(adapter, plans, projectId);
      }
      if (adapter.discoverFilesSince) {
        plans = adapter.discoverFilesSince(candidate.path, sinceMs, watermarkPlan.forcePaths).map((filePath) => ({ filePath }));
        return this.filterImportPlans(adapter, plans, projectId);
      }
    }
    const discovered = await this.discoverFiles(adapter, candidate.path);
    this.retireUndiscoveredFiles(candidate, discovered);
    plans = discovered.map((filePath) => ({ filePath }));
    return this.filterImportPlans(adapter, plans, projectId);
  }

  // A full scan that no longer finds a file, such as a deleted transcript or a
  // Claude subagent file now read with its parent, retires its row. Otherwise
  // its old parser version would make every later scan full.
  private retireUndiscoveredFiles(candidate: HistorySourceCandidate, discovered: string[]): void {
    const prefix = candidate.path.endsWith(path.sep) ? candidate.path : `${candidate.path}${path.sep}`;
    const found = new Set(discovered);
    const rows = this.database.connection.prepare(`select id, path from conversation_import_files where provider = ? and status != 'retired'`).all(candidate.provider) as Array<{ id: string; path: string }>;
    const retired = rows.filter((row) => row.path.startsWith(prefix) && !found.has(row.path));
    if (!retired.length) return;
    const retire = this.database.connection.prepare(`update conversation_import_files set status = 'retired' where id = ?`);
    this.database.connection.transaction(() => {
      for (const row of retired) retire.run(row.id);
    })();
  }

  private discoverFiles(adapter: ProviderHistoryAdapter, sourcePath: string): Promise<string[]> {
    return adapter.discoverFilesAsync?.(sourcePath) ?? Promise.resolve(adapter.discoverFiles(sourcePath));
  }

  private filterImportPlans(adapter: ProviderHistoryAdapter, plans: ImportFilePlan[], projectId: string | null): ImportFilePlan[] {
    const allowed = new Set(this.filterDiscoveredFiles(adapter, plans.map((plan) => plan.filePath), projectId));
    return plans.filter((plan) => allowed.has(plan.filePath));
  }

  private filterDiscoveredFiles(adapter: ProviderHistoryAdapter, files: string[], projectId: string | null): string[] {
    return adapter.filterDiscoveredFiles?.(files, this.historyImportScope(projectId)) ?? files;
  }

  private historyImportScope(projectId: string | null): HistoryImportScope {
    const projectWhere = projectId ? 'where id = @project_id' : '';
    const worktreeWhere = projectId ? 'where project_id = @project_id' : '';
    const params = projectId ? { project_id: projectId } : {};
    const projects = this.appDatabase.connection.prepare(`select path from projects ${projectWhere}`).all(params) as Array<{ path: string }>;
    const worktrees = this.appDatabase.connection.prepare(`select worktree_path from worktrees ${worktreeWhere}`).all(params) as Array<{ worktree_path: string }>;
    const sessions = this.appDatabase.connection.prepare(`select resume_id, project_id from sessions where harness = 'amp' and resume_id is not null`).all() as Array<{ resume_id: string; project_id: string }>;
    return {
      projectPaths: [...projects.map((row) => row.path), ...worktrees.map((row) => row.worktree_path)],
      providerConversationIds: sessions.filter((row) => projectId === null || row.project_id === projectId).map((row) => row.resume_id),
      excludedProviderConversationIds: projectId === null ? [] : sessions.filter((row) => row.project_id !== projectId).map((row) => row.resume_id)
    };
  }

  // Only an explicit file import assigns its conversations to the requested
  // project. A project-scoped source scan still reads every file, so it links
  // by resume ID and path like any other scan; otherwise every unmatched
  // conversation would land in whichever project asked.
  private linkScope(conversation: ParsedConversation, input: z.infer<typeof historyImportInput>): { project_id: string | null } {
    if (conversation.provider === 'amp' || !input.path) return { project_id: null };
    return { project_id: input.project_id ?? null };
  }

  private conversationMatchesProject(conversation: ParsedConversation, link: ConversationLink, projectId: string | null): boolean {
    return conversation.provider !== 'amp' || projectId === null || link.project_id === projectId;
  }

  private errorFingerprint(adapter: ProviderHistoryAdapter, filePath: string): HistoryFileFingerprint {
    try {
      return this.fingerprintFile(adapter, filePath);
    } catch {
      // Stat only: an unreadable file must still get an error row to be retried.
      return fs.existsSync(filePath) ? statOnlyFingerprint([filePath]) : missingFingerprint(filePath);
    }
  }

  private upsertImportFile(candidate: HistorySourceCandidate, batchId: string, filePath: string, parserVersion: string, fingerprint: HistoryFileFingerprint, warnings: string[], error: string | null, imported: boolean, statusOverride?: string): string {
    const now = new Date().toISOString();
    const id = randomUUID();
    const status = statusOverride ?? (error ? 'error' : imported ? (warnings.length ? 'imported_with_warnings' : 'imported') : 'skipped');
    const sourceId = this.sourcesService.sourceId(candidate);
    this.database.connection.prepare(`
      insert into conversation_import_files (id, source_id, batch_id, provider, path, source_kind, size_bytes, mtime_ms, content_hash, parser_version, status, warning, error, last_imported_at, metadata)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(provider, path) do update set source_id = excluded.source_id, batch_id = excluded.batch_id, source_kind = excluded.source_kind,
        size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms, content_hash = excluded.content_hash, parser_version = excluded.parser_version,
        status = excluded.status, warning = excluded.warning, error = excluded.error, last_imported_at = excluded.last_imported_at, metadata = excluded.metadata
    `).run(id, sourceId, batchId, candidate.provider, filePath, candidate.sourceKind, fingerprint.sizeBytes, fingerprint.mtimeMs, fingerprint.digest, parserVersion, status, warnings.join('\n') || null, error, now, stableJson({ fingerprint: fingerprint.metadata }));
    const row = this.database.connection.prepare(`select id from conversation_import_files where provider = ? and path = ?`).get(candidate.provider, filePath) as { id: string };
    return row.id;
  }

  private finalizeImportFile(provider: AgentHistoryProvider, filePath: string, warnings: string[], imported: boolean, scopeRejected = false): void {
    const status = scopeRejected ? 'scope_mismatch' : imported ? (warnings.length ? 'imported_with_warnings' : 'imported') : 'skipped';
    this.database.connection.prepare(`
      update conversation_import_files
      set status = ?, warning = ?, error = null, last_imported_at = ?
      where provider = ? and path = ?
    `).run(status, warnings.join('\n') || null, new Date().toISOString(), provider, filePath);
  }

  private importFileState(provider: AgentHistoryProvider, filePath: string): ImportFileState | undefined {
    return this.database.connection.prepare(`select id, source_id, size_bytes, mtime_ms, content_hash, parser_version, status, metadata from conversation_import_files where provider = ? and path = ?`).get(provider, filePath) as ImportFileState | undefined;
  }

  private isUnchanged(row: ImportFileState | undefined, parserVersion: string, fingerprint: HistoryFileFingerprint): boolean {
    if (!row || !completedImportFileStatus(row.status)) return false;
    if (row.parser_version !== parserVersion) return false;
    if (row.content_hash) return row.content_hash === fingerprint.digest;
    return row.size_bytes === fingerprint.sizeBytes && row.mtime_ms === fingerprint.mtimeMs;
  }

  private isConversationUnchanged(conversation: ParsedConversation, link: ConversationLink): boolean {
    const row = this.database.connection.prepare(`
      select project_id, session_id, process_id, worktree_id, title, cwd, provider_version, updated_at, ended_at, status, link_confidence, link_reason, metadata,
        (select count(*) from conversation_messages where conversation_id = conversations.id) as message_count,
        (select max(seq) from conversation_messages where conversation_id = conversations.id) as max_seq
      from conversations
      where provider = ? and provider_conversation_id = ?
    `).get(conversation.provider, conversation.providerConversationId) as ConversationState | undefined;
    if (!row) return false;
    const metadataMatches = row.project_id === link.project_id &&
      row.session_id === link.session_id &&
      row.process_id === link.process_id &&
      row.worktree_id === link.worktree_id &&
      row.title === conversation.title &&
      row.cwd === conversation.cwd &&
      row.provider_version === conversation.providerVersion &&
      row.updated_at === conversation.updatedAt &&
      row.ended_at === conversation.endedAt &&
      row.status === conversation.status &&
      row.link_confidence === link.link_confidence &&
      row.link_reason === link.link_reason &&
      row.metadata === stableJson(conversation.metadata) &&
      row.message_count === conversation.messages.length &&
      row.max_seq === conversation.messages.length - 1;
    if (!metadataMatches) return false;
    return this.storedMessagesDigest(conversation.provider, conversation.providerConversationId) === this.parsedStoredMessagesDigest(conversation.messages);
  }

  private fingerprintFile(adapter: ProviderHistoryAdapter, filePath: string): HistoryFileFingerprint {
    return adapter.fingerprintFile?.(filePath) ?? defaultFileFingerprint(filePath);
  }

  // Returns the stat-only fingerprint of a file that can be skipped unread. A
  // row from another source falls through so the full path adopts it.
  private quickUnchangedFingerprint(adapter: ProviderHistoryAdapter, candidate: HistorySourceCandidate, filePath: string, row: ImportFileState | undefined): HistoryFileFingerprint | null {
    if (!adapter.quickFingerprintFile || !row || !completedImportFileStatus(row.status) || row.parser_version !== adapter.parserVersion) return null;
    if (row.source_id !== this.sourcesService.sourceId(candidate)) return null;
    const stored = storedFingerprintMetadata(row);
    const expected = stored?.physicalDigest ?? statDigest(stored?.files);
    const quick = adapter.quickFingerprintFile(filePath);
    return typeof expected === 'string' && expected === quick.digest ? quick : null;
  }

  private upsertConversation(conversation: ParsedConversation, sourceFileId: string, scope: { project_id: string | null }, index = true, resolvedLink?: ConversationLink): { id: string; messages: number } {
    const link = resolvedLink ?? this.linker.link(conversation, scope);
    const now = new Date().toISOString();
    const existing = this.database.connection.prepare(`select id from conversations where provider = ? and provider_conversation_id = ?`).get(conversation.provider, conversation.providerConversationId) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();

    this.search?.removeConversation(id);
    // Write the row with its messages so a failed insert cannot leave the
    // conversation looking freshly imported over stale messages.
    const messages = this.database.connection.transaction(() => {
      this.writeConversationRow(id, conversation, link, sourceFileId, now);
      this.database.connection.prepare(`delete from conversation_messages where conversation_id = ?`).run(id);
      const insert = this.database.connection.prepare(`
        insert into conversation_messages (id, conversation_id, provider_message_id, parent_provider_message_id, turn_id, seq, role, kind, text, tool_name, tool_status, tool_input_summary, tool_output_summary, redaction_count, token_count, provider_created_at, metadata, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let count = 0;
      for (const message of conversation.messages) {
        const redacted = this.redactMessage(message);
        insert.run(randomUUID(), id, message.providerMessageId, message.parentProviderMessageId, message.turnId, message.seq, message.role, message.kind, redacted.text, message.toolName, message.toolStatus, redacted.toolInputSummary, redacted.toolOutputSummary, redacted.redactionCount, message.tokenCount, message.providerCreatedAt, stableJson(message.metadata), now);
        count += 1;
      }
      return count;
    })();
    this.markResumeImported(link.session_id, conversation.providerConversationId);
    if (index) this.search?.indexConversation(id);
    return { id, messages };
  }

  private async upsertConversationChunked(conversation: ParsedConversation, sourceFileId: string, scope: { project_id: string | null }, index = true, resolvedLink?: ConversationLink): Promise<{ id: string; messages: number }> {
    const link = resolvedLink ?? this.linker.link(conversation, scope);
    const now = new Date().toISOString();
    const existing = this.database.connection.prepare(`select id from conversations where provider = ? and provider_conversation_id = ?`).get(conversation.provider, conversation.providerConversationId) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    // Messages reference the row, so a new conversation needs it first. An
    // existing row is only refreshed once its messages are stored, so a failed
    // import cannot make stale messages look current.
    if (!existing) this.writeConversationRow(id, conversation, link, sourceFileId, now);
    let stored: { messages: number; appendedFrom: number | null };
    try {
      stored = await this.storeConversationMessagesChunked(id, Boolean(existing), conversation, now);
    } catch (error) {
      if (!existing) this.database.connection.prepare(`delete from conversations where id = ?`).run(id);
      throw error;
    }
    if (existing) this.writeConversationRow(id, conversation, link, sourceFileId, now);
    this.markResumeImported(link.session_id, conversation.providerConversationId);
    // The search index reads the row's title and project, so index after it is written.
    if (index) {
      if (stored.appendedFrom !== null && this.search?.indexConversationAppend) {
        await this.search.indexConversationAppend(id, stored.appendedFrom, conversation.messages.length);
      } else {
        await this.search?.indexConversationAsync(id);
      }
    }
    return { id, messages: stored.messages };
  }

  private writeConversationRow(id: string, conversation: ParsedConversation, link: ConversationLink, sourceFileId: string, now: string): void {
    this.database.connection.prepare(`
      insert into conversations (id, provider, provider_conversation_id, project_id, session_id, process_id, worktree_id, source_file_id, title, cwd, provider_version, started_at, updated_at, ended_at, status, link_confidence, link_reason, metadata, created_at, imported_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set project_id = excluded.project_id, session_id = excluded.session_id, process_id = excluded.process_id,
        worktree_id = excluded.worktree_id, source_file_id = excluded.source_file_id, title = excluded.title, cwd = excluded.cwd, provider_version = excluded.provider_version,
        started_at = excluded.started_at, updated_at = excluded.updated_at, ended_at = excluded.ended_at, status = excluded.status, link_confidence = excluded.link_confidence,
        link_reason = excluded.link_reason, metadata = excluded.metadata, imported_at = excluded.imported_at
    `).run(id, conversation.provider, conversation.providerConversationId, link.project_id, link.session_id, link.process_id, link.worktree_id, sourceFileId, conversation.title, conversation.cwd, conversation.providerVersion, conversation.startedAt, conversation.updatedAt, conversation.endedAt, conversation.status, link.link_confidence, link.link_reason, stableJson(conversation.metadata), now, now);
  }

  private async storeConversationMessagesChunked(id: string, existing: boolean, conversation: ParsedConversation, now: string): Promise<{ messages: number; appendedFrom: number | null }> {
    if (existing) {
      const appended = await this.tryAppendConversationMessages(id, conversation, now);
      if (appended) return appended;
    }

    const rows: ConversationMessageImportRow[] = [];
    for (const message of conversation.messages) {
      const redacted = this.redactMessage(message);
      rows.push({
        id: randomUUID(),
        conversationId: id,
        providerMessageId: message.providerMessageId,
        parentProviderMessageId: message.parentProviderMessageId,
        turnId: message.turnId,
        seq: message.seq,
        role: message.role,
        kind: message.kind,
        text: redacted.text,
        toolName: message.toolName,
        toolStatus: message.toolStatus,
        toolInputSummary: redacted.toolInputSummary,
        toolOutputSummary: redacted.toolOutputSummary,
        redactionCount: redacted.redactionCount,
        tokenCount: message.tokenCount,
        providerCreatedAt: message.providerCreatedAt,
        metadata: stableJson(message.metadata),
        createdAt: now
      });
      if (rows.length % IMPORT_MESSAGE_CHUNK_SIZE === 0) await yieldToMain();
    }

    this.search?.removeConversation(id);
    await this.replaceConversationMessagesChunked(id, rows);
    return { messages: rows.length, appendedFrom: null };
  }

  private async tryAppendConversationMessages(conversationId: string, conversation: ParsedConversation, now: string): Promise<{ messages: number; appendedFrom: number } | null> {
    const state = this.database.connection.prepare(`select count(*) as count, max(seq) as max_seq from conversation_messages where conversation_id = ?`).get(conversationId) as { count: number; max_seq: number | null };
    if (state.count === 0 || state.max_seq !== state.count - 1 || conversation.messages.length <= state.count) return null;
    const prefix = conversation.messages.slice(0, state.count);
    if (this.storedMessagesDigest(conversation.provider, conversation.providerConversationId, state.count) !== this.parsedStoredMessagesDigest(prefix)) return null;
    const rows = conversation.messages.slice(state.count).map((message) => {
      const redacted = this.redactMessage(message);
      return {
        id: randomUUID(),
        conversationId,
        providerMessageId: message.providerMessageId,
        parentProviderMessageId: message.parentProviderMessageId,
        turnId: message.turnId,
        seq: message.seq,
        role: message.role,
        kind: message.kind,
        text: redacted.text,
        toolName: message.toolName,
        toolStatus: message.toolStatus,
        toolInputSummary: redacted.toolInputSummary,
        toolOutputSummary: redacted.toolOutputSummary,
        redactionCount: redacted.redactionCount,
        tokenCount: message.tokenCount,
        providerCreatedAt: message.providerCreatedAt,
        metadata: stableJson(message.metadata),
        createdAt: now
      } satisfies ConversationMessageImportRow;
    });
    const insert = this.database.connection.prepare(`
      insert into conversation_messages (id, conversation_id, provider_message_id, parent_provider_message_id, turn_id, seq, role, kind, text, tool_name, tool_status, tool_input_summary, tool_output_summary, redaction_count, token_count, provider_created_at, metadata, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let start = 0; start < rows.length; start += IMPORT_MESSAGE_CHUNK_SIZE) {
      const chunk = rows.slice(start, start + IMPORT_MESSAGE_CHUNK_SIZE);
      this.database.connection.transaction(() => {
        for (const row of chunk) {
          insert.run(row.id, row.conversationId, row.providerMessageId, row.parentProviderMessageId, row.turnId, row.seq, row.role, row.kind, row.text, row.toolName, row.toolStatus, row.toolInputSummary, row.toolOutputSummary, row.redactionCount, row.tokenCount, row.providerCreatedAt, row.metadata, row.createdAt);
        }
      })();
      await yieldToMain();
    }
    return { messages: rows.length, appendedFrom: state.count };
  }

  private async replaceConversationMessagesChunked(conversationId: string, rows: ConversationMessageImportRow[]): Promise<void> {
    const db = this.database.connection;
    db.exec(`
      create temp table if not exists conversation_message_import_stage (
        import_token text not null,
        id text not null,
        conversation_id text not null,
        provider_message_id text,
        parent_provider_message_id text,
        turn_id text,
        seq integer not null,
        role text not null,
        kind text not null,
        text text not null,
        tool_name text,
        tool_status text,
        tool_input_summary text,
        tool_output_summary text,
        redaction_count integer not null,
        token_count integer,
        provider_created_at text,
        metadata text not null,
        created_at text not null
      )
    `);

    const token = randomUUID();
    const insertStage = db.prepare(`
      insert into conversation_message_import_stage (import_token, id, conversation_id, provider_message_id, parent_provider_message_id, turn_id, seq, role, kind, text, tool_name, tool_status, tool_input_summary, tool_output_summary, redaction_count, token_count, provider_created_at, metadata, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const clearStage = db.prepare(`delete from conversation_message_import_stage where import_token = ?`);

    try {
      for (let start = 0; start < rows.length; start += IMPORT_MESSAGE_CHUNK_SIZE) {
        const chunk = rows.slice(start, start + IMPORT_MESSAGE_CHUNK_SIZE);
        db.transaction(() => {
          for (const row of chunk) {
            insertStage.run(token, row.id, row.conversationId, row.providerMessageId, row.parentProviderMessageId, row.turnId, row.seq, row.role, row.kind, row.text, row.toolName, row.toolStatus, row.toolInputSummary, row.toolOutputSummary, row.redactionCount, row.tokenCount, row.providerCreatedAt, row.metadata, row.createdAt);
          }
        })();
        await yieldToMain();
      }

      db.transaction(() => {
        db.prepare(`delete from conversation_messages where conversation_id = ?`).run(conversationId);
        db.prepare(`
          insert into conversation_messages (id, conversation_id, provider_message_id, parent_provider_message_id, turn_id, seq, role, kind, text, tool_name, tool_status, tool_input_summary, tool_output_summary, redaction_count, token_count, provider_created_at, metadata, created_at)
          select id, conversation_id, provider_message_id, parent_provider_message_id, turn_id, seq, role, kind, text, tool_name, tool_status, tool_input_summary, tool_output_summary, redaction_count, token_count, provider_created_at, metadata, created_at
          from conversation_message_import_stage
          where import_token = ?
          order by seq
        `).run(token);
        clearStage.run(token);
      })();
    } finally {
      clearStage.run(token);
    }
  }

  // Replaces the conversation's usage and skill rows when they differ, and
  // keeps the newest observation of each quota window.
  private syncUsage(conversation: ParsedConversation): void {
    const db = this.database.connection;
    // Only history.db has usage tables; app.db keeps legacy history without them.
    this.usageTables ??= (db.prepare(`select count(*) as count from sqlite_master where type = 'table' and name in ('conversation_usage', 'provider_rate_limits', 'conversation_skill_uses')`).get() as { count: number }).count === 3;
    if (!this.usageTables) return;
    const row = db.prepare(`select id from conversations where provider = ? and provider_conversation_id = ?`).get(conversation.provider, conversation.providerConversationId) as { id: string } | undefined;
    if (!row) return;
    const usage = conversation.usage ?? [];
    // Compare every stored field: a reclassified cache write or a corrected
    // model changes cost without changing counts or totals.
    const stored = db.prepare(`
      select model, occurred_at, input_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, output_tokens, reasoning_tokens, cost_usd, subagent
      from conversation_usage where conversation_id = ? order by id
    `).all(row.id) as Array<Record<string, unknown>>;
    const parsed = usage.map((entry) => [entry.model, entry.occurredAt, entry.inputTokens, entry.cacheReadTokens, entry.cacheWriteTokens, entry.cacheWrite1hTokens, entry.outputTokens, entry.reasoningTokens, entry.costUsd, entry.subagent ? 1 : 0]);
    const unchanged = stableJson(stored.map((item) => Object.values(item))) === stableJson(parsed);
    const skills = conversation.skills ?? [];
    const storedSkills = db.prepare(`select skill, invoked_by, occurred_at, subagent from conversation_skill_uses where conversation_id = ? order by id`).all(row.id) as Array<Record<string, unknown>>;
    const parsedSkills = skills.map((entry) => [entry.name, entry.invokedBy, entry.occurredAt, entry.subagent ? 1 : 0]);
    const skillsUnchanged = stableJson(storedSkills.map((item) => Object.values(item))) === stableJson(parsedSkills);
    db.transaction(() => {
      if (!unchanged) {
        db.prepare(`delete from conversation_usage where conversation_id = ?`).run(row.id);
        const insert = db.prepare(`
          insert into conversation_usage (conversation_id, provider, model, occurred_at, input_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, output_tokens, reasoning_tokens, cost_usd, subagent)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const entry of usage) {
          insert.run(row.id, conversation.provider, entry.model, entry.occurredAt, entry.inputTokens, entry.cacheReadTokens, entry.cacheWriteTokens, entry.cacheWrite1hTokens, entry.outputTokens, entry.reasoningTokens, entry.costUsd, entry.subagent ? 1 : 0);
        }
      }
      if (!skillsUnchanged) {
        db.prepare(`delete from conversation_skill_uses where conversation_id = ?`).run(row.id);
        const insert = db.prepare(`insert into conversation_skill_uses (conversation_id, provider, skill, invoked_by, occurred_at, subagent) values (?, ?, ?, ?, ?, ?)`);
        for (const entry of skills) insert.run(row.id, conversation.provider, entry.name, entry.invokedBy, entry.occurredAt, entry.subagent ? 1 : 0);
      }
      const limit = db.prepare(`
        insert into provider_rate_limits (provider, limit_key, label, used_percent, window_minutes, resets_at, observed_at)
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict(provider, limit_key) do update set label = excluded.label, used_percent = excluded.used_percent,
          window_minutes = excluded.window_minutes, resets_at = excluded.resets_at, observed_at = excluded.observed_at
        where excluded.observed_at > provider_rate_limits.observed_at
      `);
      for (const entry of conversation.rateLimits ?? []) {
        limit.run(conversation.provider, entry.key, entry.label, entry.usedPercent, entry.windowMinutes, entry.resetsAt, entry.observedAt);
      }
    })();
  }

  private isDeleted(conversation: ParsedConversation): boolean {
    const row = this.database.connection.prepare(`select id from conversation_deletions where provider = ? and provider_conversation_id = ?`).get(conversation.provider, conversation.providerConversationId);
    return Boolean(row);
  }

  private markResumeImported(sessionId: string | null, resumeId: string | null): void {
    if (!sessionId || !resumeId) return;
    if (!this.resumeMarks.some((mark) => mark.session_id === sessionId && mark.resume_id === resumeId)) {
      this.resumeMarks.push({ session_id: sessionId, resume_id: resumeId });
    }
  }

  private storedMessagesDigest(provider: AgentHistoryProvider, providerConversationId: string, limit?: number): string {
    const suffix = limit === undefined ? '' : 'limit @limit';
    const params: Record<string, unknown> = { provider, provider_conversation_id: providerConversationId };
    if (limit !== undefined) params.limit = limit;
    const rows = this.database.connection.prepare(`
      select conversation_messages.provider_message_id, conversation_messages.parent_provider_message_id, conversation_messages.turn_id,
        conversation_messages.seq, conversation_messages.role, conversation_messages.kind, conversation_messages.text,
        conversation_messages.tool_name, conversation_messages.tool_status, conversation_messages.tool_input_summary,
        conversation_messages.tool_output_summary, conversation_messages.token_count, conversation_messages.provider_created_at, conversation_messages.metadata
      from conversation_messages
      join conversations on conversations.id = conversation_messages.conversation_id
      where conversations.provider = @provider and conversations.provider_conversation_id = @provider_conversation_id
      order by conversation_messages.seq asc
      ${suffix}
    `).all(params) as StoredMessageDigestRow[];
    return digestJson(rows);
  }

  private parsedStoredMessagesDigest(messages: ParsedMessage[]): string {
    return digestJson(messages.map((message) => {
      const redacted = this.redactMessage(message);
      return {
        provider_message_id: message.providerMessageId,
        parent_provider_message_id: message.parentProviderMessageId,
        turn_id: message.turnId,
        seq: message.seq,
        role: message.role,
        kind: message.kind,
        text: redacted.text,
        tool_name: message.toolName,
        tool_status: message.toolStatus,
        tool_input_summary: redacted.toolInputSummary,
        tool_output_summary: redacted.toolOutputSummary,
        token_count: message.tokenCount,
        provider_created_at: message.providerCreatedAt,
        metadata: stableJson(message.metadata)
      };
    }));
  }

  private redactMessage(message: ParsedMessage) {
    const text = this.redactor.redactAndCap(message.text, MESSAGE_TEXT_CAP);
    const toolInput = this.redactor.redactAndCap(message.toolInputSummary, TOOL_INPUT_CAP);
    const toolOutput = this.redactor.redactAndCap(message.toolOutputSummary, TOOL_OUTPUT_CAP);
    return { text: text.text, toolInputSummary: toolInput.text || null, toolOutputSummary: toolOutput.text || null, redactionCount: text.redactionCount + toolInput.redactionCount + toolOutput.redactionCount };
  }
}

interface ImportTotals { filesSeen: number; filesImported: number; conversationsImported: number; messagesImported: number; skippedCount: number; errorCount: number; }
interface ImportFileState { id: string; source_id: string | null; size_bytes: number | null; mtime_ms: number | null; content_hash: string | null; parser_version: string | null; status: string; metadata: string; }
interface ConversationState { project_id: string | null; session_id: string | null; process_id: string | null; worktree_id: string | null; title: string | null; cwd: string | null; provider_version: string | null; updated_at: string | null; ended_at: string | null; status: string; link_confidence: number | null; link_reason: string | null; metadata: string; message_count: number; max_seq: number | null; }
interface ResumeMark { session_id: string; resume_id: string; }
interface StoredMessageDigestRow { provider_message_id: string | null; parent_provider_message_id: string | null; turn_id: string | null; seq: number; role: string; kind: string; text: string; tool_name: string | null; tool_status: string | null; tool_input_summary: string | null; tool_output_summary: string | null; token_count: number | null; provider_created_at: string | null; metadata: string; }
interface ConversationMessageImportRow { id: string; conversationId: string; providerMessageId: string | null; parentProviderMessageId: string | null; turnId: string | null; seq: number; role: ParsedMessage['role']; kind: ParsedMessage['kind']; text: string; toolName: string | null; toolStatus: string | null; toolInputSummary: string | null; toolOutputSummary: string | null; redactionCount: number; tokenCount: number | null; providerCreatedAt: string | null; metadata: string; createdAt: string; }
interface ImportFilePlan { filePath: string; incremental?: boolean; }

function reportProgress(reporter: HistoryImportProgressReporter | undefined, batchId: string, totals: ImportTotals, currentFile: string | null): void {
  try {
    reporter?.({
      batchId,
      currentFile,
      filesSeen: totals.filesSeen,
      filesImported: totals.filesImported,
      conversationsImported: totals.conversationsImported,
      messagesImported: totals.messagesImported,
      skippedCount: totals.skippedCount,
      errorCount: totals.errorCount
    });
  } catch {
    // Progress is best-effort; the import result is the source of truth.
  }
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function openCodeWatermark(fingerprint: HistoryFileFingerprint): number | null {
  const metadata = fingerprint.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as { historyMaxUpdated?: unknown }).historyMaxUpdated;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function watermarkFromFingerprint(candidate: HistorySourceCandidate, fingerprint: HistoryFileFingerprint): number | null {
  if (candidate.provider === 'opencode') return openCodeWatermark(fingerprint);
  return fingerprint.mtimeMs;
}

function maxWatermark(current: number | null, next: number | null): number | null {
  if (next === null || !Number.isFinite(next)) return current;
  return current === null || next > current ? next : current;
}


function millis(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function missingFingerprint(filePath: string): HistoryFileFingerprint {
  return { sizeBytes: null, mtimeMs: null, contentHash: null, digest: 'missing', metadata: { files: [{ path: filePath, exists: false, sizeBytes: null, mtimeMs: null, contentHash: null }] } };
}

// A repeated provider message id would roll back the whole conversation on
// the unique index; keep the first copy and record a warning instead.
function withUniqueMessageIds(conversation: ParsedConversation, warnings: string[]): ParsedConversation {
  const seen = new Set<string>();
  const messages = conversation.messages.filter((message) => {
    if (message.providerMessageId === null) return true;
    if (seen.has(message.providerMessageId)) return false;
    seen.add(message.providerMessageId);
    return true;
  });
  const dropped = conversation.messages.length - messages.length;
  if (!dropped) return conversation;
  warnings.push(`skipped ${dropped} repeated ${conversation.provider} ${dropped === 1 ? 'message' : 'messages'}`);
  return { ...conversation, messages: messages.map((message, seq) => ({ ...message, seq })) };
}

function completedImportFileStatus(status: string): boolean {
  return status === 'imported' || status === 'imported_with_warnings' || status === 'skipped';
}

function storedFingerprintMetadata(row: ImportFileState | undefined): Record<string, unknown> | null {
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.metadata) as { fingerprint?: unknown };
    return parsed.fingerprint && typeof parsed.fingerprint === 'object' ? parsed.fingerprint as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
