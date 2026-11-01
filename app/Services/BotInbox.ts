import { randomUUID } from 'node:crypto';
import type { DatabaseService } from './DatabaseService';

export type BotInboxKind = 'notification' | 'agent_message' | 'report' | 'timer' | 'agent_notice';

export interface BotInboxInput {
  kind: BotInboxKind;
  sourceProcessId?: string | null | undefined;
  title?: string | undefined;
  body: string;
  // Pending items with the same key coalesce: the latest text wins and the
  // count grows. Null keeps every item.
  dedupeKey?: string | null | undefined;
}

export interface BotInboxItem {
  id: string;
  kind: BotInboxKind;
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

export interface BotFocusState {
  enabled: boolean;
  since: string | null;
  // Held items not yet delivered, including any a flush is delivering.
  pending: number;
}

const FOCUS_KEY = 'bot.focus.v1';
// Every source is already bounded except reports; keep one item reasonable.
const BODY_LIMIT = 64 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface BotInboxChange {
  botId: string;
  // True when held items may now be deliverable.
  flush: boolean;
}

// The one gate between incoming work and a bot's thread, for bots with
// Focus mode. Each path that would interrupt the bot unprompted
// (notification digests, agent messages, reports, timer callbacks, routed
// child notices) asks hold() first. While the bot's Focus mode is on, or
// while earlier held items are still undelivered, the item is stored here
// instead, so it survives restarts and keeps its order. The bot relay
// flushes each bot's inbox as one digest. User input never passes through
// this gate.
export class BotInbox {
  private readonly listeners = new Set<(change: BotInboxChange) => void>();

  constructor(
    private readonly database: DatabaseService,
    // Whether a bot may use Focus mode. Bots without it never hold anything.
    private readonly focusAllowed: (botId: string) => boolean = () => true,
    private readonly now: () => number = Date.now
  ) {}

  focus(botId: string): BotFocusState {
    const stored = this.storedFocus(botId);
    return { enabled: stored.enabled, since: stored.since, pending: this.pendingCount(botId) };
  }

  setFocus(botId: string, enabled: boolean): BotFocusState {
    const current = this.storedFocus(botId);
    if (current.enabled !== enabled) {
      const value = JSON.stringify({ enabled, since: enabled ? new Date(this.now()).toISOString() : null });
      this.database.connection.prepare(`insert into settings (key, value, updated_at) values (?, ?, ?)
        on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`).run(focusKey(botId), value, new Date(this.now()).toISOString());
    }
    // Turning focus off, even when it was already off, asks for a flush.
    this.changed(botId, true);
    return this.focus(botId);
  }

  // Holds an item for a bot when targetProcessId is the bot's live session
  // and its delivery must wait, or one of its stopped sessions, such as one
  // being restarted: its items go to the bot's next session. Returns false
  // when the caller should deliver as usual.
  hold(targetProcessId: string, input: BotInboxInput): boolean {
    const botId = this.botFor(targetProcessId);
    if (!botId || !this.focusAllowed(botId)) return false;
    if (targetProcessId === this.liveSession(botId)) return this.holdFor(botId, input);
    this.enqueue(botId, input);
    this.changed(botId, true);
    return true;
  }

  // As hold(), for callers that already know the target bot.
  holdFor(botId: string, input: BotInboxInput): boolean {
    if (!this.focusAllowed(botId)) return false;
    // A backlog keeps later items behind earlier ones, even after focus ends.
    if (!this.storedFocus(botId).enabled && !this.pendingCount(botId)) return false;
    this.enqueue(botId, input);
    this.changed(botId, true);
    return true;
  }

  // A child's attention or failure notice routed to its parent. Repeats of
  // the same notice coalesce.
  holdNotice(targetProcessId: string, text: string, fromProcessId: string): boolean {
    const [heading = '', ...rest] = text.split('\n');
    return this.hold(targetProcessId, { kind: 'agent_notice', sourceProcessId: fromProcessId, title: heading.replace(/^\[|\]$/g, ''), body: rest.join('\n'), dedupeKey: `notice:${fromProcessId}:${text}` });
  }

  // Claims every unclaimed pending item for one digest, oldest first.
  claim(botId: string): { digestId: string; items: BotInboxItem[] } | null {
    return this.database.connection.transaction(() => {
      const digestId = `digest_${randomUUID()}`;
      const changes = this.database.connection.prepare(`update assistant_inbox set digest_id = ? where bot_id = ? and digest_id is null and delivered_at is null`).run(digestId, botId).changes;
      if (!changes) return null;
      return { digestId, items: this.digest(digestId) };
    })();
  }

  // The digest's delivery was acknowledged, or may have been: either way it is
  // never sent again.
  confirm(botId: string, digestId: string, delivery: 'delivered' | 'uncertain'): void {
    this.database.connection.prepare(`update assistant_inbox set delivered_at = ?, delivery = ? where digest_id = ? and delivered_at is null`)
      .run(new Date(this.now()).toISOString(), delivery, digestId);
    this.changed(botId, false);
  }

