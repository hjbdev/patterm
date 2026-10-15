import type { Migration } from '../../app/Database/Migration';

// The project each context table's rows belong to, as an expression over the
// trigger's NEW or OLD row.
const owners: Record<string, (row: string) => string> = {
  todos: (row) => `${row}.project_id`,
  scratchpads: (row) => `${row}.project_id`,
  external_references: (row) => `${row}.project_id`,
  worktrees: (row) => `${row}.project_id`,
  todo_assignments: (row) => `(select project_id from todos where id = ${row}.todo_id)`,
  todo_dependencies: (row) => `(select project_id from todos where id = ${row}.todo_id)`,
  todo_leases: (row) => `(select project_id from todos where id = ${row}.todo_id)`,
  todo_references: (row) => `(select project_id from todos where id = ${row}.todo_id)`,
  scratchpad_references: (row) => `(select project_id from scratchpads where id = ${row}.scratchpad_id)`,
  session_references: (row) => `(select project_id from sessions where id = ${row}.session_id)`,
  session_scratchpads: (row) => `(select project_id from sessions where id = ${row}.session_id)`,
  session_worktrees: (row) => `(select project_id from sessions where id = ${row}.session_id)`
};

const operations = [['insert', 'NEW'], ['update', 'NEW'], ['delete', 'OLD']] as const;

export default {
  name: '2026_10_15_000049_add_context_revisions',
  up({ sql }) {
    // Counts writes to a project's todos, scratchpads, links, worktrees and
    // their attachments. Clients key cached context reads by it, so a write
    // makes exactly that project's reads stale. Triggers bump it in the
    // write's own transaction, whichever code path writes.
    sql('alter table projects add column context_revision integer not null default 0;');
    for (const [table, owner] of Object.entries(owners)) {
      for (const [operation, row] of operations) {
        sql(`create trigger context_revision_${table}_${operation} after ${operation} on ${table} begin
          update projects set context_revision = context_revision + 1 where id = ${owner(row)};
        end;`);
      }
    }
  },
  down({ sql }) {
    for (const table of Object.keys(owners)) for (const [operation] of operations) sql(`drop trigger if exists context_revision_${table}_${operation};`);
    sql('alter table projects drop column context_revision;');
  }
} satisfies Migration;
