import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_05_000033_add_harness_rate_limits',
  up(schema) {
    // The newest quota window each harness reported through an Integrated
    // session, so remaining usage survives restarts and closed sessions.
    schema.sql(`create table harness_rate_limits (
      harness text not null,
      label text not null,
      used_percent real not null,
      resets_at text,
      observed_at text not null,
      primary key (harness, label)
    )`);
  },
  down(schema) {
    schema.sql('drop table harness_rate_limits');
  }
} satisfies Migration;
