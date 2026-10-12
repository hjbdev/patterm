import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { DatabaseService } from './DatabaseService';
import type { SettingsService } from './SettingsService';
import type { TerminalService } from './TerminalService';
import type { AutoSummaryRunner } from './AutoSummaryRunner';
import { autoSummarySettingsInput, type AutoSummarySettings, type SummaryContext } from './AutoSummarySettings';
import { SecretRedactor } from './AgentHistory/SecretRedactor';
import type { IntegratedConversationEvent } from './IntegratedConversation';
import { snapshotRows } from './ConversationText';
import type { SqliteConnection } from '../Database/SqliteConnection';

// Integrated agents have no terminal; their transcript and stream events stand
// in for the screen snapshot and terminal frames.
export interface IntegratedSummarySource {
  conversation(processId: string): Promise<unknown>;
  onConversationEvent(listener: (processId: string, event: IntegratedConversationEvent) => void): () => void;
}

interface ProcessRow { id: string; pty_process_id: string | null; activity: string; integrated: number; }
interface PendingSummary {
  started: number; changed: number; attempted: number; retryAt: number; hash: string | null;
  failures: number; controller: AbortController | null;
}

export function summarySnapshot(text: string): string {
  const clean = new SecretRedactor().redact(stripVTControlCharacters(text)).text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').split('\n').slice(-100).join('\n').trim();
  const points = Array.from(clean.slice(-12 * 1024));
  let bytes = 0;
  let start = points.length;
  while (start > 0 && bytes + Buffer.byteLength(points[start - 1]!) <= 12 * 1024) {
    bytes += Buffer.byteLength(points[--start]!);
  }
  return points.slice(start).join('').replace(/^[\udc00-\udfff]/, '');
}

// Titles and status lines fill one line of the tab and sidebar.
function oneLine(text: string | undefined): string | null {
  return text ? summarySnapshot(text).replace(/\s+/g, ' ').trim() || null : null;
}

