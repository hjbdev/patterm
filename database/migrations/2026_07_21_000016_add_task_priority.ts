import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_07_21_000016_add_task_priority',

  up(schema) {
    try {
      schema.sql(`alter table tasks add column priority integer not null default 0`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column name')) {
        throw error;
      }
    }
  },

  down() {
    // Additive SQLite migration; leave the column in place on rollback.
  }
} satisfies Migration;
