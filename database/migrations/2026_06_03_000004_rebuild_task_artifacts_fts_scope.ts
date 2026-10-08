import type { Migration } from '../../app/Database/Migration';

const CREATE_FTS = `
create virtual table if not exists task_artifacts_fts using fts5(
  kind,
  owner_id,
  project_id unindexed,
  task_id unindexed,
  title,
  body,
  tokenize = 'porter unicode61'
)`;

export default {
  name: '2026_06_03_000004_rebuild_task_artifacts_fts_scope',

  up(schema) {
    schema.dropVirtualTableIfExists('task_artifacts_fts');
    schema.sql(CREATE_FTS);
  },

  down(schema) {
    schema.dropVirtualTableIfExists('task_artifacts_fts');
    schema.sql(`
      create virtual table if not exists task_artifacts_fts using fts5(
        kind,
        owner_id,
        title,
        body,
        tokenize = 'porter unicode61'
      )
    `);
  }
} satisfies Migration;
