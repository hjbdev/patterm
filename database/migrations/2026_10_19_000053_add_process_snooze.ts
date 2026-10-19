import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_19_000053_add_process_snooze',
  up(schema) {
    // The user snoozed an agent until its next message. A turn ending, a
    // request for the user, or the user's own input wakes it. The reminder
    // outlives the snooze and shows until the user dismisses it.
    schema.sql('alter table processes add column snoozed_at text');
    schema.sql('alter table processes add column snooze_reminder text');
  },
  down(schema) {
    schema.sql('alter table processes drop column snooze_reminder');
    schema.sql('alter table processes drop column snoozed_at');
  }
} satisfies Migration;
