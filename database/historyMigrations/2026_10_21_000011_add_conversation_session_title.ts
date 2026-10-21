import type { Migration } from '../../app/Database/Migration';

// The Patterm session's title (a chosen name or a generated title), kept apart
// from the native title so re-imports never overwrite it.
export default {
  name: '2026_10_21_000011_add_conversation_session_title',
  up(schema) {
    schema.sql('alter table conversations add column session_title text');
    // Deleting a message cascades to summary prose. Without this index every
    // deleted message scanned the whole table, so re-importing a long
    // conversation took seconds.
    schema.sql('create index if not exists idx_summary_prose_message on summary_prose(message_id)');
  },
  down(schema) {
    schema.sql('drop index if exists idx_summary_prose_message');
    schema.sql('alter table conversations drop column session_title');
  }
} satisfies Migration;
