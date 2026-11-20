import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_20_000068_add_missing_performance_indexes',

  up(schema) {
    schema.sql(`
      create index if not exists idx_processes_project_status_created
        on processes (project_id, status, created_at);
      create index if not exists idx_processes_parent
        on processes (parent_process_id);
      create index if not exists idx_processes_project_exited
        on processes (project_id, exited_at);
      create index if not exists idx_sessions_process_id
        on sessions (process_id);
      create index if not exists idx_sessions_project_started
        on sessions (project_id, started_at);
      create index if not exists idx_sessions_project_exited
        on sessions (project_id, exited_at);
      create index if not exists idx_timeline_events_process_type_created
        on timeline_events (process_id, event_type, created_at);
      create index if not exists idx_timeline_events_type_created
        on timeline_events (event_type, created_at);
      create table if not exists app_artifacts_fts_rows (
        kind text not null,
        owner_id text not null,
        fts_rowid integer not null,
        primary key (kind, owner_id, fts_rowid)
      );
      create index if not exists idx_app_artifacts_fts_rows_owner
        on app_artifacts_fts_rows (owner_id);
    `);

    const hasFts = schema.connection
      .prepare(`select 1 from sqlite_master where type = 'table' and name = 'app_artifacts_fts'`)
      .get();
    if (hasFts) {
      schema.sql(`
        delete from app_artifacts_fts_rows;
        insert or ignore into app_artifacts_fts_rows (kind, owner_id, fts_rowid)
        select kind, owner_id, rowid from app_artifacts_fts;
      `);
    }
  },

  down(schema) {
    schema.sql(`
      drop index if exists idx_app_artifacts_fts_rows_owner;
      drop table if exists app_artifacts_fts_rows;
      drop index if exists idx_timeline_events_type_created;
      drop index if exists idx_timeline_events_process_type_created;
      drop index if exists idx_sessions_project_exited;
      drop index if exists idx_sessions_project_started;
      drop index if exists idx_sessions_process_id;
      drop index if exists idx_processes_project_exited;
      drop index if exists idx_processes_parent;
      drop index if exists idx_processes_project_status_created;
    `);
  }
} satisfies Migration;
