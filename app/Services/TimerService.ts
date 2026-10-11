import { randomUUID } from 'node:crypto';
import type { DatabaseService } from './DatabaseService';
import { sendAgentInput } from './AgentInputService';
import type { TerminalService } from './TerminalService';
import type { IntegratedAgentService } from './IntegratedAgentService';
import type { AssistantInbox } from './AssistantInbox';

export type TimerKind = 'delay' | 'idle_any' | 'idle_all' | 'report_any' | 'report_all';
export type TimerStatus = 'pending' | 'paused';

export interface TimerRecord {
  id: string;
  kind: TimerKind;
  status: TimerStatus;
  ownerProcessId: string | null;
  watched: string[];
  body: string;
  label: string | null;
  firesAtUnixMs: number | null;
  pausedRemainingMs: number | null;
  createdAtUnixMs: number;
}

export interface McpTimerInfo {
  timer_id: string;
  label?: string;
  kind: TimerKind;
  status: TimerStatus;
  owner_process_id: string;
  watched: string[];
  body: string;
  fires_at_unix_ms?: number;
  paused_remaining_ms?: number;
}

interface TimerEntry {
  id: string;
  kind: TimerKind;
  status: TimerStatus;
  ownerProcessId: string | null;
  watched: string[];
  seenNonIdleProcessIds: Set<string>;
  body: string;
  label: string | null;
  firesAtUnixMs: number | null;
  remainingMs: number | null;
  createdAtUnixMs: number;
  timeout: NodeJS.Timeout | null;
  interval: NodeJS.Timeout | null;
}

type WatchedState =
  | { process_id: string; satisfied: boolean; reason: 'missing' }
  | { process_id: string; satisfied: boolean; reason: 'exited'; status: string; name: string }
  | { process_id: string; satisfied: boolean; reason: 'idle' | 'working' | 'not_started'; name: string; activity: string }
  | { process_id: string; satisfied: boolean; reason: 'reported'; name: string; report_status: string; excerpt: string; at: string }
  | { process_id: string; satisfied: boolean; reason: 'messaged'; name: string; excerpt: string; at: string }
  | { process_id: string; satisfied: boolean; reason: 'waiting'; name: string; activity: string };

const EXCERPT_CHARS = 300;

interface SavedTimer extends TimerRecord {
  seenNonIdleProcessIds: string[];
}

export class TimerService {
  private readonly timers = new Map<string, TimerEntry>();
  private active: boolean;

