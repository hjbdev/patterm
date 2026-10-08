import type { AgentHistoryDb } from './AgentHistoryDb';
import type { SearchService } from '../SearchService';

export class ResumeIdCaptureService {
  constructor(
    private readonly database: AgentHistoryDb,
    private readonly search?: SearchService
  ) {}

  markImported(sessionId: string | null, resumeId: string | null): boolean {
    if (!sessionId || !resumeId) return false;
    const changed = this.database.connection
      .prepare(`
        update sessions
        set resume_id = coalesce(resume_id, ?), resume_status = 'imported'
        where id = ?
          and (resume_id is null or resume_id = ? or resume_status = 'unknown')
          and (resume_id is null or resume_status != 'imported')
      `)
      .run(resumeId, sessionId, resumeId).changes;
    if (changed > 0) this.search?.indexSession(sessionId);
    return changed > 0;
  }

  markMissing(sessionId: string): void {
    const changed = this.database.connection
      .prepare(`update sessions set resume_status = 'missing' where id = ? and resume_id is null and resume_status = 'unknown'`)
      .run(sessionId).changes;
    if (changed > 0) this.search?.indexSession(sessionId);
  }
}
