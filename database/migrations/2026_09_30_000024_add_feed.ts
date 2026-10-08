import type { Migration } from '../../app/Database/Migration';

const migration = {
  name: '2026_09_30_000024_add_feed',
  up(schema) {
    // Author name and harness are kept from posting time so a thread still
    // reads correctly after its session is deleted.
    schema.sql(`create table feed_threads (
      id text primary key,
      project_id text not null references projects(id) on delete cascade,
      session_id text references sessions(id) on delete set null,
      process_id text,
      author_name text not null,
      author_harness text,
      recap text not null,
      tone text not null default 'progress' check (tone in ('progress', 'question', 'blocked', 'done')),
      liked_at text,
      created_at text not null
    )`);
    schema.sql('create index idx_feed_threads_created on feed_threads (created_at, id)');
    schema.sql('create index idx_feed_threads_project_created on feed_threads (project_id, created_at, id)');
    schema.sql(`create table feed_posts (
      thread_id text not null references feed_threads(id) on delete cascade,
      position integer not null check (position >= 0),
      body text not null,
      images text not null default '[]',
      primary key (thread_id, position)
    )`);
  },
  down(schema) {
    schema.sql('drop table feed_posts');
    schema.sql('drop table feed_threads');
  }
} satisfies Migration;

export default migration;
