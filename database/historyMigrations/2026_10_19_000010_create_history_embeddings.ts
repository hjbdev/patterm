import type { Migration } from '../../app/Database/Migration';

// Semantic search is derived from stored history, so it lives beside it.
// Imports only mark conversations dirty, through triggers in the same
// transaction as their message writes; the embedding worker reads the stored,
// redacted messages later and never blocks an import.
export default {
  name: '2026_10_19_000010_create_history_embeddings',

  up(schema) {
    schema.sql(`
      create table history_embedding_queue (
        conversation_id text primary key,
        generation integer not null default 1,
        marked_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        attempts integer not null default 0,
        retry_after text,
        last_error text
      );

      -- Vectors are keyed by passage content, so a reimport that recreates
      -- message rows with new IDs reuses them without inference.
      create table history_embedding_vectors (
        model_key text not null,
        content_hash text not null,
        vector blob not null,
        primary key (model_key, content_hash)
      ) without rowid;

      create table history_embedding_passages (
        id integer primary key,
        conversation_id text not null references conversations(id) on delete cascade,
        message_id text not null references conversation_messages(id) on delete cascade,
        seq integer not null,
        chunk integer not null,
        model_key text not null,
        content_hash text not null
      );
      create index idx_history_embedding_passages_conversation on history_embedding_passages(conversation_id);
      create index idx_history_embedding_passages_message on history_embedding_passages(message_id);
      create index idx_history_embedding_passages_hash on history_embedding_passages(model_key, content_hash);

      create table history_embedding_state (
        conversation_id text primary key references conversations(id) on delete cascade,
        model_key text not null,
        passage_count integer not null,
        indexed_at text not null
      );

      create trigger history_embedding_message_insert after insert on conversation_messages begin
        insert into history_embedding_queue (conversation_id) values (new.conversation_id)
        on conflict(conversation_id) do update set generation = generation + 1,
          marked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), attempts = 0, retry_after = null, last_error = null;
      end;
      create trigger history_embedding_message_delete after delete on conversation_messages begin
        insert into history_embedding_queue (conversation_id) values (old.conversation_id)
        on conflict(conversation_id) do update set generation = generation + 1,
          marked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), attempts = 0, retry_after = null, last_error = null;
      end;
      create trigger history_embedding_message_update after update of text, role, kind, seq on conversation_messages begin
        insert into history_embedding_queue (conversation_id) values (new.conversation_id)
        on conflict(conversation_id) do update set generation = generation + 1,
          marked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), attempts = 0, retry_after = null, last_error = null;
      end;

      -- Conversations imported before this migration are queued for backfill.
      insert into history_embedding_queue (conversation_id, marked_at) select id, '1970-01-01T00:00:00.000Z' from conversations;
    `);
  },

  down(schema) {
    schema.sql(`
      drop trigger if exists history_embedding_message_update;
      drop trigger if exists history_embedding_message_delete;
      drop trigger if exists history_embedding_message_insert;
      drop table if exists history_embedding_state;
      drop table if exists history_embedding_passages;
      drop table if exists history_embedding_vectors;
      drop table if exists history_embedding_queue;
    `);
  }
} satisfies Migration;
