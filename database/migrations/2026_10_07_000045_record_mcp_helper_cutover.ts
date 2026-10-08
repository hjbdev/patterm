import type { Migration } from '../../app/Database/Migration';

export default {
  name: '2026_10_07_000045_record_mcp_helper_cutover',
  up(schema) {
    // MCP server helpers now say which agent runs them. Agents started before
    // this keep helpers without an identity, which work until they exit.
    schema.sql(`insert or ignore into settings (key, value, updated_at)
      values ('mcp.helper_identity_cutover.v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);
  },
  down(schema) {
    schema.sql(`delete from settings where key = 'mcp.helper_identity_cutover.v1'`);
  }
} satisfies Migration;
