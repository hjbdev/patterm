import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_04_000064_add_session_secret_expiry',
  up(schema) {
    // A value lasts at most a day from when the user entered it. Secrets
    // already filled in count from their last save, so old ones expire on the
    // first sweep after upgrading.
    schema.sql('alter table session_secrets add column expires_at text');
    schema.sql(`update session_secrets set expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+1 day') where status = 'ready'`);
  },
  down(schema) {
    schema.sql('alter table session_secrets drop column expires_at');
  }
} satisfies Migration;
