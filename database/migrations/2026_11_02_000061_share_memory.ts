import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_02_000061_share_memory',
  up(schema) {
    // Who wrote each note. Existing notes keep bot_id as their original owner.
    schema.sql("alter table assistant_memory add column author_role text not null default 'assistant'");
    schema.sql('alter table assistant_memory add column author_name text');
    schema.sql('alter table assistant_memory add column author_session_id text');
    schema.sql('alter table assistant_memory add column author_harness text');
    schema.sql('alter table assistant_memory add column evidence text');
    schema.sql("update assistant_memory set author_role = 'bot', author_name = bot_id where bot_id is not null");
    // One revision for the shared store. Every note moves to a revision above
    // all the old per-owner counters, so any revision a running assistant or
    // bot remembers yields a delta of everything, which asks for a refresh.
    schema.sql(`insert into settings(key, value, updated_at)
      select 'assistant.memory.revision.v1', cast(coalesce(max(cast(value as integer)), 0) + 1 as text), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      from settings where key = 'assistant.memory.revision.v1' or key like 'bot.memory.revision.v1:%'
      on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`);
    schema.sql("update assistant_memory set revision = (select cast(value as integer) from settings where key = 'assistant.memory.revision.v1')");
    schema.sql("delete from settings where key like 'bot.memory.revision.v1:%'");
    schema.sql('drop index if exists idx_assistant_memory_bot');
    // The last message of each imported conversation the memory review has read.
    schema.sql(`create table memory_review_marks (
      conversation_id text primary key,
      seq integer not null,
      reviewed_at text not null
    )`);
  },
  down(schema) {
    // Notes stay; bots read from revision 0 again after a downgrade.
    schema.sql('drop table memory_review_marks');
    schema.sql("delete from settings where key = 'memory.review.covered.v1'");
    schema.sql('create index if not exists idx_assistant_memory_bot on assistant_memory(bot_id, status, revision)');
    for (const column of ['evidence', 'author_harness', 'author_session_id', 'author_name', 'author_role']) schema.sql(`alter table assistant_memory drop column ${column}`);
  }
} satisfies Migration;
