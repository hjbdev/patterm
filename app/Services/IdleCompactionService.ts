import type { DatabaseService } from './DatabaseService';
import { UncertainDeliveryError } from './IntegratedDelivery';
import type { CompactionSignal, IntegratedActivityChange } from './IntegratedAgentService';
import type { IntegratedConversationEvent } from './IntegratedConversation';

// A prompt cache expires a fixed time after its last use. Compacting an idle
// agent just before then reads the conversation from the cache once, so the
// next turn rewrites a short summary instead of the whole context. Only
// harnesses with a known cache lifetime and a native compaction request are
// listed:
// - Claude Code caches for 1 hour on a subscription within its limits.
// - Codex keys the cache by thread; GPT-5.6 and later keep it for 30 minutes.
// - OpenCode on those OpenAI models keys it by session, as Codex does. Other
//   providers, such as DeepSeek, keep it for hours.
// The lifetime runs from the last request, which starts before the turn ends.
// Across two weeks of transcripts a turn's final request took at most about
// 2.5 minutes (p99 under 30 seconds), so compaction leaves 3 minutes' margin.
export const IDLE_COMPACTION_AFTER_MS: Partial<Record<string, number>> = {
  claude: 57 * 60_000,
  codex: 27 * 60_000,
  opencode: 27 * 60_000
};
// The slowest final request leaves Claude under 30 seconds of headroom, so a
// deadline overdue by more than timer delay is skipped rather than risk an
// expired cache.
const LATE_MS = 20_000;


// OpenAI documents a 30-minute minimum only for GPT-5.6 and later; earlier
// models can drop an in-memory cache after 5 to 10 minutes.
export function thirtyMinuteCacheModel(model: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?(?![\d.])/.exec(model);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 5 || (major === 5 && Number(match[2] ?? 0) >= 6);
}

function eligibleModel(harness: string, model: string | null): boolean {
  if (harness === 'claude') return true;
  if (!model) return false;
  if (harness === 'codex') return thirtyMinuteCacheModel(model);
  return harness === 'opencode' && model.startsWith('openai/') && thirtyMinuteCacheModel(model.slice('openai/'.length));
}

export interface IdleCompactionSource {
  onActivityChange(listener: (change: IntegratedActivityChange) => void): () => void;
  onCompactionSignal(listener: (processId: string, signal: CompactionSignal) => void): () => void;
  onConversationEvent(listener: (processId: string, event: IntegratedConversationEvent) => void): () => void;
  compact(processId: string): Promise<void>;
  model(processId: string): Promise<string | null>;
}

interface CompactionRow {
  harness: string;
  role: string;
  activity: string;
  state: 'armed' | null;
  idle_since: string | null;
  // The automatic attempt whose turn is running, so its end is not announced.
  notice: string | null;
}

