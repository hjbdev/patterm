import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_19_000068_add_quiet_notification_turns',
  up(schema) {
    schema.sql(`create table opencode_quiet_notification_prompts (
      session_id text not null,
      message_id text not null,
      primary key (session_id, message_id)
    )`);
    schema.sql(`create table opencode_quiet_notification_steps (
      session_id text not null,
      message_id text not null,
      prompt_id text not null,
      primary key (session_id, message_id)
    )`);
  },
  down(schema) {
    schema.sql('drop table opencode_quiet_notification_steps');
    schema.sql('drop table opencode_quiet_notification_prompts');
  }
} satisfies Migration;
