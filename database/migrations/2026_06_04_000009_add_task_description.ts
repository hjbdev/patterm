import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_06_04_000009_add_task_description',

  up(schema) {
    try {
      schema.sql(`alter table tasks add column description text not null default ''`);
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
