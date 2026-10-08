import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_01_000027_add_session_service_tier',
  up(schema) {
    // The Codex service tier (speed) a session launched with; null keeps the
    // CLI's own configuration.
    schema.sql('alter table sessions add column service_tier text');
  },
  down() {
    // The service tier is retained as launch history on rollback.
  }
} satisfies Migration;
