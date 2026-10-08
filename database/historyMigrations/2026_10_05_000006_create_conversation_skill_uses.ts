import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_05_000006_create_conversation_skill_uses',

  up(schema) {
    schema.sql(`
      create table conversation_skill_uses (
        id integer primary key,
        conversation_id text not null references conversations(id) on delete cascade,
        provider text not null,
        skill text not null,
        invoked_by text not null,
        occurred_at text,
        subagent integer not null default 0
      );
      create index idx_conversation_skill_uses_conversation on conversation_skill_uses(conversation_id);
      create index idx_conversation_skill_uses_occurred on conversation_skill_uses(occurred_at);
    `);
  },

  down(schema) {
    schema.dropTableIfExists('conversation_skill_uses');
  }
} satisfies Migration;
