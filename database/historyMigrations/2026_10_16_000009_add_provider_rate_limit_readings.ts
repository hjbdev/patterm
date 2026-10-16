import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_16_000009_add_provider_rate_limit_readings',
  up(schema) {
    // Each change in a quota window's usage from imported transcripts, kept
    // for about a week, so the usage page can project the current pace.
    schema.sql(`
      create table provider_rate_limit_readings (
        provider text not null,
        label text not null,
        used_percent real not null,
        observed_at text not null,
        primary key (provider, label, observed_at)
      );
    `);
  },
  down(schema) {
    schema.dropTableIfExists('provider_rate_limit_readings');
  }
} satisfies Migration;
