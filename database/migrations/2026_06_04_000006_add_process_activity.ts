import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_06_04_000006_add_process_activity',

  up(schema) {
    schema.sql("alter table processes add column activity text not null default 'idle'");
  },

  down() {
    // Additive SQLite migration; leave the column in place on rollback.
  }
} satisfies Migration;