// The assistant is never compacted: its voice sessions steer speech into the
// thread, and Codex drops input steered into a compaction.
//
// Compacts each Integrated agent at most once per idle period. An admitted
// prompt or command arms it; activity never does, so neither the compaction's
// own turn nor a turn it aborted re-arms it, and an agent left idle is
// compacted once rather than every hour. A turn the native agent starts on its
// own, such as after a background task, is not compacted.
export class IdleCompactionService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly unsubscribers: Array<() => void> = [];
  // The automatic attempt being admitted, so its 'compact' signal is told
  // from a /compact the user typed.
  private attempting: { processId: string; attempt: string } | null = null;
  private attempts = 0;

  constructor(
    private readonly database: DatabaseService,
    private readonly integrated: IdleCompactionSource,
    // Read when a deadline arrives, so a change applies to agents already idle.
    private readonly enabled: (harness: string) => boolean,
    private readonly log: (event: string, data: Record<string, unknown>) => void = () => {},
    private readonly now: () => number = Date.now
  ) {}

  // Nothing carries over a restart, or a lost native connection. Native
  // agents run on unseen, so saved idle times and running compactions cannot
  // be trusted:
  // every agent is disarmed until its next prompt, and a compaction still
  // running is announced when it ends. Runs before any activity event.
  start(): void {
    this.database.connection.prepare(`
      update processes set cache_compaction = null, cache_idle_since = null, cache_compaction_notice = null
      where cache_compaction is not null or cache_idle_since is not null or cache_compaction_notice is not null
    `).run();
    this.unsubscribers.push(this.integrated.onActivityChange((change) => this.changed(change)));
    this.unsubscribers.push(this.integrated.onCompactionSignal((processId, signal) => this.signalled(processId, signal)));
    this.unsubscribers.push(this.integrated.onConversationEvent((processId, event) => {
      if (event.kind === 'reconnecting' || (event.kind === 'error' && event.id === 'connection_error')) this.disconnected(processId);
    }));
  }

  // While the native connection is down, work can start unseen and activity
  // stays as it was. As after a restart, the agent waits for its next prompt.
  private disconnected(processId: string): void {
    const row = this.row(processId);
    if (!row || row.state !== 'armed') return;
    this.cancel(processId);
    this.write(processId, null, null);
    this.log('skipped', { processId, reason: 'disconnected' });
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // Whether an automatic compaction's turn is running, so its end is not
  // announced. A /compact the user typed is announced as before.
  compacting(processId: string): boolean {
    return Boolean(this.row(processId)?.notice);
  }

  private changed({ processId, activity, snapshot }: IntegratedActivityChange): void {
    const row = this.row(processId);
    if (!row || !this.eligibleAgent(row)) return;
    if (activity === 'working' || activity === 'thinking') {
      // Only an admitted prompt or command arms an agent. Activity alone can
      // be a turn Codex aborted to compact, or the compaction itself.
      this.cancel(processId);
      if (row.state === 'armed' && row.idle_since) this.write(processId, 'armed', null);
    } else if (activity === 'permission') {
      // A background task can ask between turns. That is not a new turn, so
      // it only holds the deadline.
      this.cancel(processId);
    } else if (activity === 'idle' || activity === 'error') {
      // Automatic compaction is admitted only while idle, so its turn is the
      // next to end, whether seen live or in a reconnect snapshot.
      if (row.notice) {
        this.setNotice(processId, null);
        this.log('finished', { processId });
      }
      if (row.state === 'armed' && activity === 'idle') {
        if (row.idle_since) this.schedule(processId);
        else if (snapshot) {
          // The turn ended while Patterm was not watching, so the cache's age
          // is unknown.
          this.write(processId, null, null);
          this.log('skipped', { processId, reason: 'unknown idle time' });
        } else {
          this.write(processId, 'armed', this.iso());
          this.schedule(processId);
        }
      }
    }
  }

  private signalled(processId: string, signal: CompactionSignal): void {
    const row = this.row(processId);
    if (!row || !this.eligibleAgent(row)) return;
    // An automatic attempt handles its own rejection; a late one must not
    // touch a newer turn's state or deadline.
    if (signal === 'compact_rejected') return;
    this.cancel(processId);
    if (signal === 'turn') {
      // Arms even while a compaction is in flight: the new prompt extends the
      // conversation after it. A turn that already ended starts idling now.
      const idle = row.activity === 'idle';
      this.write(processId, 'armed', idle ? this.iso() : null);
      if (idle) this.schedule(processId);
    } else if (signal === 'compact') {
      // Any compaction counts as the idle period's.
      this.write(processId, null, null);
      if (this.attempting?.processId === processId) this.setNotice(processId, this.attempting.attempt);
    } else {
      // The cache belongs to the previous model until a turn runs on the new one.
      this.write(processId, null, null);
    }
  }

  private eligibleAgent(row: CompactionRow): boolean {
    return Boolean(IDLE_COMPACTION_AFTER_MS[row.harness]) && row.role !== 'assistant';
  }

  private schedule(processId: string): void {
    this.cancel(processId);
    const row = this.row(processId);
    const after = row && IDLE_COMPACTION_AFTER_MS[row.harness];
    if (!row?.idle_since || !after) return;
    const delay = Math.max(0, Date.parse(row.idle_since) + after - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(processId);
      void this.fire(processId).catch((error: unknown) => {
        this.log('failed', { processId, message: error instanceof Error ? error.message : String(error) });
      });
    }, delay);
    timer.unref();
    this.timers.set(processId, timer);
  }

  private async fire(processId: string): Promise<void> {
    const row = this.due(processId);
    if (!row) return;
    if (!this.enabled(row.harness)) {
      this.write(processId, null, null);
      this.log('skipped', { processId, harness: row.harness, reason: 'disabled' });
      return;
    }
    if (row.harness !== 'claude') {
      const model = await this.integrated.model(processId);
      // A turn, model change, or compaction during the lookup owns the row now.
      const current = this.row(processId);
      if (current?.state !== 'armed' || current.idle_since !== row.idle_since) return;
      if (!eligibleModel(row.harness, model)) {
        this.write(processId, null, null);
        this.log('skipped', { processId, harness: row.harness, model, reason: 'model' });
        return;
      }
      if (!this.due(processId)) return;
    }
    this.log('started', { processId, harness: row.harness });
    // The 'compact' signal fires synchronously while admission begins.
    const attempt = `${this.now()}:${++this.attempts}`;
    this.attempting = { processId, attempt };
    let admission: Promise<void>;
    try {
      admission = this.integrated.compact(processId);
    } finally {
      this.attempting = null;
    }
    try {
      await admission;
    } catch (error) {
      // Only this attempt's notice, and only if the attempt surely never
      // started; an uncertain one keeps it until its turn ends. The next turn
      // arms the agent again.
      if (!uncertainAdmission(error) && this.row(processId)?.notice === attempt) this.setNotice(processId, null);
      throw error;
    }
  }

  // An armed agent that has been idle long enough, and not so long that its
  // cache has gone.
  private due(processId: string): CompactionRow | null {
    const row = this.row(processId);
    const after = row && IDLE_COMPACTION_AFTER_MS[row.harness];
    if (!row || !after || !this.eligibleAgent(row) || row.state !== 'armed' || !row.idle_since || row.activity !== 'idle') return null;
    const idleFor = this.now() - Date.parse(row.idle_since);
    if (idleFor < after) {
      this.schedule(processId);
      return null;
    }
    if (idleFor > after + LATE_MS) {
      this.write(processId, null, null);
      this.log('skipped', { processId, reason: 'late', idleMinutes: Math.round(idleFor / 60_000) });
      return null;
    }
    return row;
  }

  private cancel(processId: string): void {
    const timer = this.timers.get(processId);
    if (timer) clearTimeout(timer);
    this.timers.delete(processId);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private row(processId: string): CompactionRow | undefined {
    return this.database.connection.prepare(`
      select sessions.harness, sessions.session_role as role, processes.activity, processes.cache_compaction as state, processes.cache_idle_since as idle_since,
        processes.cache_compaction_notice as notice
      from processes join sessions on sessions.process_id = processes.id
      where processes.id = ? and processes.status = 'running' and sessions.interface_mode = 'integrated' and sessions.exited_at is null
      order by sessions.started_at desc limit 1
    `).get(processId) as CompactionRow | undefined;
  }

  private setNotice(processId: string, notice: CompactionRow['notice']): void {
    this.database.connection.prepare('update processes set cache_compaction_notice = ? where id = ?').run(notice, processId);
  }

  private write(processId: string, state: CompactionRow['state'], idleSince: string | null): void {
    this.database.connection.prepare('update processes set cache_compaction = ?, cache_idle_since = ? where id = ?').run(state, idleSince, processId);
  }
}

// A timeout or lost connection after the request was sent may still have
// started the compaction.
function uncertainAdmission(error: unknown): boolean {
  return error instanceof UncertainDeliveryError || (Boolean(error) && typeof error === 'object' && (error as { definitive?: unknown }).definitive === false);
}
