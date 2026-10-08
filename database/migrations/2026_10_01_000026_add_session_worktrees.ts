import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_01_000026_add_session_worktrees',
  up({ sql }) {
    // Worktrees a session works in besides its own working directory
    // (sessions.worktree_id). Abandoning a worktree or deleting a session
    // removes its links.
    sql(`
      create table session_worktrees (
        session_id text not null references sessions(id) on delete cascade,
        worktree_id text not null references worktrees(id) on delete cascade,
        created_at text not null,
        primary key(session_id, worktree_id)
      );
      create index idx_session_worktrees_worktree on session_worktrees(worktree_id);
    `);
  },
  down() { throw new Error('Session worktree links migration is forward-only; restore a consistent backup to roll back.'); }
} satisfies Migration;
