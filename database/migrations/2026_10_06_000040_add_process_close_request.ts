import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_06_000040_add_process_close_request',
  up(schema) {
    // An agent's pending request to be closed, set by request_close and
    // cleared when the user allows, keeps it open, or talks to it again.
    schema.sql(`alter table processes add column close_requested_at text`);
    schema.sql(`alter table processes add column close_request_summary text`);
  },
  down(schema) {
    schema.sql('alter table processes drop column close_request_summary');
    schema.sql('alter table processes drop column close_requested_at');
  }
} satisfies Migration;
