import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_04_000063_add_opencode_pending_prompts',
  up(schema) {
    // Prompts OpenCode accepted into its inbox that its transcript has not
    // shown yet, keyed by native session so a resumed process sees them. A
    // pending prompt that leaves the inbox without becoming a message, and
    // that Patterm did not cancel, is marked dropped and offered for resending.
    // An uncertain send waits, untracked, until a check finds it accepted.
    // Rows go once the transcript shows the prompt or the user dismisses it.
    schema.sql(`create table opencode_pending_prompts (
      session_id text not null,
      message_id text not null,
      process_id text not null,
      text text not null,
      files integer not null default 0,
      state text not null default 'pending' check (state in ('uncertain', 'pending', 'dropped')),
      created_at text not null,
      primary key (session_id, message_id)
    )`);
    schema.sql('create index idx_opencode_pending_prompts_process on opencode_pending_prompts (process_id)');
  },
  down(schema) {
    schema.sql('drop table opencode_pending_prompts');
  }
} satisfies Migration;
