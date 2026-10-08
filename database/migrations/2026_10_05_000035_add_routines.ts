import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_05_000035_add_routines',
  up(schema) {
    // Scheduled agent launches. A null project_id is a workspace routine, which
    // runs in the assistant's internal project with reach into every project.
    schema.sql(`create table routines (
      id text primary key,
      project_id text references projects(id) on delete cascade,
      name text not null,
      enabled integer not null default 1,
      days text not null,
      time text not null,
      timezone text not null,
      prompt text not null default '',
      harness text not null,
      preset text,
      model text,
      reasoning text,
      service_tier text,
      delivery text not null default 'notification',
      created_by_type text not null,
      created_by_id text,
      next_run_at text,
      created_at text not null,
      updated_at text not null
    )`);
    schema.sql('create index routines_next_run on routines (enabled, next_run_at)');
    schema.sql(`create table routine_runs (
      id text primary key,
      routine_id text not null references routines(id) on delete cascade,
      scheduled_for text not null,
      started_at text,
      reported_at text,
      finished_at text,
      project_id text,
      session_id text,
      process_id text,
      status text not null,
      report_status text,
      excerpt text,
      created_at text not null
    )`);
    schema.sql('create index routine_runs_routine on routine_runs (routine_id, scheduled_for desc)');
    schema.sql('create index routine_runs_process on routine_runs (process_id)');
  },
  down(schema) {
    schema.sql('drop table routine_runs');
    schema.sql('drop table routines');
  }
} satisfies Migration;
