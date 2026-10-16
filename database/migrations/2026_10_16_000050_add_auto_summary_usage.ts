import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_16_000050_add_auto_summary_usage',
  up(schema) {
    schema.sql(`create table auto_summary_usage (
      id integer primary key,
      project_id text references projects(id) on delete set null,
      provider text not null,
      model text not null,
      occurred_at text not null,
      input_tokens integer not null,
      cache_read_tokens integer not null,
      cache_write_tokens integer not null,
      cache_write_1h_tokens integer not null,
      output_tokens integer not null,
      reasoning_tokens integer not null,
      cost_usd real
    );
    create index auto_summary_usage_occurred_at on auto_summary_usage(occurred_at)`);
  },
  down(schema) {
    schema.dropTableIfExists('auto_summary_usage');
  }
} satisfies Migration;
