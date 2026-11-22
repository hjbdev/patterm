import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_22_000069_add_routine_delivery_bot',
  up(schema) {
    // When delivery is 'bot', reports go to this bot instead of the assistant.
    schema.sql('alter table routines add column delivery_bot_id text');
    // Snapshots the source project or workspace scope when an item is held in
    // Focus mode, so purview changes hide and drop revoked items even if the
    // original routine or run row is later deleted.
    schema.sql('alter table assistant_inbox add column source_scope text');
  },
  down(schema) {
    schema.sql("update routines set delivery = 'notification' where delivery = 'bot'");
    schema.sql('alter table assistant_inbox drop column source_scope');
    schema.sql('alter table routines drop column delivery_bot_id');
  }
} satisfies Migration;
