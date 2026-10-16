import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_16_000051_add_harness_rate_limit_readings',
  up(schema) {
    // Each change in a quota window's usage from Integrated sessions, kept
    // for about a week, so the usage page can project the current pace.
    schema.sql(`create table harness_rate_limit_readings (
      harness text not null,
      label text not null,
      used_percent real not null,
      observed_at text not null,
      primary key (harness, label, observed_at)
    )`);
  },
  down(schema) {
    schema.sql('drop table harness_rate_limit_readings');
  }
} satisfies Migration;
