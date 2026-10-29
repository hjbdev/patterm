import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_29_000057_add_session_bot',
  up(schema) {
    // The bot a session runs, so each bot keeps one live session and resumes
    // its latest after a restart. Null for every other agent.
    schema.sql('alter table sessions add column bot_id text');
    schema.sql('create index sessions_bot_id_idx on sessions (bot_id, started_at)');
  },
  down(schema) {
    schema.sql('drop index sessions_bot_id_idx');
    schema.sql('alter table sessions drop column bot_id');
  }
} satisfies Migration;
