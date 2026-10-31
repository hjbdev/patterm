import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathsMatch } from '../Platform/PathIdentity';
import { commandLineTooLong, execFileResolved, resolveService } from '../Platform/ServiceProcess';
import { awaitingActivity } from './Activity';
import type { DatabaseService } from './DatabaseService';
import { firstSemver, type McpServerSpec } from '../Harness/HarnessProvider';
import { openCodeMcpConfigs } from '../Harness/McpDelivery';
import type { IntegratedControls, IntegratedFormAction, IntegratedLaunchInput, IntegratedLaunchResult, LiveSettings } from './IntegratedAgentService';
import { OPENCODE_VERSION_MISMATCH } from './OpenCodeServiceErrors';
import { UncertainDeliveryError, type IntegratedDeliveryState } from './IntegratedDelivery';
import type { ResolvedIntegratedPrompt } from './IntegratedInput';
import { messagesTaskOutput, textTaskOutput, type IntegratedConversationEvent, type IntegratedConversationListener, type IntegratedDeliveryStatus, type IntegratedTaskOutput } from './IntegratedConversation';
import type { TranscriptImageRef, TranscriptImageStore } from './TranscriptImageStore';

// `opencode api` sends the JSON body as one argv entry: the kernel rejects any
// single argument at or above 128 KiB (E2BIG) before the CLI starts. Managed
// uploads bypass argv through the authenticated daemon; oversized CLI-only
// text fails definitively instead of being truncated. Windows has no
// per-argument limit; it caps the whole command line instead (see
// requestTooLarge).
const MAX_ARGUMENT_BYTES = 131_072;
// A native message listing echoes admitted base64 attachment content, so the
// capture bound must cover realistic uploads (10 MiB raw -> ~13.4 MiB base64).
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const OPENCODE_RECONNECT_ATTEMPTS = 8;
// The daemon writes a heartbeat every 15 s, so a stream silent for three of
// them is a dead connection, for example a half-open one after sleep.
const OPENCODE_STREAM_IDLE_MS = 45_000;
// An execution's end is shown only once nothing follows it at once: a
// successor execution, or a parent woken by its finished background subagent.
const OPENCODE_SETTLE_MS = 150;
// The daemon reports an execution's end just before the session leaves its
// active map, so a read right after the end may still find it there.
const OPENCODE_ENDED_TRUST_MS = 1_000;

type OpenCodeStatus = Exclude<IntegratedDeliveryStatus, 'unknown'>;
type OpenCodeEmit = (event: Omit<IntegratedConversationEvent, 'processId' | 'revision'>) => void;

// What the event stream says about one Patterm session: its own execution,
// the requests waiting on the user from it or its subagents, and subagent
// sessions still running after it stopped. Background shells do not count:
// they can run for as long as a dev server does.
interface OpenCodeActivity {
  execution: 'running' | 'idle' | 'error' | 'unknown';
  detail: string;
  // Pending permission and form request id -> the session that asked, which
  // of them are forms, and recently answered ids a read may still find
  // pending for a moment.
  requests: Map<string, string>;
  forms: Set<string>;
  answered: Set<string>;
  children: Set<string>;
  // Bumped by every stream change, so a snapshot knows whether the stream
  // moved on while it was reading.
  version: number;
  // Host times of the last reported end and the last prompt or command that
  // starts work.
  endedAt: number;
  admittedAt: number;
  // The status last sent on the stream, a deferred idle or error, and the
  // open streams it goes to.
  emitted: OpenCodeStatus | null;
  settling: NodeJS.Timeout | null;
  emitters: Set<OpenCodeEmit>;
  // Activity events received but not yet applied. An end is not shown while
  // later events wait, since one of them may resume the work.
  queued: number;
}

// One open event stream. Descendant lookups can need a native read, so they
// run in event order on their own chain.
interface OpenCodeStream {
  emit: OpenCodeEmit;
  runtime: { executable: string; cwd: string };
  serial: Promise<void>;
}

// One projected transcript row, keyed by its native identity: a tool call id,
// or the assistant message plus the family-specific ordinal for text and
// reasoning. The index is the native content position, which is the same key
// the message snapshot projection uses.
interface OpenCodeRow {
  rowId: string;
  index: number;
  kind: 'text' | 'reasoning' | 'tool';
  key: string;
  ordinal: number;
  toolId?: string;
  name?: string;
  text: string;
  input: string;
  inputValue?: unknown;
  state: Record<string, unknown>;
  images?: TranscriptImageRef[];
  // ISO times from the native snapshot or the event that started or ended it.
  createdAt?: string | undefined;
  completedAt?: string | undefined;
}

interface OpenCodeProjection {
  seeded: boolean;
  nextIndex: Map<string, number>;
  rows: Map<string, OpenCodeRow>;
  family: Map<string, OpenCodeRow[]>;
  tools: Map<string, OpenCodeRow>;
}

// The OpenCode v2 API identifies a model by provider/id plus an optional
// reasoning-effort variant (`high`, `max`, ...).
export interface OpenCodeModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export function openCodeModelRef(model: string, reasoning: string | null): OpenCodeModelRef {
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(`OpenCode model must be provider/model, got '${model}'`);
  }
  const ref: OpenCodeModelRef = { providerID: model.slice(0, separator), id: model.slice(separator + 1) };
  if (reasoning) ref.variant = reasoning;
  return ref;
}


// OpenCode owns its shared daemon. Patterm registers a runtime-only MCP bridge
// and durable per-session context; it never edits the user's OpenCode config.
export class OpenCodeServerService {
  private readonly token: string;
  private readonly selections = new Map<string, { agent?: string; model?: string; variant?: string }>();
  private readonly installedMcp = new Map<string, string>();
  private readonly preparing = new Map<string, Promise<IntegratedLaunchResult>>();
  // Server replacements run one at a time, so a launch never restarts a
  // server another launch has just replaced.
  private replacing: Promise<unknown> = Promise.resolve();
  // Monotonic event revisions per process. Snapshots capture the counter before
  // their native reads, so an event that lands during a read is never dropped
  // by the renderer's boundary check.
  private readonly revisions = new Map<string, number>();
  // Event-sourced projection for targeted streaming, keyed by native session
  // and shared across subscribers: a second subscription never clears another
  // session's part identity. Rows accumulate text, reasoning, and tool
  // input/output instead of replacing each other.
  private readonly projections = new Map<string, OpenCodeProjection>();
  // Subagents run in child sessions (Session.Info.parentID). Their permission
  // and form requests pause the parent's turn, so they are surfaced with the
  // parent. Parentage never changes, so lookups are cached; null is a root.
  private readonly sessionParents = new Map<string, string | null>();
  // Native session that owns each surfaced request, for routing the reply.
  private readonly requestOwners = new Map<string, string>();
  // Subagent session -> the subagent tool row that started it, for nesting.
  private readonly childRows = new Map<string, string>();
  // Event types each session's stream does not project, for the debug log.
  private readonly unhandled = new Map<string, Record<string, number>>();
  // Model context windows by providerID/id, read once per service.
  private contextWindows: Promise<Map<string, number>> | null = null;
  // Verified daemon discovery, shared by every request until a connection or
  // credential failure shows the registration is stale.
  private discovery: Promise<OpenCodeDaemon> | null = null;
  // Stream-derived activity by native session.
  private readonly activity = new Map<string, OpenCodeActivity>();

  private readonly images: TranscriptImageStore | null;
  private readonly streamIdleMs: number;
  private readonly settleMs: number;

  constructor(
    private readonly database: DatabaseService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    options: { persistent?: boolean; images?: TranscriptImageStore; streamIdleMs?: number; settleMs?: number } = {}
  ) {
    this.token = options.persistent ? persistentBridgeToken(path.dirname(database.dbPath)) : randomUUID();
    this.images = options.images ?? null;
    this.streamIdleMs = options.streamIdleMs ?? OPENCODE_STREAM_IDLE_MS;
    this.settleMs = options.settleMs ?? OPENCODE_SETTLE_MS;
  }

  async interrupt(processId: string): Promise<void> {
    const row = this.database.connection.prepare(`
      select sessions.resume_id, processes.cwd, processes.argv from sessions
      join processes on processes.id = sessions.process_id
      where sessions.process_id = ? and sessions.harness = 'opencode'
        and sessions.exited_at is null and sessions.resume_id is not null
    `).get(processId) as { resume_id: string; cwd: string; argv: string } | undefined;
    if (!row) return;
    const argv: unknown = JSON.parse(row.argv);
    if (!Array.isArray(argv) || typeof argv[0] !== 'string' || !row.cwd) throw new Error('OpenCode session has no executable or directory');
    await this.api(argv[0], row.cwd, 'POST', `/api/session/${encodeURIComponent(row.resume_id)}/interrupt`);
  }

  // Queued prompts live in the native inbox: steering joins the running turn,
  // cancelling removes the prompt before it runs.
  async updateQueued(processId: string, messageId: string, action: 'steer' | 'cancel'): Promise<void> {
    const runtime = this.runtime(processId);
    const route = `/api/session/${encodeURIComponent(runtime.resumeId)}/inbox/${encodeURIComponent(messageId)}`;
    if (action === 'cancel') await this.api(runtime.executable, runtime.cwd, 'DELETE', route);
    else await this.api(runtime.executable, runtime.cwd, 'PATCH', route, { delivery: 'steer' });
  }

  // Subagent sessions are the background tasks here; stopping one interrupts
  // that child session only.
  async stopTask(processId: string, taskId: string): Promise<void> {
    const runtime = this.runtime(processId);
    if (this.sessionParents.get(taskId) !== runtime.resumeId) throw new Error('That subagent does not belong to this session');
    await this.api(runtime.executable, runtime.cwd, 'POST', `/api/session/${encodeURIComponent(taskId)}/interrupt`);
  }

  // A subagent session's own messages, oldest first, or the end of a
  // background shell's output. Ownership is checked with the daemon, so it
  // still works after a restart clears the cache.
  async taskOutput(processId: string, taskId: string, since?: string | null, cursor?: string | null): Promise<IntegratedTaskOutput> {
    const runtime = this.runtime(processId);
    if (taskId.startsWith('sh_')) return this.shellOutput(runtime, taskId, since);
    if (!await this.descendsFrom(taskId, runtime.resumeId, runtime)) throw new Error('That subagent does not belong to this session');
    const route = `/api/session/${encodeURIComponent(taskId)}/message?limit=${OPENCODE_TASK_PAGE}&${cursor ? `cursor=${encodeURIComponent(cursor)}` : 'order=desc'}`;
    const listing = record(await this.api(runtime.executable, runtime.cwd, 'GET', route));
    const rows = Array.isArray(listing.data) ? listing.data as unknown[] : [];
    const next = record(listing.cursor).next;
    return messagesTaskOutput(this.withStoredImages([...rows].reverse()), rows.length >= OPENCODE_TASK_PAGE && typeof next === 'string' ? next : null, since);
  }

  // The daemon keeps a shell and its output file until it is removed, which
  // also deletes the output, so Patterm reads shells but never stops them.
  private async shellOutput(runtime: { executable: string; cwd: string; resumeId: string }, shellId: string, since?: string | null): Promise<IntegratedTaskOutput> {
    const location = new URLSearchParams({ 'location[directory]': runtime.cwd });
    let shell: Record<string, unknown>;
    try {
      shell = record(record(await this.api(runtime.executable, runtime.cwd, 'GET', `/api/shell/${encodeURIComponent(shellId)}?${location}`)).data);
    } catch (error) {
      if (error instanceof ProviderCommandError && error.status === 404) return { format: 'missing', version: null };
      throw error;
    }
    const owner = record(shell.metadata).sessionID;
    if (typeof owner !== 'string' || (owner !== runtime.resumeId && !await this.descendsFrom(owner, runtime.resumeId, runtime))) {
      throw new Error('That shell does not belong to this session');
    }
    // Any read reports the output size; the daemon rejects an empty one.
    const probe = record(record(await this.api(runtime.executable, runtime.cwd, 'GET', `/api/shell/${encodeURIComponent(shellId)}/output?${location}&limit=1`)).data);
    const size = typeof probe.size === 'number' ? probe.size : 0;
    const start = Math.max(0, size - OPENCODE_SHELL_BYTES);
    const output = record(record(await this.api(runtime.executable, runtime.cwd, 'GET', `/api/shell/${encodeURIComponent(shellId)}/output?${location}&cursor=${start}&limit=${OPENCODE_SHELL_BYTES}`)).data);
    const exit = typeof shell.exit === 'number' && shell.status !== 'running' ? `\n[exited with code ${shell.exit}]\n` : '';
    return textTaskOutput(`${String(output.output ?? '')}${exit}`, start > 0, since);
  }

