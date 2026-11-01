import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_01_000060_add_reference_status',
  up(schema) {
    // Where a link's PR, release or preview stands, as its agent last reported
    // it, such as merged or kept. Null when nobody has said.
    schema.sql('alter table external_references add column status text');
  },
  down(schema) {
    schema.sql('alter table external_references drop column status');
  }
} satisfies Migration;
