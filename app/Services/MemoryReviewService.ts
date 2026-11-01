import { z } from 'zod';
import type { DatabaseService } from './DatabaseService';
import type { AgentHistoryReadService } from './AgentHistory/AgentHistoryReadService';

// When the review last covered everything imported. Conversations imported
// before it have nothing new unless their mark says otherwise.
const COVERED_KEY = 'memory.review.covered.v1';
// A first review, and a conversation first seen mid-way, look back this far.
const FIRST_LOOKBACK_MS = 7 * 86_400_000;
// An import stamps imported_at when it starts, and a large one can finish well
// after a review began. Each review looks this far behind the last covered
// time; marks keep the overlap from being read twice.
const IMPORT_OVERLAP_MS = 86_400_000;
// Bytes counted per message for its seq, speaker and time.
const MESSAGE_OVERHEAD = 80;
const MESSAGES_PER_CONVERSATION = 200;

export const memoryReviewActivityInput = z.object({
  max_bytes: z.number().int().min(4000).max(100_000).default(40_000)
}).strict();

interface Page {
  marks: Array<{ conversation_id: string; seq: number }>;
  complete: boolean;
  started_at: string;
}

export interface MemoryReviewCaller { sessionId: string; processId: string | null }

// Reads new conversation activity across every project for the nightly memory
// review, in pages. Each conversation keeps the last message reviewed, so a
// long-running session is read only from where the last review stopped. A page
// counts as reviewed only once the caller checkpoints it.
export class MemoryReviewService {
  private readonly pending = new Map<string, Page>();

  constructor(
    private readonly database: DatabaseService,
    private readonly history: Pick<AgentHistoryReadService, 'newProse'>,
    private readonly clock: () => Date = () => new Date()
  ) {}

  activity(raw: unknown, caller: MemoryReviewCaller) {
    const input = memoryReviewActivityInput.parse(raw ?? {});
    const db = this.database.connection;
    const startedAt = this.clock().toISOString();
    const lookback = new Date(this.clock().getTime() - FIRST_LOOKBACK_MS).toISOString();
    const covered = (db.prepare('select value from settings where key = ?').get(COVERED_KEY) as { value: string } | undefined)?.value ?? lookback;
    const marks = new Map((db.prepare('select conversation_id, seq from memory_review_marks').all() as Array<{ conversation_id: string; seq: number }>).map((row) => [row.conversation_id, row.seq]));
    const importedSince = new Date(Date.parse(covered) - IMPORT_OVERLAP_MS).toISOString();
    const found = this.history.newProse({ importedSince, firstSince: lookback, marks, excludeSessions: this.ownSessions(caller), limit: MESSAGES_PER_CONVERSATION });
    if (!found) throw new Error('Conversation history is unavailable, so activity cannot be reviewed. Report the review as failed.');
    const projects = new Map((db.prepare('select id, name from projects').all() as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]));
    const roles = this.sessionRoles(found.map((row) => row.session_id).filter((id): id is string => Boolean(id)));
    type Message = { seq: number; speaker: string; at: string; text: string };
    const conversations: Array<{ conversation_id: string; title: string | null; project_id: string | null; project_name: string | null; provider: string; session_role: string | null; from_seq: number; through_seq: number; more: boolean; messages: Message[] }> = [];
    let used = 0;
    let full = false;
    for (const row of found) {
      const messages: Message[] = [];
      for (const message of row.messages) {
        // Messages are whole. Only one larger than a whole page is cut, and it
        // says where to read the rest, so nothing past a mark goes unread.
        let text = message.text;
        if (!used && Buffer.byteLength(text, 'utf8') + MESSAGE_OVERHEAD > input.max_bytes) {
          text = `${Buffer.from(text, 'utf8').subarray(0, input.max_bytes - MESSAGE_OVERHEAD - 200).toString('utf8').replace(/\uFFFD$/, '')}… [cut: read the whole message with history_get conversation_id=${row.id} anchor at seq ${message.seq}]`;
        }
        const size = Buffer.byteLength(text, 'utf8') + MESSAGE_OVERHEAD;
        if (used && used + size > input.max_bytes) { full = true; break; }
        messages.push({ seq: message.seq, speaker: message.speaker, at: message.at, text });
        used += size;
      }
      if (messages.length) {
        conversations.push({
          conversation_id: row.id, title: row.title, project_id: row.project_id, project_name: row.project_id ? projects.get(row.project_id) ?? null : null,
          provider: row.provider, session_role: row.session_id ? roles.get(row.session_id) ?? null : null,
          from_seq: messages[0]!.seq, through_seq: messages.at(-1)!.seq, more: messages.length < row.messages.length || row.truncated, messages
        });
      }
      if (full) break;
    }
    const remaining = found.length - conversations.filter((row) => !row.more).length;
    this.pending.set(caller.sessionId, { marks: conversations.map((row) => ({ conversation_id: row.conversation_id, seq: row.through_seq })), complete: remaining === 0, started_at: startedAt });
    return {
      coverage: remaining === 0 ? 'complete' as const : 'partial' as const,
      conversations,
      remaining_conversations: remaining,
      next: remaining === 0
        ? 'This is all new activity. Record what is worth keeping, then call memory_review_checkpoint.'
        : 'More activity remains. Record what is worth keeping from this page, call memory_review_checkpoint, then call memory_review_activity again.'
    };
  }

  // Marks the caller's last page as reviewed. Without a checkpoint, the next
  // review reads the same activity again.
  checkpoint(caller: MemoryReviewCaller) {
    const page = this.pending.get(caller.sessionId);
    if (!page) throw new Error('No activity page to checkpoint. Call memory_review_activity first.');
    const db = this.database.connection;
    db.transaction(() => {
      const upsert = db.prepare(`insert into memory_review_marks(conversation_id, seq, reviewed_at) values(?, ?, ?)
        on conflict(conversation_id) do update set seq = max(seq, excluded.seq), reviewed_at = excluded.reviewed_at`);
      for (const mark of page.marks) upsert.run(mark.conversation_id, mark.seq, page.started_at);
      // Imports still running at started_at are caught by the next review's overlap.
      if (page.complete) db.prepare('insert into settings(key, value, updated_at) values(?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at').run(COVERED_KEY, page.started_at, page.started_at);
    })();
    this.pending.delete(caller.sessionId);
    return { ok: true, conversations: page.marks.length, coverage: page.complete ? 'complete' : 'partial' };
  }

  // A review never reads its own conversations, or earlier runs of the same routine.
  private ownSessions(caller: MemoryReviewCaller): Set<string> {
    const rows = caller.processId ? this.database.connection.prepare(`select sessions.id from routine_runs mine
      join routine_runs runs on runs.routine_id = mine.routine_id
      join sessions on sessions.process_id = runs.process_id
      where mine.process_id = ?`).all(caller.processId) as Array<{ id: string }> : [];
    return new Set([caller.sessionId, ...rows.map((row) => row.id)]);
  }

  private sessionRoles(ids: string[]): Map<string, string> {
    if (!ids.length) return new Map();
    const rows = this.database.connection.prepare(`select id, session_role from sessions where id in (select value from json_each(?))`).all(JSON.stringify([...new Set(ids)])) as Array<{ id: string; session_role: string }>;
    return new Map(rows.map((row) => [row.id, row.session_role]));
  }
}