  async prompt(processId: string, input: ResolvedIntegratedPrompt): Promise<{ id: string }> {
    const runtime = this.runtime(processId);
    const files = this.promptFiles(input);
    try {
      const body = {
        text: input.text.trim(),
        ...(files.length ? { files } : {}),
        ...(input.messageId ? { id: `msg_${input.messageId}` } : {}),
        // Like OpenCode's own clients, a prompt sent mid-turn joins the turn
        // at its next model step instead of waiting for it to end.
        delivery: 'steer', resume: true
      };
      const route = `/api/session/${encodeURIComponent(runtime.resumeId)}/prompt`;
      const response = (input.attachments.length
        ? await this.inlinePrompt(route, body)
        : await this.api(runtime.executable, runtime.cwd, 'POST', route, body)) as { data?: { id?: unknown } };
      if (typeof response.data?.id !== 'string') {
        throw new Error('OpenCode did not acknowledge the message');
      }
      this.admitted(runtime.resumeId);
      return { id: response.data.id };
    } catch (error) {
      // 4xx responses and pre-execution failures are definitive rejections.
      // Anything else may have been admitted before the reply was lost, so
      // reconcile before deciding.
      const status = error instanceof ProviderCommandError ? error.status : undefined;
      if (status && status >= 400 && status < 500) throw error;
      if (error instanceof ProviderCommandError && error.definitive) throw error;
      if (input.messageId) {
        const state = await this.reconcile(processId, input.messageId).catch((): IntegratedDeliveryState => 'unknown');
        if (state === 'accepted') {
          this.admitted(runtime.resumeId);
          return { id: `msg_${input.messageId}` };
        }
      }
      throw new UncertainDeliveryError(error instanceof Error ? error.message : String(error), input.messageId);
    }
  }

  // Project references remain file URLs. OpenCode reads a file and lists a
  // directory; a directory URL ends in `/`, as OpenCode's own clients mark it.
  // Managed uploads travel inline so OpenCode does not request
  // external-directory access to Patterm's store.
  private promptFiles(input: ResolvedIntegratedPrompt): Array<Record<string, unknown>> {
    if (input.attachments.some((attachment) => !attachment.data)) throw new Error('Attachment content is unavailable');
    return [
      ...input.references.map((reference) => ({ uri: `${pathToFileURL(reference.path).href}${reference.directory ? '/' : ''}`, name: reference.relativePath })),
      ...input.attachments.map((attachment) => ({ uri: `data:${attachment.mime};base64,${attachment.data}`, name: attachment.name }))
    ];
  }

  private async inlinePrompt(route: string, body: unknown): Promise<unknown> {
    return (await this.daemonRequest('POST', route, body, true))!.value;
  }

  // Native evidence: a bounded newest-first read can prove admission but never
  // the absence of it.
  async reconcile(processId: string, messageId: string): Promise<IntegratedDeliveryState> {
    const runtime = this.runtime(processId);
    const { rows } = await this.messageRows(runtime);
    return rows.some((row) => record(row).id === `msg_${messageId}`) ? 'accepted' : 'unknown';
  }

