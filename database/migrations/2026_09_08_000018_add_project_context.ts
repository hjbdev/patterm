import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_09_08_000018_add_project_context',
  up({ sql }) {
    sql(`
      alter table sessions add column resumed_from_session_id text references sessions(id) on delete set null;
      create table todos (
        id text primary key, project_id text not null references projects(id) on delete cascade,
        title text not null, notes text not null default '',
        status text not null default 'open' check(status in ('backlog','open','in_progress','completed')),
        priority text not null default 'medium' check(priority in ('low','medium','high')),
        revision integer not null default 1, created_at text not null, updated_at text not null,
        completed_at text, created_by_actor text not null
      );
      create index idx_todos_project_status on todos(project_id,status,updated_at);
      create table todo_dependencies (
        todo_id text not null references todos(id) on delete cascade,
        blocker_id text not null references todos(id) on delete cascade,
        primary key(todo_id,blocker_id), check(todo_id != blocker_id)
      );
      create index idx_todo_dependencies_blocker on todo_dependencies(blocker_id);
      create table todo_assignments (
        todo_id text not null references todos(id) on delete cascade,
        assignee_id text not null,
        session_id text references sessions(id) on delete cascade,
        primary key(todo_id,assignee_id),
        check((assignee_id = 'user' and session_id is null) or (session_id is not null and assignee_id = session_id))
      );
      create index idx_todo_assignments_session on todo_assignments(session_id);
      create table todo_leases (
        todo_id text primary key references todos(id) on delete cascade,
        holder_actor text not null, holder_session_id text references sessions(id) on delete cascade,
        token text not null, expires_at integer not null
      );
      create index idx_todo_leases_session on todo_leases(holder_session_id);
      create table scratchpads (
        id text primary key, project_id text not null references projects(id) on delete cascade,
        title text not null, body text not null default '',
        status text not null default 'active' check(status in ('active','archived')),
        revision integer not null default 1, created_at text not null, updated_at text not null,
        created_by_actor text not null
      );
      create index idx_scratchpads_project_status on scratchpads(project_id,status,updated_at);
      create table session_scratchpads (
        session_id text not null references sessions(id) on delete cascade,
        scratchpad_id text not null references scratchpads(id) on delete cascade,
        primary key(session_id,scratchpad_id)
      );
      create table external_references (
        id text primary key, project_id text not null references projects(id) on delete cascade,
        url text not null, provider text not null, resource_type text not null,
        external_id text, identifier text, title text,
        revision integer not null default 1, created_at text not null, updated_at text not null,
        unique(project_id,url)
      );
      create table todo_references (
        todo_id text not null references todos(id) on delete cascade,
        reference_id text not null references external_references(id) on delete cascade,
        primary key(todo_id,reference_id)
      );
      create table scratchpad_references (
        scratchpad_id text not null references scratchpads(id) on delete cascade,
        reference_id text not null references external_references(id) on delete cascade,
        primary key(scratchpad_id,reference_id)
      );
      create table session_references (
        session_id text not null references sessions(id) on delete cascade,
        reference_id text not null references external_references(id) on delete cascade,
        primary key(session_id,reference_id)
      );
    `);
  },
  down() { throw new Error('Project context migration is forward-only; restore a consistent backup to roll back.'); }
} satisfies Migration;
