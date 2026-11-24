import type { DatabaseService } from '../Services/DatabaseService';
import type { TerminalService } from '../Services/TerminalService';
import type { TimerService } from '../Services/TimerService';
import { ReconcileRuntimeAction } from './ReconcileRuntimeAction';

export class QuitApplicationAction {
  private pending: Promise<void> | undefined;

  constructor(
    private readonly database: DatabaseService,
    private readonly terminal: TerminalService,
    private readonly timers: TimerService,
    private readonly integrated: { stopAll?(): Promise<void>; interruptAll?(): Promise<void> },
    private readonly stopCoordination: () => Promise<void>
  ) {}

  execute(): Promise<void> {
    return this.pending ??= this.stop().catch((error) => { this.pending = undefined; throw error; });
  }

  private async stop(): Promise<void> {
    this.terminal.beginShutdown();
    this.timers.cancelAll();
    const errors: unknown[] = [];
    // Continue cleaning up even if an external agent cannot be interrupted.
    const stopIntegrated = () => this.integrated.stopAll?.() ?? this.integrated.interruptAll?.() ?? Promise.resolve();
    for (const action of [this.stopCoordination, stopIntegrated]) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    try {
      await this.terminal.shutdown();
    } catch (error) { errors.push(error); }
    if (errors.length) {
      throw new AggregateError(errors, 'Shutdown could not stop every managed process; check the service journal');
    }
    const now = new Date().toISOString();
    this.database.connection.prepare(`update sessions set exited_at = ? where exited_at is null`).run(now);
    this.database.connection.prepare(`update processes set status = 'exited', exited_at = coalesce(exited_at, ?), updated_at = ? where status = 'running'`).run(now, now);
    new ReconcileRuntimeAction(this.database).execute();
  }
}