// Visible text and tool titles from the latest transcript rows. Reasoning and
// subagent rows are left out; they are long and not what the user reads.
export function conversationSummaryText(conversation: unknown): string {
  const lines: string[] = [];
  for (const row of snapshotRows(conversation)) {
    if (row.kind === 'reasoning') continue;
    const text = row.kind === 'tool' ? [row.title, row.detail].filter(Boolean).join(': ') : row.text;
    if (!text.trim()) continue;
    const label = row.kind === 'tool' ? 'Tool' : row.kind === 'notice' ? 'Notice' : row.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${label}: ${text.trim().slice(0, 2000)}`);
  }
  return lines.slice(-60).join('\n');
}

// Messages Patterm or other agents type into a thread, and slash commands or
// CLI command tags, say nothing about what the owner asked for.
const INJECTED = /^(\/|<|\[(report from|message from|agent message from|Attention requested by|Attention needed by|Failure reported by|Patterm |System notification|system\]))/;

export function isOwnerMessage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== '' && !INJECTED.test(trimmed);
}

// The first messages usually state the goal and the latest ones any change of
// direction; the middle is left out to keep the input small. Redaction runs
// before the cut, so a cut cannot hide a secret from it.
export function ownerMessages(texts: string[], redact: (text: string) => string = (text) => text): string[] {
  // History and a live runtime can both hold a message; keep its first copy.
  const own = [...new Set(texts.map((text) => text.trim()))].filter(isOwnerMessage);
  const picked = own.length > 10 ? [...own.slice(0, 2), ...own.slice(-8)] : own;
  return picked.map((text, index) => redact(text).slice(0, index === 0 ? 1500 : 500));
}

// Terminal processes are keyed by their PTY ID, as terminal frames are, and
// Integrated agents by their process ID.
function summaryKey(row: ProcessRow): string {
  return row.integrated ? row.id : row.pty_process_id!;
}

export class AutoSummaryService {
  private readonly pending = new Map<string, PendingSummary>();
  private readonly jobs = new Map<AbortController, Promise<unknown>>();
  private readonly unsubscribers: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private error: string | null = null;
  private errorAt: string | null = null;
  private settings: AutoSummarySettings;
  private disposed = false;

  constructor(private readonly database: DatabaseService, private readonly settingsService: SettingsService,
    private readonly terminal: Pick<TerminalService, 'request' | 'onFrame'>,
    private readonly runner: Pick<AutoSummaryRunner, 'run' | 'availability'>,
    private readonly notify: () => void, private readonly now: () => number = Date.now,
    private readonly integrated: IntegratedSummarySource | null = null,
    private readonly history: { readonly connection: SqliteConnection } | null = null) {
    this.settings = settingsService.autoSummarySettings();
  }

  start(): void {
    this.unsubscribers.push(this.terminal.onFrame((frame) => {
      if (!frame.processId) return;
      const pending = this.pending.get(frame.processId);
      if (!pending) return;
      pending.changed = this.now();
      if (frame.type === 'terminal-lifecycle' && frame.event === 'activity' && frame.activity === 'permission') {
        pending.controller?.abort();
      }
      if (frame.type === 'terminal-lifecycle' && frame.event === 'exit') {
        pending.controller?.abort();
        this.pending.delete(frame.processId);
      }
    }));
    if (this.integrated) {
      this.unsubscribers.push(this.integrated.onConversationEvent((processId) => {
        const pending = this.pending.get(processId);
        if (pending) pending.changed = this.now();
      }));
    }
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  // Takes a PTY ID for terminal input and a process ID for Integrated prompts.
  userInput(key: string): void {
    if (!this.settings.enabled || this.disposed) return;
    const existing = this.pending.get(key);
    if (existing) { existing.changed = this.now(); return; }
    this.pending.set(key, {
      started: this.now(), changed: this.now(), attempted: -Infinity, retryAt: 0,
      hash: null, failures: 0, controller: null
    });
  }

  status() {
    return { settings: this.settings, providers: ['claude', 'codex', 'opencode'].map((provider) => ({
      provider, ...this.runner.availability(provider as AutoSummarySettings['provider'])
    })), inFlight: this.jobs.size, lastError: this.error, lastErrorAt: this.errorAt };
  }

  update(raw: unknown): AutoSummarySettings {
    const settings = autoSummarySettingsInput.parse(raw);
    if (settings.enabled) {
      const availability = this.runner.availability(settings.provider);
      if (!availability.available) throw new Error(availability.reason!);
    }
    this.settings = this.settingsService.updateAutoSummarySettings(settings);
    // Generated titles go when they are turned off; chosen and native names stay.
    if (!settings.titles) this.database.connection.prepare('update sessions set auto_title = null where auto_title is not null').run();
    for (const controller of this.jobs.keys()) controller.abort();
    this.pending.clear();
    this.error = null;
    this.errorAt = null;
    this.notify();
    return this.settings;
  }

  async test(raw: unknown): Promise<{ ok: true }> {
    if (this.disposed || this.jobs.size >= 2) throw new Error('Summarisers are busy. Try again shortly.');
    const settings = autoSummarySettingsInput.parse(raw);
    const controller = new AbortController();
    const job = this.runner.run(settings, 'patterm okay', controller.signal, 'test');
    this.jobs.set(controller, job);
    try {
      const { summary } = await job;
      if (controller.signal.aborted) throw new Error('Summary cancelled.');
      if (summary.trim().toLowerCase() !== 'patterm okay') throw new Error('Summariser health check did not return the expected phrase.');
      return { ok: true };
    } finally { this.jobs.delete(controller); }
  }

  tick(): void {
    if (this.disposed || !this.settings.enabled || this.pending.size === 0) return;
    const live = (this.database.connection.prepare(`select id, pty_process_id, activity, exists(select 1 from sessions
        where sessions.process_id = processes.id and interface_mode = 'integrated' and exited_at is null) as integrated
      from processes where status = 'running' and parent_process_id is null`).all() as unknown as ProcessRow[])
      .filter((row) => row.integrated ? this.integrated !== null : row.pty_process_id !== null);
    const ids = new Set(live.map(summaryKey));
    for (const [id, pending] of this.pending) {
      if (!ids.has(id)) { pending.controller?.abort(); this.pending.delete(id); }
    }
    // Give older attempts priority so two slow terminals cannot starve the rest.
    live.sort((a, b) => (this.pending.get(summaryKey(a))?.attempted ?? Infinity) - (this.pending.get(summaryKey(b))?.attempted ?? Infinity));
    for (const row of live) {
      if (this.jobs.size >= 2) break;
      const pending = this.pending.get(summaryKey(row));
      if (!pending || pending.controller || row.activity === 'permission') continue;
      const now = this.now();
      const interval = this.settings.intervalSeconds * 1000;
      if (now < pending.retryAt || now - pending.attempted < interval) continue;
      // An idle agent that has drawn or received nothing since its last attempt
      // matched or made a recap would only match it again. Working terminals
      // keep their periodic recaps: without a viewer they send no frames.
      if (row.activity === 'idle' && pending.hash !== null && pending.failures === 0 && pending.changed <= pending.attempted) continue;
      const quiet = row.activity === 'idle' && now - pending.changed >= 2000;
      if (!quiet && now - Math.max(pending.started, pending.attempted) < interval) continue;
      const settings = this.settings;
      const controller = new AbortController();
      pending.controller = controller;
      pending.attempted = now;
      const job = this.summarise(row, pending, settings, controller).finally(() => {
        pending.controller = null;
        this.jobs.delete(controller);
      });
      this.jobs.set(controller, job);
    }
  }

  private async summarise(row: ProcessRow, pending: PendingSummary, settings: AutoSummarySettings, controller: AbortController): Promise<void> {
    try {
      const conversation = row.integrated ? await this.integrated!.conversation(row.id) : null;
      const source = row.integrated
        ? conversationSummaryText(conversation)
        : ((await this.terminal.request('terminal.process.output', { process_id: row.pty_process_id, max_lines: 100 })) as { screen?: string }).screen ?? '';
      if (controller.signal.aborted || this.settings !== settings) return;
      const text = summarySnapshot(source);
      const context = this.context(row.id, conversation);
      const hash = createHash('sha256').update(text).update(JSON.stringify(context.user_messages)).digest('hex');
      if (text.length < 40) return;
      // A match means the recap is current, even after an earlier failure.
      if (hash === pending.hash) { pending.failures = 0; return; }
      const eligible = this.database.connection.prepare(`select 1 from processes where id = ? and pty_process_id is ?
        and status = 'running' and parent_process_id is null and activity != 'permission'`).get(row.id, row.pty_process_id);
      if (!eligible) return;
      const result = await this.runner.run(settings, text, controller.signal, 'summary', context);
      const summary = summarySnapshot(result.summary);
      if (!summary || controller.signal.aborted || this.settings !== settings || this.pending.get(summaryKey(row)) !== pending) return;
      const title = settings.titles ? oneLine(result.title) : null;
      const db = this.database.connection;
      const changed = db.transaction(() => {
        const updated = db.prepare(`update processes set auto_summary = ?, auto_status = ?, auto_summary_at = ?,
          auto_summary_provider = ?, auto_summary_model = ? where id = ? and pty_process_id is ? and status = 'running'
          and parent_process_id is null and activity != 'permission'`).run(summary, oneLine(result.status),
          new Date(this.now()).toISOString(), settings.provider, settings.models[settings.provider], row.id, row.pty_process_id).changes;
        if (updated && title) db.prepare('update sessions set auto_title = ? where process_id = ? and exited_at is null').run(title, row.id);
        return updated;
      })();
      if (changed) {
        pending.hash = hash;
        pending.failures = 0;
        this.notify();
      }
    } catch (error) {
      if (controller.signal.aborted || this.settings !== settings) return;
      pending.failures++;
      pending.retryAt = this.now() + Math.min(600_000, settings.intervalSeconds * 1000 * 2 ** Math.min(pending.failures, 5));
      // Runners only emit fixed, credential-safe errors; never store provider output.
      this.error = error instanceof Error && error.message.startsWith('Summary') ? error.message : 'Auto-summary failed. Test the summariser in Settings.';
      this.errorAt = new Date(this.now()).toISOString();
    }
  }

  // What the thread is for: its name, linked issues and todos, the owner's own
  // messages, and the last recap, which the next one updates instead of
  // starting again from the latest screen.
  private context(processId: string, conversation: unknown): SummaryContext {
    const db = this.database.connection;
    const thread = db.prepare(`select processes.name, processes.auto_summary, sessions.id as session_id, sessions.display_name,
        sessions.auto_title, sessions.last_title
      from processes left join sessions on sessions.process_id = processes.id where processes.id = ?
      order by sessions.started_at desc limit 1`).get(processId) as
      { name: string; auto_summary: string | null; session_id: string | null; display_name: string | null;
        auto_title: string | null; last_title: string | null } | undefined;
    if (!thread) return {};
    const references = thread.session_id ? (db.prepare(`select r.identifier, r.title, r.url from session_references sr
      join external_references r on r.id = sr.reference_id where sr.session_id = ? order by r.created_at limit 10`)
      .all(thread.session_id) as Array<{ identifier: string | null; title: string | null; url: string }>)
      .map((ref) => [ref.identifier, ref.title].filter(Boolean).join(': ') || ref.url) : [];
    const todos = thread.session_id ? (db.prepare(`select t.title, t.status from todo_assignments a join todos t on t.id = a.todo_id
      where a.session_id = ? order by t.created_at limit 10`).all(thread.session_id) as Array<{ title: string; status: string }>)
      .map((todo) => `${todo.title} (${todo.status.replace('_', ' ')})`) : [];
    const live = snapshotRows(conversation).filter((row) => row.role === 'user' && row.kind === 'text').map((row) => row.text);
    const redactor = new SecretRedactor();
    // Everything here goes to the provider, so every field is redacted.
    const redact = (text: string) => redactor.redact(stripVTControlCharacters(text)).text;
    return {
      thread_name: redact(thread.display_name ?? thread.name),
      references: references.map(redact), todos: todos.map(redact),
      user_messages: ownerMessages([...this.historyMessages(thread.session_id), ...live], redact),
      previous_summary: thread.auto_summary === null ? null : redact(thread.auto_summary),
      previous_title: thread.auto_title === null ? null : redact(thread.auto_title),
      native_title: thread.last_title === null ? null : redact(thread.last_title)
    };
  }

  // Imported history holds a terminal agent's messages, and the older part of
  // an Integrated one that its runtime has dropped. It can lag behind. Agent
  // reports and timers share the owner's role, so pages are read until enough
  // of the owner's own messages are found, up to a bound.
  private historyMessages(sessionId: string | null): string[] {
    if (!this.history || !sessionId) return [];
    const history = this.history;
    const collect = (order: 'asc' | 'desc', wanted: number) => {
      const statement = history.connection.prepare(`select m.text from conversation_messages m join conversations c on c.id = m.conversation_id
        where c.session_id = ? and m.role = 'user' and m.kind = 'message' order by c.started_at ${order}, m.seq ${order} limit 50 offset ?`);
      const found: string[] = [];
      for (let offset = 0; offset < 500 && found.length < wanted; offset += 50) {
        const rows = (statement.all(sessionId, offset) as Array<{ text: string }>).map((row) => row.text);
        found.push(...rows.filter(isOwnerMessage));
        if (rows.length < 50) break;
      }
      return found.slice(0, wanted);
    };
    try {
      return [...collect('asc', 2), ...collect('desc', 8).reverse()];
    } catch {
      // History is optional; a busy or missing database leaves the recap to the other context.
      return [];
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const controller of this.jobs.keys()) controller.abort();
    this.pending.clear();
    await Promise.allSettled(this.jobs.values());
  }
}
