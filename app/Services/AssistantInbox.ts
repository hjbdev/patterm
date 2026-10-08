import { randomUUID } from 'node:crypto';
import type { DatabaseService } from './DatabaseService';

export type AssistantInboxKind = 'notification' | 'agent_message' | 'report' | 'timer' | 'agent_notice';

export interface AssistantInboxInput {
  kind: AssistantInboxKind;
  sourceProcessId?: string | null | undefined;
  title?: string | undefined;
  body: string;
  // Pending items with the same key coalesce: the latest text wins and the
  // count grows. Null keeps every item.
  dedupeKey?: string | null | undefined;
}

export interface AssistantInboxItem {
  id: string;
  kind: AssistantInboxKind;
  source_process_id: string | null;
  title: string;
  body: string;
  occurrences: number;
  created_at: string;
  updated_at: string;
  digest_id: string | null;
  delivered_at: string | null;
  delivery: 'delivered' | 'uncertain' | null;
}

export interface AssistantFocusState {
  enabled: boolean;
  since: string | null;
  // Held items not yet delivered, including any a flush is delivering.
  pending: number;
}

const FOCUS_KEY = 'assistant.focus.v1';
// Every source is already bounded except reports; keep one item reasonable.
const BODY_LIMIT = 64 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// The one gate between incoming work and the assistant's thread. Each path
// that would interrupt the assistant unprompted (notification digests, agent
// messages, reports, timer callbacks, routed child notices) asks hold()
// first. While Focus mode is on, or while earlier held items are still
// undelivered, the item is stored here instead, so it survives restarts and
// keeps its order. The assistant service flushes the inbox as one digest.
// User input never passes through this gate.
export class AssistantInbox {
  private readonly listeners = new Set<(change: { flush: boolean }) => void>();

  constructor(private readonly database: DatabaseService, private readonly now: () => number = Date.now) {}

  focus(): AssistantFocusState {
    const stored = this.storedFocus();
    return { enabled: stored.enabled, since: stored.since, pending: this.pendingCount() };
  }

