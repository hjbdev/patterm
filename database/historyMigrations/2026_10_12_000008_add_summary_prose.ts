import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_12_000008_add_summary_prose',
  up(schema) {
    schema.sql(`
      create table summary_prose_sources (
        conversation_id text primary key references conversations(id) on delete cascade,
        revision integer not null,
        message_count integer not null,
        total_bytes integer not null,
        content_hash text not null
      );
      create table summary_prose (
        conversation_id text not null references conversations(id) on delete cascade,
        position integer not null,
        message_id text not null references conversation_messages(id) on delete cascade,
        label text not null,
        text_bytes integer not null,
        message_hash text not null,
        prefix_hash text not null,
        primary key (conversation_id, position)
      );
    `);
  },
  down(schema) {
    schema.dropTableIfExists('summary_prose');
    schema.dropTableIfExists('summary_prose_sources');
  }
} satisfies Migration;
