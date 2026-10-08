import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_06_000038_add_routine_run_at',
  up(schema) {
    // A routine with run_at runs once at that instant instead of on its weekdays.
    // worktree_id starts its runs in that worktree, such as an agent's follow-up.
    schema.sql('alter table routines add column run_at text');
    schema.sql('alter table routines add column worktree_id text references worktrees(id) on delete set null');
  },
  down(schema) {
    schema.sql('alter table routines drop column worktree_id');
    schema.sql('alter table routines drop column run_at');
  }
} satisfies Migration;
