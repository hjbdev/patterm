import type { SqliteConnection } from '../Database/SqliteConnection';
import { headUtf8 } from './ConversationText';
import { proseText, proseHash } from './AgentHistory/SummaryProseIndex';
import { summaryMemory, SUMMARY_INPUT_BYTES, SUMMARY_SYSTEM_PROMPT, type SummaryContext } from './AutoSummarySettings';

export interface SummaryThread {
  id: string; project_id: string; session_id: string; harness: string; resume_id: string | null;
  activity: string; status: string; name: string; auto_summary: string | null;
  display_name: string | null; auto_title: string | null; last_title: string | null;
}
export interface SummarySource {
  conversation_id: string; provider: string; native_id: string; revision: number; message_count: number; total_bytes: number;
}
export interface SummaryState {
  project_id: string; provider: string; native_id: string; position: number; byte_offset: number;
  prefix_hash: string; message_hash: string; recap: string; origin: string; stale: number; paused: number;
  rebuild_end: number | null; revision: number; updated_at: string | null;
}
interface ProseRow {
  position: number; label: string; text_bytes: number; message_hash: string; prefix_hash: string; text: string;
}
export interface SummaryBatch {
  source: SummarySource; state: SummaryState; context: SummaryContext; text: string;
  position: number; byte_offset: number; prefix_hash: string; message_hash: string;
  coverage: 'complete' | 'partial' | 'catching_up';
}
const EMPTY_MEMORY = { goal: '', decisions: '', completed: '', unresolved: '' };

// The app owns summary state; history.db is read-only here. The importer publishes
// stable hashes once its message projection is ready, avoiding rescans each tick.
export class AutoSummaryHistory {
  constructor(private readonly app: SqliteConnection, private readonly history: SqliteConnection) {}

  snapshot<T>(read: () => T): T { return this.history.transaction(read)(); }

  source(thread: SummaryThread): SummarySource | null {
    const row = this.history.prepare(`select c.id as conversation_id, c.provider,
        coalesce(c.provider_conversation_id, c.id) as native_id, p.revision, p.message_count, p.total_bytes
      from conversations c join summary_prose_sources p on p.conversation_id = c.id
      where c.project_id = ? and c.provider = ? and (c.session_id = ? or c.provider_conversation_id = ?)
        and p.message_count = (select count(*) from summary_prose where conversation_id = c.id)
      order by c.imported_at desc limit 1`).get(thread.project_id, thread.harness, thread.session_id, thread.resume_id) as SummarySource | undefined;
    return row ?? null;
  }

