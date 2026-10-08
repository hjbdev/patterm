import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_06_000044_add_routine_remote_creator',
  up(schema) {
    // An agent on a paired host can save routines here. Its session is not in
    // this database, so its name and its host:process address are kept.
    schema.sql('alter table routines add column created_by_remote_name text');
    schema.sql('alter table routines add column created_by_remote_process_id text');
  },
  down(schema) {
    schema.sql('alter table routines drop column created_by_remote_process_id');
    schema.sql('alter table routines drop column created_by_remote_name');
  }
} satisfies Migration;
