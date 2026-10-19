import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_19_000054_add_project_snooze',
  up(schema) {
    // A project snoozed until a time. Its notifications are recorded while
    // it sleeps but held from toasts, desktop notifications and push; when
    // it wakes, one summary counts the held ones and clears the mark.
    schema.sql('alter table projects add column snoozed_until text');
    schema.sql('alter table notifications add column held integer not null default 0');
  },
  down(schema) {
    schema.sql('alter table notifications drop column held');
    schema.sql('alter table projects drop column snoozed_until');
  }
} satisfies Migration;
