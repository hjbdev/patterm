import type { DatabaseService } from '../Services/DatabaseService';
import { SessionContextService } from '../Services/SessionContextService';
import type { TerminalInventoryProcess } from '../Services/TerminalHostService';

// Match saved records to supervised hosts. A fresh standalone sidecar, or a
// completed Quit, has no inventory and invalidates every previous PTY handle.
export class ReconcileRuntimeAction {
  constructor(private readonly database: DatabaseService) {}

  execute(inventory?: TerminalInventoryProcess[]): { sessions: number; processes: number; unreportedChildExits: string[] } {
    if (inventory) return this.reconnect(inventory);
    const now = new Date().toISOString();
    const db = this.database.connection;

    const unreportedChildExits = (db.prepare(`select processes.id from processes
      where processes.status = 'running' and processes.kind = 'agent' and processes.parent_process_id is not null
        and not exists (
          select 1 from sessions where sessions.process_id = processes.id and sessions.interface_mode = 'integrated' and sessions.exited_at is null
        )
        and not exists (
          select 1 from timeline_events where timeline_events.process_id = processes.id and timeline_events.event_type = 'agent.reported'
        )`).all() as Array<{ id: string }>).map((row) => row.id);

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
    return { sessions, processes, unreportedChildExits };
  }

  private reconnect(inventory: TerminalInventoryProcess[]): { sessions: number; processes: number; unreportedChildExits: string[] } {
    const db = this.database.connection;
    const terminals = new Map(inventory.map((process) => [process.process_id, process]));
    const now = new Date().toISOString();
    let sessions = 0;
    let processes = 0;
    const unreportedChildExits: string[] = [];
    const rows = db.prepare(`select processes.id, processes.pty_process_id, processes.kind, processes.parent_process_id from processes
      where processes.status = 'running' and not exists (
        select 1 from sessions where sessions.process_id = processes.id and sessions.interface_mode = 'integrated' and sessions.exited_at is null
      )`).all() as Array<{ id: string; pty_process_id: string | null; kind: string; parent_process_id: string | null }>;
    for (const row of rows) {
      const terminal = row.pty_process_id ? terminals.get(row.pty_process_id) : undefined;
      if (terminal?.status === 'running') {
        const turnStarted = terminal.activity === 'idle' || terminal.activity === 'error'
          ? null
          : terminal.activity === 'working' || terminal.activity === 'thinking'
            ? now
            : undefined;
        if (turnStarted === null) {
          db.prepare(`update processes set activity = ?, turn_started_at = null, updated_at = ? where id = ? and (activity != ? or turn_started_at is not null)`).run(terminal.activity, now, row.id, terminal.activity);
        } else if (turnStarted !== undefined) {
          db.prepare(`update processes set activity = ?, turn_started_at = coalesce(turn_started_at, ?), updated_at = ? where id = ? and (activity != ? or turn_started_at is null)`).run(terminal.activity, turnStarted, now, row.id, terminal.activity);
        } else {
          db.prepare(`update processes set activity = ?, updated_at = ? where id = ? and activity != ?`).run(terminal.activity, now, row.id, terminal.activity);
        }
        db.prepare(`update sessions set last_title = ? where process_id = ? and exited_at is null`).run(terminal.title, row.id);
        continue;
      }
      const code = terminal?.exit_code ?? null;
      const status = code !== null && code !== 0 ? 'failed' : 'exited';
      processes += db.prepare(`update processes set status = ?, pty_process_id = null, exited_at = ?, exit_code = ?, updated_at = ? where id = ?`)
        .run(status, now, code, now, row.id).changes;
      sessions += db.prepare(`update sessions set exited_at = ?, exit_code = ? where process_id = ? and exited_at is null`).run(now, code, row.id).changes;
      if (status === 'exited' && row.kind === 'agent' && row.parent_process_id) {
        const reported = db.prepare(`select 1 from timeline_events where process_id = ? and event_type = 'agent.reported' limit 1`).get(row.id);
        if (!reported) unreportedChildExits.push(row.id);
      }
    }
    sessions += db.prepare(`update sessions set exited_at = ? where exited_at is null and not exists (select 1 from processes where processes.id = sessions.process_id and processes.status = 'running')`).run(now).changes;
    new SessionContextService(this.database).reconcileLeases();
    return { sessions, processes, unreportedChildExits };
  }
}
