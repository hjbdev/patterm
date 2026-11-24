import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_11_24_000070_retire_tui_agents',
  up(schema) {
    schema.sql("delete from harness_installations where harness = 'rawpty'");
    schema.sql("delete from settings where key = 'agents.interface.v1'");
  },
  down() {
    // Harness discovery repopulates installations and settings fall back to defaults.
  }
} satisfies Migration;
