import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_06_08_000010_add_process_exit_metadata',

  up(schema) {
    schema.sql('alter table processes add column exited_at text');
    schema.sql('alter table processes add column exit_code integer');
  },

  down() {
    // Additive SQLite migration; leave the columns in place on rollback.
  }
} satisfies Migration;
