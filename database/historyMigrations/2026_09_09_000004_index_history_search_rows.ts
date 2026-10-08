import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_09_09_000004_index_history_search_rows',

  up(schema) {
    // FTS5 cannot index equality lookups on its unindexed conversation_id.
    // Preserve existing FTS row IDs and content while adding a small B-tree lookup.
    schema.sql(`
      create table conversation_history_rows (
        fts_rowid integer primary key,
        conversation_id text not null
      );
      insert into conversation_history_rows (fts_rowid, conversation_id)
        select rowid, coalesce(conversation_id, owner_id) from conversation_history_fts;
      create index idx_history_rows_conversation on conversation_history_rows(conversation_id);
    `);
  },

  down(schema) {
    schema.dropTableIfExists('conversation_history_rows');
  }
} satisfies Migration;
