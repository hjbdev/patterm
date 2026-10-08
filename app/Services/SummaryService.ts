import type { DatabaseService } from './DatabaseService';
import type { SearchService } from './SearchService';
import type { TimelineService } from './TimelineService';

export class SummaryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: TimelineService,
    private readonly search?: SearchService
  ) {}

  createSessionExitSummary(sessionId: string): { session_id: string } | null {
    const db = this.database.connection;
    const session = db.prepare('select project_id, harness, last_title, exit_code, last_summary from sessions where id = ?').get(sessionId) as
      { project_id: string; harness: string | null; last_title: string | null; exit_code: number | null; last_summary: string | null } | undefined;
    if (!session) return null;
    if (session.last_summary) return { session_id: sessionId };
    const body = `Session ${session.last_title ?? sessionId} exited. Harness: ${session.harness ?? 'unknown'}. Exit code: ${session.exit_code ?? 'unknown'}.`;
    db.transaction(() => {
      db.prepare('update sessions set last_summary = ? where id = ?').run(body, sessionId);
      this.timeline.append({ event_type: 'summary.created', project_id: session.project_id, session_id: sessionId, actor_type: 'system', metadata: { body, provider: 'system' } });
      this.search?.indexSession(sessionId);
    })();
    return { session_id: sessionId };
  }
}
