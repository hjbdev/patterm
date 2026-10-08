import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_07_15_000002_create_history_search_index_state',

  up(schema) {
    schema.sql(`
      create table if not exists conversation_history_index_state (
        conversation_id text primary key references conversations(id) on delete cascade,
        message_count integer not null,
        project_id text,
        task_id text,
        title text not null,
        body_signature text not null
      );

      with stored as (
        select conversations.id, count(conversation_messages.id) as message_count
        from conversations
        left join conversation_messages on conversation_messages.conversation_id = conversations.id
        group by conversations.id
      )
      insert into conversation_history_index_state (conversation_id, message_count, project_id, task_id, title, body_signature)
      select conversations.id, stored.message_count, conversations.project_id, conversations.task_id,
        coalesce(conversations.title, conversations.provider || ' conversation'),
        json_array(conversations.provider, conversations.provider_conversation_id, conversations.cwd, conversations.provider_version,
          conversations.status, conversations.link_reason, conversations.metadata)
      from conversations
      join conversation_import_files on conversation_import_files.id = conversations.source_file_id
      left join conversation_import_batches on conversation_import_batches.id = conversation_import_files.batch_id
      join stored on stored.id = conversations.id
      where conversation_import_files.status in ('imported', 'imported_with_warnings', 'skipped')
        and (conversation_import_files.batch_id is null or conversation_import_batches.status in ('completed', 'completed_with_errors'))
      on conflict(conversation_id) do nothing;

      update conversation_import_files
      set status = 'importing'
      where status in ('imported', 'imported_with_warnings', 'skipped')
        and exists (
          select 1 from conversation_import_batches
          where conversation_import_batches.id = conversation_import_files.batch_id
            and conversation_import_batches.status not in ('completed', 'completed_with_errors')
        );
    `);
  },

  down(schema) {
    schema.dropTableIfExists('conversation_history_index_state');
  }
} satisfies Migration;
