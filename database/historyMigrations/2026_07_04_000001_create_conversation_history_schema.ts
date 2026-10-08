import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_07_04_000001_create_conversation_history_schema',

  up(schema) {
    schema.sql(`
      create table if not exists conversation_import_batches (
        id text primary key,
        trigger text not null,
        provider text,
        source_id text,
        project_id text,
        task_id text,
        started_at text not null,
        finished_at text,
        status text not null,
        files_seen integer not null default 0,
        files_imported integer not null default 0,
        conversations_imported integer not null default 0,
        messages_imported integer not null default 0,
        skipped_count integer not null default 0,
        error_count integer not null default 0
      );

      create table if not exists conversation_import_files (
        id text primary key,
        source_id text,
        batch_id text,
        provider text not null,
        path text not null,
        source_kind text not null,
        size_bytes integer,
        mtime_ms integer,
        content_hash text,
        parser_version text not null,
        status text not null,
        warning text,
        error text,
        last_imported_at text,
        metadata text not null default '{}',
        unique(provider, path)
      );

      create table if not exists conversations (
        id text primary key,
        provider text not null,
        provider_conversation_id text,
        project_id text,
        task_id text,
        session_id text,
        process_id text,
        worktree_id text,
        source_file_id text,
        title text,
        cwd text,
        provider_version text,
        started_at text,
        updated_at text,
        ended_at text,
        status text not null,
        link_confidence real,
        link_reason text,
        metadata text not null default '{}',
        created_at text not null,
        imported_at text not null
      );

      create unique index if not exists conversations_provider_external_unique
        on conversations(provider, provider_conversation_id) where provider_conversation_id is not null;
      create index if not exists idx_conversations_project_updated on conversations(project_id, updated_at desc);
      create index if not exists idx_conversations_task_updated on conversations(task_id, updated_at desc);
      create index if not exists idx_conversations_session on conversations(session_id);
      create index if not exists idx_conversations_source_file on conversations(source_file_id);

      create table if not exists conversation_messages (
        id text primary key,
        conversation_id text not null references conversations(id) on delete cascade,
        provider_message_id text,
        parent_provider_message_id text,
        turn_id text,
        seq integer not null,
        role text not null,
        kind text not null,
        text text not null default '',
        tool_name text,
        tool_status text,
        tool_input_summary text,
        tool_output_summary text,
        redaction_count integer not null default 0,
        token_count integer,
        provider_created_at text,
        metadata text not null default '{}',
        created_at text not null
      );

      create unique index if not exists conversation_messages_provider_unique
        on conversation_messages(conversation_id, provider_message_id) where provider_message_id is not null;
      create unique index if not exists conversation_messages_seq_unique on conversation_messages(conversation_id, seq);
      create index if not exists idx_conversation_messages_conversation_seq on conversation_messages(conversation_id, seq);
      create index if not exists idx_conversation_messages_created on conversation_messages(provider_created_at);
      create index if not exists idx_conversation_messages_tool on conversation_messages(tool_name);

      create table if not exists conversation_deletions (
        id text primary key,
        provider text not null,
        provider_conversation_id text not null,
        source_file_id text,
        deleted_at text not null,
        reason text,
        unique(provider, provider_conversation_id)
      );

      create table if not exists conversation_import_watermarks (
        id text primary key,
        source_id text not null,
        provider text not null,
        source_path text not null,
        parser_version text not null,
        watermark_kind text not null,
        value_ms integer,
        metadata text not null default '{}',
        last_batch_id text,
        created_at text not null,
        updated_at text not null,
        unique(source_id, watermark_kind)
      );
      create index if not exists idx_conversation_import_files_source_state
        on conversation_import_files (source_id, status, parser_version, mtime_ms);
      create index if not exists idx_conversation_import_watermarks_source_kind
        on conversation_import_watermarks (source_id, watermark_kind);

      create virtual table if not exists conversation_history_fts using fts5(
        kind,
        owner_id,
        conversation_id unindexed,
        project_id unindexed,
        task_id unindexed,
        title,
        body,
        tokenize = 'porter unicode61'
      );
    `);
  },

  down(schema) {
    schema.sql(`
      drop table if exists conversation_history_fts;
      drop index if exists idx_conversation_import_watermarks_source_kind;
      drop index if exists idx_conversation_import_files_source_state;
      drop table if exists conversation_import_watermarks;
      drop table if exists conversation_deletions;
      drop index if exists idx_conversation_messages_tool;
      drop index if exists idx_conversation_messages_created;
      drop index if exists idx_conversation_messages_conversation_seq;
      drop index if exists conversation_messages_seq_unique;
      drop index if exists conversation_messages_provider_unique;
      drop table if exists conversation_messages;
      drop index if exists idx_conversations_source_file;
      drop index if exists idx_conversations_session;
      drop index if exists idx_conversations_task_updated;
      drop index if exists idx_conversations_project_updated;
      drop index if exists conversations_provider_external_unique;
      drop table if exists conversations;
      drop table if exists conversation_import_files;
      drop table if exists conversation_import_batches;
    `);
  }
} satisfies Migration;
