import { awaitingUser } from './Activity';
import { stripVTControlCharacters } from 'node:util';
import { SecretRedactor } from './AgentHistory/SecretRedactor';
import type { DatabaseService } from './DatabaseService';
import type { SettingsService } from './SettingsService';
import type { TerminalService } from './TerminalService';
import type { AutoSummaryRunner } from './AutoSummaryRunner';
import type { SqliteConnection } from '../Database/SqliteConnection';
import { headUtf8 } from './ConversationText';
import { proseText } from './AgentHistory/SummaryProseIndex';
import { AutoSummaryHistory, type SummaryThread } from './AutoSummaryHistory';
import { autoSummarySettingsInput, summaryMemory, summaryResult, type AutoSummarySettings, type SummaryContext } from './AutoSummarySettings';

interface PendingSummary {
  changed: number; attempted: number; retryAt: number; failures: number;
  controller: AbortController | null; sourceRevision: number | null; batchStarted: number | null; hash: string | null;
}

export function summarySnapshot(text: string): string {
  const clean = new SecretRedactor().redact(stripVTControlCharacters(text)).text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').split('\n').slice(-100).join('\n').trim();
  const points = Array.from(clean.slice(-12 * 1024));
  let bytes = 0;
  let start = points.length;
  while (start > 0 && bytes + Buffer.byteLength(points[start - 1]!) <= 12 * 1024) {
    bytes += Buffer.byteLength(points[--start]!);
  }
  return points.slice(start).join('').replace(/^[\udc00-\udfff]/, '');
}

// Titles and status lines fill one line of the tab and sidebar.
function oneLine(text: string | undefined): string | null {
  return text ? summarySnapshot(text).replace(/\s+/g, ' ').trim() || null : null;
}

export class AutoSummaryService {
  private readonly pending = new Map<string, PendingSummary>();
  private readonly jobs = new Map<AbortController, Promise<unknown>>();
  private readonly unsubscribers: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private error: string | null = null;
  private errorAt: string | null = null;
  private settings: AutoSummarySettings;

  constructor(private readonly database: DatabaseService, private readonly settingsService: SettingsService,
    private readonly terminal: Pick<TerminalService, 'request' | 'onFrame'>,
    private readonly runner: Pick<AutoSummaryRunner, 'run' | 'availability'>,
    private readonly notify: () => void, private readonly now: () => number = Date.now,
    private readonly history: { readonly connection: SqliteConnection; ensureAvailable?: () => boolean } | null = null) {
    this.settings = settingsService.autoSummarySettings();
  }

