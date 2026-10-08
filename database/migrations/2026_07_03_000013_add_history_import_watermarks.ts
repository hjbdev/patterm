import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_07_03_000013_add_history_import_watermarks',

  up(schema) {
    schema.sql(`
      create table if not exists conversation_import_watermarks (
        id text primary key,
        source_id text not null references conversation_import_sources(id) on delete cascade,
        provider text not null,
        source_path text not null,
        parser_version text not null,
        watermark_kind text not null,
        value_ms integer,
        metadata text not null default '{}',
        last_batch_id text references conversation_import_batches(id) on delete set null,
        created_at text not null,
        updated_at text not null,
        unique(source_id, watermark_kind)
      );
      create index if not exists idx_conversation_import_files_source_state
        on conversation_import_files (source_id, status, parser_version, mtime_ms);
      create index if not exists idx_conversation_import_watermarks_source_kind
        on conversation_import_watermarks (source_id, watermark_kind);
    `);
  },

  down(schema) {
    schema.sql(`
      drop index if exists idx_conversation_import_watermarks_source_kind;
      drop index if exists idx_conversation_import_files_source_state;
      drop table if exists conversation_import_watermarks;
    `);
  }
} satisfies Migration;
