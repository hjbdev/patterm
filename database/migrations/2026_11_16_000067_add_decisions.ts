import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_16_000067_add_decisions',
  up({ sql }) {
    sql(`
      create table decisions (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        session_id text references sessions(id) on delete set null,
        created_by_actor text not null,
        phase text not null,
        decision text not null,
        why text not null,
        evidence text not null,
        result text not null,
        supersedes_id text references decisions(id),
        created_at text not null
      );
      create index idx_decisions_project_session_created on decisions(project_id, session_id, created_at);
      create index idx_decisions_project_created on decisions(project_id, created_at);
      create trigger context_revision_decisions_insert after insert on decisions begin
        update projects set context_revision = context_revision + 1 where id = NEW.project_id;
      end;
      create trigger context_revision_decisions_update after update on decisions begin
        update projects set context_revision = context_revision + 1 where id = NEW.project_id;
      end;
    `);
  },
  down({ sql }) {
    sql(`
      drop trigger if exists context_revision_decisions_update;
      drop trigger if exists context_revision_decisions_insert;
      drop table if exists decisions;
    `);
  }
} satisfies Migration;
