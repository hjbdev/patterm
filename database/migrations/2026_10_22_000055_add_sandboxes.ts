import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_22_000055_add_sandboxes',
  up(schema) {
    // A remote machine holding one worktree. Agents launched on that
    // worktree run here with their own logins, while their file and shell
    // tools run on the remote copy at the same absolute path. Its work is
    // synced back into the local worktree, which records the last state it
    // received. A deleted sandbox keeps its row so its agents' history
    // still names it.
    schema.sql(`
      create table sandboxes (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        worktree_id text references worktrees(id) on delete set null,
        backend text not null,
        remote_name text not null,
        path text not null,
        status text not null,
        error text,
        exec_token text,
        exec_port integer,
        synced_head text,
        synced_tree text,
        synced_at text,
        sync_error text,
        created_at text not null,
        updated_at text not null,
        deleted_at text
      )
    `);
    schema.sql('create unique index sandboxes_live_worktree on sandboxes(worktree_id) where deleted_at is null');
  },
  down(schema) {
    schema.sql('drop index if exists sandboxes_live_worktree');
    schema.dropTableIfExists('sandboxes');
  }
} satisfies Migration;
