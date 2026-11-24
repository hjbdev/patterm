import type { DatabaseService } from '../Services/DatabaseService';

// Stores the native agent's own conversation title read from the provider. The
// user's or agent's chosen display name still takes precedence when shown.
export class UpdateSessionTitleAction {
  constructor(private readonly database: DatabaseService) {}

  // Integrated callers may address the agent by process or session ID.
  forProcess(processId: string, title: string): boolean {
    const clean = title.trim().slice(0, 500);
    if (!clean) return false;
    return this.database.connection
      .prepare(`update sessions set last_title = ? where (process_id = ? or id = ?) and exited_at is null and coalesce(last_title, '') != ?`)
      .run(clean, processId, processId, clean).changes > 0;
  }
}
