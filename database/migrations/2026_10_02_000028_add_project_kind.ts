import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_02_000028_add_project_kind',
  up(schema) {
    // Workspace projects are the user's repositories. The assistant project is
    // internal: it owns the global assistant session and is never listed.
    schema.sql(`alter table projects add column kind text not null default 'workspace'`);
  },
  down() {
    // The column is retained on rollback; older builds ignore it.
  }
} satisfies Migration;