  // The digest was definitively not delivered. Its items wait for the next
  // flush: a new item, the bot's next launch, or turning focus off again.
  release(botId: string, digestId: string): void {
    this.unclaim(`digest_id = ?`, [digestId]);
    this.changed(botId, false);
  }

  // After a restart, a claimed but unacknowledged digest may or may not have
  // reached its bot. It is delivered again rather than lost.
  recover(): void {
    this.unclaim(`digest_id is not null`, []);
    this.database.connection.prepare(`delete from assistant_inbox where delivered_at is not null and delivered_at < ?`)
      .run(new Date(this.now() - RETENTION_MS).toISOString());
  }

  // Pending items, or one digest's items, oldest first.
  list(botId: string, input: { digestId?: string | undefined; limit: number; offset: number }): { items: BotInboxItem[]; total: number } {
    const where = input.digestId ? 'bot_id = ? and digest_id = ?' : 'bot_id = ? and delivered_at is null';
    const params = input.digestId ? [botId, input.digestId] : [botId];
    const total = (this.database.connection.prepare(`select count(*) as count from assistant_inbox where ${where}`).get(...params) as { count: number }).count;
    const items = this.database.connection.prepare(`${ITEM_SELECT} where ${where} order by seq limit ? offset ?`).all(...params, input.limit, input.offset) as BotInboxItem[];
    return { items, total };
  }

  liveSession(botId: string): string | null {
    return (this.database.connection.prepare(`select sessions.process_id from sessions join processes on processes.id = sessions.process_id
      where sessions.bot_id = ? and sessions.session_role in ('assistant', 'bot') and sessions.exited_at is null and processes.status = 'running'
      order by sessions.started_at desc limit 1`).get(botId) as { process_id: string } | undefined)?.process_id ?? null;
  }

  // The bot whose session, live or stopped, ran in this process.
  botFor(processId: string): string | null {
    return (this.database.connection.prepare(`select bot_id from sessions where process_id = ? and session_role in ('assistant', 'bot') and bot_id is not null
      order by started_at desc limit 1`).get(processId) as { bot_id: string } | undefined)?.bot_id ?? null;
  }

  onChange(listener: (change: BotInboxChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private digest(digestId: string): BotInboxItem[] {
    return this.database.connection.prepare(`${ITEM_SELECT} where digest_id = ? order by seq`).all(digestId) as BotInboxItem[];
  }

  private enqueue(botId: string, input: BotInboxInput): void {
    const at = new Date(this.now()).toISOString();
    const body = input.body.length > BODY_LIMIT ? `${input.body.slice(0, BODY_LIMIT)}\n[truncated]` : input.body;
    this.database.connection.prepare(`insert into assistant_inbox (id, bot_id, kind, source_process_id, title, body, dedupe_key, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (bot_id, dedupe_key) where dedupe_key is not null and digest_id is null
      do update set title = excluded.title, body = excluded.body, source_process_id = excluded.source_process_id,
        occurrences = occurrences + 1, updated_at = excluded.updated_at`)
      .run(`inbox_${randomUUID()}`, botId, input.kind, input.sourceProcessId ?? null, input.title ?? '', body, input.dedupeKey ?? null, at, at);
  }

  // Returns claimed items to the queue. A newer pending repeat folds into the
  // claimed item, which keeps its place in the order.
  private unclaim(where: string, params: unknown[]): void {
    this.database.connection.transaction(() => {
      const rows = this.database.connection.prepare(`select seq, bot_id, dedupe_key, occurrences from assistant_inbox where ${where} and delivered_at is null order by seq`)
        .all(...params) as Array<{ seq: number; bot_id: string; dedupe_key: string | null; occurrences: number }>;
      for (const row of rows) {
        const newer = row.dedupe_key ? this.database.connection.prepare(`select seq, source_process_id, title, body, occurrences, updated_at from assistant_inbox where bot_id = ? and dedupe_key = ? and digest_id is null`)
          .get(row.bot_id, row.dedupe_key) as { seq: number; source_process_id: string | null; title: string; body: string; occurrences: number; updated_at: string } | undefined : undefined;
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

  private pendingCount(botId: string): number {
    return (this.database.connection.prepare(`select count(*) as count from assistant_inbox where bot_id = ? and delivered_at is null`).get(botId) as { count: number }).count;
  }

  private storedFocus(botId: string): { enabled: boolean; since: string | null } {
    const row = this.database.connection.prepare('select value from settings where key = ?').get(focusKey(botId)) as { value: string } | undefined;
    try {
      const value = row ? JSON.parse(row.value) as { enabled?: unknown; since?: unknown } : {};
      return { enabled: value.enabled === true, since: typeof value.since === 'string' ? value.since : null };
    } catch {
      return { enabled: false, since: null };
    }
  }

  private changed(botId: string, flush: boolean): void {
    for (const listener of this.listeners) {
      try { listener({ botId, flush }); } catch { /* listeners log their own failures */ }
    }
  }
}

const ITEM_SELECT = `select id, kind, source_process_id, title, body, occurrences, created_at, updated_at, digest_id, delivered_at, delivery from assistant_inbox`;

function focusKey(botId: string): string {
  return `${FOCUS_KEY}:${botId}`;
}
