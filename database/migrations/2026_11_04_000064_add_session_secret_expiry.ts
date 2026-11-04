import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_04_000064_add_session_secret_expiry',
  up(schema) {
    // A value lasts at most a day from when the user entered it. Nothing
    // recorded when older values were entered (updated_at also moves on
    // edits), so they stay null and expire on the first sweep.
    schema.sql('alter table session_secrets add column expires_at text');
  },
  down(schema) {
    schema.sql('alter table session_secrets drop column expires_at');
  }
} satisfies Migration;
