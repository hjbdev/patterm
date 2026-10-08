import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_03_000030_add_process_turn_start',
  up(schema) {
    // When an Integrated agent's current turn began, so a turn that reported
    // is not announced as merely finished, including across restarts.
    schema.sql('alter table processes add column turn_started_at text');
  },
  // SQLite cannot drop the column on every supported version, and retaining
  // it would make a later re-run fail, so the migration is forward-only.
  down() { throw new Error('Process turn start migration is forward-only; restore a consistent backup to roll back.'); }
} satisfies Migration;
