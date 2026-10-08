import type { Migration } from '../../app/Database/Migration';

const migration = {
  name: '2026_09_30_000023_add_notifications',
  up(schema) {
    schema.sql(`create table notifications (
      id text primary key,
      project_id text references projects(id) on delete cascade,
      process_id text references processes(id) on delete cascade,
      session_id text references sessions(id) on delete set null,
      source text not null check (source in ('mcp', 'terminal', 'integrated', 'runtime', 'system')),
      kind text not null check (kind in ('attention', 'permission', 'turn_finished', 'bell', 'message', 'failure')),
      urgency text not null check (urgency in ('low', 'normal', 'high')),
      delivery text not null check (delivery in ('in_app', 'all')),
      audience text not null default 'user' check (audience in ('user', 'parent')),
      routed_to_process_id text,
      title text not null,
      body text not null default '',
      dedupe_key text,
      occurrences integer not null default 1,
      created_at text not null,
      updated_at text not null,
      read_at text,
      resolved_at text
    )`);
    schema.sql('create index idx_notifications_project_open on notifications (project_id, resolved_at, created_at)');
    schema.sql('create index idx_notifications_process_open on notifications (process_id, resolved_at)');
    schema.sql(`create table push_subscriptions (
      id text primary key,
      endpoint text not null unique,
      p256dh text not null,
      auth text not null,
      label text not null default '',
      created_at text not null,
      last_success_at text,
      failure_count integer not null default 0
    )`);
  },
  down(schema) {
    schema.sql('drop table push_subscriptions');
    schema.sql('drop table notifications');
  }
} satisfies Migration;

export default migration;
