import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_07_03_000012_add_history_import_lookup_indexes',

  up(schema) {
    schema.sql(`
      create index if not exists idx_sessions_resume_started
        on sessions (resume_id, started_at desc);
      create index if not exists idx_sessions_cwd_started
        on sessions (cwd, started_at desc);
      create index if not exists idx_worktrees_worktree_path
        on worktrees (worktree_path);
      create index if not exists idx_worktrees_repo_path
        on worktrees (repo_path);
    `);
  },

  down(schema) {
    schema.sql(`
      drop index if exists idx_worktrees_repo_path;
      drop index if exists idx_worktrees_worktree_path;
      drop index if exists idx_sessions_cwd_started;
      drop index if exists idx_sessions_resume_started;
    `);
  }
} satisfies Migration;
