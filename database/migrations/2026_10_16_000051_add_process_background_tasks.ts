import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_16_000051_add_process_background_tasks',
  up(schema) {
    // Background tasks still running for an Integrated agent, such as a shell
    // it waits on. Rows show the agent busy while any run; activity, which
    // queues, timers and notifications follow, stays as the harness reports.
    schema.sql('alter table processes add column background_tasks integer not null default 0');
  },
  down(schema) {
    schema.sql('alter table processes drop column background_tasks');
  }
} satisfies Migration;
