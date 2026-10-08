import type { Migration } from '../../app/Database/Migration';

// Processes can be associated with a task worktree, matching sessions.worktree_id.
export default {
  name: '2026_06_03_000003_add_process_worktree_id',

  up(schema) {
    schema.sql('alter table processes add column worktree_id text references worktrees(id) on delete set null');
  },

  down() {
    // SQLite column rollback is intentionally left additive for this nullable v1 field.
  }
} satisfies Migration;
