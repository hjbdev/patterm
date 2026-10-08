import type { DatabaseService } from '../Services/DatabaseService';
import { SessionContextService } from '../Services/SessionContextService';
import type { TerminalInventoryProcess } from '../Services/TerminalHostService';

// Match saved records to supervised hosts. A fresh standalone sidecar, or a
// completed Quit, has no inventory and invalidates every previous PTY handle.
export class ReconcileRuntimeAction {
  constructor(private readonly database: DatabaseService) {}

  execute(inventory?: TerminalInventoryProcess[]): { sessions: number; processes: number } {
    if (inventory) return this.reconnect(inventory);
    const now = new Date().toISOString();
    const db = this.database.connection;

    const sessions = db
      .prepare(`update sessions set exited_at = ? where exited_at is null and interface_mode = 'tui'`)
      .run(now).changes;
    const processes = db
      .prepare(`update processes set status = 'exited', exited_at = coalesce(exited_at, ?), updated_at = ?
        where status = 'running' and not exists (
          select 1 from sessions where sessions.process_id = processes.id and sessions.interface_mode = 'integrated' and sessions.exited_at is null
        )`)
      .run(now, now).changes;

    // PTY handles belong to one sidecar instance and its counter restarts at launch.
    db.prepare(`update processes set pty_process_id = null where pty_process_id is not null`).run();

    new SessionContextService(this.database).reconcileLeases();
    return { sessions, processes };
  }

  private reconnect(inventory: TerminalInventoryProcess[]): { sessions: number; processes: number } {
    const db = this.database.connection;
    const terminals = new Map(inventory.map((process) => [process.process_id, process]));
    const now = new Date().toISOString();
    let sessions = 0;
    let processes = 0;
    const rows = db.prepare(`select processes.id, processes.pty_process_id from processes
      where processes.status = 'running' and not exists (
        select 1 from sessions where sessions.process_id = processes.id and sessions.interface_mode = 'integrated' and sessions.exited_at is null
      )`).all() as Array<{ id: string; pty_process_id: string | null }>;
    for (const row of rows) {
      const terminal = row.pty_process_id ? terminals.get(row.pty_process_id) : undefined;
      if (terminal?.status === 'running') {
        db.prepare(`update processes set activity = ?, updated_at = ? where id = ? and activity != ?`).run(terminal.activity, now, row.id, terminal.activity);
        db.prepare(`update sessions set last_title = ? where process_id = ? and exited_at is null`).run(terminal.title, row.id);
        continue;
      }
      const code = terminal?.exit_code ?? null;
      processes += db.prepare(`update processes set status = ?, pty_process_id = null, exited_at = ?, exit_code = ?, updated_at = ? where id = ?`)
        .run(code !== null && code !== 0 ? 'failed' : 'exited', now, code, now, row.id).changes;
      sessions += db.prepare(`update sessions set exited_at = ?, exit_code = ? where process_id = ? and exited_at is null`).run(now, code, row.id).changes;
    }
    sessions += db.prepare(`update sessions set exited_at = ? where exited_at is null and not exists (select 1 from processes where processes.id = sessions.process_id and processes.status = 'running')`).run(now).changes;
    new SessionContextService(this.database).reconcileLeases();
    return { sessions, processes };
  }
}