  start(): void {
    this.unsubscribers.push(this.terminal.onFrame((frame) => {
      if (frame.type !== 'terminal-lifecycle' || !frame.processId) return;
      if (frame.event === 'activity' && awaitingUser(frame.activity)) {
        const row = this.database.connection.prepare('select id from processes where pty_process_id = ?').get(frame.processId) as { id: string } | undefined;
        if (row) this.pending.get(row.id)?.controller?.abort();
      }
      // Exit does not discard enrollment: the final history import may arrive later.
    }));
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  userInput(key: string): void {
    if (!this.settings.enabled || this.disposed) return;
    const row = this.database.connection.prepare(`select id, kind from processes where (id = ? or pty_process_id = ?)
      and parent_process_id is null and status = 'running'`).get(key, key) as { id: string; kind: string } | undefined;
    if (!row) return;
    if (row.kind === 'agent') this.database.connection.prepare('insert or ignore into auto_summary_enrollments values (?)').run(row.id);
    this.ensurePending(row.id);
  }

  private ensurePending(id: string): PendingSummary {
    let pending = this.pending.get(id);
    if (!pending) {
      pending = { changed: this.now(), attempted: -Infinity, retryAt: 0, failures: 0, controller: null,
        sourceRevision: null, batchStarted: null, hash: null };
      this.pending.set(id, pending);
    }
    return pending;
  }

  status() {
    return { settings: this.settings, providers: ['claude', 'codex', 'opencode'].map((provider) => ({
      provider, ...this.runner.availability(provider as AutoSummarySettings['provider'])
    })), inFlight: this.jobs.size, lastError: this.error, lastErrorAt: this.errorAt };
  }

  update(raw: unknown): AutoSummarySettings {
    const settings = autoSummarySettingsInput.parse(raw);
    if (settings.enabled) {
      const available = this.runner.availability(settings.provider);
      if (!available.available) throw new Error(available.reason!);
    }
    this.settings = this.settingsService.updateAutoSummarySettings(settings);
    if (!settings.titles) this.database.connection.prepare('update sessions set auto_title = null where auto_title is not null').run();
    for (const controller of this.jobs.keys()) controller.abort();
    this.pending.clear(); this.error = null; this.errorAt = null;
    this.notify();
    return this.settings;
  }

  async test(raw: unknown): Promise<{ ok: true }> {
    if (this.disposed || this.jobs.size >= 2) throw new Error('Summarisers are busy. Try again shortly.');
    const settings = autoSummarySettingsInput.parse(raw), controller = new AbortController();
    const job = this.runner.run(settings, 'patterm okay', controller.signal, 'test');
    this.jobs.set(controller, job);
    try {
      const { summary } = await job;
      if (controller.signal.aborted) throw new Error('Summary cancelled.');
      if (summary.trim().toLowerCase() !== 'patterm okay') throw new Error('Summariser health check did not return the expected phrase.');
      return { ok: true };
    } finally { this.jobs.delete(controller); }
  }

  private threads(): SummaryThread[] {
    return this.database.connection.prepare(`select p.*, s.id as session_id, s.harness, s.resume_id, s.display_name, s.auto_title, s.last_title
      from auto_summary_enrollments e join processes p on p.id = e.process_id
      join sessions s on s.id = (select id from sessions where process_id = p.id order by started_at desc, rowid desc limit 1)
      where p.parent_process_id is null and p.kind = 'agent' and p.status != 'closed'
        and not exists (select 1 from sessions newer where s.resume_id is not null and newer.resume_id = s.resume_id
          and newer.project_id = s.project_id and newer.harness = s.harness
          and (newer.started_at > s.started_at or newer.started_at = s.started_at and newer.rowid > s.rowid))`).all() as SummaryThread[];
  }

  private reader(): AutoSummaryHistory | null {
    try {
      if (!this.history || this.history.ensureAvailable && !this.history.ensureAvailable()) return null;
      return new AutoSummaryHistory(this.database.connection, this.history.connection);
    }
    catch { return null; }
  }

  // Imported content, rather than terminal frames, drives automatic calls. A
  // periodic read is also a recovery path for imports completed while offline.
  historyChanged(): void { this.tick(); }

  tick(): void {
    if (this.disposed || !this.settings.enabled) return;
    const reader = this.reader();
    if (reader) {
      const threads = this.threads();
      for (const thread of threads) this.ensurePending(thread.id);
      threads.sort((a, b) => this.pending.get(a.id)!.attempted - this.pending.get(b.id)!.attempted);
      for (const thread of threads) {
        if (this.jobs.size >= 2) break;
        const pending = this.pending.get(thread.id)!;
        const now = this.now(), settings = this.settings;
        if (awaitingUser(thread.activity)) { pending.controller?.abort(); continue; }
        if (pending.controller || now < pending.retryAt || now - pending.attempted < settings.intervalSeconds * 1000) continue;
        try {
          const batch = reader.snapshot(() => {
            const source = reader.source(thread);
            if (!source) return null;
            const state = reader.state(thread, source);
            this.setCoverage(thread.id, reader.coverage(source, state));
            if (state.stale || state.paused || state.position >= source.message_count && state.byte_offset === 0) return null;
            pending.batchStarted ??= now;
            if (source.revision !== pending.sourceRevision) {
              pending.sourceRevision = source.revision; pending.changed = now;
            }
            if (now - pending.changed < 2000) return null;
            return reader.batch(source, state, this.context(thread));
          });
          if (!batch) continue;
          const source = batch.source;
          // Small changes during an active turn wait for a settled turn or a
          // minute of batching. Idle user corrections are never dropped.
          if (['working', 'thinking'].includes(thread.activity) && Buffer.byteLength(batch.text) < 2000 && now - (pending.batchStarted ?? now) < 60_000) continue;
          const controller = new AbortController();
          pending.controller = controller; pending.attempted = now; pending.batchStarted = null;
          const job = (async () => {
            try {
              const result = summaryResult.parse(await this.runner.run(settings, batch.text, controller.signal, 'summary', batch.context, thread.project_id));
              if (!result.memory) throw new Error('Summary returned no internal recap.');
              if (controller.signal.aborted || this.settings !== settings) return;
              const eligible = this.database.connection.prepare(`select 1 from processes p join sessions s on s.process_id = p.id
                where p.id = ? and p.project_id = ? and p.kind = 'agent' and p.parent_process_id is null
                  and p.status != 'closed' and p.activity not in ('permission', 'question') and s.id = ? and s.resume_id is ? and s.harness = ?
                  and s.id = (select id from sessions where process_id = p.id order by started_at desc, rowid desc limit 1)`).get(thread.id, thread.project_id, thread.session_id, thread.resume_id, thread.harness);
              if (!eligible) return;
              // An append or tool-only import need not waste a successful call.
              // Validate exactly the prefix consumed, including a split message.
              const consumed = { ...batch.state, position: batch.position, byte_offset: batch.byte_offset,
                prefix_hash: batch.prefix_hash, message_hash: batch.message_hash };
              const coverage = reader.snapshot(() => {
                const current = reader.source(thread);
                if (!current || current.native_id !== source.native_id || current.conversation_id !== source.conversation_id || !reader.valid(current, consumed)) return null;
                return reader.coverage(current, consumed);
              });
              if (coverage === null) return;
              this.setCoverage(thread.id, coverage);
              const memory = summaryMemory.parse(Object.fromEntries(Object.entries(result.memory).map(([key, value]) => [key, proseText(value)])));
              const at = new Date(this.now()).toISOString();
              const saved = this.database.connection.transaction(() => {
                if (!reader.save(batch, JSON.stringify(memory), at)) return false;
                // Historical batches update memory, but never replace a current
                // status with where the thread stood halfway through its history.
                if (coverage !== 'catching_up') {
                  this.database.connection.prepare(`update processes set auto_summary = ?, auto_status = ?, auto_summary_at = ?,
                    auto_summary_provider = ?, auto_summary_model = ?, auto_summary_coverage = ? where id = ?`)
                    .run(summarySnapshot(result.summary), coverage === 'complete' ? oneLine(result.status) : 'Partial conversation recap',
                      at, settings.provider, settings.models[settings.provider], coverage, thread.id);
                  if (settings.titles && result.title) this.database.connection.prepare('update sessions set auto_title = ? where id = ?')
                    .run(oneLine(result.title), thread.session_id);
                }
                return true;
              })();
              if (saved) { pending.failures = 0; this.notify(); }
            } catch (error) { this.failed(pending, settings, controller, error); }
          })().finally(() => { pending.controller = null; this.jobs.delete(controller); });
          this.jobs.set(controller, job);
        } catch { /* An unavailable/busy history database is retried without a model call. */ }
      }
    }
    // Shell/process summaries retain their existing bounded screen source.
    for (const [id, pending] of this.pending) {
      const row = this.database.connection.prepare('select kind, status, activity, pty_process_id, project_id from processes where id = ?').get(id) as { kind: string; status: string; activity: string; pty_process_id: string | null; project_id: string } | undefined;
      if (!row || row.status === 'closed') { pending.controller?.abort(); this.pending.delete(id); continue; }
      if (row.kind === 'agent' || row.status !== 'running' || awaitingUser(row.activity) || !row.pty_process_id || pending.controller || this.jobs.size >= 2) continue;
      if (this.now() < pending.retryAt || this.now() - pending.attempted < this.settings.intervalSeconds * 1000 || this.now() - pending.changed < 2000) continue;
      const settings = this.settings, controller = new AbortController();
      pending.attempted = this.now(); pending.controller = controller;
      const job = (async () => {
        try {
          const screen = await this.terminal.request('terminal.process.output', { process_id: row.pty_process_id, max_lines: 100 }) as { screen?: string };
          const text = summarySnapshot(screen.screen ?? '');
          if (controller.signal.aborted || this.settings !== settings || text.length < 40 || pending.hash === text) return;
          const result = await this.runner.run(settings, text, controller.signal, 'summary', {}, row.project_id);
          if (controller.signal.aborted || this.settings !== settings) return;
          const changed = this.database.connection.prepare(`update processes set auto_summary = ?, auto_status = ?, auto_summary_at = ?,
            auto_summary_provider = ?, auto_summary_model = ? where id = ? and pty_process_id = ? and status = 'running' and activity not in ('permission', 'question')`)
            .run(summarySnapshot(result.summary), oneLine(result.status), new Date(this.now()).toISOString(), settings.provider, settings.models[settings.provider], id, row.pty_process_id).changes;
          if (changed) { pending.hash = text; pending.failures = 0; this.notify(); }
        } catch (error) { this.failed(pending, settings, controller, error); }
      })().finally(() => { pending.controller = null; this.jobs.delete(controller); });
      this.jobs.set(controller, job);
    }
  }

  private setCoverage(id: string, coverage: string): void {
    if (this.database.connection.prepare('update processes set auto_summary_coverage = ? where id = ? and auto_summary_coverage is not ?').run(coverage, id, coverage).changes) this.notify();
  }

  private failed(pending: PendingSummary, settings: AutoSummarySettings, controller: AbortController, _error: unknown): void {
    if (controller.signal.aborted || this.settings !== settings) return;
    pending.failures++;
    pending.retryAt = this.now() + Math.min(600_000, settings.intervalSeconds * 1000 * 2 ** Math.min(pending.failures, 5));
    this.error = 'Auto-summary failed. Test the summariser in Settings.';
    this.errorAt = new Date(this.now()).toISOString();
    this.notify();
  }

  private context(thread: SummaryThread): SummaryContext {
    const clean = (text: string) => headUtf8(proseText(text), 160).text;
    const references = (this.database.connection.prepare(`select r.title, r.identifier from session_references sr
      join external_references r on r.id = sr.reference_id where sr.session_id = ? order by r.created_at limit 5`)
      .all(thread.session_id) as Array<{ title: string | null; identifier: string | null }>).map((r) => clean([r.identifier, r.title].filter(Boolean).join(': ')));
    const todos = (this.database.connection.prepare(`select t.title, t.status from todo_assignments a join todos t on t.id = a.todo_id
      where a.session_id = ? order by t.created_at limit 5`).all(thread.session_id) as Array<{ title: string; status: string }>)
      .map((t) => clean(`${t.title} (${t.status})`));
    return { thread_name: clean(thread.display_name ?? thread.name), references, todos,
      previous_summary: thread.auto_summary ? headUtf8(proseText(thread.auto_summary), 600).text : null,
      previous_title: thread.auto_title ? clean(thread.auto_title) : null, native_title: thread.last_title ? clean(thread.last_title) : null };
  }

  control(sessionId: string, operation: 'inspect' | 'rebuild' | 'cancel' | 'resume', projectId: string) {
    const session = this.database.connection.prepare(`select p.*, s.id as session_id, s.harness, s.resume_id, s.display_name, s.auto_title, s.last_title
      from sessions s join processes p on p.id = s.process_id where s.id = ? and s.project_id = ? and p.kind = 'agent' and p.parent_process_id is null and p.status != 'closed'`)
      .get(sessionId, projectId) as SummaryThread | undefined;
    if (!session) throw new Error('Summary session not found.');
    if (operation !== 'inspect' && session.resume_id) {
      const latest = this.database.connection.prepare(`select id from sessions where project_id = ? and harness = ? and resume_id = ?
        order by started_at desc, rowid desc limit 1`).get(projectId, session.harness, session.resume_id) as { id: string } | undefined;
      if (latest?.id !== sessionId) throw new Error('Open the latest resumed session to change its summary.');
    }
    const reader = this.reader(), source = reader?.source(session);
    if (!reader || !source) throw new Error('Imported conversation history is not ready yet.');
    if (operation === 'rebuild') {
      if (!this.settings.enabled) throw new Error('Enable auto-summaries before rebuilding.');
      reader.rebuild(session, source);
      this.database.connection.prepare('insert or ignore into auto_summary_enrollments values (?)').run(session.id);
    } else if (operation === 'resume') {
      if (!this.settings.enabled) throw new Error('Enable auto-summaries before resuming.');
      reader.resume(session, source);
    } else if (operation === 'cancel') reader.cancel(session, source);
    if (operation !== 'inspect') { this.pending.get(session.id)?.controller?.abort(); this.pending.delete(session.id); }
    const state = reader.snapshot(() => reader.state(session, source)), coverage = reader.coverage(source, state);
    this.setCoverage(session.id, coverage);
    return { coverage, totalMessages: source.message_count, processedMessages: state.position,
      estimatedCalls: Math.max(Math.ceil(source.total_bytes / 6000), Math.ceil(source.message_count / 64)), rebuilding: state.rebuild_end !== null, paused: state.paused === 1, enabled: this.settings.enabled };
  }

  async dispose(): Promise<void> {
    this.disposed = true; if (this.timer) clearInterval(this.timer);
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const controller of this.jobs.keys()) controller.abort();
    this.pending.clear(); await Promise.allSettled(this.jobs.values());
  }
}
