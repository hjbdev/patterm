import type { DatabaseService } from '../Services/DatabaseService';
import { SessionContextService } from '../Services/SessionContextService';
import type { TerminalService } from '../Services/TerminalService';
import type { IntegratedAgentService } from '../Services/IntegratedAgentService';
import type { OpenCodeServerService } from '../Services/OpenCodeServerService';

interface ProcessRow {
  id: string;
  pty_process_id: string | null;
  integrated: number;
}

export class StopProcessAction {
  constructor(
    private readonly database: DatabaseService,
    private readonly terminal: TerminalService,
    private readonly openCode?: Pick<OpenCodeServerService, 'interrupt'>,
    private readonly integrated?: Pick<IntegratedAgentService, 'stop'>
  ) {}

  async execute(processId: string): Promise<{ ok: true; process_id?: string; status: string }> {
    const process = this.resolveProcess(processId);
    if (!process) {
      return { ok: true, status: 'missing' };
    }

    if (process.integrated) await this.integrated?.stop(process.id);
    else await this.openCode?.interrupt(process.id);
    const result = process.integrated ? null : await this.terminal.request('terminal.process.stop', { process_id: process.pty_process_id ?? process.id });
    const status = !process.integrated && stopStatus(result) === 'exited' ? 'exited' : 'stopped';
    const now = new Date().toISOString();
    const db = this.database.connection;

    db.prepare(`update processes set status = ?, exited_at = coalesce(exited_at, ?), updated_at = ? where id = ? and status = 'running'`).run(status, now, now, process.id);
    db.prepare(`update sessions set exited_at = coalesce(exited_at, ?) where process_id = ?`).run(now, process.id);
    new SessionContextService(this.database).releaseProcessLeases(process.id);

    return { ok: true, process_id: process.id, status };
  }

  private resolveProcess(processId: string): ProcessRow | null {
    const process = this.database.connection
      .prepare(`select processes.id, processes.pty_process_id,
        exists(select 1 from sessions where sessions.process_id = processes.id and sessions.interface_mode = 'integrated') as integrated
        from processes where processes.id = ? or processes.pty_process_id = ? order by processes.status = 'running' desc limit 1`)
      .get(processId, processId) as ProcessRow | undefined;

    return process ?? null;
  }
}

function stopStatus(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }

  const status = (result as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}