  // Installed OpenCode exposes one global event stream. Patterm discovers the
  // running daemon the same way the CLI does (its state-directory registration
  // plus a Basic health check) and keeps that connection only for events;
  // closing it never stops the daemon or the agent.
  async subscribe(processId: string, listener: IntegratedConversationListener): Promise<() => void> {
    const runtime = this.runtime(processId);
    await this.daemon();
    const sessionId = runtime.resumeId;
    // Seed part identity from the authoritative snapshot once per session;
    // events after this update rows without another full-snapshot cycle.
    await this.seedProjection(sessionId, runtime);
    let stopped = false;
    let controller: AbortController | null = null;
    let retry: NodeJS.Timeout | null = null;
    let attempts = 0;
    const emit: OpenCodeEmit = (event) => {
      const revision = (this.revisions.get(processId) ?? 0) + 1;
      this.revisions.set(processId, revision);
      listener({ ...event, processId, revision });
    };
    const stream: OpenCodeStream = { emit, runtime, serial: Promise.resolve() };
    const activity = this.activityState(sessionId);
    activity.emitters.add(emit);
    const schedule = (): void => {
      if (stopped) return;
      emit({ kind: 'reconnecting' });
      attempts += 1;
      if (attempts > OPENCODE_RECONNECT_ATTEMPTS) {
        emit({ kind: 'error', id: 'connection_error', delta: 'Could not reconnect to the OpenCode event stream; check the shared server.' });
        return;
      }
      retry = setTimeout(() => void open(false), Math.min(250 * 2 ** (attempts - 1), 5_000));
    };
    const pump = async (body: ReadableStream<Uint8Array>, connection: AbortController): Promise<void> => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      // Heartbeats count as traffic; a connection silent for longer is dead
      // even when the socket never closes, so it is dropped and reopened.
      const watchdog = setTimeout(() => connection.abort(), this.streamIdleMs);
      watchdog.unref?.();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          watchdog.refresh();
          buffer += decoder.decode(value, { stream: true });
          for (let boundary = buffer.indexOf('\n\n'); boundary >= 0; boundary = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const payload = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
            if (!payload) continue;
            let envelope: unknown;
            try { envelope = JSON.parse(payload); } catch { continue; }
            // One event that cannot be applied must not drop the rest of the
            // chunk or end the stream.
            try { this.handleEvent(sessionId, envelope, stream); } catch { /* the next snapshot covers it */ }
          }
        }
      } finally {
        clearTimeout(watchdog);
        // Release the socket however the read ended.
        connection.abort();
      }
    };
    const open = async (first: boolean): Promise<void> => {
      const connection = new AbortController();
      try {
        controller = connection;
        const daemon = await this.daemon();
        const response = await fetch(`${daemon.url}/api/event`, {
          headers: { Authorization: daemon.auth, Accept: 'text/event-stream' },
          signal: connection.signal
        }).catch((error: unknown) => {
          if (connectionRefused(error) || connectionClosed(error)) this.forgetDaemon();
          throw error;
        });
        if (response.status === 401) this.forgetDaemon();
        if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed (${response.status})`);
        attempts = 0;
        // Backfill handoff: the snapshot is re-read after every (re)connect,
        // and the projection merges parts created while disconnected so their
        // native content index stays aligned with the refreshed snapshot.
        if (!first) await this.seedProjection(sessionId, runtime);
        emit({ kind: 'pending' });
        void pump(response.body, connection).catch(() => {}).finally(() => { if (!stopped && controller === connection) schedule(); });
      } catch (error) {
        connection.abort();
        if (stopped) return;
        if (first) throw error;
        schedule();
      }
    };
    try {
      await open(true);
    } catch (error) {
      this.releaseActivity(sessionId, activity, emit);
      throw error;
    }
    return () => {
      stopped = true;
      controller?.abort();
      if (retry) clearTimeout(retry);
      this.releaseActivity(sessionId, activity, emit);
    };
  }

  // Only events scoped to this native session are surfaced; the stream is
  // server-wide and carries every session on the daemon. Text, reasoning, and
  // tool events are projected onto their native row identity: the assistant
  // message plus the family-specific ordinal, or the native tool call id.
  private handleEvent(sessionId: string, envelope: unknown, stream: OpenCodeStream): void {
    const { emit, runtime } = stream;
    const event = record(envelope);
    const type = typeof event.type === 'string' ? event.type : '';
    const data = record(event.data);
    // The envelope's `created` (ms) is the native event time; the host clock
    // stands in when it is missing.
    const at = openCodeTime(event.created) ?? openCodeTime(data.timestamp) ?? new Date().toISOString();
    const form = record(data.form);
    const eventSession = typeof data.sessionID === 'string' ? data.sessionID : typeof form.sessionID === 'string' ? form.sessionID : null;
    // Only subagent parentage is kept from the daemon-wide stream; other
    // sessions are looked up lazily when one asks for something or runs.
    // v2 events carry the session fields in data; v1 nests them in info.
    if (type === 'session.created') {
      const info = record(data.info);
      const created = typeof data.sessionID === 'string' ? data.sessionID : typeof info.id === 'string' ? info.id : null;
      const parent = typeof data.parentID === 'string' ? data.parentID : typeof info.parentID === 'string' ? info.parentID : null;
      if (created && parent) bounded(this.sessionParents, created, parent);
    }
    if (eventSession && eventSession !== sessionId) {
      // A subagent's request pauses this session, and a background subagent
      // keeps it working after its own turn ends. Its end alone never settles
      // this session. Requests also re-read the snapshot for the dock.
      const request = isRequestEvent(type);
      if (request || executionEvent(type, data)) {
        const child = eventSession;
        this.queueActivity(sessionId, stream, async (state) => {
          if (!await this.descendsFrom(child, sessionId, runtime).catch(() => false)) return;
          this.applyChildActivity(state, child, type, data);
          if (request) emit({ kind: 'pending' });
        });
        if (request) return;
      }
      // A direct subagent's content nests under its tool row.
      const parentId = this.childRows.get(eventSession);
      if (parentId && this.sessionParents.get(eventSession) === sessionId) this.handleChildContent(eventSession, parentId, type, data, emit, at);
      return;
    }
    // A background shell starting or ending changes the tasks, which only the
    // snapshot lists. Shell events name their session in metadata; one that
    // names none may be this session's.
    if (type === 'shell.created' || type === 'shell.exited' || type === 'shell.deleted') {
      const owner = eventSession ?? record(data.metadata).sessionID;
      if (owner === undefined || owner === sessionId) emit({ kind: 'pending' });
      return;
    }
    if (eventSession !== sessionId) return;
    const projection = this.projection(sessionId);
    const execution = executionEvent(type, data);
    if (execution) {
      const failure = execution === 'failed' ? String(record(data.error).message ?? data.message ?? '').trim() : '';
      if (failure) emit({ kind: 'replace', message: { id: `error_${String(event.id ?? randomUUID())}`, role: 'assistant', kind: 'notice', level: 'error', text: failure, createdAt: at, completedAt: at } });
      this.queueActivity(sessionId, stream, (state) => this.applyRootExecution(sessionId, state, execution, failure));
      return;
    }
    // Ids match the snapshot's projection of the same native rows.
    if (type === 'session.retry.scheduled' && typeof data.assistantMessageID === 'string') {
      const message = String(record(data.error).message ?? 'Request failed');
      emit({ kind: 'replace', message: { id: `${data.assistantMessageID}-retry`, role: 'assistant', kind: 'notice', level: 'warning', text: `${message}; retrying (attempt ${String(data.attempt ?? '?')})`, createdAt: at } });
      return;
    }
    if (type === 'session.compaction.started' || type === 'session.compaction.ended' || type === 'session.compaction.failed') {
      const failed = type.endsWith('.failed');
      emit({ kind: 'replace', message: {
        id: `compaction_${sessionId}`, role: 'assistant', kind: 'notice', level: failed ? 'error' : 'info',
        text: type.endsWith('.started') ? 'Compacting the conversation…' : failed ? `Compaction failed: ${String(record(data.error).message ?? 'unknown error')}` : 'Conversation compacted',
        createdAt: at, ...(type.endsWith('.started') ? {} : { completedAt: at })
      } });
      // The snapshot's usage drops the pre-compaction context.
      if (type.endsWith('.ended')) emit({ kind: 'pending' });
      return;
    }
    // V2 content events update only the affected row. The snapshot is re-read
    // only for genuinely unmappable events (removals or a legacy part whose
    // identity cannot be established), never for every delta.
    if (type.startsWith('session.text.') || type.startsWith('session.reasoning.')) {
      this.applyFamilyEvent(projection, data, type, emit, at);
      return;
    }
    if (type.startsWith('session.tool.')) {
      this.applyToolEvent(projection, data, type, emit, at);
      const tool = typeof data.id === 'string' ? projection.tools.get(data.id) : undefined;
      const child = subagentSession(tool?.name, data.metadata, sessionId);
      if (tool && child && !this.childRows.has(child)) {
        bounded(this.childRows, child, tool.rowId);
        bounded(this.sessionParents, child, sessionId);
        // Align the child's row indices with its snapshot before events land.
        void this.seedProjection(child, { ...runtime, resumeId: child });
      }
      return;
    }
    // The native user admission row keeps its inbox id, which is the same id
    // the message snapshot uses, so a reconnect never duplicates the prompt.
    // Synthetic items, such as a finished background subagent's result, are
    // not the user's and the snapshot drops them.
    if (type === 'session.inbox.enqueued') {
      const inboxID = typeof data.inboxID === 'string' ? data.inboxID : '';
      const item = record(data.item);
      const payload = record(item.payload);
      if (inboxID && item.type === 'user' && typeof payload.text === 'string') {
        emit({ kind: 'replace', message: { id: inboxID, role: 'user', kind: 'text', text: payload.text, createdAt: at, completedAt: at } });
      }
      return;
    }
    // The queue changed; the snapshot carries the inbox.
    if (type === 'session.inbox.cancelled' || type === 'session.inbox.delivery.changed' || type === 'session.inbox.delivered') {
      emit({ kind: 'pending' });
      return;
    }
    if (type.startsWith('session.step.') || type.startsWith('session.usage.') || type.startsWith('session.instructions.')) {
      return;
    }
    if (type === 'message.part.updated') {
      this.applyLegacyPart(projection, data, emit, at);
      return;
    }
    if (type === 'message.part.delta') {
      this.applyLegacyDelta(projection, data, emit);
      return;
    }
    if (isRequestEvent(type) || type === 'session.diff') {
      this.queueActivity(sessionId, stream, (state) => {
        if (applyRequest(state, type, data, sessionId)) this.publishActivity(state);
        emit({ kind: 'pending' });
      });
      return;
    }
    if (type === 'message.removed' || type === 'message.part.removed') {
      emit({ kind: 'pending' });
      return;
    }
    const counts = this.unhandled.get(sessionId) ?? {};
    if (Object.keys(counts).length < 100 || counts[type] !== undefined) counts[type] = (counts[type] ?? 0) + 1;
    bounded(this.unhandled, sessionId, counts);
  }

  // Stream-derived state lives as long as a stream for the session is open.
  private activityState(sessionId: string): OpenCodeActivity {
    let state = this.activity.get(sessionId);
    if (!state) {
      state = newActivity();
      this.activity.set(sessionId, state);
    }
    return state;
  }

  private releaseActivity(sessionId: string, state: OpenCodeActivity, emit: OpenCodeEmit): void {
    state.emitters.delete(emit);
    if (state.emitters.size) return;
    this.cancelSettle(state);
    if (this.activity.get(sessionId) === state) this.activity.delete(sessionId);
  }

  // A prompt or command that starts work was accepted. The daemon puts the
  // session in its active map before it replies.
  private admitted(sessionId: string): void {
    const state = this.activity.get(sessionId);
    if (state) state.admittedAt = Date.now();
  }

  // Activity events apply in arrival order, behind subagent events still
  // waiting on a parent lookup, and only to the state of the stream they
  // arrived on: a lookup can finish after that stream closed or was replaced.
  private queueActivity(sessionId: string, stream: OpenCodeStream, apply: (state: OpenCodeActivity) => void | Promise<void>): void {
    const state = this.activityState(sessionId);
    state.queued += 1;
    stream.serial = stream.serial
      .then(async () => { if (this.activity.get(sessionId) === state) await apply(state); })
      .catch(() => {})
      .finally(() => { state.queued -= 1; });
  }

  private applyRootExecution(sessionId: string, state: OpenCodeActivity, execution: OpenCodeExecutionEvent, failure: string): void {
    if (execution === 'started') {
      state.execution = 'running';
      state.detail = '';
      this.publishActivity(state);
      return;
    }
    // A request cannot outlive the execution waiting on it; an interrupted
    // permission ends without a reply event.
    dropRequests(state, sessionId);
    if (execution === 'shutdown') {
      // The daemon is stopping and resumes this turn when it starts again, so
      // the turn has not finished. The reconnect re-reads what happened.
      state.version += 1;
      this.cancelSettle(state);
      this.broadcast(state, { kind: 'pending' });
      return;
    }
    state.endedAt = Date.now();
    state.execution = execution === 'failed' ? 'error' : 'idle';
    state.detail = failure;
    this.publishActivity(state);
  }

  private applyChildActivity(state: OpenCodeActivity, child: string, type: string, data: Record<string, unknown>): void {
    let changed: boolean;
    const execution = isRequestEvent(type) ? null : executionEvent(type, data);
    if (isRequestEvent(type)) {
      changed = applyRequest(state, type, data, child);
    } else if (execution === 'started') {
      changed = !state.children.has(child);
      state.children.add(child);
    } else if (execution === 'shutdown') {
      // The daemon resumes the subagent after it restarts.
      return;
    } else {
      changed = state.children.delete(child);
      changed = dropRequests(state, child) || changed;
    }
    if (changed) this.publishActivity(state);
  }

  // Sends the status the stream state implies. An end is held back briefly
  // and dropped if work resumes, so a successor execution or a parent woken
  // by its subagent does not flash idle and announce a finished turn.
  private publishActivity(state: OpenCodeActivity): void {
    state.version += 1;
    if (!state.emitters.size) return;
    const status = activityStatus(state);
    if (status === null) {
      // This session's own state is not known yet; let the snapshot decide.
      this.cancelSettle(state);
      this.broadcast(state, { kind: 'pending' });
      return;
    }
    if (status === 'idle' || status === 'error') {
      if (state.settling) clearTimeout(state.settling);
      const settle = (): void => {
        // Events still waiting may resume the work; wait for them first.
        if (state.queued) {
          state.settling = setTimeout(settle, this.settleMs);
          state.settling.unref?.();
          return;
        }
        state.settling = null;
        const settled = activityStatus(state);
        if (settled) this.sendStatus(state, settled);
      };
      state.settling = setTimeout(settle, this.settleMs);
      state.settling.unref?.();
      return;
    }
    this.cancelSettle(state);
    this.sendStatus(state, status);
  }

  private sendStatus(state: OpenCodeActivity, status: OpenCodeStatus): void {
    state.emitted = status;
    this.broadcast(state, { kind: 'status', status, ...(status === 'error' && state.detail ? { detail: state.detail } : {}) });
  }

  private broadcast(state: OpenCodeActivity, event: Parameters<OpenCodeEmit>[0]): void {
    for (const emit of state.emitters) emit(event);
  }

  private cancelSettle(state: OpenCodeActivity): void {
    if (state.settling) clearTimeout(state.settling);
    state.settling = null;
  }

  // The snapshot's status agrees with the stream. A read never reports an end
  // the stream is still holding back, and when the stream moved on during the
  // read, the stream is newer. Otherwise the native state decides and becomes
  // the stream's baseline, which also repairs events missed while
  // disconnected. A session the daemon lists as active just after the stream
  // reported its end has ended, unless a prompt was accepted since.
  private snapshotActivity(
    state: OpenCodeActivity,
    version: number,
    readAt: number,
    native: { active: unknown; rows: unknown[]; requests: Array<Record<string, unknown>>; forms: Set<string>; sessionId: string }
  ): { status: OpenCodeStatus | undefined; detail: string } {
    const running = openCodeRunning(native.active, native.sessionId);
    const requests = new Map(native.requests.flatMap((row) => typeof row.id === 'string' && !state.answered.has(row.id)
      ? [[row.id, typeof row.sessionID === 'string' ? row.sessionID : native.sessionId] as [string, string]]
      : []));
    if (running === undefined) return { status: requests.size ? awaitingActivity(approvals(requests, native.forms)) : undefined, detail: '' };
    // While an end is held back or events wait behind a lookup, the read
    // reports no status, so callers keep what they show: the queue may yet
    // resume the work, and the last streamed status can be older than a
    // snapshot reconciled since. The streamed end then announces the turn.
    if (state.settling || state.queued) return { status: undefined, detail: state.detail };
    if (state.version !== version) {
      const status = activityStatus(state);
      if (status) return { status, detail: state.detail };
    }
    const ended = state.execution !== 'running' && state.endedAt > state.admittedAt && readAt - state.endedAt < OPENCODE_ENDED_TRUST_MS;
    const outcome = latestOutcome(native.rows);
    // An execution that failed stays failed until the next one starts.
    const failed = outcome === undefined ? state.execution === 'error' : outcome?.failed === true;
    const detail = failed ? (state.execution === 'error' && state.detail ? state.detail : outcome?.detail ?? '') : '';
    const live = record(record(native.active).data);
    const candidates = new Set([...subagentChildren(native.rows, native.sessionId), ...state.children]);
    state.execution = running && !ended ? 'running' : failed ? 'error' : 'idle';
    state.detail = detail;
    state.requests = requests;
    state.forms = native.forms;
    state.children = new Set([...candidates].filter((child) => record(live[child]).type === 'running'));
    return { status: activityStatus(state) ?? undefined, detail };
  }

  private handleChildContent(
    childSession: string,
    parentId: string,
    type: string,
    data: Record<string, unknown>,
    emit: (event: Omit<IntegratedConversationEvent, 'processId' | 'revision'>) => void,
    at: string
  ): void {
    const nested = (event: Omit<IntegratedConversationEvent, 'processId' | 'revision'>): void => {
      emit(event.kind === 'replace' && event.message ? { ...event, message: { ...event.message, parentId } } : event);
    };
    const projection = this.projection(childSession);
    if (type.startsWith('session.text.') || type.startsWith('session.reasoning.')) this.applyFamilyEvent(projection, data, type, nested, at);
    else if (type.startsWith('session.tool.')) this.applyToolEvent(projection, data, type, nested, at);
    else if (type === 'session.inbox.enqueued') {
      const inboxID = typeof data.inboxID === 'string' ? data.inboxID : '';
      const item = record(data.item);
      const payload = record(item.payload);
      if (inboxID && item.type === 'user' && typeof payload.text === 'string') nested({ kind: 'replace', message: { id: inboxID, role: 'user', kind: 'text', text: payload.text, createdAt: at, completedAt: at } });
    }
  }

  // Session totals from Session.Info, context from the newest assistant
  // message, and the window from that message's model. Each assistant message
  // is one model request, so the newest one's start is the latest activity.
  // Best effort: usage never blocks the transcript.
  private async usage(runtime: { executable: string; cwd: string; resumeId: string }, rows: unknown[]): Promise<Record<string, unknown>> {
    // A newer finished compaction makes that context stale. OpenCode does not
    // report the compacted size, so context is unknown until the next request.
    const latest = rows.map(record).find((row) => (row.type === 'assistant' && Object.keys(record(row.tokens)).length) || (row.type === 'compaction' && row.status === 'completed'));
    const tokens = latest?.type === 'assistant' ? record(latest.tokens) : {};
    const cache = record(tokens.cache);
    const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const context = number(tokens.input) + number(cache.read) + number(cache.write);
    const model = record(latest?.model);
    const started = record(rows.map(record).find((row) => row.type === 'assistant')?.time).created;
    const [info, windows] = await Promise.all([
      this.api(runtime.executable, runtime.cwd, 'GET', `/api/session/${encodeURIComponent(runtime.resumeId)}`).then((value) => record(record(value).data), () => ({} as Record<string, unknown>)),
      this.modelWindows(runtime).catch(() => new Map<string, number>())
    ]);
    const totals = record(info.tokens);
    const totalCache = record(totals.cache);
    const window = windows.get(`${String(model.providerID ?? '')}/${String(model.id ?? '')}`);
    return {
      ...(context > 0 ? { contextTokens: context } : {}),
      ...(window ? { contextWindow: window } : {}),
      ...(Object.keys(totals).length ? { inputTokens: number(totals.input) + number(totalCache.read) + number(totalCache.write), outputTokens: number(totals.output) + number(totals.reasoning) } : {}),
      ...(typeof info.cost === 'number' ? { costUsd: info.cost } : {}),
      ...(typeof started === 'number' && started > 0 ? { lastModelActivityAt: new Date(started).toISOString() } : {})
    };
  }

  private modelWindows(runtime: { executable: string; cwd: string }): Promise<Map<string, number>> {
    if (!this.contextWindows) {
      const location = new URLSearchParams({ 'location[directory]': runtime.cwd });
      const loading = this.api(runtime.executable, runtime.cwd, 'GET', `/api/model?${location}`).then((value) => new Map(dataRows(value).flatMap((model) => {
        const context = record(model.limit).context;
        const id = stringValue(model.id ?? model.modelID);
        return typeof context === 'number' && context > 0 && id ? [[`${String(model.providerID ?? '')}/${id}`, context] as [string, number]] : [];
      })));
      this.contextWindows = loading;
      loading.catch(() => { if (this.contextWindows === loading) this.contextWindows = null; });
    }
    return this.contextWindows;
  }

  // Recent rows of each subagent session named by a subagent tool in the
  // window, tagged with that tool's row so nesting survives a reload.
  private async childMessages(runtime: { executable: string; cwd: string; resumeId: string }, rows: unknown[]): Promise<unknown[]> {
    const children = new Map<string, string>();
    // Rows arrive newest first; walk them oldest first so the newest
    // subagents are the ones kept.
    for (const raw of [...rows].reverse()) {
      const message = record(raw);
      if (message.type !== 'assistant' || typeof message.id !== 'string' || !Array.isArray(message.content)) continue;
      for (const [index, part] of message.content.entries()) {
        const block = record(part);
        if (block.type !== 'tool') continue;
        const child = subagentSession(block.name, record(block.state).metadata, runtime.resumeId);
        if (child) children.set(child, `${message.id}-${index}`);
      }
    }
    const recent = [...children].slice(-OPENCODE_CHILD_SESSIONS);
    const pages = await Promise.all(recent.map(async ([child, parentId]) => {
      bounded(this.childRows, child, parentId);
      bounded(this.sessionParents, child, runtime.resumeId);
      try {
        const { rows: childRows } = await this.messageRows({ ...runtime, resumeId: child }, OPENCODE_CHILD_MESSAGES);
        return [...childRows].reverse().map((row) => ({ ...record(row), parentId }));
      } catch { return []; }
    }));
    return pages.flat();
  }

  // The projection is session-scoped and survives subscription release: a new
  // subscription for another process never clears a live session's identity.
  private projection(sessionId: string): OpenCodeProjection {
    let projection = this.projections.get(sessionId);
    if (!projection) {
      projection = { seeded: false, nextIndex: new Map(), rows: new Map(), family: new Map(), tools: new Map() };
      this.projections.set(sessionId, projection);
    }
    return projection;
  }

  private row(
    projection: OpenCodeProjection,
    messageID: string,
    key: string,
    kind: 'text' | 'reasoning' | 'tool',
    ordinal: number,
    toolId?: string,
    index?: number
  ): OpenCodeRow {
    const existing = projection.rows.get(key);
    if (existing) return existing;
    const resolved = index ?? projection.nextIndex.get(messageID) ?? 0;
    const row: OpenCodeRow = {
      rowId: `${messageID}-${resolved}`,
      index: resolved,
      kind,
      key,
      ordinal,
      ...(toolId !== undefined ? { toolId } : {}),
      text: '',
      input: '',
      state: {}
    };
    projection.rows.set(key, row);
    if (kind === 'tool' && toolId !== undefined) {
      projection.tools.set(toolId, row);
    } else {
      const list = projection.family.get(kind) ?? [];
      list.push(row);
      projection.family.set(kind, list);
    }
    if (resolved >= (projection.nextIndex.get(messageID) ?? 0)) projection.nextIndex.set(messageID, resolved + 1);
    return row;
  }

  // The native content index is the row id suffix the snapshot projection
  // uses, so a seeded row keeps that exact index and later parts append.
  private emitRow(row: OpenCodeRow, emit: (event: Omit<IntegratedConversationEvent, 'processId' | 'revision'>) => void): void {
    const times = { ...(row.createdAt ? { createdAt: row.createdAt } : {}), ...(row.completedAt ? { completedAt: row.completedAt } : {}) };
    if (row.kind === 'tool') {
      emit({
        kind: 'replace',
        message: {
          id: row.rowId,
          role: 'assistant',
          kind: 'tool',
          title: row.name ?? 'Tool',
          text: row.text,
          tool: { name: row.name ?? 'Tool', input: row.inputValue !== undefined ? row.inputValue : row.input, state: row.state, ...(row.images?.length ? { images: row.images } : {}) },
          ...times
        }
      });
      return;
    }
    emit({ kind: 'replace', message: { id: row.rowId, role: 'assistant', kind: row.kind, text: row.text, ...times } });
  }

  // Seed the native content index of every part once per session and merge on
  // reconnect. The V2 snapshot carries no ids for text and reasoning, and the
  // event ordinals are family-specific (each family starts at zero), so a
  // single global ordinal would collide.
  private async seedProjection(sessionId: string, runtime: { executable: string; cwd: string; resumeId: string }): Promise<void> {
    const projection = this.projection(sessionId);
    try {
      const { rows } = await this.messageRows(runtime, 20);
      for (const raw of rows) {
        const message = record(raw);
        const messageID = typeof message.id === 'string' ? message.id : '';
        if (!messageID || message.type !== 'assistant') continue;
        const content = Array.isArray(message.content) ? message.content : [];
        const ordinals: Record<string, number> = { text: 0, reasoning: 0 };
        const messageTime = record(message.time);
        for (const [index, part] of content.entries()) {
          const block = record(part);
          const type = typeof block.type === 'string' ? block.type : '';
          const seedTimes = (row: OpenCodeRow): void => {
            const time = record(block.time);
            row.createdAt ??= openCodeTime(time.created ?? messageTime.created);
            row.completedAt ??= openCodeTime(time.completed ?? (index === content.length - 1 ? messageTime.completed : undefined));
          };
          if (type === 'text' || type === 'reasoning') {
            const ordinal = ordinals[type] ?? 0;
            ordinals[type] = ordinal + 1;
            const row = this.row(projection, messageID, `${messageID}:${type}:${ordinal}`, type, ordinal, undefined, index);
            if (!row.text && typeof block.text === 'string') row.text = block.text;
            seedTimes(row);
            continue;
          }
          if (type !== 'tool') continue;
          const toolId = typeof block.id === 'string' ? block.id : '';
          if (!toolId) continue;
          const state = record(block.state);
          const row = this.row(projection, messageID, `${messageID}:tool:${toolId}`, 'tool', 0, toolId, index);
          if (typeof block.name === 'string') row.name = block.name;
          if (!row.text) row.text = this.toolStateText(state);
          if (!row.input && state.input !== undefined) row.inputValue = state.input;
          if (!Object.keys(row.state).length) row.state = state;
          seedTimes(row);
        }
        if (content.length > (projection.nextIndex.get(messageID) ?? 0)) projection.nextIndex.set(messageID, content.length);
      }
      projection.seeded = true;
    } catch { /* seeding is best effort; events still create rows */ }
  }

  private applyFamilyEvent(
    projection: OpenCodeProjection,
    data: Record<string, unknown>,
    type: string,
    emit: (event: Omit<IntegratedConversationEvent, 'processId' | 'revision'>) => void,
    at: string
  ): void {
    const family = type.startsWith('session.reasoning.') ? 'reasoning' : 'text';
    const messageID = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : '';
    const ordinal = typeof data.ordinal === 'number' ? data.ordinal : 0;
    if (!messageID) return;
    const row = this.row(projection, messageID, `${messageID}:${family}:${ordinal}`, family, ordinal);
    row.createdAt ??= at;
    if (type.endsWith('.started')) {
      this.emitRow(row, emit);
      return;
    }
    if (type.endsWith('.delta')) {
      const delta = typeof data.delta === 'string' ? data.delta : '';
      if (!delta) return;
      row.text += delta;
      emit({ kind: 'append', id: row.rowId, delta });
      return;
    }
    if (type.endsWith('.ended')) {
      if (typeof data.text === 'string') row.text = data.text;
      row.completedAt ??= at;
      this.emitRow(row, emit);
    }
  }

  private applyToolEvent(
    projection: OpenCodeProjection,
    data: Record<string, unknown>,
    type: string,
    emit: (event: Omit<IntegratedConversationEvent, 'processId' | 'revision'>) => void,
    at: string
  ): void {
    const messageID = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : '';
    const toolId = typeof data.id === 'string' ? data.id : '';
    if (!messageID || !toolId) return;
    const row = this.row(projection, messageID, `${messageID}:tool:${toolId}`, 'tool', 0, toolId);
    row.createdAt ??= at;
    if (typeof data.name === 'string') row.name = data.name;
    if (type === 'session.tool.input.started') {
      this.emitRow(row, emit);
      return;
    }
    if (type === 'session.tool.input.ended') {
      if (typeof data.text === 'string') row.input = data.text;
      this.emitRow(row, emit);
      return;
    }
    if (type === 'session.tool.called') {
      if (data.input !== undefined) row.inputValue = data.input;
      this.emitRow(row, emit);
      return;
    }
    if (type === 'session.tool.progress') {
      row.state = { status: 'running', ...(data.metadata !== undefined ? { metadata: data.metadata } : {}) };
      this.emitRow(row, emit);
      return;
    }
    if (type === 'session.tool.success') {
      row.text = this.toolStateText({ content: data.content });
      row.images = this.contentImages(data.content);
      row.state = { status: 'completed', ...(data.metadata !== undefined ? { metadata: data.metadata } : {}) };
      row.completedAt ??= at;
      this.emitRow(row, emit);
      return;
    }
    if (type.endsWith('.failed') || type.endsWith('.error') || type.endsWith('.rejected')) {
      row.text = this.toolStateText({ content: data.content }) || row.text;
      row.images = this.contentImages(data.content);
      row.state = { status: 'error', error: { message: String(record(data.error).message ?? data.message ?? row.text ?? 'Tool failed') } };
      row.completedAt ??= at;
      this.emitRow(row, emit);
      return;
    }
    // Output streaming (if a build emits it) accumulates like every other
    // delta; unknown tool events are ignored rather than forcing a resync.
    if (type.endsWith('.delta') || type.endsWith('.output')) {
      const delta = typeof data.delta === 'string' ? data.delta : '';
      if (delta) {
        row.text += delta;
        this.emitRow(row, emit);
      }
    }
  }

  // Legacy V1 message.part.* frames stay supported: they carry stable part ids,
  // so they map onto the same session projection without a snapshot read.
  private applyLegacyPart(
    projection: OpenCodeProjection,
    data: Record<string, unknown>,
    emit: (event: Omit<IntegratedConversationEvent, 'processId' | 'revision'>) => void,
    at: string
  ): void {
    const part = record(data.part);
    const messageID = typeof part.messageID === 'string' ? part.messageID : typeof data.messageID === 'string' ? data.messageID : '';
    const partID = typeof part.id === 'string' ? part.id : '';
    const type = typeof part.type === 'string' ? part.type : '';
    if (!messageID || !partID || (type !== 'text' && type !== 'reasoning' && type !== 'tool')) {
      emit({ kind: 'pending' });
      return;
    }
    const row = this.legacyRow(projection, messageID, partID, type, part);
    if (!row) {
      emit({ kind: 'pending' });
      return;
    }
    // V1 parts carry `time.start`/`time.end`; a tool keeps them in its state.
    const time = record(part.time ?? record(part.state).time);
    row.createdAt ??= openCodeTime(time.start) ?? at;
    row.completedAt ??= openCodeTime(time.end);
    if (row.kind === 'tool') {
      const state = record(part.state);
      row.state = state;
      row.text = this.toolStateText(state);
      if (state.input !== undefined) row.inputValue = state.input;
      if (!row.completedAt && (state.status === 'completed' || state.status === 'error')) row.completedAt = at;
    } else if (typeof part.text === 'string') {
      row.text = part.text;
    }
    this.emitRow(row, emit);
  }

  private applyLegacyDelta(
    projection: OpenCodeProjection,
    data: Record<string, unknown>,
    emit: (event: Omit<IntegratedConversationEvent, 'processId' | 'revision'>) => void
  ): void {
    const partID = typeof data.partID === 'string' ? data.partID : '';
    const field = typeof data.field === 'string' ? data.field : '';
    const delta = typeof data.delta === 'string' ? data.delta : '';
    if (!partID || !delta) return;
    const row = projection.rows.get(`v1:${partID}`);
    if (!row) {
      emit({ kind: 'pending' });
      return;
    }
    if (row.kind === 'tool') {
      if (field === 'input') {
        row.inputValue = undefined;
        row.input += delta;
      }
      else row.text += delta;
      this.emitRow(row, emit);
      return;
    }
    if (field !== 'text') return;
    row.text += delta;
    emit({ kind: 'append', id: row.rowId, delta });
  }

  private legacyRow(
    projection: OpenCodeProjection,
    messageID: string,
    partID: string,
    type: string,
    part: Record<string, unknown>
  ): OpenCodeRow | null {
    const key = `v1:${partID}`;
    const existing = projection.rows.get(key);
    if (existing) {
      if (type === 'tool' && typeof part.name === 'string') existing.name = part.name;
      return existing;
    }
    // Match a seeded row by native tool id or by the text prefix it extends;
    // more than one candidate is ambiguous and asks for a snapshot refresh.
    const toolId = type === 'tool' && typeof part.id === 'string' ? part.id : undefined;
    const text = typeof part.text === 'string' ? part.text : undefined;
    const seeded = [...projection.rows.values()].filter((candidate) => candidate.rowId.startsWith(`${messageID}-`)
      && candidate.kind === type && !candidate.key.startsWith('v1:'));
    const matches = seeded.filter((candidate) => (
      (toolId !== undefined && candidate.toolId === toolId)
      || (toolId === undefined && text !== undefined && candidate.text !== '' && (text.startsWith(candidate.text) || candidate.text.startsWith(text)))
    ));
    if (matches.length > 1) return null;
    if (matches.length === 1) {
      const row = matches[0]!;
      projection.rows.set(key, row);
      if (type === 'tool' && typeof part.name === 'string') row.name = part.name;
      return row;
    }
    const kind = type === 'text' || type === 'reasoning' ? type : 'tool';
    const row = this.row(projection, messageID, key, kind, 0, toolId);
    if (kind === 'tool') {
      if (typeof part.name === 'string') row.name = part.name;
      const state = record(part.state);
      row.text = this.toolStateText(state);
      if (state.input !== undefined) row.inputValue = state.input;
    } else if (typeof text === 'string') {
      row.text = text;
    }
    return row;
  }

  private contentImages(content: unknown): TranscriptImageRef[] {
    if (!this.images || !Array.isArray(content)) return [];
    return content.slice(0, 20).flatMap((item) => {
      const part = record(item);
      const image = part.type === 'file' ? this.images!.fromDataUrl(part.uri, typeof part.name === 'string' ? part.name : undefined) : null;
      return image ? [image] : [];
    });
  }

  // Native rows embed images as base64: user files carry `data`, and tool
  // results carry data URIs. Those bytes become stored references so they
  // never travel to the renderer; unstorable images just lose their bytes.
  private withStoredImages(rows: unknown[]): unknown[] {
    return rows.map((raw) => {
      const row = record(raw);
      const files = Array.isArray(row.files) ? row.files : null;
      const content = Array.isArray(row.content) ? row.content : null;
      if (!files && !content) return raw;
      const next: Record<string, unknown> = { ...row };
      if (files) {
        next.files = files.map((item) => {
          const file = record(item);
          if (typeof file.data !== 'string') return item;
          const { data, ...rest } = file;
          const image = this.images?.fromBase64(data, typeof file.name === 'string' ? file.name : undefined);
          return { ...rest, ...(image ? { sha256: image.sha256 } : {}) };
        });
      }
      if (content) {
        next.content = content.map((item) => {
          const part = record(item);
          const state = record(part.state);
          if (part.type !== 'tool' || !Array.isArray(state.content)) return item;
          return { ...part, state: { ...state, content: state.content.map((entry) => {
            const block = record(entry);
            if (block.type !== 'file' || typeof block.uri !== 'string' || !block.uri.startsWith('data:')) return entry;
            const { uri, ...rest } = block;
            const image = this.images?.fromDataUrl(uri, typeof block.name === 'string' ? block.name : undefined);
            return { ...rest, ...(image ? { sha256: image.sha256 } : {}) };
          }) } };
        });
      }
      return next;
    });
  }

  private toolStateText(state: Record<string, unknown>): string {
    const content = Array.isArray(state.content) ? state.content : [];
    return content.flatMap((item) => typeof record(item).text === 'string' ? [String(record(item).text)] : []).join('\n');
  }

  // The CLI discovers the background service from its state-directory
  // registration. Read the same file, require a loopback or Tailscale URL, and
  // verify the registration against the daemon's own identity report.
  private daemon(): Promise<OpenCodeDaemon> {
    if (!this.discovery) {
      const discovery = this.discoverDaemon();
      this.discovery = discovery;
      discovery.catch(() => { if (this.discovery === discovery) this.discovery = null; });
    }
    return this.discovery;
  }

  // A concurrent rediscovery may be dropped too; that only costs one more
  // health check.
  private forgetDaemon(): void {
    this.discovery = null;
  }

  private async discoverDaemon(): Promise<OpenCodeDaemon> {
    // OpenCode reads xdg-basedir on every platform, so Windows keeps the
    // registration at ~/.local/state/opencode/service.json, not under %LOCALAPPDATA%.
    const stateHome = this.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state');
    const filename = path.join(stateHome, 'opencode', 'service.json');
    let registration: unknown;
    try { registration = JSON.parse(await fs.promises.readFile(filename, 'utf8')); }
    catch { throw new Error('OpenCode background service was not found; start it with `opencode service start`'); }
    const info = record(registration);
    const url = typeof info.url === 'string' ? info.url : '';
    const password = typeof info.password === 'string' ? info.password : '';
    const pid = typeof info.pid === 'number' ? info.pid : null;
    const version = typeof info.version === 'string' ? info.version : '';
    let parsed: URL | null = null;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'http:' || !openCodeDaemonHost(parsed.hostname) || !password || !pid) {
      throw new Error('OpenCode background service registration is invalid');
    }
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const infoResponse = await fetch(`${url}/api/info`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(5_000) });
    const identity = record(await this.readJson(infoResponse));
    if (identity.healthy === false || identity.pid !== pid || (version && identity.version !== version)) {
      throw new Error('OpenCode background service identity check failed');
    }
    return { url, auth };
  }

  private async readJson(response: Response): Promise<unknown> {
    if (!response.ok) throw new Error(`OpenCode service request failed (${response.status})`);
    return response.json();
  }

  // OpenCode's server titles the session after its first message.
  async title(processId: string, _prompt: string): Promise<string | null> {
    const runtime = this.runtime(processId);
    const session = record(await this.api(runtime.executable, runtime.cwd, 'GET', `/api/session/${encodeURIComponent(runtime.resumeId)}`));
    const title = record(session.data).title;
    return typeof title === 'string' && title.trim() ? title.trim() : null;
  }

  async controls(processId: string): Promise<IntegratedControls> {
    const runtime = this.runtime(processId);
    const location = `?${new URLSearchParams({ 'location[directory]': runtime.cwd })}`;
    const [modelResult, agentResult, commandResult, defaultResult, providerResult] = await Promise.all([
      this.api(runtime.executable, runtime.cwd, 'GET', `/api/model${location}`),
      this.api(runtime.executable, runtime.cwd, 'GET', `/api/agent${location}`),
      this.api(runtime.executable, runtime.cwd, 'GET', `/api/command${location}`),
      this.api(runtime.executable, runtime.cwd, 'GET', `/api/model/default${location}`),
      // Provider names only label the model list, so the picker survives without them.
      this.api(runtime.executable, runtime.cwd, 'GET', `/api/provider${location}`).catch(() => null)
    ]);
    const providerNames = new Map(dataRows(providerResult).flatMap((item) => {
      const id = stringValue(item.id);
      return id ? [[id, providerLabel(stringValue(item.name) ?? id)] as [string, string]] : [];
    }));
    const models = dataRows(modelResult).flatMap((item) => {
      const providerID = stringValue(item.providerID);
      const id = stringValue(item.id ?? item.modelID);
      return providerID && id && item.enabled !== false
        ? [{ value: `${providerID}/${id}`, label: stringValue(item.name) ?? `${providerID}/${id}`, description: providerNames.get(providerID) ?? providerID }]
        : [];
    });
    const agents = dataRows(agentResult).flatMap((item) => {
      const id = stringValue(item.id ?? item.name);
      return item.hidden !== true && item.mode !== 'subagent' && id
        ? [{ value: id, label: stringValue(item.name) ?? id }]
        : [];
    });
    const defaults = record(record(defaultResult).data);
    const defaultModel = stringValue(defaults.providerID) && stringValue(defaults.id ?? defaults.modelID)
      ? `${String(defaults.providerID)}/${String(defaults.id ?? defaults.modelID)}`
      : models[0]?.value ?? '';
    const selected = this.selections.get(processId) ?? {};
    const activeModel = selected.model ?? runtime.model ?? defaultModel;
    const metadata = dataRows(modelResult).find((item) => `${stringValue(item.providerID)}/${stringValue(item.id ?? item.modelID)}` === activeModel);
    const variants = (Array.isArray(metadata?.variants) ? metadata.variants : []).map(record)
      .flatMap((variant) => {
        const id = stringValue(variant.id);
        return id ? [{ value: id, label: stringValue(variant.name) ?? id[0]!.toUpperCase() + id.slice(1) }] : [];
      });
    return {
      selectors: [
        ...(models.length ? [{ id: 'model', label: 'Model', value: activeModel, options: models }] : []),
        ...(variants.length ? [{ id: 'variant', label: 'Thinking', value: selected.variant
          ?? (selected.model ? null : runtime.reasoning) ?? 'default', options: [{ value: 'default', label: 'Default' }, ...variants] }] : []),
        ...(agents.length ? [{ id: 'agent', label: 'Agent', value: selected.agent ?? agents[0]!.value, options: agents }] : [])
      ],
      commands: [
        ...OPENCODE_BUILTIN_COMMANDS,
        ...dataRows(commandResult).flatMap((item) => stringValue(item.name) && !OPENCODE_BUILTIN_COMMANDS.some((command) => command.name === item.name)
          ? [{ name: stringValue(item.name)!, ...(stringValue(item.description) ? { description: stringValue(item.description)! } : {}) }]
          : [])
      ]
    };
  }

  async configure(processId: string, selector: string, value: string): Promise<void> {
    const runtime = this.runtime(processId);
    if (selector === 'agent') {
      await this.api(runtime.executable, runtime.cwd, 'POST', `/api/session/${encodeURIComponent(runtime.resumeId)}/agent`, { agent: value });
      this.selections.set(processId, { ...this.selections.get(processId), agent: value });
      return;
    }
    if (selector === 'model') {
      const slash = value.indexOf('/');
      if (slash < 1 || slash === value.length - 1) throw new Error('Invalid OpenCode model');
      await this.api(runtime.executable, runtime.cwd, 'POST', `/api/session/${encodeURIComponent(runtime.resumeId)}/model`, {
        model: { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
      });
      const { variant: _previousVariant, ...previous } = this.selections.get(processId) ?? {};
      this.selections.set(processId, { ...previous, model: value });
      return;
    }
    if (selector === 'variant') {
      const controls = await this.controls(processId);
      const variant = controls.selectors.find((item) => item.id === 'variant');
      if (!variant?.options.some((option) => option.value === value)) throw new Error('Unknown OpenCode variant');
      const model = controls.selectors.find((item) => item.id === 'model')?.value;
      if (!model) throw new Error('OpenCode model is unavailable');
      const slash = model.indexOf('/');
      await this.api(runtime.executable, runtime.cwd, 'POST', `/api/session/${encodeURIComponent(runtime.resumeId)}/model`, {
        model: { providerID: model.slice(0, slash), id: model.slice(slash + 1), ...(value === 'default' ? {} : { variant: value }) }
      });
      this.selections.set(processId, { ...this.selections.get(processId), variant: value });
      return;
    }
    throw new Error('Unknown OpenCode setting');
  }

  async compact(processId: string): Promise<unknown> {
    const runtime = this.runtime(processId);
    let result: unknown;
    try {
      result = await this.api(runtime.executable, runtime.cwd, 'POST', `/api/session/${encodeURIComponent(runtime.resumeId)}/compact`, { delivery: 'queue' });
    } catch (error) {
      // As for prompts, a 4xx response is a definitive rejection.
      if (error instanceof ProviderCommandError && error.status && error.status >= 400 && error.status < 500) throw new ProviderCommandError(error.message, error.status, true);
      throw error;
    }
    this.admitted(runtime.resumeId);
    return result;
  }

  // The daemon keeps a model change across a Patterm restart; the selection
  // map and the launch model do not.
  async currentModel(processId: string): Promise<string | null> {
    return (await this.nativeSettings(processId)).model ?? null;
  }

  // The variant lives on the native model too, and survives the same way.
  async nativeSettings(processId: string): Promise<LiveSettings> {
    const runtime = this.runtime(processId);
    const session = record(await this.api(runtime.executable, runtime.cwd, 'GET', `/api/session/${encodeURIComponent(runtime.resumeId)}`));
    const model = record(record(session.data).model);
    const providerID = stringValue(model.providerID);
    const id = stringValue(model.id ?? model.modelID);
    return providerID && id ? { model: `${providerID}/${id}`, reasoning: stringValue(model.variant) ?? null } : {};
  }

  // The TUI's built-in commands are session API calls, not native commands.
  // Everything else is a custom command the daemon runs.
  async command(processId: string, name: string, text: string): Promise<unknown> {
    const runtime = this.runtime(processId);
    const session = `/api/session/${encodeURIComponent(runtime.resumeId)}`;
    // A custom command with a built-in's name wins, as it did before.
    const custom = OPENCODE_BUILTIN_COMMANDS.some((command) => command.name === name)
      && dataRows(await this.api(runtime.executable, runtime.cwd, 'GET', `/api/command?${new URLSearchParams({ 'location[directory]': runtime.cwd })}`).catch(() => null)).some((command) => command.name === name);
    // A native command starts a turn. Built-ins other than compact do not:
    // /shell runs outside one.
    const native = async (): Promise<unknown> => {
      const result = await this.api(runtime.executable, runtime.cwd, 'POST', `${session}/command`, { name, text, delivery: 'queue' });
      this.admitted(runtime.resumeId);
      return result;
    };
    if (custom) return native();
    if (name === 'compact') return this.compact(processId);
    if (name === 'rename') {
      if (!text.trim()) throw new Error('Give the new name after /rename');
      return this.api(runtime.executable, runtime.cwd, 'PATCH', session, { title: text.trim() });
    }
    if (name === 'shell') {
      if (!text.trim()) throw new Error('Give a shell command after /shell');
      return this.api(runtime.executable, runtime.cwd, 'POST', `${session}/shell`, { command: text.trim() });
    }
    if (name === 'undo') {
      // Like the TUI: stage a revert of the latest prompt and its reply, which
      // /redo clears. The TUI never commits it. A running turn is not reverted
      // underneath itself.
      if (openCodeRunning(await this.api(runtime.executable, runtime.cwd, 'GET', '/api/session/active'), runtime.resumeId) === true) {
        throw new Error('Stop the running turn before undoing it');
      }
      const { rows } = await this.messageRows(runtime, 50);
      const latest = rows.map(record).find((row) => row.type === 'user' && typeof row.id === 'string' && row.id.startsWith('msg_'));
      if (!latest) throw new Error('There is no message to undo');
      return this.api(runtime.executable, runtime.cwd, 'POST', `${session}/revert/stage`, { messageID: latest.id });
    }
    if (name === 'redo') return this.api(runtime.executable, runtime.cwd, 'DELETE', `${session}/revert`);
    return native();
  }

  async conversation(processId: string): Promise<unknown> {
    const runtime = this.runtime(processId);
    // Capture the event boundary before the native reads: an event that lands
    // during a read keeps a newer revision, so the renderer re-applies it
    // instead of dropping it with the snapshot.
    const revision = this.revisions.get(processId) ?? 0;
    // Without an open stream the snapshot decides alone.
    const activity = this.activity.get(runtime.resumeId) ?? newActivity();
    const activityVersion = activity.version;
    const readAt = Date.now();
    const [{ rows, truncated, cursor }, ownPermissions, ownForms, active, childRequests, inbox, shells] = await Promise.all([
      this.messageRows(runtime),
      this.api(runtime.executable, runtime.cwd, 'GET', `/api/session/${encodeURIComponent(runtime.resumeId)}/permission`),
      this.api(runtime.executable, runtime.cwd, 'GET', `/api/session/${encodeURIComponent(runtime.resumeId)}/form`),
      this.api(runtime.executable, runtime.cwd, 'GET', '/api/session/active'),
      this.childRequests(runtime),
      // Older daemons without the inbox route simply show no queue.
      this.api(runtime.executable, runtime.cwd, 'GET', `/api/session/${encodeURIComponent(runtime.resumeId)}/inbox`).catch(() => null),
      // Running shells; older daemons without the route show none as running.
      this.api(runtime.executable, runtime.cwd, 'GET', `/api/shell?${new URLSearchParams({ 'location[directory]': runtime.cwd })}`).catch(() => null)
    ]);
    const [nestedRows, usage] = await Promise.all([this.childMessages(runtime, rows), this.usage(runtime, rows)]);
    const tasks = subagentTasks(rows, runtime.resumeId, active, new Set(dataRows(shells).map((shell) => String(shell.id))));
    const permissions = [...dataRows(ownPermissions), ...childRequests.permissions];
    const forms = [...dataRows(ownForms), ...childRequests.forms];
    // Rows from this session's own routes belong to it; subagent rows name
    // the descendant session that asked.
    for (const request of [...dataRows(ownPermissions), ...dataRows(ownForms)]) {
      if (typeof request.id === 'string') bounded(this.requestOwners, request.id, runtime.resumeId);
    }
    for (const request of [...childRequests.permissions, ...childRequests.forms]) {
      const row = record(request);
      if (typeof row.id === 'string' && typeof row.sessionID === 'string') bounded(this.requestOwners, row.id, row.sessionID);
    }
    const { status, detail } = this.snapshotActivity(activity, activityVersion, readAt, {
      active, rows, sessionId: runtime.resumeId,
      requests: [...permissions, ...forms].map(record),
      forms: new Set(forms.flatMap((form) => typeof record(form).id === 'string' ? [record(form).id as string] : []))
    });
    return {
      process_id: processId, session_id: runtime.sessionId, provider_session_id: runtime.resumeId, provider: 'opencode',
      status,
      ...(status === 'error' && detail ? { status_detail: detail } : {}),
      // Newest-first bounded read, reversed for chronological display.
      history_truncated: truncated,
      history_cursor: cursor ?? null,
      revision,
      streaming: true,
      messages: { data: this.withStoredImages([...[...rows].reverse(), ...nestedRows]) },
      permissions: { data: permissions.map(permissionView) },
      forms: declinableForms(forms),
      usage,
      tasks,
      diagnostics: { unhandled: this.unhandled.get(runtime.resumeId) ?? {} },
      queue: dataRows(inbox).flatMap((item) => item.type === 'user' && typeof item.id === 'string'
        ? [{ id: item.id, text: String(record(item.payload).text ?? ''), delivery: item.delivery === 'steer' ? 'steer' : 'queue' }]
        : []),
      questions: { data: [] }
    };
  }

  async olderMessages(processId: string, cursor: string): Promise<unknown> {
    const runtime = this.runtime(processId);
    const limit = 50;
    // A cursor encodes the native order and direction. OpenCode rejects a
    // request that combines it with an explicit order parameter.
    const listing = record(await this.api(runtime.executable, runtime.cwd, 'GET',
      `/api/session/${encodeURIComponent(runtime.resumeId)}/message?limit=${limit}&cursor=${encodeURIComponent(cursor)}`));
    const rows = Array.isArray(listing.data) ? listing.data as unknown[] : [];
    const next = record(listing.cursor).next;
    return {
      messages: { data: this.withStoredImages([...rows].reverse()) },
      cursor: rows.length >= limit && typeof next === 'string' ? next : null
    };
  }

  // Reconciliation and display read the newest bounded window so a >200-row
  // session can still see and confirm its latest message.
  private async messageRows(runtime: { executable: string; cwd: string; resumeId: string }, limit = 200): Promise<{ rows: unknown[]; truncated: boolean; cursor: unknown }> {
    const listing = record(await this.api(runtime.executable, runtime.cwd, 'GET', `/api/session/${encodeURIComponent(runtime.resumeId)}/message?limit=${limit}&order=desc`));
    const rows = Array.isArray(listing.data) ? listing.data as unknown[] : [];
    return { rows, truncated: rows.length >= limit, cursor: listing.cursor };
  }

  // Subagent requests are directory-wide and include every daemon session, so
  // only those descending from this session are kept. Older daemons without
  // the directory routes still show the session's own requests.
  private async childRequests(runtime: { executable: string; cwd: string; resumeId: string }): Promise<{ permissions: unknown[]; forms: unknown[] }> {
    const location = new URLSearchParams({ 'location[directory]': runtime.cwd });
    const [permissions, forms] = await Promise.allSettled([
      this.api(runtime.executable, runtime.cwd, 'GET', `/api/permission/request?${location}`),
      this.api(runtime.executable, runtime.cwd, 'GET', `/api/form?${location}`)
    ]);
    const children = async (settled: PromiseSettledResult<unknown>): Promise<Array<Record<string, unknown>>> => {
      if (settled.status !== 'fulfilled') return [];
      const rows = dataRows(settled.value)
        .filter((row) => typeof row.id === 'string' && typeof row.sessionID === 'string' && row.sessionID !== runtime.resumeId);
      const kept = await Promise.all(rows.map(async (row) => await this.descendsFrom(String(row.sessionID), runtime.resumeId, runtime).catch(() => false) ? row : null));
      return kept.filter((row): row is Record<string, unknown> => row !== null);
    };
    const [childPermissions, childForms] = await Promise.all([children(permissions), children(forms)]);
    return {
      permissions: childPermissions.map((row) => ({ ...row, action: `Subagent: ${String(row.action ?? 'Request')}` })),
      forms: childForms.map((row) => ({ ...row, detail: 'Requested by a subagent' }))
    };
  }

  // Walks Session.Info.parentID upwards. Depth is bounded so a malformed cycle
  // cannot loop.
  private async descendsFrom(sessionId: string, rootId: string, runtime: { executable: string; cwd: string }): Promise<boolean> {
    let current: string | null = sessionId;
    for (let depth = 0; current && depth < 8; depth++) {
      let parent = this.sessionParents.get(current);
      if (parent === undefined) {
        const info = record(record(await this.api(runtime.executable, runtime.cwd, 'GET', `/api/session/${encodeURIComponent(current)}`)).data);
        parent = typeof info.parentID === 'string' && info.parentID ? info.parentID : null;
        bounded(this.sessionParents, current, parent);
      }
      if (parent === rootId) return true;
      current = parent;
    }
    return false;
  }

  // Replies go to the session that asked, and only when it is this agent's
  // own session or one of its subagents.
  private requestSession(runtime: { resumeId: string }, requestId: string): string {
    const owner = this.requestOwners.get(requestId);
    if (!owner || owner === runtime.resumeId) return runtime.resumeId;
    let current: string | null | undefined = owner;
    for (let depth = 0; current && depth < 8; depth++) {
      current = this.sessionParents.get(current);
      if (current === runtime.resumeId) return owner;
    }
    throw new Error('That request does not belong to this session');
  }

  async replyPermission(processId: string, requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    const runtime = this.runtime(processId);
    await this.api(runtime.executable, runtime.cwd, 'POST', `/api/session/${encodeURIComponent(this.requestSession(runtime, requestId))}/permission/${encodeURIComponent(requestId)}/reply`, {
      decision: reply, ...(message ? { message } : {})
    });
  }

  async replyQuestion(_processId: string, _requestId: string, _answers: string[][]): Promise<void> {
    throw new Error('OpenCode uses native forms instead of questions');
  }

  // Typed native forms: string, number, integer, boolean, multiselect, and
  // external fields are answered as their native JSON value, never coerced
  // into string arrays.
  // OpenCode has no separate decline: both decline and cancel cancel the form.
  async replyForm(processId: string, formId: string, answer: Record<string, unknown>, action: IntegratedFormAction = 'accept'): Promise<void> {
    const runtime = this.runtime(processId);
    const route = `/api/session/${encodeURIComponent(this.requestSession(runtime, formId))}/form/${encodeURIComponent(formId)}`;
    if (action === 'accept') await this.api(runtime.executable, runtime.cwd, 'POST', `${route}/reply`, { answer });
    else await this.api(runtime.executable, runtime.cwd, 'DELETE', route);
  }

  async interruptAll(): Promise<void> {
    const rows = this.database.connection.prepare(`select process_id from sessions where harness = 'opencode' and exited_at is null and process_id is not null`).all() as Array<{ process_id: string }>;
    const results = await Promise.allSettled(rows.map((row) => this.interrupt(row.process_id)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'Could not interrupt every OpenCode session');
  }

  isBridgeToken(token: unknown): boolean {
    return token === this.token;
  }

  resolveIdentity(token: unknown, sessionId: unknown): string {
    if (!this.isBridgeToken(token) || typeof sessionId !== 'string' || !sessionId.startsWith('ses')) {
      throw new Error('Invalid OpenCode bridge identity');
    }
    const rows = this.database.connection.prepare(`
      select sessions.mcp_identity from sessions
      join processes on processes.id = sessions.process_id
      where sessions.harness = 'opencode' and sessions.resume_id = ?
        and sessions.exited_at is null and processes.status = 'running'
        and sessions.mcp_identity is not null
    `).all(sessionId) as Array<{ mcp_identity: string }>;
    if (rows.length !== 1) throw new Error('OpenCode session is not attached to one active Patterm agent');
    return rows[0]!.mcp_identity;
  }

  // The daemon is shared by every session in a directory, so a server is only
  // replaced when its configuration changes or the daemon has restarted and
  // forgotten it. Replacing an unchanged config is a no-op in OpenCode, and
  // the cache of what was installed does not survive a Patterm restart, so a
  // restart that wants fresh tool lists also reconnects every server the
  // daemon already had. That starts a new client for every session in the
  // directory.
  // A server that fails to start shows as failed in OpenCode and does not stop
  // the launch. Native configuration reconciliation is serial and an enabled
  // PUT waits for the handshake under that lock. Stage all configs disabled,
  // then connect through the per-server endpoint concurrently; resources,
  // prompts, authentication and tool discovery remain owned by OpenCode.
  private async installGlobalMcpServers(executable: string, cwd: string, location: URLSearchParams, configs: Record<string, Record<string, unknown>>, daemonRestarted: boolean, reconnect: boolean): Promise<void> {
    const pending: Array<{ name: string; key: string; body: string; route: string }> = [];
    await Promise.all(Object.entries(configs).map(async ([name, config]) => {
      const key = `${cwd}\0${name}`;
      const body = JSON.stringify(config);
      const route = `/api/experimental/mcp/${encodeURIComponent(name)}`;
      try {
        const changed = daemonRestarted || this.installedMcp.get(key) !== body;
        if (changed) {
          await this.api(executable, cwd, 'PUT', `${route}?${location}`, { config: { ...config, disabled: true } });
        }
        if (changed || reconnect) pending.push({ name, key, body, route });
      } catch {
        this.installedMcp.delete(key);
      }
    }));
    if (!pending.length) return;
    const listed = await this.api(executable, cwd, 'GET', `/api/mcp?${location}`) as {
      data?: Array<{ name: string; status: { status: string } }>;
    };
    const statuses = new Map((listed.data ?? []).map((server) => [server.name, server.status.status]));
    await Promise.all(pending.map(async ({ name, key, body, route }) => {
      try {
        // An empty Patterm cache does not mean the native client is new: an
        // unchanged disabled PUT leaves a surviving connection untouched.
        if (reconnect || statuses.get(name) === 'disabled') {
          await this.api(executable, cwd, 'POST', `${route}/connect?${location}`);
        }
        this.installedMcp.set(key, body);
      } catch {
        this.installedMcp.delete(key);
      }
    }));
  }

  async prepare(input: IntegratedLaunchInput): Promise<IntegratedLaunchResult> {
    // A directory's bridge and MCP clients are shared. Later launches reuse
    // the first launch's installation rather than racing a second connect.
    const previous = this.preparing.get(input.cwd) ?? Promise.resolve();
    const prepared = previous.catch(() => undefined).then(() => this.prepareInDirectory(input));
    this.preparing.set(input.cwd, prepared);
    try { return await prepared; }
    finally { if (this.preparing.get(input.cwd) === prepared) this.preparing.delete(input.cwd); }
  }

  private async prepareInDirectory(input: IntegratedLaunchInput): Promise<IntegratedLaunchResult> {
    const { executable, cwd, mcp } = input;
    // The native API caps each durable instruction entry at 8 KiB.
    if (Buffer.byteLength(JSON.stringify(input.context)) > 8 * 1024) throw new Error('Patterm context exceeds the OpenCode instruction limit');
    if (!(await this.versions(executable, cwd)).matched) await this.replaceStaleService(executable, cwd);
    const bridgeName = `patterm_${createHash('sha256').update(mcp.env.PATTERM_MCP_SOCKET ?? '').digest('hex').slice(0, 12)}`;
    const location = new URLSearchParams({ 'location[directory]': cwd });
    const bridge = {
      config: {
        type: 'local', command: [mcp.command, ...mcp.args], disabled: true, codemode: false,
        environment: {
          ELECTRON_RUN_AS_NODE: '1',
          PATTERM_MCP_SOCKET: mcp.env.PATTERM_MCP_SOCKET,
          PATTERM_OPENCODE_BRIDGE: this.token
        }
      }
    };
    // Patterm's bridge is missing only when the daemon has not seen this
    // directory since it started.
    const before = await this.api(executable, cwd, 'GET', `/api/mcp?${location}`) as { data?: Array<{ name: string }> };
    const daemonRestarted = !(before.data ?? []).some((server) => server.name === bridgeName);
    await this.api(executable, cwd, 'PUT', `/api/experimental/mcp/${bridgeName}?${location}`, bridge);
    for (let attempt = 0; ; attempt++) {
      const listed = await this.api(executable, cwd, 'GET', `/api/mcp?${location}`) as {
        data?: Array<{ name: string; status: { status: string } }>;
      };
      const status = listed.data?.find((server) => server.name === bridgeName)?.status.status;
      if (status === 'connected') break;
      if (status === 'disabled' && attempt === 0) {
        await this.api(executable, cwd, 'POST', `/api/experimental/mcp/${bridgeName}/connect?${location}`);
        continue;
      }
      if (status !== 'pending' || attempt >= 20) throw new Error(`OpenCode MCP bridge did not connect (${status ?? 'missing'})`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // The daemon's helpers serve every session, so they carry the bridge
    // token rather than this agent's identity.
    const { PATTERM_MCP_IDENTITY: _identity, ...shared } = mcp.env;
    const helpers = { ...mcp, env: { ...shared, PATTERM_OPENCODE_BRIDGE: this.token } };
    await this.installGlobalMcpServers(executable, cwd, location, openCodeMcpConfigs(input.mcpServers ?? [], helpers), daemonRestarted, input.reconnectMcp === true);

    let sessionId = input.resumeId;
    const selectedModel = input.model ? openCodeModelRef(input.model, input.reasoning ?? null) : null;
    if (sessionId) {
      const existing = await this.api(executable, cwd, 'GET', `/api/session/${encodeURIComponent(sessionId)}`) as {
        data?: { location?: { directory?: string } };
      };
      if (!pathsMatch(existing.data?.location?.directory, cwd)) throw new Error('OpenCode session directory does not match the Patterm launch directory');
      const attached = this.database.connection.prepare(`select id from sessions where harness = 'opencode' and resume_id = ? and exited_at is null`).get(sessionId);
      if (attached) throw new Error('OpenCode session is already attached to Patterm');
      if (selectedModel) {
        await this.api(executable, cwd, 'POST', `/api/session/${encodeURIComponent(sessionId)}/model`, { model: selectedModel });
      }
    } else {
      // An explicit title stops OpenCode generating one, so pass only a name
      // the user chose.
      const created = await this.api(executable, cwd, 'POST', '/api/session', {
        ...(input.name ? { title: input.name } : {}),
        location: { directory: cwd },
        ...(selectedModel ? { model: selectedModel } : {})
      }) as { data?: { id?: string } };
      sessionId = created.data?.id ?? null;
    }
    if (!sessionId?.startsWith('ses')) throw new Error('OpenCode did not return a session ID');
    await this.api(executable, cwd, 'PUT', `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/patterm`, { value: input.context });
    return { resumeId: sessionId, argv: [executable] };
  }

  private async versions(executable: string, cwd: string): Promise<{ matched: boolean; cli: string | null; server: string | null }> {
    const cli = firstSemver(await this.runCli(executable, cwd, ['--version']));
    const identity = record(await this.api(executable, cwd, 'GET', '/api/info'));
    const server = typeof identity.version === 'string' ? identity.version : null;
    return { matched: Boolean(cli) && identity.healthy !== false && server === cli, cli, server };
  }

  // Replaces a shared daemon left on an older version by a CLI update. This
  // interrupts every running turn on the daemon, including sessions outside
  // Patterm, so it runs unasked only while no turn is running. Patterm's own
  // conversation streams reconnect, and the next launch reinstalls the bridge.
  restartService(executable: string): Promise<{ version: string }> {
    return this.exclusively(() => this.replaceService(executable));
  }

  // Like the native TUI, a launch replaces a stale server, but only while no
  // turn is running on it: a restart interrupts every running turn, including
  // sessions outside Patterm, so that case still waits for the user. The
  // versions are read again once it is this launch's turn, because an earlier
  // launch may have replaced the server already.
  private replaceStaleService(executable: string, cwd: string): Promise<unknown> {
    return this.exclusively(async () => {
      const versions = await this.versions(executable, cwd);
      if (versions.matched) return;
      // A snapshot that cannot be read does not show the server is idle.
      const data = record(await this.api(executable, cwd, 'GET', '/api/session/active')).data;
      const running = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).length : null;
      if (running !== 0) {
        const turns = running === null ? 'and OpenCode did not say which turns are running' : `with ${running} OpenCode ${running === 1 ? 'turn' : 'turns'} running`;
        throw new Error(`${OPENCODE_VERSION_MISMATCH}: CLI ${versions.cli ?? 'unknown'}, server ${versions.server ?? 'unknown'}, ${turns}.`);
      }
      return this.replaceService(executable);
    });
  }

  private exclusively<T>(task: () => Promise<T>): Promise<T> {
    const result = this.replacing.then(task);
    this.replacing = result.catch(() => undefined);
    return result;
  }

  private async replaceService(executable: string): Promise<{ version: string }> {
    const cwd = os.homedir();
    await this.runCli(executable, cwd, ['service', 'restart']);
    this.forgetDaemon();
    let versions = await this.versions(executable, cwd).catch(() => null);
    for (let attempt = 0; !versions?.matched && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      this.forgetDaemon();
      versions = await this.versions(executable, cwd).catch(() => null);
    }
    if (!versions?.matched || !versions.cli) {
      throw new Error(`OpenCode server still reports ${versions?.server ?? 'an unknown version'} after restarting; check \`opencode service status\``);
    }
    return { version: versions.cli };
  }

  // OpenCode runs one shared daemon for every session, so stopping the daemon
  // is never correct. The native interrupt is the authoritative stop for one
  // turn: a failure propagates so a possibly-running turn is not reported as
  // closed. A session that is already gone has nothing to interrupt.
  async stop(processId: string): Promise<void> {
    await this.interrupt(processId);
  }

  async cleanupLaunch(input: IntegratedLaunchInput, result: IntegratedLaunchResult): Promise<void> {
    await this.api(input.executable, input.cwd, 'POST', `/api/session/${encodeURIComponent(result.resumeId)}/interrupt`);
  }

  async stopAll(): Promise<void> {
    await this.interruptAll();
  }

  // Model discovery only needs the CLI; the catalog service owns caching.
  async listModels(executable: string): Promise<unknown> {
    return this.api(executable, os.homedir(), 'GET', '/api/model');
  }

  // The verified background service is called over HTTP exactly as
  // `opencode api` does (same route, Basic credential, and JSON body) without
  // starting a CLI process per request. The CLI remains the transport when
  // the registration is missing or cannot be verified. A refused connection or
  // rejected credential happens before the request runs, so it rediscovers and
  // retries once; a dropped pooled connection does the same for reads only.
  private async api(executable: string, cwd: string, method: string, route: string, body?: unknown): Promise<unknown> {
    const response = await this.daemonRequest(method, route, body, false);
    return response ? response.value : this.cliApi(executable, cwd, method, route, body);
  }

  // Resolves null when an optional daemon cannot be used; a required daemon
  // reports why instead.
  private async daemonRequest(method: string, route: string, body: unknown, required: boolean): Promise<{ value: unknown } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const daemon = required ? await this.daemon() : await this.daemon().catch(() => null);
      if (!daemon) return null;
      try {
        return { value: await this.daemonApi(daemon, method, route, body) };
      } catch (error) {
        if (!(error instanceof StaleDaemonError)) throw error;
        this.forgetDaemon();
      }
    }
    if (required) throw new ProviderCommandError('OpenCode background service is unavailable; check the shared server', undefined, true);
    return null;
  }

  private async daemonApi(daemon: OpenCodeDaemon, method: string, route: string, body?: unknown): Promise<unknown> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${daemon.url}${route}`, {
        method,
        headers: { Authorization: daemon.auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000)
      });
      if (response.status === 401) throw new StaleDaemonError();
      text = await response.text();
    } catch (error) {
      if (error instanceof StaleDaemonError || connectionRefused(error)) throw new StaleDaemonError();
      // A restarted daemon closes pooled connections. A read is safe to repeat;
      // a write may have run, so it stays uncertain after rediscovery.
      if (connectionClosed(error)) {
        if (method === 'GET') throw new StaleDaemonError();
        this.forgetDaemon();
      }
      // The request may have reached the daemon; never echo request details.
      throw new ProviderCommandError('OpenCode service request failed; check the shared server');
    }
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new ProviderCommandError('OpenCode response exceeded the capture limit; check delivery before resending.');
    }
    if (!response.ok) {
      throw new ProviderCommandError(serverErrorMessage(text) ?? 'OpenCode command failed; check the shared server and CLI version', response.status);
    }
    try { return text.trim() ? JSON.parse(text) : null; }
    catch { throw new Error('OpenCode returned an invalid API response'); }
  }

  private async cliApi(executable: string, cwd: string, method: string, route: string, body?: unknown): Promise<unknown> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const args = ['api', method, route, ...(payload === undefined ? [] : ['--data', payload])];
    if (payload !== undefined && this.requestTooLarge(executable, args, payload)) {
      throw new ProviderCommandError('The OpenCode request is too large for the native CLI transport; shorten the message or attach a file.', undefined, true);
    }
    const stdout = await this.runCli(executable, cwd, args);
    try { return stdout.trim() ? JSON.parse(stdout) : null; }
    catch { throw new Error('OpenCode returned an invalid API response'); }
  }

  // POSIX rejects one argument at MAX_ARGUMENT_BYTES. Windows rejects a whole
  // command line past its CreateProcess (or, through cmd.exe, shell) limit.
  private requestTooLarge(executable: string, args: string[], payload: string): boolean {
    if (process.platform !== 'win32') return Buffer.byteLength(payload) >= MAX_ARGUMENT_BYTES;
    return commandLineTooLong(resolveService(executable, args, this.env));
  }

  private runtime(processId: string): { executable: string; cwd: string; resumeId: string; sessionId: string; model: string | null; reasoning: string | null } {
    const row = this.database.connection.prepare(`
      select sessions.id, sessions.resume_id, sessions.model, sessions.reasoning, processes.cwd, processes.argv
      from sessions join processes on processes.id = sessions.process_id
      where sessions.process_id = ? and sessions.harness = 'opencode'
        and sessions.interface_mode = 'integrated' and sessions.exited_at is null
        and processes.status = 'running'
    `).get(processId) as { id: string; resume_id: string | null; model: string | null; reasoning: string | null; cwd: string | null; argv: string | null } | undefined;
    const argv = row?.argv ? JSON.parse(row.argv) as unknown : null;
    if (!row?.resume_id || !row.cwd || !Array.isArray(argv) || typeof argv[0] !== 'string') {
      throw new Error('OpenCode Integrated session is not active');
    }
    return { executable: argv[0], cwd: row.cwd, resumeId: row.resume_id, sessionId: row.id, model: row.model, reasoning: row.reasoning };
  }

  private runCli(executable: string, cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        execFileResolved(executable, args, { cwd, env: this.env, timeout: 30_000, maxBuffer: MAX_RESPONSE_BYTES }, (error, stdout, stderr) => {
          // execFile errors contain argv, including the bridge credential. Never
          // expose those errors or an upstream config echo in logs/the renderer.
          const output = `${stdout}\n${stderr}`;
          if (error) return reject(openCodeError(error, output));
          resolve(stdout);
        });
      } catch (error) {
        // E2BIG and other spawn failures throw synchronously instead of
        // reaching the callback; they happen before the CLI starts.
        reject(openCodeError(error, ''));
      }
    });
  }
}

// OpenCode times are epoch milliseconds.
function openCodeTime(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;
}

// Loopback, or a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48) for
// a service shared on the owner's tailnet.
function openCodeDaemonHost(hostname: string): boolean {
  if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) return true;
  if (/^\[fd7a:115c:a1e0:/i.test(hostname)) return true;
  const octets = hostname.split('.');
  if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return false;
  return Number(octets[0]) === 100 && Number(octets[1]) >= 64 && Number(octets[1]) <= 127;
}

interface OpenCodeDaemon {
  url: string;
  auth: string;
}

// The daemon behind a registration is gone or has a new credential. Raised
// only when the request cannot have run, or is a read that is safe to repeat,
// so the caller may rediscover and retry.
class StaleDaemonError extends Error {}

function connectionRefused(error: unknown): boolean {
  return errorCause(error) === 'ECONNREFUSED';
}

function connectionClosed(error: unknown): boolean {
  const code = errorCause(error);
  return code === 'UND_ERR_SOCKET' || code === 'ECONNRESET';
}

function errorCause(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
}

function openCodeError(error: unknown, output: string): ProviderCommandError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'EACCES' || code === 'E2BIG') {
    return new ProviderCommandError('OpenCode could not start the native CLI; check the executable and permissions.', undefined, true);
  }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    // The CLI ran and may already have admitted the request; the reply simply
    // exceeded the bounded capture, so this stays uncertain.
    return new ProviderCommandError('OpenCode response exceeded the capture limit; check delivery before resending.');
  }
  const status = /HTTP (\d{3})/.exec(output)?.[1];
  return new ProviderCommandError(serverErrorMessage(output) ?? 'OpenCode command failed; check the shared server and CLI version', status ? Number(status) : undefined);
}

// Native error envelopes carry a user-facing message. Only the message of a
// tagged error body is surfaced; raw CLI output can echo request argv.
function serverErrorMessage(output: string): string | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const body = record(JSON.parse(trimmed));
      if (typeof body._tag === 'string' && typeof body.message === 'string' && body.message.length <= 500) return body.message;
    } catch { /* not a JSON error body */ }
  }
  return null;
}

// Only the HTTP status is surfaced; the CLI output can echo request argv.
export class ProviderCommandError extends Error {
  constructor(message: string, readonly status?: number, readonly definitive = false) {
    super(message);
    this.name = 'ProviderCommandError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dataRows(value: unknown): Array<Record<string, unknown>> {
  const data = Array.isArray(value) ? value : record(value).data;
  return Array.isArray(data) ? data.map(record) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

// Every model runs in OpenCode, so its own plans drop the prefix: "OpenCode Go"
// shows as "Go", and plain "OpenCode", its Zen plan, as "Zen".
function providerLabel(name: string): string {
  return name.replace(/^opencode\b\s*/i, '') || 'Zen';
}

// OpenCode reports idle sessions by omitting them from the server-scoped active
// snapshot. `null` means this build has no active-session route, so whether it
// runs is unknown; malformed payloads and provider errors stay visible.
function openCodeRunning(value: unknown, sessionId: string): boolean | undefined {
  if (value === null) return undefined;
  const data = record(value).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('OpenCode returned an invalid active-session response');
  }
  const active = record(data);
  if (active[sessionId] === undefined) return false;
  return record(active[sessionId]).type === 'running' ? true : undefined;
}

type OpenCodeExecutionEvent = 'started' | 'ended' | 'failed' | 'shutdown';

// Execution lifecycle, once per busy period. `session.idle` and
// `session.error` are the deprecated forms.
function executionEvent(type: string, data: Record<string, unknown>): OpenCodeExecutionEvent | null {
  if (type === 'session.execution.started') return 'started';
  if (type === 'session.execution.succeeded' || type === 'session.idle') return 'ended';
  if (type === 'session.execution.interrupted') return data.reason === 'shutdown' ? 'shutdown' : 'ended';
  if (type === 'session.execution.failed' || type === 'session.error') return 'failed';
  return null;
}

function newActivity(): OpenCodeActivity {
  return {
    execution: 'unknown', detail: '', requests: new Map(), forms: new Set(), answered: new Set(), children: new Set(), version: 0,
    endedAt: 0, admittedAt: 0, emitted: null, settling: null, emitters: new Set(), queued: 0
  };
}

function isRequestEvent(type: string): boolean {
  return type.startsWith('form.') || type.startsWith('permission.');
}

// Tracks one asked or settled permission or form. Returns whether the
// pending set changed.
function applyRequest(state: OpenCodeActivity, type: string, data: Record<string, unknown>, owner: string): boolean {
  const asked = type === 'permission.asked' ? data.id : type === 'form.created' ? record(data.form).id : undefined;
  if (typeof asked === 'string') {
    if (state.requests.get(asked) === owner) return false;
    state.requests.set(asked, owner);
    if (type === 'form.created') state.forms.add(asked);
    return true;
  }
  const settled = type === 'permission.replied' ? data.requestID : type === 'form.replied' || type === 'form.cancelled' ? data.id : undefined;
  if (typeof settled !== 'string') return false;
  // The daemon reports the answer just before it drops the request.
  state.answered.add(settled);
  if (state.answered.size > 200) state.answered.delete(state.answered.values().next().value!);
  state.forms.delete(settled);
  return state.requests.delete(settled);
}

// How many pending requests are permissions rather than forms.
function approvals(requests: Map<string, string>, forms: Set<string>): number {
  return [...requests.keys()].filter((id) => !forms.has(id)).length;
}

function dropRequests(state: OpenCodeActivity, owner: string): boolean {
  let changed = false;
  for (const [id, session] of state.requests) {
    if (session !== owner) continue;
    state.forms.delete(id);
    changed = state.requests.delete(id) || changed;
  }
  return changed;
}

// A request waiting on the user comes first, then this session's own work or
// a background subagent still running (as for Claude and Codex), then a
// failure until the next execution, then idle. Otherwise null while this
// session's own state is unknown.
function activityStatus(state: OpenCodeActivity): OpenCodeStatus | null {
  if (state.requests.size) return awaitingActivity(approvals(state.requests, state.forms));
  if (state.execution === 'running' || state.children.size) return 'working';
  if (state.execution === 'error') return 'error';
  return state.execution === 'idle' ? 'idle' : null;
}

// The newest recorded end of this session's own work, from rows newest
// first. Each execution appends an `idle` row with its outcome; a newer user
// or assistant row means later work has none yet (null). Undefined when the
// window holds no outcome at all, as on daemons that do not record them.
function latestOutcome(rows: unknown[]): { failed: boolean; detail: string } | null | undefined {
  const list = rows.map(record);
  const index = list.findIndex((row) => row.type === 'idle');
  if (index < 0) return undefined;
  if (list.slice(0, index).some((row) => row.type === 'user' || row.type === 'assistant' || row.type === 'compaction')) return null;
  const outcome = list[index]!;
  if (outcome.outcome !== 'failed') return { failed: false, detail: '' };
  // Newer daemons record the error on the outcome; older ones only on the
  // failed turn's reply.
  const turn = list.slice(index + 1).find((row) => row.type === 'assistant' || row.type === 'user');
  const message = record(outcome.error).message ?? (turn?.type === 'assistant' ? record(turn.error).message : undefined);
  return { failed: true, detail: typeof message === 'string' ? message.trim() : '' };
}

// Subagent sessions named by subagent tools in the window.
function subagentChildren(rows: unknown[], ownSession: string): string[] {
  return rows.flatMap((raw) => {
    const message = record(raw);
    if (message.type !== 'assistant' || !Array.isArray(message.content)) return [];
    return message.content.flatMap((part) => {
      const block = record(part);
      const child = block.type === 'tool' ? subagentSession(block.name, record(block.state).metadata, ownSession) : null;
      return child ? [child] : [];
    });
  });
}

// Windows defines no O_NOFOLLOW, and opening a link there always follows it, so
// the file is checked with lstat first. Its mode bits are synthesised from the
// read-only attribute, so the owner-only check below is POSIX-only too. What
// protects the file on Windows is the data directory's ACL: it lives under the
// user's profile (%LOCALAPPDATA%), which only that user, SYSTEM, and
// administrators can open.
function persistentBridgeToken(directory: string): string {
  const filename = path.join(directory, 'opencode-bridge-token');
  let descriptor: number;
  try {
    if (process.platform === 'win32' && fs.lstatSync(filename, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('OpenCode bridge token must be an owner-only file');
    }
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // The application runtime lock serialises creation. Keep this credential out
    // of general settings and exports, because existing bridge clients reuse it.
    const token = randomUUID();
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const created = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(created, token);
      fs.fsyncSync(created);
      fs.renameSync(temporary, filename);
    } finally {
      fs.closeSync(created);
      fs.rmSync(temporary, { force: true });
    }
    return token;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) {
      throw new Error('OpenCode bridge token must be an owner-only file');
    }
    const token = fs.readFileSync(descriptor, 'utf8');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token)) {
      throw new Error('Invalid saved OpenCode bridge token');
    }
    return token;
  } finally {
    fs.closeSync(descriptor);
  }
}

// Every native form can be cancelled (session.form.cancel), so the dock offers
// Decline alongside Submit.
// Native Permission.Request: the agent's message, the resources, and the
// patterns an "always" reply would save. Always is only offered when there is
// a pattern to save, and names it.
function permissionView(value: unknown): Record<string, unknown> {
  const row = record(value);
  const metadata = record(row.metadata);
  const save = Array.isArray(row.save) ? row.save.filter((item): item is string => typeof item === 'string' && item.length > 0) : null;
  const diff = typeof metadata.diff === 'string' ? metadata.diff : '';
  return {
    ...row,
    ...(typeof row.message === 'string' && row.message.trim() ? { detail: row.message.trim() } : {}),
    ...(diff ? { patch: diff } : {}),
    feedback: true,
    ...(save ? { always: save.length > 0 } : {}),
    ...(save?.length ? { always_label: `Always allow ${save.slice(0, 3).join(', ')}${save.length > 3 ? '…' : ''}` } : {})
  };
}

function declinableForms(rows: unknown[]): { data: unknown[] } {
  return { data: rows.map((row) => ({ ...record(row), declinable: true })) };
}

// Each subagent tool in the window is a task; the daemon's active-session map
// says whether its session is still running.
// Subagent sessions and background shells named by tool parts in the window.
function subagentTasks(rows: unknown[], ownSession: string, active: unknown, runningShells: Set<string>): Array<Record<string, unknown>> {
  const running = record(record(active).data);
  const tasks = new Map<string, Record<string, unknown>>();
  for (const raw of [...rows].reverse()) {
    const message = record(raw);
    if (message.type !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content.map(record)) {
      if (part.type !== 'tool') continue;
      const state = record(part.state);
      const input = record(state.input);
      const shell = record(state.metadata).shellID;
      if (part.name === 'shell' && input.background === true && typeof shell === 'string' && shell.startsWith('sh_')) {
        const running = runningShells.has(shell);
        tasks.set(shell, { id: shell, label: String(input.command ?? 'Shell'), kind: 'shell', status: running ? 'running' : 'completed', stoppable: false });
        continue;
      }
      const child = subagentSession(part.name, state.metadata, ownSession);
      if (!child) continue;
      const live = record(running[child]).type === 'running';
      const status = live ? 'running' : state.status === 'error' ? 'failed' : state.status === 'running' ? 'running' : 'completed';
      tasks.set(child, {
        id: child,
        label: String(input.description ?? input.prompt ?? 'Subagent'),
        kind: String(input.agent ?? input.subagent_type ?? 'subagent'),
        status,
        stoppable: status === 'running'
      });
    }
  }
  return [...tasks.values()].slice(-20);
}

const OPENCODE_BUILTIN_COMMANDS = [
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'undo', description: 'Revert the latest message (/redo restores it)' },
  { name: 'redo', description: 'Restore what /undo reverted' },
  { name: 'rename', description: 'Rename the session' },
  { name: 'shell', description: 'Run a shell command' }
];

// The daemon is shared and long-lived, so per-session lookups are capped:
// the oldest entry goes first, and a later miss is looked up again.
function bounded<K, V>(map: Map<K, V>, key: K, value: V, limit = 5_000): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value!);
}

const OPENCODE_CHILD_SESSIONS = 8;
const OPENCODE_CHILD_MESSAGES = 40;
// Task drawer page size, and how much of a shell's output it shows.
const OPENCODE_TASK_PAGE = 100;
const OPENCODE_SHELL_BYTES = 256 * 1024;

// The subagent tool (alias task) reports the session it started in its
// metadata. Shell tools also carry a sessionID, their own, so only subagent
// tools naming another session count.
function subagentSession(name: unknown, metadata: unknown, ownSession: string): string | null {
  if (typeof name !== 'string' || !/^(subagent|task)$/i.test(name)) return null;
  const child = record(metadata).sessionID;
  return typeof child === 'string' && child && child !== ownSession ? child : null;
}
