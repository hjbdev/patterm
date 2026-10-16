import { z } from 'zod';
import type { DatabaseService } from './DatabaseService';
import type { IntegratedAgentService } from './IntegratedAgentService';
import type { AgentHistoryReadService } from './AgentHistory/AgentHistoryReadService';
import { type ConversationRow, headUtf8, historyRows, rowBody, snapshotRows } from './ConversationText';

export const conversationOutputInput = z.object({
  process_id: z.string().min(1).describe('Agent process ID to read.'),
  limit: z.number().int().positive().max(100).default(20).describe('Most messages to return; default 20, at most 100.'),
  before: z.string().min(1).optional().describe('next_before from the previous page, to read the messages before it.'),
  include: z.array(z.enum(['tools', 'reasoning', 'notices'])).default([])
    .describe('Rows to add to user and assistant text: tool calls with their output, reasoning, or notices such as retries.'),
  max_bytes: z.number().int().positive().max(64_000).default(16_000)
    .describe('Most UTF-8 bytes of message titles and text in the page, latest_answer included; default 16000, at most 64000. Titles are cut to 200 bytes, and last_report.body to 4000 bytes on its own.')
});

type Include = z.infer<typeof conversationOutputInput>['include'][number];
type Source = 'live' | 'native' | 'archive' | 'history';

interface Batch {
  rows: ConversationRow[];
  // Cursor of the batch before this one, or null at the start of the conversation.
  older: string | null;
  source: Source;
}

// A position in the conversation: rows strictly before `id` in batch `b`, or
// the whole batch when `id` is null. `k` names the reader that made it.
interface Cursor { k: 'live' | 'history'; b: string | null; id: string | null }

interface ProcessRow {
  id: string;
  name: string;
  project_id: string;
  status: string;
  activity: string | null;
  updated_at: string;
  exited_at: string | null;
  session_id: string | null;
  harness: string | null;
  resume_id: string | null;
  interface_mode: string | null;
  session_exited_at: string | null;
}

// One call reads a bounded amount however sparse the included rows are.
const MAX_BATCHES = 4;
const MAX_SCANNED = 1_000;
const HISTORY_BATCH = 200;
// Snapshot statuses that are activities, as IntegratedAgentService accepts them.
const ACTIVITIES = new Set(['working', 'thinking', 'idle', 'permission', 'question', 'error']);
// Reports have no size limit of their own; readers get the start of one.
const REPORT_BYTES = 4_000;
const TITLE_BYTES = 200;

// Reads an agent's conversation in bounded pages, newest first, for
// orchestrators. A live Integrated agent is read from its runtime and then
// from the same older pages the transcript view loads: the provider's own
// for Codex and OpenCode, imported history for Claude. Other agents are read
// from imported history, which can be behind them.
export class ConversationOutputService {
  constructor(
    private readonly database: DatabaseService,
    private readonly integrated: Pick<IntegratedAgentService, 'conversation' | 'olderMessages'> | null,
    private readonly history: Pick<AgentHistoryReadService, 'conversationIdForSession' | 'tail'> | null
  ) {}