  state(thread: SummaryThread, source: SummarySource): SummaryState {
    let state = this.readState(thread.project_id, source);
    if (!state) {
      // A large pre-existing thread gets a bounded recent seed, never an automatic
      // million-token rebuild. Its partial origin remains visible on later updates.
      const large = source.total_bytes > 32 * 1024;
      let position = 0, offset = 0, messageHash = '';
      if (large) {
        const tail = this.history.prepare(`select position, text_bytes from summary_prose
          where conversation_id = ? order by position desc limit 64`).all(source.conversation_id) as Array<{ position: number; text_bytes: number }>;
        let bytes = 0;
        position = source.message_count;
        for (const row of tail) {
          if (bytes && bytes + row.text_bytes > 6 * 1024) break;
          position = row.position; bytes += row.text_bytes;
        }
      }
      if (large) {
        const firstTail = this.row(source, position);
        if (firstTail && firstTail.text_bytes > 6 * 1024) {
          const buffer = Buffer.from(proseText(firstTail.text));
          offset = buffer.length - 6 * 1024;
          while (offset < buffer.length && (buffer[offset]! & 0xc0) === 0x80) offset++;
          messageHash = firstTail.message_hash;
        }
      }
      const prefix = position ? this.hashRow(source, position - 1)?.prefix_hash ?? '' : '';
      this.app.prepare(`insert or ignore into auto_summary_memory
        (project_id, provider, native_id, position, byte_offset, message_hash, prefix_hash, origin) values (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(thread.project_id, source.provider, source.native_id, position, offset, messageHash, prefix, large ? 'partial' : 'beginning');
      state = this.readState(thread.project_id, source)!;
    }
    if (!state.stale && !this.valid(source, state)) {
      this.app.prepare(`update auto_summary_memory set stale = 1, revision = revision + 1
        where project_id = ? and provider = ? and native_id = ?`).run(thread.project_id, source.provider, source.native_id);
      state = this.readState(thread.project_id, source)!;
    }
    return state;
  }

  readState(projectId: string, source: SummarySource): SummaryState | undefined {
    return this.app.prepare('select * from auto_summary_memory where project_id = ? and provider = ? and native_id = ?')
      .get(projectId, source.provider, source.native_id) as SummaryState | undefined;
  }

  private row(source: SummarySource, position: number): ProseRow | undefined {
    return this.history.prepare(`select p.*, m.text from summary_prose p join conversation_messages m on m.id = p.message_id
      where p.conversation_id = ? and p.position = ?`).get(source.conversation_id, position) as ProseRow | undefined;
  }

  private hashRow(source: SummarySource, position: number): { prefix_hash: string; message_hash: string } | undefined {
    return this.history.prepare('select prefix_hash, message_hash from summary_prose where conversation_id = ? and position = ?')
      .get(source.conversation_id, position) as { prefix_hash: string; message_hash: string } | undefined;
  }

  valid(source: SummarySource, state: SummaryState): boolean {
    if (state.position > source.message_count) return false;
    if (state.position > 0 && this.hashRow(source, state.position - 1)?.prefix_hash !== state.prefix_hash) return false;
    if (state.byte_offset && this.hashRow(source, state.position)?.message_hash !== state.message_hash) return false;
    return true;
  }

  coverage(source: SummarySource, state: SummaryState): string {
    return state.stale ? 'stale' : state.paused ? 'paused' : state.position < source.message_count || state.byte_offset ? 'catching_up'
      : state.origin === 'partial' ? 'partial' : 'complete';
  }

  batch(source: SummarySource, state: SummaryState, context: SummaryContext): SummaryBatch | null {
    if (state.stale || state.paused) return null;
    const end = Math.min(source.message_count, state.rebuild_end ?? source.message_count);
    const first = this.history.prepare(`select p.*, m.text from summary_prose p join conversation_messages m on m.id = p.message_id
      where p.conversation_id = ? and p.label = 'User' order by p.position limit 1`).get(source.conversation_id) as ProseRow | undefined;
    context = { ...context, previous_summary: state.updated_at ? null : context.previous_summary ?? null, memory: summaryMemory.parse(JSON.parse(state.recap === '{}' ? JSON.stringify(EMPTY_MEMORY) : state.recap)),
      owner_goal: first ? headUtf8(proseText(first.text), 1000).text : '', coverage: 'catching_up' };
    const overhead = Buffer.byteLength(SUMMARY_SYSTEM_PROMPT) + Buffer.byteLength(JSON.stringify({ ...context, conversation_text: '' }));
    const budget = Math.min(8 * 1024, SUMMARY_INPUT_BYTES - overhead - 64);
    if (budget < 128) throw new Error('Summary context exceeded the limit.');
    let position = state.position, offset = state.byte_offset, prefix = state.prefix_hash, hash = state.message_hash, text = '';
    // Fetch only the next bounded page. A long individual message is split at a
    // UTF-8 boundary; the offset advances only over text actually sent.
    let read = 0;
    while (position < end && read++ < 64) {
      const row = this.row(source, position);
      if (!row) return null;
      const normalized = proseText(row.text);
      if (proseHash(`${row.label}\n${normalized}`) !== row.message_hash) return null;
      const body = Buffer.from(normalized).subarray(offset).toString('utf8');
      const label = `${text ? '\n\n' : ''}${row.label}${offset ? ' (continued)' : ''}: `;
      const remaining = budget - Buffer.byteLength(JSON.stringify(text + label)) + 2;
      if (remaining < 32) break;
      let low = 0, high = Buffer.byteLength(body);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(headUtf8(body, middle).text)) - 2 <= remaining) low = middle;
        else high = middle - 1;
      }
      const part = headUtf8(body, low).text;
      if (!part) break;
      text += label + part;
      offset += Buffer.byteLength(part);
      hash = row.message_hash;
      if (offset < row.text_bytes) break;
      position++; offset = 0; prefix = row.prefix_hash; hash = '';
    }
    if (!text) return null;
    const coverage = position < source.message_count || offset ? 'catching_up' : state.origin === 'partial' ? 'partial' : 'complete';
    context.coverage = coverage;
    return { source, state, context, text, position, byte_offset: offset, prefix_hash: prefix, message_hash: hash, coverage };
  }

  save(batch: SummaryBatch, recap: string, now: string): boolean {
    const { state, source } = batch;
    return this.app.prepare(`update auto_summary_memory set position = ?, byte_offset = ?, prefix_hash = ?, message_hash = ?,
      recap = ?, revision = revision + 1, updated_at = ?, rebuild_end = case when ? >= rebuild_end and ? = 0 then null else rebuild_end end
      where project_id = ? and provider = ? and native_id = ? and revision = ? and stale = 0 and paused = 0`)
      .run(batch.position, batch.byte_offset, batch.prefix_hash, batch.message_hash, recap, now, batch.position, batch.byte_offset,
        state.project_id, source.provider, source.native_id, state.revision).changes > 0;
  }

  rebuild(thread: SummaryThread, source: SummarySource): void {
    this.state(thread, source);
    this.app.prepare(`update auto_summary_memory set position = 0, byte_offset = 0, prefix_hash = '', message_hash = '', recap = '{}',
      origin = 'beginning', stale = 0, paused = 0, rebuild_end = ?, revision = revision + 1
      where project_id = ? and provider = ? and native_id = ?`).run(source.message_count, thread.project_id, source.provider, source.native_id);
  }

  resume(thread: SummaryThread, source: SummarySource): void {
    this.app.prepare(`update auto_summary_memory set paused = 0, revision = revision + 1
      where project_id = ? and provider = ? and native_id = ?`).run(thread.project_id, source.provider, source.native_id);
  }

  cancel(thread: SummaryThread, source: SummarySource): void {
    this.app.prepare(`update auto_summary_memory set paused = 1, revision = revision + 1
      where project_id = ? and provider = ? and native_id = ?`).run(thread.project_id, source.provider, source.native_id);
  }
}
