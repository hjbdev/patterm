import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_05_000032_add_integrated_held_prompts',
  up(schema) {
    // Prompts an Integrated agent could not take because a native turn that
    // accepts no input (such as Codex compaction) was running. Each is sent,
    // oldest first, once that turn ends, and deleted when it is sent. error
    // holds why the last attempt failed. An unconfirmed prompt may have
    // reached the agent; it is never sent again, and stays until the
    // transcript confirms it or the user dismisses it.
    schema.sql(`create table integrated_held_prompts (
      seq integer primary key autoincrement,
      process_id text not null,
      message_id text not null,
      payload text not null,
      payload_hash text,
      turn_kind text not null,
      error text,
      state text not null default 'held' check (state in ('held', 'unconfirmed')),
      created_at text not null,
      unique (process_id, message_id)
    )`);
  },
  down(schema) {
    schema.sql('drop table integrated_held_prompts');
  }
} satisfies Migration;
