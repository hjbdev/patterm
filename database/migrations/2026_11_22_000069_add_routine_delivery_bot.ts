import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_22_000069_add_routine_delivery_bot',
  up(schema) {
    // When delivery is 'bot', reports go to this bot instead of the assistant.
    schema.sql('alter table routines add column delivery_bot_id text');
  },
  down(schema) {
    schema.sql('alter table routines drop column delivery_bot_id');
  }
} satisfies Migration;
