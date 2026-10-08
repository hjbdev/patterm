import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_06_000042_add_project_links',
  up(schema) {
    // A local project and a project on a paired host are the same work. Both
    // hosts keep the link; a project links to at most one project per host.
    schema.sql(`create table if not exists project_links (
      host_id text not null,
      project_id text not null references projects(id) on delete cascade,
      remote_project_id text not null,
      remote_project_name text not null,
      created_at text not null,
      primary key (host_id, project_id),
      unique (host_id, remote_project_id)
    )`);
  },
  down(schema) {
    schema.dropTableIfExists('project_links');
  }
} satisfies Migration;
