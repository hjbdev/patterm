import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_12_000047_add_auto_titles',
  up(schema) {
    schema.sql('alter table sessions add column auto_title text');
    schema.sql('alter table processes add column auto_status text');
    // The name shown for a session: a chosen name, then a generated title, then
    // the native CLI's own. Callers fall back to processes.name after this.
    schema.sql('alter table sessions add column title text generated always as (coalesce(display_name, auto_title, last_title)) virtual');
    // An earlier restart copied the harness's placeholder title into the
    // display name, where it hid every later title. Nobody chose those names.
    schema.sql(`update sessions set display_name = null where title_set_by_user = 0
      and display_name in ('Claude Code', 'Codex', 'OpenCode', 'Amp')`);
  },
  down(schema) {
    schema.sql('alter table sessions drop column title');
    schema.sql('alter table processes drop column auto_status');
    schema.sql('alter table sessions drop column auto_title');
  }
} satisfies Migration;
