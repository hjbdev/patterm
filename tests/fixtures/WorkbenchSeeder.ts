import type { DatabaseService } from '../../app/Services/DatabaseService';

export class WorkbenchSeeder {
  constructor(private readonly database: DatabaseService) {}

  seedIfEmpty(): void {
    const db = this.database.connection;
    const existing = db.prepare(`select count(*) as count from projects`).get() as { count: number };
    if (existing.count > 0) return;

    db.transaction(() => {
      const now = new Date().toISOString();
      const cwd = process.cwd();
      db.prepare(`insert into projects (id, name, path, created_at, updated_at) values ('project_local', 'Patterm Desktop', ?, ?, ?)`)
        .run(cwd, now, now);
      db.prepare(`insert into processes (id, project_id, parent_process_id, kind, name, status, created_at, updated_at) values
        ('seed_parent', 'project_local', null, 'agent', 'project orchestrator', 'running', ?, ?),
        ('seed_child', 'project_local', 'seed_parent', 'agent', 'scaffold shell', 'running', ?, ?)`)
        .run(now, now, now, now);
      db.prepare(`insert into sessions (id, project_id, process_id, harness, session_role, resume_status, started_at, last_title, created_by_actor) values
        ('seed_parent_session', 'project_local', 'seed_parent', 'codex', 'orchestrator', 'found', ?, 'project orchestrator', 'system'),
        ('seed_child_session', 'project_local', 'seed_child', 'claude', 'child', 'found', ?, 'scaffold shell', 'system')`)
        .run(now, now);
      db.prepare(`insert into worktrees (id, project_id, repo_path, worktree_path, branch, created_by, created_at)
        values ('seed_worktree', 'project_local', ?, ?, 'feat/scaffold-shell', 'system', ?)`)
        .run(cwd, `${cwd}/.worktrees/scaffold`, now);
    })();
  }
}
