import type { Migration } from '../../app/Database/Migration';

// Images stay in the native transcripts. Each row records where to read one
// back and its hash, so the same image shown twice is listed once.
export default {
  name: '2026_10_10_000007_create_conversation_media',

  up(schema) {
    schema.sql(`
      create table conversation_media (
        id integer primary key,
        conversation_id text not null references conversations(id) on delete cascade,
        message_seq integer,
        kind text not null,
        mime text not null,
        sha256 text not null,
        size_bytes integer not null,
        name text,
        occurred_at text,
        source_path text not null,
        locator text not null
      );
      create index idx_conversation_media_conversation on conversation_media(conversation_id);
      create index idx_conversation_media_sha256 on conversation_media(sha256);
    `);
  },

  down(schema) {
    schema.dropTableIfExists('conversation_media');
  }
} satisfies Migration;
