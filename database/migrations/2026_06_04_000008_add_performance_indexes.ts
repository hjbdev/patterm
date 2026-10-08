import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_06_04_000008_add_performance_indexes',

  up(schema) {
    schema.sql(`
      create index if not exists idx_tasks_project_created
        on tasks (project_id, created_at);
      create index if not exists idx_sessions_project_task_started
        on sessions (project_id, task_id, started_at);
      create index if not exists idx_processes_project_task_created
        on processes (project_id, task_id, created_at);
      create index if not exists idx_processes_pty_status
        on processes (pty_process_id, status);
      create index if not exists idx_worktrees_task_created
        on worktrees (task_id, created_at);
      create index if not exists idx_worktrees_project_created
        on worktrees (project_id, created_at);
      create index if not exists idx_issue_links_task_updated
        on issue_links (task_id, updated_at desc);
      create index if not exists idx_diff_snapshots_task_created
        on diff_snapshots (task_id, created_at desc);
      create index if not exists idx_diff_snapshots_worktree_created
        on diff_snapshots (worktree_id, created_at desc);
      create index if not exists idx_task_comments_task_created
        on task_comments (task_id, created_at);
      create index if not exists idx_task_comments_task_kind_created
        on task_comments (task_id, kind, created_at desc);
      create index if not exists idx_timeline_events_task_created
        on timeline_events (task_id, created_at);
    `);
  },

  down(schema) {
    schema.sql(`
      drop index if exists idx_timeline_events_task_created;
      drop index if exists idx_task_comments_task_kind_created;
      drop index if exists idx_task_comments_task_created;
      drop index if exists idx_diff_snapshots_worktree_created;
      drop index if exists idx_diff_snapshots_task_created;
      drop index if exists idx_issue_links_task_updated;
      drop index if exists idx_worktrees_project_created;
      drop index if exists idx_worktrees_task_created;
      drop index if exists idx_processes_pty_status;
      drop index if exists idx_processes_project_task_created;
      drop index if exists idx_sessions_project_task_started;
      drop index if exists idx_tasks_project_created;
    `);
  }
} satisfies Migration;
