import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_09_000046_add_assistant_memory',
  up(schema) {
    schema.sql(`create table assistant_memory (
      id text primary key,
      text text not null,
      importance text not null check (importance in ('low', 'medium', 'high')),
      project_id text,
      fact_at text not null,
      recorded_at text not null,
      revision integer not null,
      status text not null check (status in ('active', 'replaced', 'forgotten')),
      replaced_by text references assistant_memory(id)
    )`);
    schema.sql('create index idx_assistant_memory_status on assistant_memory(status, revision)');
  },
  down(schema) {
    schema.sql('drop table assistant_memory');
    schema.sql("delete from settings where key = 'assistant.memory.revision.v1'");
  }
} satisfies Migration;
