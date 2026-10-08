import type { Migration } from '../../app/Database/Migration';

const migration = {
  name: '2026_09_22_000022_add_integrated_submissions',
  up(schema) {
    schema.sql(`create table integrated_submissions (
      process_id text not null,
      message_id text not null,
      payload_hash text not null,
      state text not null check (state in ('accepted', 'uncertain', 'forgotten')),
      result text,
      error text,
      created_at text not null,
      primary key (process_id, message_id)
    )`);
    schema.sql('create index idx_integrated_submissions_process_created on integrated_submissions (process_id, created_at)');
  },
  down(schema) {
    schema.sql('drop table integrated_submissions');
  }
} satisfies Migration;

export default migration;
