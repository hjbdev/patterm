import type { Migration } from '../../app/Database/Migration';

// Processes gain a live PTY handle (distinct from the uuid row id, since sidecar
// PTY ids reset each run) and an auto-restart flag (relaunch on exit).
export default {
  name: '2026_06_03_000002_add_process_runtime_columns',

  up(schema) {
    schema.sql('alter table processes add column pty_process_id text');
    schema.sql('alter table processes add column auto_restart integer not null default 0');
  },

  down() {
    // SQLite (pre-3.35) cannot drop columns cleanly; this additive, nullable
    // change is left in place on rollback.
  }
} satisfies Migration;
