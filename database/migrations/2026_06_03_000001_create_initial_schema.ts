import type { Migration } from '../../app/Database/Migration';
import { INITIAL_SCHEMA_SQL } from '../schema/initialSchema';

export default {
  name: '2026_06_03_000001_create_initial_schema',

  up(schema) {
    schema.sql(INITIAL_SCHEMA_SQL);
  },

  down(schema) {
    schema.dropVirtualTableIfExists('task_artifacts_fts');
    schema.dropTableIfExists('timeline_events');
    schema.dropTableIfExists('settings');
    schema.dropTableIfExists('harness_installations');
    schema.dropTableIfExists('diff_snapshots');
    schema.dropTableIfExists('issue_links');
    schema.dropTableIfExists('worktrees');
    schema.dropTableIfExists('processes');
    schema.dropTableIfExists('sessions');
    schema.dropTableIfExists('task_comments');
    schema.dropTableIfExists('revisions');
    schema.dropTableIfExists('tasks');
    schema.dropTableIfExists('projects');
  }
} satisfies Migration;
