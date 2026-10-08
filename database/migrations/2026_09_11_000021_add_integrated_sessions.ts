import type { Migration } from '../../app/Database/Migration';

const migration = {
  name: '2026_09_11_000021_add_integrated_sessions',
  up(schema) {
    schema.sql("alter table sessions add column interface_mode text not null default 'tui' check (interface_mode in ('tui', 'integrated'))");
  },
  down(schema) {
    schema.sql('alter table sessions drop column interface_mode');
  }
} satisfies Migration;

export default migration;