  async read(raw: z.input<typeof conversationOutputInput>) {
    const input = conversationOutputInput.parse(raw);
    const process = this.process(input.process_id);
    if (!process) throw new Error(`unknown process: ${input.process_id}`);
    const live = Boolean(this.integrated) && process.interface_mode === 'integrated' && !process.session_exited_at && process.status === 'running';
    const kind = live ? 'live' : 'history';
    const cursor = input.before ? decodeCursor(input.before) : null;
    if (cursor && cursor.k !== kind) throw new Error('get_conversation_output: cursor expired; read again without before');

    // Set by the loader as it reads.
    const read: { snapshot: Record<string, unknown> | null; conversationId: string | null; importedAt: string | null } = { snapshot: null, conversationId: null, importedAt: null };
    const load = async (batch: string | null): Promise<Batch> => {
      if (live && batch === null) {
        const snapshot = (await this.integrated!.conversation(process.id) ?? {}) as Record<string, unknown>;
        read.snapshot = snapshot;
        return { rows: snapshotRows(snapshot), older: snapshotCursor(snapshot), source: 'live' };
      }
      if (live) {
        const page = (await this.integrated!.olderMessages(process.id, batch!) ?? {}) as Record<string, unknown>;
        const older = typeof page.cursor === 'string' ? page.cursor : null;
        if (Array.isArray(page.archived_messages)) return { rows: historyRows(page.archived_messages as Parameters<typeof historyRows>[0]), older, source: 'archive' };
        return { rows: snapshotRows(page), older, source: 'native' };
      }
      read.conversationId ??= this.linkedConversation(process);
      if (!read.conversationId || !this.history) return { rows: [], older: null, source: 'history' };
      const tail = this.history.tail(read.conversationId, HISTORY_BATCH, batch === null ? undefined : Number(batch));
      read.importedAt = tail.conversation?.importedAt ?? null;
      const first = tail.messages[0];
      return { rows: historyRows(tail.messages), older: tail.has_more && first ? String(first.seq) : null, source: 'history' };
    };

    // Each batch is read once per call; the page and the latest-answer search
    // share them. A live agent's snapshot is always read, for its turn state.
    const batches = new Map<string | null, Promise<Batch>>();
    const loadOnce = (key: string | null) => {
      let batch = batches.get(key);
      if (!batch) { batch = load(key); batches.set(key, batch); }
      return batch;
    };
    if (live) await loadOnce(null);

    let budget = input.max_bytes;
    let batchCursor = cursor?.b ?? null;
    let batch = await loadOnce(batchCursor);

    const include = new Set<Include>(input.include);
    const page: Array<{ id: string; role: string; kind: string; title?: string; text: string; truncated: boolean }> = [];
    const sources = new Set<Source>();
    let index = cursor?.id ? batch.rows.findIndex((row) => row.id === cursor.id) : batch.rows.length;
    if (index < 0) throw new Error('get_conversation_output: cursor expired; read again without before');
    let next: Cursor | null = null;
    let scanned = 0;
    let loads = 1;
    for (;;) {
      if (index === 0) {
        // This batch is read; continue in the one before it, if any.
        if (!batch.older) break;
        if (loads >= MAX_BATCHES || page.length >= input.limit) { next = { k: kind, b: batch.older, id: null }; break; }
        batchCursor = batch.older;
        batch = await loadOnce(batchCursor);
        loads += 1;
        index = batch.rows.length;
        continue;
      }
      const row = batch.rows[index - 1]!;
      if (page.length >= input.limit || scanned >= MAX_SCANNED) { next = { k: kind, b: batchCursor, id: batch.rows[index]?.id ?? null }; break; }
      if (wanted(row, include)) {
        // Titles count too: a Codex command row's title is the whole command.
        const fullTitle = row.title ? headUtf8(row.title, TITLE_BYTES) : null;
        const body = rowBody(row);
        const bytes = Buffer.byteLength(fullTitle?.text ?? '', 'utf8') + Buffer.byteLength(body, 'utf8');
        // A row that does not fit starts the next page. Only a row that alone
        // exceeds the budget is cut, title first, so every page moves on.
        if (bytes > budget && page.length > 0) { next = { k: kind, b: batchCursor, id: batch.rows[index]?.id ?? null }; break; }
        const title = fullTitle ? headUtf8(fullTitle.text, Math.max(0, budget)) : null;
        const titleBytes = Buffer.byteLength(title?.text ?? '', 'utf8');
        const text = headUtf8(body, Math.max(0, budget - titleBytes));
        budget -= titleBytes + Buffer.byteLength(text.text, 'utf8');
        const truncated = text.truncated || Boolean(fullTitle?.truncated || title?.truncated);
        page.push({ id: row.id, role: row.role, kind: row.kind, ...(title?.text ? { title: title.text } : {}), text: text.text, truncated });
        sources.add(batch.source);
      }
      scanned += 1;
      index -= 1;
    }

    // The newest page names the latest answer. Its text is sent once: in the
    // page when the page holds it, otherwise here from what is left of the budget.
    let answer: { message_id: string; in_page: true } | { message_id: string; text: string; truncated: boolean } | null = null;
    if (!cursor) {
      const row = await latestAnswer(loadOnce);
      if (row && page.some((message) => message.id === row.id)) answer = { message_id: row.id, in_page: true };
      else if (row) {
        const text = headUtf8(row.text.trim(), Math.max(0, budget));
        answer = { message_id: row.id, text: text.text, truncated: text.truncated };
      }
    }

    const pending = (key: string) => {
      const value = read.snapshot?.[key] as { data?: unknown } | undefined;
      return Array.isArray(value?.data) && value.data.length > 0;
    };
    // A live snapshot's status is fresher than the stored activity.
    const snapshotStatus = read.snapshot?.status;
    const activity = typeof snapshotStatus === 'string' && ACTIVITIES.has(snapshotStatus) ? snapshotStatus : process.activity ?? 'unknown';
    return {
      process_id: process.id,
      name: process.name,
      status: process.status,
      activity,
      turn: { state: turnState(process.status, activity, pending('permissions'), pending('questions') || pending('forms')) },
      ...(cursor ? {} : { latest_answer: answer }),
      last_report: this.lastReport(process.id),
      messages: page.reverse(),
      next_before: next ? encodeCursor(next) : null,
      has_more: Boolean(next),
      sources: [...sources],
      // The provider cannot read back older turns, so has_more false does not
      // mean the start of the conversation.
      ...(read.snapshot?.history_unavailable === true ? { history_unavailable: true } : {}),
      ...(kind === 'history' ? {
        conversation_id: read.conversationId,
        source_updated_at: read.importedAt,
        // A running agent can write more at any moment, so its history may
        // always be behind; an exited one is behind until imported after exit.
        stale: process.status === 'running' || !read.importedAt || read.importedAt < (process.exited_at ?? process.updated_at)
      } : {})
    };
  }

