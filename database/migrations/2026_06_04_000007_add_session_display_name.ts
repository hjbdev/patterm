import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_06_04_000007_add_session_display_name',

  up(schema) {
    try {
      schema.sql('alter table sessions add column display_name text');
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
