import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_02_000062_add_process_status_label',
  up(schema) {
    // The status label pinned on an agent, by id from the status_labels.v1
    // setting, and who pinned it: 'agent' or 'user'.
    schema.sql('alter table processes add column status_label_id text');
    schema.sql('alter table processes add column status_label_set_at text');
    schema.sql('alter table processes add column status_label_set_by text');
  },
  down(schema) {
    for (const column of ['status_label_set_by', 'status_label_set_at', 'status_label_id']) schema.sql(`alter table processes drop column ${column}`);
  }
} satisfies Migration;
