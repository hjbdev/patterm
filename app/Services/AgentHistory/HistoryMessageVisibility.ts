import type { SqliteConnection } from '../../Database/SqliteConnection';
import { isQuietReply, QUIET_REPLY } from '../ClaudeQuietReplies';

// An early import may index the native reply before the host sees its result.
// Both search and transcript reads consult the same completed-turn decisions.
export class HistoryMessageVisibility {
  private readonly registered = new WeakSet<SqliteConnection>();

  constructor(private readonly quietReplies?: string) {}

  predicate(connection: SqliteConnection): string {
    if (!this.quietReplies) return '1';
    if (!this.registered.has(connection)) {
      connection.registerFunction('patterm_quiet_reply', (sessionId, messageId) =>
        Number(typeof sessionId === 'string' && typeof messageId === 'string' && isQuietReply(this.quietReplies, sessionId, messageId)));
      this.registered.add(connection);
    }
    return `(case when conversation_messages.role = 'assistant' and conversation_messages.kind = 'message'
      and conversation_messages.text = '${QUIET_REPLY}' and json_extract(conversation_messages.metadata, '$.source') = 'claude-jsonl'
      then not patterm_quiet_reply(
        (select provider_conversation_id from conversations where id = conversation_messages.conversation_id),
        json_extract(conversation_messages.metadata, '$.nativeMessageId')
      ) else 1 end)`;
  }

  searchPredicate(connection: SqliteConnection): string {
    if (!this.quietReplies) return '1';
    return `not exists (select 1 from conversation_messages where id = conversation_history_fts.owner_id
      and conversation_history_fts.kind = 'conversation_message' and not ${this.predicate(connection)})`;
  }
}
