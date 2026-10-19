import { isActivityState } from './Activity';
import { UpdateSessionTitleAction } from '../Actions/UpdateSessionTitleAction';
import type { DatabaseService } from './DatabaseService';
import { SessionContextService } from './SessionContextService';
import type { historyImportInput } from './AgentHistory/AgentHistoryImportService';
import type { z } from 'zod';
import type { ProcessLauncher } from './ProcessLauncher';
import type { SearchService } from './SearchService';
import type { SummaryService } from './SummaryService';
import type { TimelineService } from './TimelineService';
import type { ChangeTopic } from './ChangeTopics';

// Broad enough to accept any frame TerminalService emits (damage frames lack
// processId/event); we filter to lifecycle 'exit' inside.
interface AnyFrame {
  type: string;
  processId?: string | null;
  event?: string;
  exitCode?: number | null;
  title?: string;
  activity?: string;
}

export interface LifecycleSource {
  onFrame(listener: (frame: AnyFrame) => void): () => void;
}

interface ProcessRow {
  id: string;
  project_id: string;
  auto_restart: number;
}

const RELAUNCH_WINDOW_MS = 10_000;
const RELAUNCH_LIMIT = 5;
const LIFECYCLE_RETRY_DELAY_MS = 250;
const EPHEMERAL_RETRY_LIMIT = 3;

interface PendingLifecycleRetry {
  frame: AnyFrame;
  attempt: number;
  timer: ReturnType<typeof setTimeout>;
}

