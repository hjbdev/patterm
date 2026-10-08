import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_09_10_000020_add_runtime_timers',
  up(schema) {
    schema.sql('create table runtime_timers (id text primary key, record text not null)');
  },
  down(schema) {
    schema.sql('drop table runtime_timers');
  }
} satisfies Migration;
