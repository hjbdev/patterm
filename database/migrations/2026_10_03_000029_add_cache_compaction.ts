import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_03_000029_add_cache_compaction',
  up(schema) {
    // Idle compaction state for Integrated agents: `armed` after a prompt the
    // agent has not compacted since, and when it went idle. Cleared when the
    // service starts.
    schema.sql('alter table processes add column cache_compaction text');
    schema.sql('alter table processes add column cache_idle_since text');
    // The automatic compaction attempt whose turn is running, so its end is
    // not announced. Arming changes, such as a model change, never touch it.
    schema.sql('alter table processes add column cache_compaction_notice text');
  },
  down() {
    // The columns are inert without the service and are kept on rollback.
  }
} satisfies Migration;
