import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_29_000055_add_process_asking',
  up(schema) {
    // What an Integrated agent waiting on you asks, in one short line, so its
    // list row can say it. Cleared once nothing is pending.
    schema.sql('alter table processes add column asking text');
  },
  down(schema) {
    schema.sql('alter table processes drop column asking');
  }
} satisfies Migration;