  setFocus(enabled: boolean): AssistantFocusState {
    const current = this.storedFocus();
    if (current.enabled !== enabled) {
      const value = JSON.stringify({ enabled, since: enabled ? new Date(this.now()).toISOString() : null });
      this.database.connection.prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)
        on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`).run(FOCUS_KEY, value, new Date(this.now()).toISOString());
    }
    // Turning focus off, even when it was already off, asks for a flush.
    this.changed(true);
    return this.focus();
  }

  // Holds an item for the assistant when targetProcessId is the live
  // assistant and its delivery must wait, or a stopped assistant process,
  // such as one being restarted: its items go to the next assistant. Returns
  // false when the caller should deliver as usual.
  hold(targetProcessId: string, input: AssistantInboxInput): boolean {
    if (targetProcessId === this.liveAssistant()) return this.holdForAssistant(input);
    if (!this.database.connection.prepare(`select 1 from sessions where process_id = ? and session_role = 'assistant'`).get(targetProcessId)) return false;
    this.enqueue(input);
    this.changed(true);
    return true;
  }

  // As hold(), for callers that already know the target is the assistant.
  holdForAssistant(input: AssistantInboxInput): boolean {
    // A backlog keeps later items behind earlier ones, even after focus ends.
    if (!this.storedFocus().enabled && !this.pendingCount()) return false;
    this.enqueue(input);
    this.changed(true);
    return true;
  }

  // A child's attention or failure notice routed to its parent. Repeats of
  // the same notice coalesce.
  holdNotice(targetProcessId: string, text: string, fromProcessId: string): boolean {
    const [heading = '', ...rest] = text.split('\n');
    return this.hold(targetProcessId, { kind: 'agent_notice', sourceProcessId: fromProcessId, title: heading.replace(/^\[|\]$/g, ''), body: rest.join('\n'), dedupeKey: `notice:${fromProcessId}:${text}` });
  }

  // Claims every unclaimed pending item for one digest, oldest first.
  claim(): { digestId: string; items: AssistantInboxItem[] } | null {
    return this.database.connection.transaction(() => {
      const digestId = `digest_${randomUUID()}`;
      const changes = this.database.connection.prepare(`update assistant_inbox set digest_id = ? where digest_id is null and delivered_at is null`).run(digestId).changes;
      if (!changes) return null;
      return { digestId, items: this.digest(digestId) };
    })();
  }

  // The digest's delivery was acknowledged, or may have been: either way it is
  // never sent again.
  confirm(digestId: string, delivery: 'delivered' | 'uncertain'): void {
    this.database.connection.prepare(`update assistant_inbox set delivered_at = ?, delivery = ? where digest_id = ? and delivered_at is null`)
      .run(new Date(this.now()).toISOString(), delivery, digestId);
    this.changed(false);
  }

  // The digest was definitively not delivered. Its items wait for the next
  // flush: a new item, the assistant's next launch, or turning focus off again.
  release(digestId: string): void {
    this.unclaim(`digest_id = ?`, [digestId]);
    this.changed(false);
  }

  // After a restart, a claimed but unacknowledged digest may or may not have
  // reached the assistant. It is delivered again rather than lost.
  recover(): void {
    this.unclaim(`digest_id is not null`, []);
    this.database.connection.prepare(`delete from assistant_inbox where delivered_at is not null and delivered_at < ?`)
      .run(new Date(this.now() - RETENTION_MS).toISOString());
  }

  // Pending items, or one digest's items, oldest first.
  list(input: { digestId?: string | undefined; limit: number; offset: number }): { items: AssistantInboxItem[]; total: number } {
    const where = input.digestId ? 'digest_id = ?' : 'delivered_at is null';
    const params = input.digestId ? [input.digestId] : [];
    const total = (this.database.connection.prepare(`select count(*) as count from assistant_inbox where ${where}`).get(...params) as { count: number }).count;
    const items = this.database.connection.prepare(`${ITEM_SELECT} where ${where} order by seq limit ? offset ?`).all(...params, input.limit, input.offset) as AssistantInboxItem[];
    return { items, total };
  }

  liveAssistant(): string | null {
    return (this.database.connection.prepare(`select sessions.process_id from sessions join processes on processes.id = sessions.process_id
      where sessions.session_role = 'assistant' and sessions.exited_at is null and processes.status = 'running'
      order by sessions.started_at desc limit 1`).get() as { process_id: string } | undefined)?.process_id ?? null;
  }

  // flush is true when held items may now be deliverable.
  onChange(listener: (change: { flush: boolean }) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private digest(digestId: string): AssistantInboxItem[] {
    return this.database.connection.prepare(`${ITEM_SELECT} where digest_id = ? order by seq`).all(digestId) as AssistantInboxItem[];
  }

  private enqueue(input: AssistantInboxInput): void {
    const at = new Date(this.now()).toISOString();
    const body = input.body.length > BODY_LIMIT ? `${input.body.slice(0, BODY_LIMIT)}\n[truncated]` : input.body;
    this.database.connection.prepare(`insert into assistant_inbox (id, kind, source_process_id, title, body, dedupe_key, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (dedupe_key) where dedupe_key is not null and digest_id is null
      do update set title = excluded.title, body = excluded.body, source_process_id = excluded.source_process_id,
        occurrences = occurrences + 1, updated_at = excluded.updated_at`)
      .run(`inbox_${randomUUID()}`, input.kind, input.sourceProcessId ?? null, input.title ?? '', body, input.dedupeKey ?? null, at, at);
  }

  // Returns claimed items to the queue. A newer pending repeat folds into the
  // claimed item, which keeps its place in the order.
  private unclaim(where: string, params: unknown[]): void {
    this.database.connection.transaction(() => {
      const rows = this.database.connection.prepare(`select seq, dedupe_key, occurrences from assistant_inbox where ${where} and delivered_at is null order by seq`)
        .all(...params) as Array<{ seq: number; dedupe_key: string | null; occurrences: number }>;
      for (const row of rows) {
        const newer = row.dedupe_key ? this.database.connection.prepare(`select seq, source_process_id, title, body, occurrences, updated_at from assistant_inbox where dedupe_key = ? and digest_id is null`)
          .get(row.dedupe_key) as { seq: number; source_process_id: string | null; title: string; body: string; occurrences: number; updated_at: string } | undefined : undefined;
        if (newer) {
          this.database.connection.prepare(`delete from assistant_inbox where seq = ?`).run(newer.seq);
          this.database.connection.prepare(`update assistant_inbox set digest_id = null, source_process_id = ?, title = ?, body = ?, occurrences = occurrences + ?, updated_at = ? where seq = ?`)
            .run(newer.source_process_id, newer.title, newer.body, newer.occurrences, newer.updated_at, row.seq);
        } else {
          this.database.connection.prepare(`update assistant_inbox set digest_id = null where seq = ?`).run(row.seq);
        }
      }
    })();
  }

  private pendingCount(): number {
    return (this.database.connection.prepare(`select count(*) as count from assistant_inbox where delivered_at is null`).get() as { count: number }).count;
  }

  private storedFocus(): { enabled: boolean; since: string | null } {
    const row = this.database.connection.prepare('select value from settings where key = ?').get(FOCUS_KEY) as { value: string } | undefined;
    try {
      const value = row ? JSON.parse(row.value) as { enabled?: unknown; since?: unknown } : {};
      return { enabled: value.enabled === true, since: typeof value.since === 'string' ? value.since : null };
    } catch {
      return { enabled: false, since: null };
    }
  }

  private changed(flush: boolean): void {
    for (const listener of this.listeners) {
      try { listener({ flush }); } catch { /* listeners log their own failures */ }
    }
  }
}

const ITEM_SELECT = `select id, kind, source_process_id, title, body, occurrences, created_at, updated_at, digest_id, delivered_at, delivery from assistant_inbox`;
