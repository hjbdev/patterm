import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_13_000049_add_project_removed_at',
  up(schema) {
    // Removing a project hides it instead of deleting it: project rows cascade
    // to sessions, worktrees, todos, and resume IDs that must be kept. Adding
    // the same folder again clears the column and restores everything.
    schema.sql('alter table projects add column removed_at text');
  },
  down(schema) {
    schema.sql('alter table projects drop column removed_at');
  }
} satisfies Migration;
