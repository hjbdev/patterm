import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_05_000031_add_assistant_inbox',
  up(schema) {
    // Incoming items held for the assistant while Focus mode is on, kept
    // until a digest delivers them. digest_id marks the flush that claimed an
    // item; delivered_at is set once that flush's delivery is acknowledged.
    schema.sql(`create table assistant_inbox (
      seq integer primary key autoincrement,
      id text not null unique,
      kind text not null check (kind in ('notification', 'agent_message', 'report', 'timer', 'agent_notice')),
      source_process_id text,
      title text not null default '',
      body text not null,
      dedupe_key text,
      occurrences integer not null default 1,
      created_at text not null,
      updated_at text not null,
      digest_id text,
      delivered_at text,
      delivery text check (delivery in ('delivered', 'uncertain'))
    )`);
    // Repeats coalesce only into an item no flush has claimed yet.
    schema.sql('create unique index idx_assistant_inbox_pending_dedupe on assistant_inbox (dedupe_key) where dedupe_key is not null and digest_id is null');
    schema.sql('create index idx_assistant_inbox_digest on assistant_inbox (digest_id, seq)');
    schema.sql('create index idx_assistant_inbox_pending on assistant_inbox (delivered_at, seq)');
  },
  down(schema) {
    schema.sql('drop table assistant_inbox');
  }
} satisfies Migration;
