import type { Migration } from '../../app/Database/Migration';

// Per-session MCP identity mirrors the CLI's mcp-stdio identity token.
export default {
  name: '2026_06_03_000005_add_session_mcp_identity',

  up(schema) {
    try {
      schema.sql('alter table sessions add column mcp_identity text');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column name')) {
        throw error;
      }
    }
    schema.sql('create unique index if not exists sessions_mcp_identity_unique on sessions (mcp_identity) where mcp_identity is not null');
  },

  down() {
    // SQLite column rollback is intentionally additive for this nullable v1 field.
  }
} satisfies Migration;
