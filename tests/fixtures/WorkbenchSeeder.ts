import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../../app/Services/DatabaseService';
import type { TimelineService } from '../../app/Services/TimelineService';

export class WorkbenchSeeder {
  constructor(
    private readonly database: DatabaseService,
    private readonly timeline: TimelineService
  ) {}

  seedIfEmpty(): void {
    const existing = this.database.connection.prepare(`select count(*) as count from projects`).get() as { count: number };
    if (existing.count > 0) {
      return;
    }

    const seed = this.database.connection.transaction(() => this.seed());
    seed();
  }

  private seed(): void {
    const db = this.database.connection;
    const now = new Date().toISOString();
    const projectId = 'project_local';

    db.prepare(`insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)`).run(
      projectId,
      'Patterm Desktop',
      process.cwd(),
      now,
      now
    );

    const orchestratorProcess = this.insertProcess(projectId, null, 'agent', 'project orchestrator', 'running');
    this.insertSession(projectId, orchestratorProcess, 'codex', 'orchestrator', 'found', 'project orchestrator', null);
    const exploreProcess = this.insertProcess(projectId, orchestratorProcess, 'agent', 'explore codebase', 'running');
    this.insertSession(projectId, exploreProcess, 'claude', 'child', 'found', 'explore codebase', null);
    this.insertProcess(projectId, orchestratorProcess, 'dev-server', 'vite dev', 'running');

    const childProcess = this.insertProcess(projectId, null, 'agent', 'scaffold shell', 'running');
    this.insertSession(projectId, childProcess, 'claude', 'child', 'found', 'scaffold shell', null);
    const reviewProcess = this.insertProcess(projectId, childProcess, 'agent', 'one-off rust check', 'exited');
    this.insertSession(projectId, reviewProcess, 'codex', 'child', 'missing', 'one-off rust check', now);
    this.insertProcess(projectId, childProcess, 'test-runner', 'pnpm test:terminal', 'exited');

    this.insertWorktree(projectId, 'feat/scaffold-shell');
  }

  private insertProcess(
    projectId: string,
    parentProcessId: string | null,
    kind: string,
    name: string,
    status: string
  ): string {
    const id = `process_${randomUUID()}`;
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `insert into processes (id, project_id, parent_process_id, kind, name, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, projectId, parentProcessId, kind, name, status, now, now);
    return id;
  }

  private insertSession(
    projectId: string,
    processId: string,
    harness: string,
    role: string,
    resumeStatus: string,
    lastTitle: string,
    exitedAt: string | null
  ): string {
    const id = `session_${randomUUID()}`;
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `insert into sessions (id, project_id, process_id, harness, session_role, resume_status, started_at, exited_at, last_title, created_by_actor)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'system')`
      )
      .run(id, projectId, processId, harness, role, resumeStatus, now, exitedAt, lastTitle);
    return id;
  }

  private insertWorktree(projectId: string, branch: string): string {
    const id = `worktree_${randomUUID()}`;
    const now = new Date().toISOString();
    this.database.connection
      .prepare(
        `insert into worktrees (id, project_id, repo_path, worktree_path, branch, created_by, created_at)
         values (?, ?, ?, ?, ?, 'system', ?)`
      )
      .run(id, projectId, process.cwd(), `${process.cwd()}/.worktrees/scaffold`, branch, now);
    return id;
  }
}
