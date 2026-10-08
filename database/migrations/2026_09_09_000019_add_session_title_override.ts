import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_09_09_000019_add_session_title_override',
  up(schema) {
    schema.sql('alter table sessions add column title_set_by_user integer not null default 0');
    // Existing custom names have no provenance, so preserve them as user overrides.
    schema.sql('update sessions set title_set_by_user = 1 where display_name is not null');
  },
  down() {
    // Preserve user overrides on rollback.
  }
} satisfies Migration;
