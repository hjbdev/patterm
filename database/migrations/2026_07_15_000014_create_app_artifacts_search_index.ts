import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_07_15_000014_create_app_artifacts_search_index',

  up(schema) {
    schema.sql(`
      create virtual table if not exists app_artifacts_fts using fts5(
        kind,
        owner_id,
        project_id unindexed,
        task_id unindexed,
        title,
        body,
        tokenize = 'porter unicode61'
      );
      delete from settings where key = 'search.app_artifacts_fts.version';
    `);
  },

  down(schema) {
    schema.sql(`delete from settings where key = 'search.app_artifacts_fts.version'`);
    schema.dropVirtualTableIfExists('task_artifacts_fts');
    schema.sql(`alter table app_artifacts_fts rename to task_artifacts_fts`);
  }
} satisfies Migration;
