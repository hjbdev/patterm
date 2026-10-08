import type { Migration } from '../../app/Database/Migration';
import { archiveBeforeTaskRemoval, removeTaskColumns } from '../../app/Services/TaskRemovalArchiveService';

export default {
  name: '2026_09_08_000017_remove_tasks',
  beforeUp: archiveBeforeTaskRemoval,
  up({ connection: db, sql }) {
    sql(`
      alter table diff_snapshots add column project_id text references projects(id) on delete cascade;
      update diff_snapshots set project_id = coalesce(
        (select project_id from tasks where tasks.id = diff_snapshots.task_id),
        (select project_id from worktrees where worktrees.id = diff_snapshots.worktree_id));
      update timeline_events set project_id = coalesce(project_id,
        (select project_id from tasks where tasks.id = timeline_events.task_id),
        (select project_id from sessions where sessions.id = timeline_events.session_id),
        (select project_id from processes where processes.id = timeline_events.process_id));
      update conversations set project_id = coalesce(project_id, (select project_id from tasks where tasks.id = conversations.task_id));
      update conversation_import_batches set project_id = coalesce(project_id, (select project_id from tasks where tasks.id = conversation_import_batches.task_id));
      delete from revisions where revisionable_type in ('task', 'task_comment', 'spec', 'decision', 'check_in', 'summary', 'issue_link')
        or revisionable_id in (select id from tasks union select id from task_comments union select id from issue_links);
      drop table task_comments;
      drop table issue_links;
      drop table task_artifacts_fts;
      drop table app_artifacts_fts;
    `);
    // Drop the task FK columns before the tasks table: timeline's old FK cascades.
    removeTaskColumns(db);
    sql(`
      drop table tasks;
      drop index projects_identifier_key_unique;
      alter table projects drop column identifier_key;
      alter table projects drop column next_task_number;
      create index idx_diff_snapshots_project_created on diff_snapshots(project_id, created_at desc);
      create virtual table app_artifacts_fts using fts5(kind, owner_id, project_id unindexed, title, body, tokenize = 'porter unicode61');
      delete from settings where key = 'search.app_artifacts_fts.version' or key like '%task%';
    `);
    const settings = db.prepare("select key, value from settings where key in ('ui.sidebar.expanded.v1', 'ui.workspace.layout.v1')").all() as Array<{ key: string; value: string }>;
    for (const setting of settings) {
      let value: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(setting.value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid settings');
        value = parsed as Record<string, unknown>;
      } catch {
        // The old settings reader also fell back to defaults for malformed JSON.
        db.prepare('delete from settings where key = ?').run(setting.key);
        continue;
      }
      delete value.tasks;
      delete value.knownTasks;
      delete value.taskPaneVisible;
      db.prepare('update settings set value = ? where key = ?').run(JSON.stringify(value), setting.key);
    }
    if (db.prepare('pragma foreign_key_check').all().length) throw new Error('foreign key validation failed after task removal');
  },
  down() {
    throw new Error('Task removal is forward-only. Stop the application and restore both databases from the verified task-removal archive with the previous application version.');
  }
} satisfies Migration;
