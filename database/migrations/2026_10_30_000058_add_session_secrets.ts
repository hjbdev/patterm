import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_30_000058_add_session_secrets',
  up(schema) {
    // Secrets an agent asked for and the user entered. Each belongs to one
    // session and follows it when the conversation resumes. `ciphertext` stays
    // null until the user fills the request; the key lives outside the
    // database, so backups never hold usable values.
    schema.sql(`create table session_secrets (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      session_id text not null references sessions(id) on delete cascade,
      name text not null,
      kind text not null check (kind in ('api_key', 'login')),
      purpose text not null default '',
      status text not null check (status in ('requested', 'ready')),
      allowed_hosts text not null default '[]',
      uses text not null default '[]',
      injection text,
      ciphertext blob,
      created_at text not null,
      updated_at text not null,
      unique (session_id, name)
    )`);
    schema.sql('create index session_secrets_project_idx on session_secrets (project_id, status)');
  },
  down(schema) {
    schema.sql('drop table session_secrets');
  }
} satisfies Migration;
