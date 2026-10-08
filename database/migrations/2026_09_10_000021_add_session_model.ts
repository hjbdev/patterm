import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_09_10_000021_add_session_model',
  up(schema) {
    schema.sql('alter table sessions add column model text');
    schema.sql('alter table sessions add column reasoning text');
  },
  down() {
    // Model selection is retained as launch history on rollback.
  }
} satisfies Migration;
