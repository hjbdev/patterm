import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_10_000066_add_figure_templates',
  up(schema) {
    // Saved pages for html_render, shared by the whole workspace. Each
    // version is written once and never changed, so a figure that names one
    // draws the same page for good. Who published it is Patterm's record of
    // the caller, never something the caller says.
    schema.sql(`create table figure_templates (
      name text not null,
      version integer not null,
      description text not null default '',
      html text not null,
      schema_json text not null,
      example_json text not null,
      sha256 text not null,
      published_by_role text not null,
      published_by_name text,
      published_by_session_id text,
      published_at text not null,
      primary key (name, version)
    )`);
  },
  down(schema) {
    schema.sql('drop table figure_templates');
  }
} satisfies Migration;
