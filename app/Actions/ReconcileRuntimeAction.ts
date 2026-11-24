import type { DatabaseService } from '../Services/DatabaseService';
import { SessionContextService } from '../Services/SessionContextService';
import type { TerminalInventoryProcess } from '../Services/TerminalHostService';

export interface ReconcileRuntimeOptions {
  // Legacy TUI agent processes whose background turn could not be interrupted
  // yet: reap their PTY and mark the process failed, but leave sessions.exited_at
  // open so Quit or the next startup retries interrupting them.
  keepOpenProcessIds?: readonly string[];
}

// Match saved non-agent PTY records to supervised hosts, and reap any legacy
// TUI agent rows left over from before TUI agents were retired. A fresh
// standalone sidecar, or a completed Quit, has no inventory and invalidates
// every previous PTY handle.
export class ReconcileRuntimeAction {
  constructor(private readonly database: DatabaseService) {}

  execute(inventory?: TerminalInventoryProcess[], options: ReconcileRuntimeOptions = {}): { sessions: number; processes: number; reapedPtyIds: string[] } {
    const keepOpen = new Set(options.keepOpenProcessIds ?? []);
    if (inventory) return this.reconnect(inventory, keepOpen);
    const now = new Date().toISOString();
    const db = this.database.connection;

    const sessions = this.markLegacyTuiSessionsExited(now, keepOpen);
    let processes = 0;
    if (keepOpen.size > 0) {
      const ids = [...keepOpen];
      const placeholders = ids.map(() => '?').join(', ');
      processes += db
        .prepare(`update processes set status = 'failed', exited_at = coalesce(exited_at, ?), updated_at = ? where status = 'running' and id in (${placeholders})`)
        .run(now, now, ...ids).changes;
    }
    processes += db
      .prepare(`update processes set status = 'exited', exited_at = coalesce(exited_at, ?), updated_at = ?
        where status = 'running' and (
          kind != 'agent' or not exists (
            select 1 from sessions where sessions.process_id = processes.id and sessions.interface_mode = 'integrated' and sessions.exited_at is null
          )
        )`)
      .run(now, now).changes;

    // PTY handles belong to one sidecar instance and its counter restarts at launch.
    db.prepare(`update processes set pty_process_id = null where pty_process_id is not null`).run();

    new SessionContextService(this.database).reconcileLeases();
    return { sessions, processes, reapedPtyIds: [] };
  }

  private reconnect(inventory: TerminalInventoryProcess[], keepOpen: ReadonlySet<string>): { sessions: number; processes: number; reapedPtyIds: string[] } {
    const db = this.database.connection;
    const terminals = new Map(inventory.map((process) => [process.process_id, process]));
    const now = new Date().toISOString();
    let sessions = this.markLegacyTuiSessionsExited(now, keepOpen);
    let processes = 0;
    const reapedPtyIds: string[] = [];
    const rows = db.prepare(`select processes.id, processes.pty_process_id, processes.kind from processes
      where processes.status = 'running' and (
        processes.kind != 'agent' or not exists (
          select 1 from sessions where sessions.process_id = processes.id and sessions.interface_mode = 'integrated' and sessions.exited_at is null
        )
      )`).all() as Array<{ id: string; pty_process_id: string | null; kind: string }>;
    for (const row of rows) {
      const terminal = row.pty_process_id ? terminals.get(row.pty_process_id) : undefined;
      if (row.kind !== 'agent' && terminal?.status === 'running') {
        db.prepare(`update processes set activity = ?, updated_at = ? where id = ? and activity != ?`).run(terminal.activity, now, row.id, terminal.activity);
        continue;
      }
      if (row.kind === 'agent' && row.pty_process_id && terminal?.status === 'running') {
        reapedPtyIds.push(row.pty_process_id);
      }
      const heldOpen = keepOpen.has(row.id);
      const code = terminal?.exit_code ?? null;
      const status = heldOpen || (code !== null && code !== 0) ? 'failed' : 'exited';
      processes += db.prepare(`update processes set status = ?, pty_process_id = null, exited_at = ?, exit_code = ?, updated_at = ? where id = ?`)
        .run(status, now, code, now, row.id).changes;
      if (!heldOpen) {
        sessions += db.prepare(`update sessions set exited_at = ?, exit_code = ? where process_id = ? and exited_at is null`).run(now, code, row.id).changes;
      }
    }
    if (keepOpen.size > 0) {
      const ids = [...keepOpen];
      const placeholders = ids.map(() => '?').join(', ');
      sessions += db.prepare(`update sessions set exited_at = ? where exited_at is null and (process_id is null or process_id not in (${placeholders})) and not exists (select 1 from processes where processes.id = sessions.process_id and processes.status = 'running')`)
        .run(now, ...ids).changes;
    } else {
      sessions += db.prepare(`update sessions set exited_at = ? where exited_at is null and not exists (select 1 from processes where processes.id = sessions.process_id and processes.status = 'running')`).run(now).changes;
    }
    new SessionContextService(this.database).reconcileLeases();
    return { sessions, processes, reapedPtyIds };
  }

  private markLegacyTuiSessionsExited(now: string, keepOpen: ReadonlySet<string>): number {
    const db = this.database.connection;
    if (keepOpen.size === 0) {
      return db.prepare(`update sessions set exited_at = ? where exited_at is null and interface_mode = 'tui'`).run(now).changes;
    }
    const ids = [...keepOpen];
    const placeholders = ids.map(() => '?').join(', ');
    return db
      .prepare(`update sessions set exited_at = ? where exited_at is null and interface_mode = 'tui' and (process_id is null or process_id not in (${placeholders}))`)
      .run(now, ...ids).changes;
  }
}
