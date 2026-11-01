import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_01_000060_add_assistant_bot',
  up(schema) {
    // The assistant is now the built-in bot 'assistant'. Its sessions keep
    // the 'assistant' role and gain the bot ID, so it resumes its thread.
    schema.sql("update sessions set bot_id = 'assistant' where session_role = 'assistant' and bot_id is null");
    // Each bot with Focus mode has its own inbox. Everything held so far was
    // held for the assistant.
    schema.sql("alter table assistant_inbox add column bot_id text not null default 'assistant'");
    schema.sql('drop index idx_assistant_inbox_pending_dedupe');
    schema.sql('create unique index idx_assistant_inbox_pending_dedupe on assistant_inbox (bot_id, dedupe_key) where dedupe_key is not null and digest_id is null');
    schema.sql('drop index idx_assistant_inbox_pending');
    schema.sql('create index idx_assistant_inbox_pending on assistant_inbox (bot_id, delivered_at, seq)');
    // Focus mode is per bot too.
    schema.sql("insert or ignore into settings (key, value, updated_at) select 'bot.focus.v1:assistant', value, updated_at from settings where key = 'assistant.focus.v1'");
    schema.sql("delete from settings where key = 'assistant.focus.v1'");
  },
  down(schema) {
    schema.sql("insert or ignore into settings (key, value, updated_at) select 'assistant.focus.v1', value, updated_at from settings where key = 'bot.focus.v1:assistant'");
    schema.sql("delete from settings where key like 'bot.focus.v1:%'");
    schema.sql("delete from assistant_inbox where bot_id <> 'assistant'");
    schema.sql('drop index idx_assistant_inbox_pending');
    schema.sql('create index idx_assistant_inbox_pending on assistant_inbox (delivered_at, seq)');
    schema.sql('drop index idx_assistant_inbox_pending_dedupe');
    schema.sql('create unique index idx_assistant_inbox_pending_dedupe on assistant_inbox (dedupe_key) where dedupe_key is not null and digest_id is null');
    schema.sql('alter table assistant_inbox drop column bot_id');
    schema.sql("update sessions set bot_id = null where session_role = 'assistant'");
  }
} satisfies Migration;
