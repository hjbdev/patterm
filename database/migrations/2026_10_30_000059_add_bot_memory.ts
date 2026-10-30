import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_30_000059_add_bot_memory',
  up(schema) {
    // The bot a saved note belongs to. Null for the assistant's notes, so the
    // assistant keeps everything it saved before bots had memory.
    schema.sql('alter table assistant_memory add column bot_id text');
    schema.sql('create index idx_assistant_memory_bot on assistant_memory(bot_id, status, revision)');
  },
  down(schema) {
    schema.sql('drop index idx_assistant_memory_bot');
    schema.sql('delete from assistant_memory where bot_id is not null');
    schema.sql("delete from settings where key like 'bot.memory.revision.v1:%'");
    schema.sql('alter table assistant_memory drop column bot_id');
  }
} satisfies Migration;
