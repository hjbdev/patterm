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
    // Backfill existing process-less project notifications from their dedupe_key
    // (`notification:<project_id|patterm>:<kind>`) so upgraded databases enforce
    // purview after a bot is narrowed.
    schema.sql(`update assistant_inbox
      set source_scope = case
        when substr(dedupe_key, 14, instr(substr(dedupe_key, 14), ':') - 1) = 'patterm' then 'workspace'
        else 'project:' || substr(dedupe_key, 14, instr(substr(dedupe_key, 14), ':') - 1)
      end
      where source_scope is null and kind = 'notification' and source_process_id is null
        and dedupe_key like 'notification:%:%' and instr(substr(dedupe_key, 14), ':') > 1`);
  },
  down(schema) {
    schema.sql("update routines set delivery = 'notification' where delivery = 'bot'");
    schema.sql('alter table assistant_inbox drop column source_scope');
    schema.sql('alter table routines drop column delivery_bot_id');
  }
} satisfies Migration;