// Reacts to sidecar PTY exits: marks agent sessions exited, and either restarts
// (auto_restart) or marks processes exited. Announces each change so clients
// update their tabs and lists.
export class RuntimeReconciler {
  private readonly unsubscribe: () => void;
  private readonly relaunchHistory = new Map<string, number[]>();
  private readonly pendingLifecycleRetries = new Map<string, PendingLifecycleRetry>();

  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: TimelineService,
    private readonly processLauncher: ProcessLauncher,
    private readonly summaries: SummaryService | null,
    terminal: LifecycleSource,
    // Exits also release todo leases, so they change project context too.
    private readonly notifyChanged: (topics: readonly ChangeTopic[]) => void,
    private readonly historyImport: { import(input: z.input<typeof historyImportInput>): unknown } | null = null,
    private readonly search: SearchService | null = null,
    initialFrames: Iterable<AnyFrame> = [],
    // Called when a running process exits with a non-zero code. Stops never
    // reach this: the sidecar reports no exit after a stop request.
    private readonly onProcessFailed: (processId: string, exitCode: number) => void = () => {},
    // Called after a PTY agent's activity changes, with the state it left.
    private readonly onActivityChanged: (processId: string, previous: string, activity: string) => void = () => {}
  ) {
    this.unsubscribe = terminal.onFrame((frame) => {
      this.dispatchLifecycleFrame(frame);
    });
    for (const frame of initialFrames) this.dispatchLifecycleFrame(frame);
  }

  dispose(): void {
    this.unsubscribe();
    for (const retry of this.pendingLifecycleRetries.values()) {
      clearTimeout(retry.timer);
    }
    this.pendingLifecycleRetries.clear();
  }

  private dispatchLifecycleFrame(frame: AnyFrame, attempt = 0): void {
    try {
      if (frame.type !== 'terminal-lifecycle' || !frame.processId) {
        return;
      }
      if (frame.event === 'exit') {
        this.handleExit(frame.processId, frame.exitCode ?? null);
        return;
      }
      if (frame.event === 'activity' && frame.activity) {
        this.handleActivity(frame.processId, frame.activity);
        return;
      }
      if (frame.event === 'title' && frame.title) {
        this.handleTitle(frame.processId, frame.title);
      }
    } catch (error) {
      if (isSqliteBusy(error) && this.retryLifecycleFrame(frame, attempt)) {
        return;
      }
      throw error;
    }
  }

  private retryLifecycleFrame(frame: AnyFrame, attempt: number): boolean {
    if (frame.type !== 'terminal-lifecycle' || !frame.processId || !isRetryableLifecycleEvent(frame.event)) {
      return false;
    }

    const nextAttempt = attempt + 1;
    if (frame.event !== 'exit' && nextAttempt > EPHEMERAL_RETRY_LIMIT) {
      return true;
    }

    const key = `${frame.event}:${frame.processId}`;
    const pending = this.pendingLifecycleRetries.get(key);
    if (pending) {
      pending.frame = frame;
      return true;
    }

    const timer = setTimeout(() => {
      const retry = this.pendingLifecycleRetries.get(key);
      if (!retry) {
        return;
      }
      this.pendingLifecycleRetries.delete(key);
      this.dispatchLifecycleFrame(retry.frame, retry.attempt);
    }, LIFECYCLE_RETRY_DELAY_MS);
    this.pendingLifecycleRetries.set(key, { frame, attempt: nextAttempt, timer });
    return true;
  }

  private handleExit(ptyId: string, exitCode: number | null): void {
    const db = this.database.connection;
    const now = new Date().toISOString();
    let changed = false;
    new SessionContextService(this.database).releaseProcessLeases(ptyId);

    const sessionRows = db
      .prepare(
        `select sessions.id
         from sessions
         left join processes on processes.id = sessions.process_id
         where sessions.exited_at is null
           and (sessions.process_id = ? or processes.pty_process_id = ?)`
      )
      .all(ptyId, ptyId) as Array<{ id: string }>;
    if (sessionRows.length > 0) {
      const placeholders = sessionRows.map(() => '?').join(', ');
      db.prepare(`update sessions set exited_at = ?, exit_code = ? where exited_at is null and id in (${placeholders})`).run(
        now,
        exitCode,
        ...sessionRows.map((row) => row.id)
      );
      for (const row of sessionRows) {
        this.summaries?.createSessionExitSummary(row.id);
        this.importSessionHistory(row.id);
      }
      changed = true;
    }

    const process = db
      .prepare(`select id, project_id, auto_restart from processes where pty_process_id = ? and status = 'running'`)
      .get(ptyId) as ProcessRow | undefined;

    if (process) {
      if (process.auto_restart === 1 && this.withinRelaunchBudget(process.id)) {
        void this.processLauncher
          .relaunch(process.id)
          .then(() => this.notifyChanged(['workbench']))
          .catch(() => this.markExited(process.id, now, exitCode));
      } else {
        if (process.auto_restart === 1) {
          // Crash-looping: stop relaunching and record the give-up.
          db.prepare(`update processes set auto_restart = 0 where id = ?`).run(process.id);
          this.timeline.append({
            event_type: 'process.relaunch_giveup',
            project_id: process.project_id,
            process_id: process.id,
            actor_type: 'system'
          });
        }
        this.relaunchHistory.delete(process.id);
        this.markExited(process.id, now, exitCode);
      }
      changed = true;
    }

    if (changed) {
      this.notifyChanged(['workbench', 'context']);
    }
  }

  private handleActivity(ptyId: string, activity: string): void {
    if (!isActivityState(activity)) {
      return;
    }

    const now = new Date().toISOString();
    const previous = this.database.connection
      .prepare(`select id, activity from processes where pty_process_id = ? and activity != ?`)
      .all(ptyId, activity) as Array<{ id: string; activity: string }>;
    const changed = this.database.connection
      .prepare(`update processes set activity = ?, updated_at = ? where pty_process_id = ? and activity != ?`)
      .run(activity, now, ptyId, activity).changes;

    if (changed > 0) {
      this.notifyChanged(['workbench']);
      for (const row of previous) this.onActivityChanged(row.id, row.activity, activity);
    }
  }

  private handleTitle(ptyId: string, title: string): void {
    if (new UpdateSessionTitleAction(this.database).forPty(ptyId, title)) {
      this.notifyChanged(['workbench']);
    }
  }

  private markExited(processId: string, now: string, exitCode: number | null): void {
    const status = exitCode === null || exitCode === 0 ? 'exited' : 'failed';
    const running = this.database.connection.prepare(`select 1 from processes where id = ? and status = 'running'`).get(processId);
    this.database.connection
      .prepare(`update processes set status = ?, exited_at = ?, exit_code = ?, updated_at = ? where id = ?`)
      .run(status, now, exitCode, now, processId);
    this.relaunchHistory.delete(processId);
    this.notifyChanged(['workbench']);
    if (running && status === 'failed') {
      try { this.onProcessFailed(processId, exitCode!); } catch { /* notifications are best effort */ }
    }
  }

  private importSessionHistory(sessionId: string): void {
    const row = this.database.connection.prepare(`select project_id, harness, resume_status from sessions where id = ?`).get(sessionId) as
      | { project_id: string; harness: string | null; resume_status: string }
      | undefined;
    if (!row || !isHistoryProvider(row.harness)) {
      return;
    }
    try {
      this.historyImport?.import({ provider: row.harness, project_id: row.project_id, trigger: 'session_exit' });
    } catch {
      // Import failures are recorded in import batches; exit reconciliation should keep going.
    }
    const changed = this.database.connection
      .prepare(`update sessions set resume_status = 'missing' where id = ? and resume_id is null and resume_status = 'unknown'`)
      .run(sessionId).changes;
    if (changed > 0) this.search?.indexSession(sessionId);
  }

  private withinRelaunchBudget(processId: string): boolean {
    const at = Date.now();
    const recent = (this.relaunchHistory.get(processId) ?? []).filter((ts) => at - ts < RELAUNCH_WINDOW_MS);
    if (recent.length >= RELAUNCH_LIMIT) {
      this.relaunchHistory.set(processId, recent);
      return false;
    }
    recent.push(at);
    this.relaunchHistory.set(processId, recent);
    return true;
  }
}


function isRetryableLifecycleEvent(value: string | undefined): boolean {
  return value === 'activity' || value === 'title' || value === 'exit';
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as Error & { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || /database is locked|database table is locked/i.test(error.message);
}

function isHistoryProvider(value: string | null): value is 'claude' | 'codex' | 'opencode' {
  return value === 'claude' || value === 'codex' || value === 'opencode';
}
