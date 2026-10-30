import type { DatabaseService } from './DatabaseService';
import type { TimelineService } from './TimelineService';

export class SessionContextService {
  constructor(private readonly database: DatabaseService) {}

  // Called inside session registration's transaction, after the new row exists.
  inherit(sessionId: string, projectId: string, harness: string, resumeId: string, timeline: TimelineService, sourceSessionId?: string | null): void {
    const db = this.database.connection;
    const predecessor = db.prepare(`select id from sessions
      where project_id = ? and harness = ? and resume_id = ? and id != ?
        and (? is null or id = ?)
      order by started_at desc, rowid desc limit 1`)
      .get(projectId, harness, resumeId, sessionId, sourceSessionId ?? null, sourceSessionId ?? null) as { id: string } | undefined;
    if (!predecessor) {
      if (sourceSessionId) throw new Error('Resume source does not match this project and native conversation');
      return;
    }
    db.prepare('update sessions set resumed_from_session_id = ? where id = ?').run(predecessor.id, sessionId);
    // A resumed conversation keeps its generated title and last recap until the next one replaces them.
    db.prepare(`update sessions set auto_title = (select auto_title from sessions where id = ?)
      where id = ? and auto_title is null`).run(predecessor.id, sessionId);
    db.prepare(`update processes set (auto_summary, auto_status, auto_summary_at, auto_summary_provider, auto_summary_model, auto_summary_coverage) =
        (select p.auto_summary, p.auto_status, p.auto_summary_at, p.auto_summary_provider, p.auto_summary_model, p.auto_summary_coverage
          from processes p join sessions s on s.process_id = p.id where s.id = ?)
      where id = (select process_id from sessions where id = ?) and auto_summary is null
        and exists (select 1 from processes p join sessions s on s.process_id = p.id where s.id = ? and p.auto_summary is not null)`)
      .run(predecessor.id, sessionId, predecessor.id);
    db.prepare(`insert into session_references (session_id, reference_id)
      select ?, a.reference_id from session_references a join external_references r on r.id = a.reference_id
      where a.session_id = ? and r.project_id = ?`).run(sessionId, predecessor.id, projectId);
    db.prepare(`insert into session_scratchpads (session_id, scratchpad_id)
      select ?, a.scratchpad_id from session_scratchpads a join scratchpads s on s.id = a.scratchpad_id
      where a.session_id = ? and s.project_id = ?`).run(sessionId, predecessor.id, projectId);
    // Secrets follow the conversation. Unique names keep a secret the new
    // session already holds.
    db.prepare(`update session_secrets set session_id = ? where session_id = ?
      and name not in (select name from session_secrets where session_id = ?)`).run(sessionId, predecessor.id, sessionId);
    // Keep link order. The new session's own worktree is never a link.
    db.prepare(`insert into session_worktrees (session_id, worktree_id, created_at)
      select ?, a.worktree_id, a.created_at from session_worktrees a join worktrees w on w.id = a.worktree_id
      where a.session_id = ? and w.project_id = ? and a.worktree_id is not (select worktree_id from sessions where id = ?)
      order by a.created_at, a.rowid`).run(sessionId, predecessor.id, projectId, sessionId);
    const assignments = db.prepare(`select a.todo_id from todo_assignments a join todos t on t.id = a.todo_id
      where a.session_id = ? and t.project_id = ? and t.status != 'completed'`).all(predecessor.id, projectId) as { todo_id: string }[];
    for (const assignment of assignments) {
      db.prepare(`update todo_assignments set assignee_id = ?, session_id = ? where todo_id = ? and session_id = ?`)
        .run(sessionId, sessionId, assignment.todo_id, predecessor.id);
      db.prepare('update todos set revision=revision+1,updated_at=? where id=?').run(new Date().toISOString(), assignment.todo_id);
      timeline.append({ event_type: 'todo.assignment_transferred', project_id: projectId, session_id: sessionId,
        metadata: { todo_id: assignment.todo_id, from_session_id: predecessor.id, to_session_id: sessionId } });
    }
  }

  releaseProcessLeases(processId: string): void {
    this.database.connection.prepare(`delete from todo_leases where holder_session_id in
      (select s.id from sessions s left join processes p on p.id = s.process_id
       where s.process_id = ? or p.pty_process_id = ?)` ).run(processId, processId);
  }

  reconcileLeases(): void {
    this.database.connection.prepare(`delete from todo_leases where expires_at <= ? or holder_session_id in
      (select s.id from sessions s left join processes p on p.id = s.process_id
       where s.exited_at is not null or p.id is null or p.status != 'running')`).run(Date.now());
  }
}
