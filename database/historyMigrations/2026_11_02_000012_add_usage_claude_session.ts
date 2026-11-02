import type { Migration } from '../../app/Database/Migration';

// OpenCode's claude-agent responses name the Claude Code session that also
// recorded them, so usage counts the fuller Claude record once it is imported.
export default {
  name: '2026_11_02_000012_add_usage_claude_session',
  up(schema) {
    schema.sql('alter table conversation_usage add column claude_session_id text');
    schema.sql('create index if not exists idx_conversation_usage_claude_session on conversation_usage(claude_session_id) where claude_session_id is not null');
  },
  down(schema) {
    schema.sql('drop index if exists idx_conversation_usage_claude_session');
    schema.sql('alter table conversation_usage drop column claude_session_id');
  }
} satisfies Migration;
