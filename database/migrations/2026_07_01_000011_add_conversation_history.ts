import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_07_01_000011_add_conversation_history',

  up(schema) {
    schema.sql(`
      create table if not exists conversation_import_sources (
        id text primary key,
        provider text not null,
        source_kind text not null,
        path text not null,
        enabled integer not null default 0,
        watch_enabled integer not null default 0,
        created_at text not null,
        updated_at text not null,
        unique(provider, path)
      );

      create table if not exists conversation_import_batches (
        id text primary key,
        trigger text not null,
        provider text,
        source_id text references conversation_import_sources(id) on delete set null,
        project_id text references projects(id) on delete set null,
        task_id text references tasks(id) on delete set null,
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
        source_id text references conversation_import_sources(id) on delete set null,
        batch_id text references conversation_import_batches(id) on delete set null,
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
        project_id text references projects(id) on delete set null,
        task_id text references tasks(id) on delete set null,
        session_id text references sessions(id) on delete set null,
        process_id text references processes(id) on delete set null,
        worktree_id text references worktrees(id) on delete set null,
        source_file_id text references conversation_import_files(id) on delete set null,
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
    `);
  },

  down(schema) {
    schema.sql(`
      drop index if exists idx_conversation_messages_tool;
      drop index if exists idx_conversation_messages_created;
      drop index if exists idx_conversation_messages_conversation_seq;
      drop index if exists conversation_messages_seq_unique;
      drop index if exists conversation_messages_provider_unique;
      drop table if exists conversation_deletions;
      drop table if exists conversation_messages;
      drop index if exists idx_conversations_source_file;
      drop index if exists idx_conversations_session;
      drop index if exists idx_conversations_task_updated;
      drop index if exists idx_conversations_project_updated;
      drop index if exists conversations_provider_external_unique;
      drop table if exists conversations;
      drop table if exists conversation_import_files;
      drop table if exists conversation_import_batches;
      drop table if exists conversation_import_sources;
    `);
  }
} satisfies Migration;
