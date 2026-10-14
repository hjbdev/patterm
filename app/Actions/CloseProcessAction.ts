import type { DatabaseService } from '../Services/DatabaseService';
import { SessionContextService } from '../Services/SessionContextService';
import type { TerminalService } from '../Services/TerminalService';
import type { IntegratedAgentService } from '../Services/IntegratedAgentService';
import type { OpenCodeServerService } from '../Services/OpenCodeServerService';
import type { NotificationService } from '../Services/NotificationService';

interface ProcessRow {
  id: string;
  pty_process_id: string | null;
  status: string;
  integrated: number;
}

export class CloseProcessAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly terminal: TerminalService,
    private readonly openCode?: Pick<OpenCodeServerService, 'interrupt'>,
    private readonly integrated?: Pick<IntegratedAgentService, 'stop'> & Partial<Pick<IntegratedAgentService, 'stopIfLive'>>,
    private readonly notifications?: Pick<NotificationService, 'resolve'>,
    // An Integrated agent has no terminal exit to announce its close.
    private readonly onChanged?: () => void
  ) {}

  async execute(processId: string): Promise<{ closed: string[] }> {
    const rootProcess = this.resolveProcess(processId);
    if (!rootProcess) {
      return { closed: [] };
    }

    const processes = this.descendantProcesses(rootProcess);
    const processIds = processes.map((process) => process.id);
    const now = new Date().toISOString();

    for (const process of processes) {
      // A host can outlive an agent wrongly marked failed; stop it as well.
      if (process.status !== 'running' && process.integrated) await this.integrated?.stopIfLive?.(process.id).catch(() => undefined);
      if (process.status !== 'running') continue;
      // A genuine stop failure propagates and the lifecycle below is skipped:
      // a live host that refused to stop is never marked closed. A dead native
      // process is still stopped by the service after its interrupt fails.
      if (process.integrated) await this.integrated?.stop(process.id);
      else await this.openCode?.interrupt(process.id);
      if (!process.integrated) await this.terminal.request('terminal.process.stop', { process_id: process.pty_process_id ?? process.id });
    }

    const placeholders = processIds.map(() => '?').join(', ');
    const db = this.database.connection;
    db.prepare(`update processes set status = 'closed', exited_at = coalesce(exited_at, ?), updated_at = ? where id in (${placeholders})`).run(now, now, ...processIds);
    db.prepare(`update sessions set exited_at = coalesce(exited_at, ?) where process_id in (${placeholders})`).run(now, ...processIds);
    // Closing a process dismisses everything it asked for.
    for (const id of processIds) this.notifications?.resolve({ process_id: id });
    const context = new SessionContextService(this.database);
    for (const id of processIds) context.releaseProcessLeases(id);
    this.onChanged?.();
    for (const process of processes) {
      if (process.status === 'closed' || (!process.pty_process_id && process.status !== 'running')) continue;
      if (!process.integrated) await this.terminal.request('terminal.process.close', { process_id: process.pty_process_id ?? process.id });
    }

    return { closed: processIds };
  }

  private resolveProcess(processId: string): ProcessRow | null {
    const db = this.database.connection;

    const process = db.prepare(`select processes.id, processes.pty_process_id, processes.status,
      exists(select 1 from sessions where sessions.process_id = processes.id and sessions.interface_mode = 'integrated') as integrated
      from processes where processes.id = ? or processes.pty_process_id = ? order by processes.status = 'running' desc`).get(processId, processId) as
      | ProcessRow
      | undefined;
    if (process) {
      return process;
    }

    const session = db.prepare(`select process_id from sessions where process_id = ? or id = ?`).get(processId, processId) as
      | { process_id: string | null }
      | undefined;

    return (
      db.prepare(`select processes.id, processes.pty_process_id, processes.status,
        exists(select 1 from sessions where sessions.process_id = processes.id and sessions.interface_mode = 'integrated') as integrated
        from processes where processes.id = ?`).get(session?.process_id ?? processId) as ProcessRow | undefined
    ) ?? null;
  }

  private descendantProcesses(rootProcess: ProcessRow): ProcessRow[] {
    const db = this.database.connection;
    const children = db.prepare(`select processes.id, processes.pty_process_id, processes.status,
      exists(select 1 from sessions where sessions.process_id = processes.id and sessions.interface_mode = 'integrated') as integrated
      from processes where parent_process_id = ?`);
    const pending = [rootProcess];
    const processes: ProcessRow[] = [];
    const seen = new Set<string>();

    while (pending.length > 0) {
      const process = pending.shift();
      if (!process || seen.has(process.id)) {
        continue;
      }

      seen.add(process.id);
      processes.push(process);

      for (const row of children.all(process.id) as ProcessRow[]) {
        pending.push(row);
      }
    }

    return processes;
  }
}
