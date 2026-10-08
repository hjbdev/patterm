export const INITIAL_SCHEMA_SQL = `
create table if not exists projects (
  id text primary key,
  name text not null,
  path text not null,
  identifier_key text,
  next_task_number integer not null default 1,
  created_at text not null,
  updated_at text not null
);

create table if not exists tasks (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  number integer,
  title text not null,
  priority integer not null default 0,
  status text not null default 'active',
  created_at text not null,
  updated_at text not null
);

create unique index if not exists projects_identifier_key_unique on projects(identifier_key collate nocase);
create unique index if not exists tasks_project_number_unique on tasks(project_id, number);

create table if not exists revisions (
  id text primary key,
  revisionable_type text not null,
  revisionable_id text not null,
  key text not null,
  old_value text,
  new_value text,
  metadata text,
  actor_type text not null,
  actor_id text,
  created_at text not null
);

create table if not exists task_comments (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  kind text not null default 'comment',
  body text not null,
  document_body text not null default '',
  metadata text not null default '{}',
  actor_type text not null,
  actor_id text,
  created_at text not null,
  updated_at text not null
);

create table if not exists sessions (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  task_id text references tasks(id) on delete set null,
  process_id text,
  harness text,
  session_role text not null,
  resume_id text,
  resume_status text not null default 'unknown',
  started_at text not null,
  exited_at text,
  exit_code integer,
  cwd text,
  worktree_id text,
  last_title text,
  last_summary text,
  created_by_actor text
);

create table if not exists processes (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  task_id text references tasks(id) on delete set null,
  parent_process_id text,
  kind text not null,
  name text not null,
  status text not null,
  cwd text,
  argv text,
  created_at text not null,
  updated_at text not null
);

create table if not exists worktrees (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  task_id text references tasks(id) on delete set null,
  repo_path text not null,
  worktree_path text not null,
  branch text,
  created_by text not null,
  created_at text not null
);

create table if not exists issue_links (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  provider text not null,
  external_id text not null,
  url text not null,
  title text,
  body_snapshot text,
  created_at text not null,
  updated_at text not null
);

create table if not exists diff_snapshots (
  id text primary key,
  task_id text references tasks(id) on delete set null,
  worktree_id text references worktrees(id) on delete set null,
  patch text not null,
  metadata text,
  created_at text not null
);

create table if not exists harness_installations (
  id text primary key,
  harness text not null,
  executable_path text not null,
  version text,
  status text not null,
  discovered_at text not null,
  last_checked_at text not null
);

create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at text not null
);

create table if not exists timeline_events (
  id text primary key,
  event_type text not null,
  project_id text references projects(id) on delete cascade,
  task_id text references tasks(id) on delete cascade,
  session_id text references sessions(id) on delete set null,
  process_id text references processes(id) on delete set null,
  actor_type text not null,
  actor_id text,
  metadata text not null default '{}',
  created_at text not null
);

create virtual table if not exists task_artifacts_fts using fts5(
  kind,
  owner_id,
  title,
  body,
  tokenize = 'porter unicode61'
);
`;