  private process(processId: string): ProcessRow | null {
    return (this.database.connection.prepare(`
      select processes.id, coalesce(sessions.title, processes.name) as name, processes.project_id, processes.status,
             processes.activity, processes.updated_at, processes.exited_at, sessions.id as session_id, sessions.harness, sessions.resume_id,
             sessions.interface_mode, sessions.exited_at as session_exited_at
      from processes left join sessions on sessions.process_id = processes.id
      where processes.id = ?
      order by sessions.started_at desc limit 1
    `).get(processId) as ProcessRow | undefined) ?? null;
  }

  private linkedConversation(process: ProcessRow): string | null {
    if (!process.session_id || !this.history) return null;
    return this.history.conversationIdForSession({ sessionId: process.session_id, provider: process.harness, resumeId: process.resume_id, projectId: process.project_id });
  }

  private lastReport(processId: string) {
    const row = this.database.connection.prepare(`
      select id, metadata, created_at from timeline_events
      where event_type = 'agent.reported' and process_id = ?
      order by created_at desc limit 1
    `).get(processId) as { id: string; metadata: string; created_at: string } | undefined;
    if (!row) return null;
    const metadata = parseRecord(row.metadata);
    const body = headUtf8(typeof metadata.body === 'string' ? metadata.body : '', REPORT_BYTES);
    return {
      event_id: row.id,
      status: typeof metadata.status === 'string' ? metadata.status : 'completed',
      ...(typeof metadata.title === 'string' && metadata.title ? { title: metadata.title.slice(0, 200) } : {}),
      body: body.text,
      ...(body.truncated ? { truncated: true } : {}),
      created_at: row.created_at
    };
  }
}

function wanted(row: ConversationRow, include: ReadonlySet<Include>): boolean {
  if (row.kind === 'tool') return include.has('tools');
  if (row.kind === 'reasoning') return include.has('reasoning');
  if (row.kind === 'notice') return include.has('notices');
  return true;
}

// Pending requests are more specific than activity: older hosts report a
// pending question as permission activity.
function turnState(status: string, activity: string, pendingPermission: boolean, pendingQuestion: boolean) {
  if (status !== 'running') return 'exited';
  if (pendingQuestion && !pendingPermission) return 'awaiting_answer';
  if (pendingPermission || activity === 'permission') return 'awaiting_permission';
  if (activity === 'question') return 'awaiting_answer';
  if (activity === 'working' || activity === 'thinking') return 'working';
  if (activity === 'error') return 'errored';
  if (activity === 'idle') return 'ended';
  return 'unknown';
}

// The last assistant text since the latest user prompt, searched newest
// first within the same bounds as a page. Null when the agent has not
// answered the latest prompt, or no answer is found within the bounds.
async function latestAnswer(loadOnce: (key: string | null) => Promise<Batch>): Promise<ConversationRow | null> {
  let key: string | null = null;
  let scanned = 0;
  for (let loads = 0; loads < MAX_BATCHES; loads += 1) {
    const batch = await loadOnce(key);
    for (let index = batch.rows.length - 1; index >= 0 && scanned < MAX_SCANNED; index -= 1, scanned += 1) {
      const row = batch.rows[index]!;
      if (row.kind !== 'text') continue;
      if (row.role === 'user') return null;
      if (row.text.trim()) return row;
    }
    if (!batch.older || scanned >= MAX_SCANNED) return null;
    key = batch.older;
  }
  return null;
}

// Snapshots name the page before them as `history_cursor: { next }`, or as a
// bare string (OpenCode).
function snapshotCursor(snapshot: Record<string, unknown>): string | null {
  const cursor = snapshot.history_cursor;
  if (typeof cursor === 'string') return cursor;
  const next = (cursor as { next?: unknown } | null)?.next;
  return typeof next === 'string' ? next : null;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): Cursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if ((cursor.k === 'live' || cursor.k === 'history') && (cursor.b === null || typeof cursor.b === 'string') && (cursor.id === null || typeof cursor.id === 'string')) return cursor;
  } catch { /* reported below */ }
  throw new Error('get_conversation_output: invalid cursor; pass next_before unchanged');
}

function parseRecord(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}
