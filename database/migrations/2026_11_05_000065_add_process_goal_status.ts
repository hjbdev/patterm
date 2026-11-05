import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_05_000065_add_process_goal_status',
  up(schema) {
    // The status of an Integrated agent's open native goal, such as active
    // or paused, for its tab. Null while it has none. The goal itself stays
    // native; this follows the snapshots Patterm reads.
    schema.sql('alter table processes add column goal_status text');
  },
  down(schema) {
    schema.sql('alter table processes drop column goal_status');
  }
} satisfies Migration;