  private resolveRemote: ((address: string) => { host_id: string; process_id: string; name: string } | null) | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly terminal: TerminalService,
    private readonly options: { persistent?: boolean; integrated?: Pick<IntegratedAgentService, 'prompt'>; assistantInbox?: Pick<AssistantInbox, 'hold'>; onChanged?: () => void } = {}
  ) {
    this.active = !options.persistent;
    if (options.persistent) {
      const rows = database.connection.prepare('select record from runtime_timers').all() as Array<{ record: string }>;
      for (const row of rows) {
        const saved = JSON.parse(row.record) as SavedTimer;
        this.timers.set(saved.id, {
          ...saved,
          seenNonIdleProcessIds: new Set(saved.seenNonIdleProcessIds),
          remainingMs: saved.pausedRemainingMs,
          timeout: null,
          interval: null
        });
      }
    }
  }

  // Restored watchers must wait until the app has reconciled the live runtime.
  activate(): void {
    if (this.active) return;
    this.active = true;
    for (const entry of this.timers.values()) this.arm(entry);
  }

  list(): TimerRecord[] {
    return [...this.timers.values()].map((entry) => this.toRecord(entry));
  }

  listMcp(): McpTimerInfo[] {
    return [...this.timers.values()].map((entry) => this.toMcpInfo(entry));
  }

  setDelay(input: { seconds: number; ownerProcessId?: string | null | undefined; body: string; label?: string | null | undefined }): TimerRecord {
    const id = randomTimerId();
    const delay = Math.max(0, input.seconds * 1000);
    const entry: TimerEntry = {
      id,
      kind: 'delay',
      status: 'pending',
      ownerProcessId: input.ownerProcessId ?? null,
      watched: [],
      seenNonIdleProcessIds: new Set(),
      body: input.body,
      label: input.label?.trim() || null,
      firesAtUnixMs: Date.now() + delay,
      remainingMs: null,
      createdAtUnixMs: Date.now(),
      timeout: null,
      interval: null
    };
    this.register(entry);
    return this.toRecord(entry);
  }

  setIdle(input: {
    kind: 'idle_any' | 'idle_all';
    watched: string[];
    ownerProcessId?: string | null | undefined;
    body: string;
    maxWaitSeconds?: number | undefined;
    label?: string | null | undefined;
  }): TimerRecord {
    const id = randomTimerId();
    const entry: TimerEntry = {
      id,
      kind: input.kind,
      status: 'pending',
      ownerProcessId: input.ownerProcessId ?? null,
      watched: input.watched,
      seenNonIdleProcessIds: new Set(),
      body: input.body,
      label: input.label?.trim() || null,
      firesAtUnixMs: input.maxWaitSeconds && input.maxWaitSeconds > 0 ? Date.now() + input.maxWaitSeconds * 1000 : null,
      remainingMs: null,
      createdAtUnixMs: Date.now(),
      timeout: null,
      interval: null
    };
    this.register(entry);
    return this.toRecord(entry);
  }

  setReport(input: {
    kind: 'report_any' | 'report_all';
    watched: string[];
    ownerProcessId?: string | null | undefined;
    body: string;
    maxWaitSeconds?: number | undefined;
    label?: string | null | undefined;
  }): TimerRecord {
    const id = randomTimerId();
    const entry: TimerEntry = {
      id,
      kind: input.kind,
      status: 'pending',
      ownerProcessId: input.ownerProcessId ?? null,
      watched: input.watched,
      seenNonIdleProcessIds: new Set(),
      body: input.body,
      label: input.label?.trim() || null,
      firesAtUnixMs: input.maxWaitSeconds && input.maxWaitSeconds > 0 ? Date.now() + input.maxWaitSeconds * 1000 : null,
      remainingMs: null,
      createdAtUnixMs: Date.now(),
      timeout: null,
      interval: null
    };
    this.register(entry);
    return this.toRecord(entry);
  }

  cancel(timerId: string): 'ok' {
    if (this.options.persistent) this.database.connection.prepare('delete from runtime_timers where id = ?').run(timerId);
    const entry = this.timers.get(timerId);
    if (entry) {
      this.clearHandles(entry);
      this.timers.delete(timerId);
      this.options.onChanged?.();
    }
    return 'ok';
  }

  cancelAll(): void {
    if (this.options.persistent) this.database.connection.prepare('delete from runtime_timers').run();
    for (const entry of this.timers.values()) this.clearHandles(entry);
    this.timers.clear();
  }

  pause(timerId: string): 'ok' {
    const entry = this.timers.get(timerId);
    if (!entry || entry.status === 'paused') {
      return 'ok';
    }
    if (entry.firesAtUnixMs !== null) {
      entry.remainingMs = Math.max(0, entry.firesAtUnixMs - Date.now());
    }
    this.clearHandles(entry);
    entry.status = 'paused';
    this.persist(entry);
    this.options.onChanged?.();
    return 'ok';
  }

  resume(timerId: string): 'ok' {
    const entry = this.timers.get(timerId);
    if (!entry || entry.status === 'pending') {
      return 'ok';
    }
    entry.status = 'pending';
    if (entry.remainingMs !== null) entry.firesAtUnixMs = Date.now() + entry.remainingMs;
    entry.remainingMs = null;
    this.persist(entry);
    this.arm(entry);
    this.options.onChanged?.();
    return 'ok';
  }

  // Pauses a process's pending timers while it is replaced, so none fires
  // into the gap. Returns the IDs to resume once the replacement owns them.
  holdOwner(processId: string): string[] {
    const held = [...this.timers.values()].filter((entry) => entry.ownerProcessId === processId && entry.status === 'pending').map((entry) => entry.id);
    for (const id of held) this.pause(id);
    return held;
  }

  // Pending callbacks of replaced processes go to the process replacing them.
  transferOwner(fromProcessIds: readonly string[], toProcessId: string): void {
    const from = new Set(fromProcessIds);
    let changed = false;
    for (const entry of this.timers.values()) {
      if (!entry.ownerProcessId || !from.has(entry.ownerProcessId)) continue;
      entry.ownerProcessId = toProcessId;
      this.persist(entry);
      changed = true;
    }
    if (changed) this.options.onChanged?.();
  }

  dispose(): void {
    this.active = false;
    for (const entry of this.timers.values()) {
      this.clearHandles(entry);
    }
    this.timers.clear();
  }

  private register(entry: TimerEntry): void {
    this.persist(entry);
    this.timers.set(entry.id, entry);
    this.arm(entry);
    this.options.onChanged?.();
  }

  private persist(entry: TimerEntry): void {
    if (!this.options.persistent) return;
    const record: SavedTimer = { ...this.toRecord(entry), seenNonIdleProcessIds: [...entry.seenNonIdleProcessIds] };
    this.database.connection.prepare('insert into runtime_timers (id, record) values (?, ?) on conflict(id) do update set record = excluded.record')
      .run(entry.id, JSON.stringify(record));
  }

  private arm(entry: TimerEntry): void {
    if (!this.active || entry.status !== 'pending') return;
    if (entry.firesAtUnixMs !== null) this.armTimeout(entry, entry.firesAtUnixMs - Date.now());
    if (entry.kind === 'idle_any' || entry.kind === 'idle_all') {
      this.armIdleInterval(entry);
      void this.checkIdle(entry).catch(() => undefined);
    } else if (entry.kind === 'report_any' || entry.kind === 'report_all') {
      this.armReportInterval(entry);
      void this.checkReport(entry).catch(() => undefined);
    }
  }

  private async checkIdle(entry: TimerEntry): Promise<void> {
    if (entry.status !== 'pending' || entry.watched.length === 0 || !this.timers.has(entry.id)) {
      return;
    }
    const states = entry.watched.map((id) => this.processIdleState(entry, id));
    const satisfied = entry.kind === 'idle_any' ? states.some((state) => state.satisfied) : states.every((state) => state.satisfied);
    if (satisfied) {
      await this.fire(entry, 'condition', states);
    }
  }

  private processIdleState(entry: TimerEntry, processId: string): WatchedState {
    const row = this.watchedProcess(processId);
    if (!row) {
      return { process_id: processId, satisfied: true, reason: 'missing' };
    }
    if (row.status !== 'running') {
      return { process_id: row.id, satisfied: true, reason: 'exited', status: row.status, name: row.name };
    }
    if (row.activity !== 'idle') {
      if (!entry.seenNonIdleProcessIds.has(row.id)) {
        entry.seenNonIdleProcessIds.add(row.id);
        this.persist(entry);
      }
      return { process_id: row.id, satisfied: false, reason: 'working', name: row.name, activity: row.activity };
    }

    const satisfied = entry.seenNonIdleProcessIds.has(row.id) || row.updated_at !== row.created_at;
    return { process_id: row.id, satisfied, reason: satisfied ? 'idle' : 'not_started', name: row.name, activity: row.activity };
  }

  private watchedProcess(processId: string) {
    return this.database.connection
      .prepare(
        `select processes.id, processes.status, processes.activity, processes.created_at, processes.updated_at,
                coalesce((select coalesce(sessions.display_name, sessions.last_title) from sessions
                          where sessions.process_id = processes.id order by sessions.started_at desc limit 1), processes.name) as name
         from processes
         where processes.id = ? or processes.pty_process_id = ?
         order by processes.status = 'running' desc
         limit 1`
      )
      .get(processId, processId) as { id: string; status: string; activity: string; created_at: string; updated_at: string; name: string } | undefined;
  }

  private async checkReport(entry: TimerEntry): Promise<void> {
    if (entry.status !== 'pending' || entry.watched.length === 0 || !this.timers.has(entry.id)) {
      return;
    }
    const states = entry.watched.map((id) => this.processReportState(entry, id));
    const satisfied = entry.kind === 'report_any' ? states.some((state) => state.satisfied) : states.every((state) => state.satisfied);
    if (satisfied) {
      await this.fire(entry, 'condition', states);
    }
  }

  // Resolves `host:process` addresses of agents on paired hosts.
  setRemoteResolver(resolve: (address: string) => { host_id: string; process_id: string; name: string } | null): void {
    this.resolveRemote = resolve;
  }

  // An agent on another host answers a report timer by messaging its owner.
  // Its exit is not seen here, so only the message or the rescue timeout
  // fires the timer.
  private remoteReportState(entry: TimerEntry, address: string): WatchedState {
    let remote: { host_id: string; process_id: string; name: string } | null = null;
    try { remote = this.resolveRemote?.(address) ?? null; } catch { remote = null; }
    if (!remote) return { process_id: address, satisfied: true, reason: 'missing' };
    const label = `${remote.name}:${remote.process_id}`;
    const event = this.database.connection.prepare(
      `select metadata, created_at from timeline_events
       where event_type = 'message.received' and created_at >= ?
         and json_extract(metadata, '$.from_host_id') = ? and json_extract(metadata, '$.from_process_id') = ?
         and json_extract(metadata, '$.to_process_id') = ? and json_extract(metadata, '$.delivery') is null
       order by created_at asc limit 1`
    ).get(new Date(entry.createdAtUnixMs).toISOString(), remote.host_id, remote.process_id, entry.ownerProcessId ?? '') as { metadata: string; created_at: string } | undefined;
    if (!event) return { process_id: label, satisfied: false, reason: 'waiting', name: label, activity: 'remote' };
    const metadata = parseRecord(event.metadata);
    return { process_id: label, satisfied: true, reason: 'messaged', name: label, excerpt: excerptOf(typeof metadata.body === 'string' ? metadata.body : ''), at: event.created_at };
  }

  private processReportState(entry: TimerEntry, processId: string): WatchedState {
    if (processId.includes(':')) return this.remoteReportState(entry, processId);
    const row = this.watchedProcess(processId);
    if (!row) {
      return { process_id: processId, satisfied: true, reason: 'missing' };
    }

    // A report, or a message to the timer's owner, made after the timer
    // started. Messages count so agents outside the owner's tree, which
    // cannot report to it, can still answer it.
    const reportedAfter = new Date(entry.createdAtUnixMs).toISOString();
    const event = this.database.connection
      .prepare(
        `select event_type, metadata, created_at
         from timeline_events
         where process_id = ?
           and created_at >= ?
           and (event_type = 'agent.reported'
                or (event_type = 'message.sent' and json_extract(metadata, '$.to_process_id') = ?
                    and json_extract(metadata, '$.delivery') is null))
         order by created_at asc
         limit 1`
      )
      .get(row.id, reportedAfter, entry.ownerProcessId ?? '') as { event_type: string; metadata: string; created_at: string } | undefined;
    if (event) {
      const metadata = parseRecord(event.metadata);
      const excerpt = excerptOf([metadata.title, metadata.body].filter((part) => typeof part === 'string' && part.trim()).join(': '));
      return event.event_type === 'agent.reported'
        ? { process_id: row.id, satisfied: true, reason: 'reported', name: row.name, report_status: typeof metadata.status === 'string' ? metadata.status : 'completed', excerpt, at: event.created_at }
        : { process_id: row.id, satisfied: true, reason: 'messaged', name: row.name, excerpt, at: event.created_at };
    }
    if (row.status !== 'running') {
      return { process_id: row.id, satisfied: true, reason: 'exited', status: row.status, name: row.name };
    }
    return { process_id: row.id, satisfied: false, reason: 'waiting', name: row.name, activity: row.activity };
  }

  private async fire(entry: TimerEntry, trigger: 'condition' | 'timeout', states?: WatchedState[]): Promise<void> {
    if (!this.active || entry.status !== 'pending' || !this.timers.has(entry.id)) {
      return;
    }
    const text = this.callbackText(entry, trigger, states);
    // Consume before sending: a lost acknowledgement must not replay terminal
    // input after a restart. A crash during delivery can lose this callback.
    this.cancel(entry.id);
    if (entry.ownerProcessId && text) {
      // An assistant in Focus mode reads the callback when focus ends.
      if (this.options.assistantInbox?.hold(entry.ownerProcessId, { kind: 'timer', title: `Timer ${entry.id} (${entry.kind}) fired`, body: text, dedupeKey: `timer:${entry.id}` })) return;
      await sendAgentInput(this.database, this.terminal, {
        process_id: entry.ownerProcessId,
        kind: 'text',
        text,
        submit: true
      }, this.options.integrated);
    }
  }

  // Watch timers say why they fired and what each watched process did, so
  // the owner need not read output to find out. Delay timers send their body.
  private callbackText(entry: TimerEntry, trigger: 'condition' | 'timeout', computed?: WatchedState[]): string {
    if (entry.kind === 'delay') return entry.body;
    const report = entry.kind === 'report_any' || entry.kind === 'report_all';
    const states = computed ?? entry.watched.map((id) => report ? this.processReportState(entry, id) : this.processIdleState(entry, id));
    const name = `${entry.id}${entry.label ? ` (${entry.label})` : ''}`;
    const lines = [`[Patterm timer ${name}: ${trigger === 'timeout' ? 'max_wait elapsed' : 'condition met'}]`, ...states.map((state) => describeState(state, report))];
    if (states.some((state) => state.reason === 'reported')) lines.push('Read full results with get_conversation_output.');
    const body = entry.body.trim();
    return body ? `${lines.join('\n')}\n${body}` : lines.join('\n');
  }

  private clearHandles(entry: TimerEntry): void {
    if (entry.timeout) {
      clearTimeout(entry.timeout);
    }
    if (entry.interval) {
      clearInterval(entry.interval);
    }
    entry.timeout = null;
    entry.interval = null;
  }

  private armTimeout(entry: TimerEntry, delayMs: number): void {
    entry.timeout = setTimeout(() => {
      void this.fire(entry, 'timeout').catch(() => undefined);
    }, Math.max(0, delayMs));
  }

  private armIdleInterval(entry: TimerEntry): void {
    entry.interval = setInterval(() => {
      void this.checkIdle(entry).catch(() => undefined);
    }, 500);
  }

  private armReportInterval(entry: TimerEntry): void {
    entry.interval = setInterval(() => {
      void this.checkReport(entry).catch(() => undefined);
    }, 500);
  }

  private toRecord(entry: TimerEntry): TimerRecord {
    return {
      id: entry.id,
      kind: entry.kind,
      status: entry.status,
      ownerProcessId: entry.ownerProcessId,
      watched: [...entry.watched],
      body: entry.body,
      label: entry.label,
      firesAtUnixMs: entry.firesAtUnixMs,
      pausedRemainingMs: entry.remainingMs,
      createdAtUnixMs: entry.createdAtUnixMs
    };
  }

  private toMcpInfo(entry: TimerEntry): McpTimerInfo {
    return {
      timer_id: entry.id,
      ...(entry.label ? { label: entry.label } : {}),
      kind: entry.kind,
      status: entry.status,
      owner_process_id: entry.ownerProcessId ?? '',
      watched: [...entry.watched],
      body: entry.body,
      ...(entry.firesAtUnixMs === null ? {} : { fires_at_unix_ms: entry.firesAtUnixMs }),
      ...(entry.remainingMs === null ? {} : { paused_remaining_ms: entry.remainingMs })
    };
  }

}

function describeState(state: WatchedState, report: boolean): string {
  switch (state.reason) {
    case 'missing': return `- ${state.process_id}: no longer exists`;
    case 'exited': return `- ${state.process_id} "${state.name}": ${state.status}${report ? ' without reporting' : ''}`;
    case 'reported': return `- ${state.process_id} "${state.name}": reported ${state.report_status} at ${state.at}${state.excerpt ? `: ${state.excerpt}` : ''}`;
    case 'messaged': return `- ${state.process_id} "${state.name}": sent you a message at ${state.at}${state.excerpt ? `: ${state.excerpt}` : ''}`;
    case 'idle': return `- ${state.process_id} "${state.name}": idle (its turn ended)`;
    case 'not_started': return `- ${state.process_id} "${state.name}": idle and has not started working`;
    case 'working':
    case 'waiting': return `- ${state.process_id} "${state.name}": still ${state.activity === 'idle' ? 'running without a report' : state.activity}`;
  }
}

function excerptOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

function parseRecord(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

function randomTimerId(): string {
  return `timer_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}
