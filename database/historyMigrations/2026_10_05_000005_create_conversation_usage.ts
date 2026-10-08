import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_05_000005_create_conversation_usage',

  up(schema) {
    schema.sql(`
      create table conversation_usage (
        id integer primary key,
        conversation_id text not null references conversations(id) on delete cascade,
        provider text not null,
        model text,
        occurred_at text,
        input_tokens integer not null default 0,
        cache_read_tokens integer not null default 0,
        cache_write_tokens integer not null default 0,
        cache_write_1h_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cost_usd real,
        subagent integer not null default 0
      );
      create index idx_conversation_usage_conversation on conversation_usage(conversation_id);
      create index idx_conversation_usage_occurred on conversation_usage(occurred_at);

      create table provider_rate_limits (
        provider text not null,
        limit_key text not null,
        label text not null,
        used_percent real not null,
        window_minutes integer,
        resets_at text,
        observed_at text not null,
        primary key (provider, limit_key)
      );
    `);
  },

  down(schema) {
    schema.dropTableIfExists('provider_rate_limits');
    schema.dropTableIfExists('conversation_usage');
  }
} satisfies Migration;
