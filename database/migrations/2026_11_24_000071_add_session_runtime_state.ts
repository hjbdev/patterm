import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_24_000071_add_session_runtime_state',
  up(schema) {
    schema.sql('alter table sessions add column runtime_state text');
  },
  down(schema) {
    schema.sql('alter table sessions drop column runtime_state');
  }
} satisfies Migration;
