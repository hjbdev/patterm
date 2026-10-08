import type { Migration } from '../../app/Database/Migration';
import { archiveBeforeTaskRemoval, removeTaskColumns } from '../../app/Services/TaskRemovalArchiveService';

export default {
  name: '2026_09_08_000003_remove_task_scope',
  beforeUp: archiveBeforeTaskRemoval,
  up({ connection: db, sql }) {
    sql('alter table conversation_history_fts rename to previous_history_fts');
    sql(`
      create virtual table conversation_history_fts using fts5(kind, owner_id, conversation_id unindexed, project_id unindexed, title, body, tokenize = 'porter unicode61');
      insert into conversation_history_fts (kind, owner_id, conversation_id, project_id, title, body)
        select kind, owner_id, conversation_id,
          coalesce((select project_id from conversations where conversations.id = previous_history_fts.conversation_id), project_id),
          title, body from previous_history_fts;
      drop table previous_history_fts;
    `);
    removeTaskColumns(db);
  },
  down() {
    throw new Error('Task removal is forward-only. Restore both databases from the verified task-removal archive.');
  }
} satisfies Migration;
