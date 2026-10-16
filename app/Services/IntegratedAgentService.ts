import { awaitingUser, isActivityState } from './Activity';
import { createHash, randomUUID } from 'node:crypto';
import { UpdateSessionTitleAction } from '../Actions/UpdateSessionTitleAction';
import type { DatabaseService } from './DatabaseService';
import type { IntegratedInputResolver, IntegratedPromptInput, IntegratedWorktreeFile, ResolvedIntegratedPrompt } from './IntegratedInput';
import { TurnBusyError, UncertainDeliveryError, type IntegratedDeliveryState } from './IntegratedDelivery';
import { HELD_QUEUE_EVENT_ID, type IntegratedConversationEvent, type IntegratedConversationListener, type IntegratedQueuedMessage } from './IntegratedConversation';
import type { AgentHistoryReadService } from './AgentHistory/AgentHistoryReadService';
import type { McpLaunchServer } from './McpServerRegistry';
import type { UsageService } from './UsageService';
import { callIntegratedHost, detachedHostLauncher, integratedHostListening, type IntegratedHostLauncher } from './IntegratedHostLauncher';
import { presetHarnessInput } from '../Harness/HarnessPresets';

const ARCHIVE_PAGE_SIZE = 80;
const ARCHIVE_CURSOR_PREFIX = 'archive:';
// Native titles appear asynchronously: Claude generates one on request, while
// OpenCode names the conversation during the first turn. Retry a few
// times after each accepted prompt, then wait for the next one.
const TITLE_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 45_000, 120_000];
// A live agent whose event stream could not be opened, or whose provider gave
// up reconnecting, is subscribed again after these delays. Activity is frozen
// until then, so the first retry is quick and later ones back off.
const RESUBSCRIBE_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

export interface IntegratedLaunchInput {
  executable: string;
  cwd: string;
  // The user's chosen name, or null to let the native agent title the session.
  name: string | null;
  context: string;
  mcp: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  // The user's global MCP servers for this harness.
  mcpServers?: McpLaunchServer[];
  resumeId: string | null;
  model?: string | null;
  reasoning?: string | null;
  serviceTier?: string | null;
  // A restart reconnects MCP servers a shared daemon keeps across sessions,
  // so their tool lists are fetched again.
  reconnectMcp?: boolean;
}

// Launch settings a running agent reports. A missing key is one it does not
// report; null means the harness default.
export interface LiveSettings {
  model?: string | null;
  reasoning?: string | null;
  service_tier?: string | null;
}

export interface IntegratedLaunchResult {
  resumeId: string;
  argv: string[];
}

export type IntegratedFormAction = 'accept' | 'decline' | 'cancel';

export interface IntegratedControlSelector {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
}

export interface IntegratedCommand {
  name: string;
  description?: string;
  // Patterm commands run in the renderer and never reach the native agent.
  source?: 'patterm';
}

export interface IntegratedControls {
  selectors: IntegratedControlSelector[];
  commands: IntegratedCommand[];
  // Set by providers whose conversation snapshots report `controls_revision`;
  // equal values mean the controls haven't changed.
  revision?: string;
}

const PATTERM_COMMANDS: IntegratedCommand[] = [
  { name: 'new', description: 'Start a new conversation with the same agent', source: 'patterm' },
  { name: 'resume', description: 'Resume a previous conversation', source: 'patterm' },
  { name: 'restart', description: 'Restart the agent and resume this conversation, picking up MCP and settings changes', source: 'patterm' }
];

export interface IntegratedProviderService {  prepare(input: IntegratedLaunchInput): Promise<IntegratedLaunchResult>;
  conversation(processId: string): Promise<unknown>;
  olderMessages?(processId: string, cursor: string): Promise<unknown>;
  prompt(processId: string, input: ResolvedIntegratedPrompt): Promise<unknown>;
  interrupt(processId: string): Promise<void>;
  // Stops one background task from the snapshot's `tasks`.
  stopTask?(processId: string, taskId: string): Promise<void>;
  // Reads one background task's output: a subagent transcript or shell text.
  // `since` is the version from the previous read; an unchanged task skips it.
  // A `cursor` from an earlier read returns the page of messages before it.
  taskOutput?(processId: string, taskId: string, since?: string | null, cursor?: string | null): Promise<unknown>;
  // Steers or cancels one prompt from the snapshot's `queue`.
  updateQueued?(processId: string, messageId: string, action: 'steer' | 'cancel'): Promise<void>;
  replyPermission(processId: string, requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void>;
  replyQuestion(processId: string, requestId: string, answers: string[][]): Promise<void>;
  // Native typed forms (OpenCode forms, MCP elicitations). Answers are the
  // field's native JSON value: string, number, boolean, or string[] for
  // multiselect. Decline and cancel carry no answer.
  replyForm?(processId: string, formId: string, answer: Record<string, unknown>, action?: IntegratedFormAction): Promise<void>;
  controls?(processId: string): Promise<IntegratedControls>;
  configure?(processId: string, selector: string, value: string): Promise<void>;
  command?(processId: string, name: string, text: string): Promise<unknown>;
  // Native compaction, never a custom command of the same name.
  compact?(processId: string): Promise<unknown>;
  // The native session's current model, where Patterm's selection can be stale.
  currentModel?(processId: string): Promise<string | null>;
  // The native session's model and reasoning, read together for the same reason.
  nativeSettings?(processId: string): Promise<LiveSettings>;
  // Native evidence that a previously ambiguous prompt was admitted.
  reconcile?(processId: string, messageId: string): Promise<IntegratedDeliveryState>;
  // Event-driven conversation updates. Returned function releases the listener.
  subscribe?(processId: string, listener: IntegratedConversationListener): Promise<() => void>;
  // The native conversation title, or null while the agent has not named it.
  // `prompt` is the latest accepted text, for providers that title on request.
  title?(processId: string, prompt: string): Promise<string | null>;
  stop?(processId: string): Promise<void>;
  stopAll?(): Promise<void>;
  cleanupLaunch?(input: IntegratedLaunchInput, result: IntegratedLaunchResult): Promise<void>;
}

export type CompactionSignal = 'turn' | 'compact' | 'compact_rejected' | 'model';

export interface IntegratedActivityChange {
  processId: string;
  previous: string;
  activity: string;
  snapshot: boolean;
}

export class IntegratedAgentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly providers: Partial<Record<'claude' | 'codex' | 'opencode', IntegratedProviderService>>,
    // Reading a conversation is not a workbench mutation, but providers report
    // activity and titles as a side effect. Notify only when either actually
    // changes so polling the transcript does not refetch the whole workspace.
    private readonly onWorkbenchChange?: () => void,
    // Trust boundary for @ references and uploaded attachments. Text-only
    // callers keep working without it.
    private readonly inputs?: IntegratedInputResolver,
    private readonly hostLauncher: IntegratedHostLauncher = detachedHostLauncher
  ) {}

  private readonly conversationSubscriptions = new Map<string, ConversationSubscription>();
  // Concurrent identical submissions share one native call. Resolved outcomes
  // live in the bounded integrated_submissions table, so neither memory
  // eviction nor a restart makes a used id look like a fresh send.
  private readonly inflight = new Map<string, Map<string, InFlightSubmission>>();
  // Every prompt and command still on its way to the native agent, with or
  // without a message ID, so maintenance never races one.
  private readonly sending = new Map<string, number>();
  // One delivery run of held prompts per agent. A trigger during a run asks
  // for another run once it ends.
  private readonly heldFlushes = new Map<string, { again: boolean; started: boolean }>();
  // Prompts reach each agent one at a time in arrival order, so a held prompt
  // is never overtaken by a later one. The tail of each agent's chain.
  private readonly dispatches = new Map<string, Promise<unknown>>();
  // Prompts waiting in that chain, which a held prompt must not overtake.
  private readonly waiting = new Map<string, number>();
  // Arrival order is fixed before inputs resolve: one prompt's references can
  // take longer to read than a later prompt's text.
  private readonly arrivals = new Map<string, Promise<unknown>>();
  // The held prompt each agent is sending now. It can no longer be cancelled.
  private readonly dispatching = new Map<string, HeldPromptRow>();
  // One pending title refresh per agent; a newer prompt replaces it.
  private readonly titleRefreshes = new Map<string, { timer: NodeJS.Timeout | null }>();
  private history: AgentHistoryReadService | null = null;
  // Debug log sink for native events a provider did not project. Each type is
  // logged once per agent so protocol drift is visible without flooding.
  private debugLog: { write(source: string, event: string, data?: unknown): void } | null = null;
  private usage: Pick<UsageService, 'recordLimits'> | null = null;
  private readonly loggedUnhandled = new Map<string, Set<string>>();
  // Service-owned observation of every live agent, so activity follows the
  // native turn even when no client is viewing the conversation.
  private readonly observers = new Map<string, ActivityObserver>();
  // Failed attempts to observe each agent, for the retry backoff.
  private readonly observeAttempts = new Map<string, number>();
  private readonly eventListeners = new Set<(processId: string, event: IntegratedConversationEvent) => void>();
  private readonly activityListeners = new Set<(change: IntegratedActivityChange) => void>();
  private readonly compactionListeners = new Set<(processId: string, signal: CompactionSignal) => void>();
  // Stream events and synthetic marks bump the sequence. Snapshot reads and
  // post-admission marks write only when no newer write landed meanwhile.
  private readonly activitySequence = new Map<string, number>();

  setHistoryReadService(history: AgentHistoryReadService): void {
    this.history = history;
  }

  setDebugLog(debugLog: { write(source: string, event: string, data?: unknown): void }): void {
    this.debugLog = debugLog;
  }

  // Keeps the quota windows sessions report for the usage dashboard.
  setUsage(usage: Pick<UsageService, 'recordLimits'>): void {
    this.usage = usage;
  }

  // Activity transitions of live agents. Snapshot transitions come from
  // re-reading state after a reconnect, not from the native stream.
  onActivityChange(listener: (change: IntegratedActivityChange) => void): () => void {
    this.activityListeners.add(listener);
    return () => { this.activityListeners.delete(listener); };
  }

  // What idle compaction needs beyond activity, keyed by the canonical process
  // ID: an admitted prompt or command, a compaction Patterm starts or that
  // was rejected, and a model change.
  onCompactionSignal(listener: (processId: string, signal: CompactionSignal) => void): () => void {
    this.compactionListeners.add(listener);
    return () => { this.compactionListeners.delete(listener); };
  }

  // Every stream event the service observes for a live agent, keyed by process
  // ID, whether or not a client is viewing the conversation.
  onConversationEvent(listener: (processId: string, event: IntegratedConversationEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  private recordLimits(key: string, conversation: unknown): void {
    const limits = record(record(conversation).usage).limits;
    if (!this.usage || !Array.isArray(limits) || !limits.length) return;
    try {
      this.usage.recordLimits(this.harness(key), limits);
    } catch { /* usage is best effort; a busy database must not break the stream */ }
  }

  private logUnhandled(key: string, conversation: unknown): void {
    if (!this.debugLog) return;
    const unhandled = record(record(record(conversation).diagnostics).unhandled);
    const types = Object.keys(unhandled);
    if (!types.length) return;
    let logged = this.loggedUnhandled.get(key);
    if (!logged) {
      logged = new Set();
      this.loggedUnhandled.set(key, logged);
    }
    for (const type of types) {
      if (logged.has(type)) continue;
      logged.add(type);
      this.debugLog.write('integrated', 'native-event.unhandled', { processId: key, provider: record(conversation).provider, type, count: unhandled[type] });
    }
  }

  prepare(harness: 'claude' | 'codex' | 'opencode', input: IntegratedLaunchInput): Promise<IntegratedLaunchResult> {
    return this.provider(harness).prepare(input);
  }

  async cleanupLaunch(harness: 'claude' | 'codex' | 'opencode', input: IntegratedLaunchInput, result: IntegratedLaunchResult): Promise<void> {
    await this.provider(harness).cleanupLaunch?.(input, result);
  }

  async conversation(processId: string): Promise<unknown> {
    const key = this.ledgerKey(processId);
    const sequence = this.sequence(key);
    let conversation = await this.forProcess(processId).conversation(processId);
    this.markSnapshot(key, conversation, sequence);
    this.logUnhandled(key, conversation);
    this.recordLimits(key, conversation);
    this.confirmHeld(key, conversation);
    const held = this.heldQueue(key);
    if (held.length) {
      const native = record(conversation).queue;
      conversation = { ...record(conversation), queue: [...(Array.isArray(native) ? native : []), ...held] };
    }
    const archive = this.archiveSession(processId, conversation);
    if (!archive || !this.history) return conversation;
    const before = archiveBoundary(conversation, archive.startedAt);
    const count = this.history.archive(archive.provider, archive.resumeId, archive.projectId, before, 0, 0).count;
    if (count === 0) return conversation;
    return { ...record(conversation), history_truncated: true, history_unavailable: false, history_cursor: { next: archiveCursor(before, count) } };
  }

  // The transcript alone, for reading ahead of the user. Unlike
  // `conversation` it keeps no snapshot ledger: it never changes activity,
  // delivers held prompts, or records limits, so reading an agent nobody has
  // opened changes nothing. It leaves out the command and model lists, which
  // the pane reads separately, and imported history, which the pane's own
  // snapshot adds.
  async peekConversation(processId: string): Promise<unknown> {
    const conversation = record(await this.forProcess(processId).conversation(processId));
    const { commands: _commands, models: _models, ...transcript } = conversation;
    const held = this.heldQueue(this.ledgerKey(processId));
    if (!held.length) return transcript;
    const native = transcript.queue;
    return { ...transcript, queue: [...(Array.isArray(native) ? native : []), ...held] };
  }

  // Archive pages carry imported rows untouched. The renderer projects them
  // exactly as the History view does.
  async olderMessages(processId: string, cursor: string): Promise<unknown> {
    if (cursor.startsWith(ARCHIVE_CURSOR_PREFIX)) {
      const archive = this.archiveSession(processId, null);
      if (!archive || !this.history) throw new Error('Imported history is unavailable for this agent');
      const { before, end } = parseArchiveCursor(cursor);
      const offset = Math.max(0, end - ARCHIVE_PAGE_SIZE);
      const page = this.history.archive(archive.provider, archive.resumeId, archive.projectId, before, offset, end - offset);
      return { messages: [], archived_messages: page.messages, cursor: offset > 0 ? archiveCursor(before, offset) : null };
    }
    const provider = this.forProcess(processId);
    if (!provider.olderMessages) throw new Error('This native agent cannot load older messages');
    return provider.olderMessages(processId, cursor);
  }

  prompt(processId: string, input: IntegratedPromptInput | string, _context?: string): Promise<unknown> {
    return this.whileSending(processId, () => this.submit(processId, input));
  }

  private async whileSending<T>(processId: string, send: () => Promise<T>): Promise<T> {
    let key: string;
    try { key = this.ledgerKey(processId); } catch { return send(); }
    this.sending.set(key, (this.sending.get(key) ?? 0) + 1);
    try {
      return await send();
    } finally {
      const count = (this.sending.get(key) ?? 1) - 1;
      if (count > 0) this.sending.set(key, count);
      else this.sending.delete(key);
    }
  }

  private async submit(processId: string, input: IntegratedPromptInput | string): Promise<unknown> {
    const request: IntegratedPromptInput = typeof input === 'string' ? { text: input } : input;
    const hasContent = Boolean(request.text.trim() || request.references?.length || request.attachments?.length);
    if (!hasContent) throw new Error('Message is empty');
    if ((request.references?.length || request.attachments?.length) && !this.inputs) {
      throw new Error('Integrated file references are unavailable');
    }
    const key = this.ledgerKey(processId);
    const arrived = await this.serially(this.arrivals, key, async () => {
      const resolved = this.inputs ? await this.inputs.resolve(processId, request) : { ...request, references: [], attachments: [] };
      // Wrapped so the arrival chain waits for the prompt's place, not its
      // native call.
      const result = this.accept(processId, key, resolved);
      void result.catch(() => {});
      return { result };
    });
    return arrived.result;
  }

  // Synchronous until the prompt is held or joins the dispatch chain.
  private async accept(processId: string, key: string, resolved: ResolvedIntegratedPrompt): Promise<unknown> {
    const messageId = resolved.messageId;
    if (!messageId) return this.runPrompt(processId, resolved, null);
    const hash = submissionHash(resolved);
    const legacy = legacySubmissionHash(resolved);
    const running = this.inflight.get(key)?.get(messageId);
    if (running) {
      if (running.hash !== hash && running.legacy !== legacy) throw new Error('This message id was already used with a different payload');
      return running.promise;
    }
    // A held prompt keeps its id until it is sent; a retry joins it.
    const sending = this.dispatching.get(key);
    const held = sending?.message_id === messageId ? sending : this.heldPrompt(key, messageId);
    if (held) {
      if (held.payload_hash !== hash) throw new Error('This message id was already used with a different payload');
      if (held.state === 'unconfirmed') return { delivery: 'uncertain', message_id: messageId, error: held.error ?? 'Delivery could not be confirmed.' };
      return heldResult(messageId, held.turn_kind);
    }
    const known = this.submission(key, messageId);
    if (known) {
      // The same id with a different payload is a caller bug, not a retry.
      if (known.payload_hash !== hash && known.payload_hash !== legacy) throw new Error('This message id was already used with a different payload');
      if (known.state === 'accepted') return replaySubmission(known);
      // Uncertain or forgotten ids are reconciled against native evidence; an
      // absent bounded snapshot stays unknown and is never silently resent.
      const state = await this.reconcileNative(processId, messageId);
      if (state === 'accepted') {
        const result = { delivery: 'accepted', message_id: messageId };
        this.recordSubmission(key, messageId, hash, 'accepted', JSON.stringify(result), null);
        return result;
      }
      return {
        delivery: 'uncertain',
        message_id: messageId,
        error: known.error ?? (known.state === 'forgotten'
          ? 'This message id was used before and cannot be retried safely; check delivery or send again as a new message.'
          : 'Delivery could not be confirmed.')
      };
    }
    const identity: SubmissionIdentity = { key, messageId, hash };
    const promise = this.runPrompt(processId, resolved, identity);
    let perProcess = this.inflight.get(key);
    if (!perProcess) {
      perProcess = new Map();
      this.inflight.set(key, perProcess);
    }
    perProcess.set(messageId, { hash, legacy, promise });
    void promise.finally(() => {
      const current = this.inflight.get(key);
      if (current?.get(messageId)?.promise === promise) current.delete(messageId);
    }).catch(() => {});
    return promise;
  }

  // Provider invocation plus submission bookkeeping. The reservation is written
  // before the external call, so a crash between native admission and the
  // acknowledgement leaves an uncertain row rather than an id that looks unused.
  // Outcome bookkeeping failures never turn an admitted prompt into a
  // definitive rejection.
  private runPrompt(processId: string, resolved: ResolvedIntegratedPrompt, identity: SubmissionIdentity | null): Promise<unknown> {
    const key = this.ledgerKey(processId);
    // Behind held prompts a new one is stored at once, rather than in memory
    // until their native calls settle.
    const backlog = this.nextHeld(key) ?? this.dispatching.get(key);
    if (backlog && !this.waiting.get(key)) {
      const result = this.hold(key, resolved, identity, backlog.turn_kind);
      this.flushHeld(key);
      return Promise.resolve(result);
    }
    this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1);
    return this.serially(this.dispatches, key, () => {
      const count = (this.waiting.get(key) ?? 1) - 1;
      if (count > 0) this.waiting.set(key, count);
      else this.waiting.delete(key);
      return this.dispatchPrompt(processId, key, resolved, identity);
    });
  }

  private async dispatchPrompt(processId: string, activityKey: string, resolved: ResolvedIntegratedPrompt, identity: SubmissionIdentity | null): Promise<unknown> {
    // Later prompts wait behind held ones so the agent reads them in order.
    const backlog = this.nextHeld(activityKey);
    if (backlog) {
      const result = this.hold(activityKey, resolved, identity, backlog.turn_kind);
      this.flushHeld(activityKey);
      return result;
    }
    if (identity) this.recordSubmission(identity.key, identity.messageId, identity.hash, 'uncertain', null, null);
    const sequence = this.sequence(activityKey);
    let result: unknown;
    try {
      result = await this.forProcess(processId).prompt(processId, resolved);
    } catch (error) {
      if (error instanceof UncertainDeliveryError) {
        // An ambiguous submission may already be running natively. Return a
        // visible uncertain state instead of throwing or retrying.
        const id = error.messageId ?? identity?.messageId;
        if (identity && id) {
          try { this.recordSubmission(identity.key, id, identity.hash, 'uncertain', null, error.message); } catch { /* the reservation already exists */ }
        }
        return { delivery: 'uncertain', message_id: id ?? null, error: error.message };
      }
      // The provider classified this as a definitive pre-admission rejection.
      if (identity) {
        try { this.removeSubmission(identity.key, identity.messageId); } catch { /* fail closed: the row stays uncertain */ }
      }
      // A turn that takes no input is running; send the prompt after it. Try
      // once now in case that turn ended before the prompt was stored.
      if (error instanceof TurnBusyError) {
        const held = this.hold(activityKey, resolved, identity, error.turnKind);
        this.flushHeld(activityKey);
        return held;
      }
      throw error;
    }
    this.admitted(processId, activityKey, sequence, resolved, identity, result);
    return result;
  }

  // The native provider admitted the prompt. Activity and result bookkeeping
  // are best effort from here: a failure must not delete the reservation or
  // present the submission as rejected. A turn that already reported its own
  // status while the call was in flight wins over the synthetic mark.
  private admitted(processId: string, key: string, sequence: number, resolved: ResolvedIntegratedPrompt, identity: SubmissionIdentity | null, result: unknown): void {
    // A prompt does not answer a pending permission or question, so the agent
    // still waits.
    try { if (!awaitingUser(this.activity(key))) this.markActivitySince(key, 'working', sequence); } catch { /* activity is best effort */ }
    this.signal(key, 'turn');
    try { this.refreshTitle(processId, resolved.text); } catch { /* titles are best effort */ }
    if (identity) {
      try { this.recordSubmission(identity.key, identity.messageId, identity.hash, 'accepted', JSON.stringify(result ?? null), null); } catch { /* reconcile will confirm later */ }
    }
  }

  // Stores a prompt the agent cannot take yet. It was definitively not
  // admitted, so sending it later cannot run it twice. Prompts without a
  // client id get one so the queue can show and cancel them.
  private hold(key: string, resolved: ResolvedIntegratedPrompt, identity: SubmissionIdentity | null, turnKind: string): unknown {
    const messageId = identity?.messageId ?? `held_${randomUUID()}`;
    this.database.connection.prepare(`insert into integrated_held_prompts (process_id, message_id, payload, payload_hash, turn_kind, created_at)
      values (?, ?, ?, ?, ?, ?) on conflict (process_id, message_id) do nothing`)
      .run(key, messageId, JSON.stringify(resolved), identity?.hash ?? submissionHash(resolved), turnKind, new Date().toISOString());
    this.debugLog?.write('integrated', 'prompt.held', { processId: key, messageId, turnKind });
    this.queueChanged(key);
    return heldResult(messageId, turnKind);
  }

  // Sends held prompts oldest first once the agent can take input. Each later
  // prompt steers the turn the first one started, as a typed message would.
  private flushHeld(key: string): void {
    // A call before the running pass reads the queue joins that pass.
    const running = this.heldFlushes.get(key);
    if (running) {
      if (running.started) running.again = true;
      return;
    }
    if (!this.nextHeld(key)) return;
    const flush = { again: false, started: false };
    this.heldFlushes.set(key, flush);
    void this.whileSending(key, () => this.serially(this.dispatches, key, () => {
      flush.started = true;
      return this.deliverHeld(key);
    })).catch((error: unknown) => {
      this.debugLog?.write('integrated', 'prompt.held_flush_failed', { processId: key, message: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      this.heldFlushes.delete(key);
      if (flush.again) this.flushHeld(key);
    });
  }

  private async deliverHeld(key: string): Promise<void> {
    if (!this.isLive(key)) return;
    for (let row = this.nextHeld(key); row; row = this.nextHeld(key)) {
      const resolved = JSON.parse(row.payload) as ResolvedIntegratedPrompt;
      const identity = { key, messageId: row.message_id, hash: row.payload_hash ?? submissionHash(resolved) };
      // Claimed before the call, as a first send reserves its id: a restart
      // after native admission leaves an uncertain id, never a second send.
      this.claimHeld(key, row, identity.hash);
      this.dispatching.set(key, row);
      const sequence = this.sequence(key);
      let result: unknown;
      try {
        // The held id lets the transcript confirm an unconfirmed send.
        result = await this.forProcess(key).prompt(key, { ...resolved, messageId: row.message_id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // It may be running, so it is never sent again. It stays visible as
        // unconfirmed until the transcript shows it or the user dismisses it.
        if (error instanceof UncertainDeliveryError) {
          this.debugLog?.write('integrated', 'prompt.held_failed', { processId: key, messageId: row.message_id, uncertain: true, message });
          this.releaseHeld(key, row, identity.hash, message, 'unconfirmed');
          continue;
        }
        // Still busy, for example a second compaction, it waits for that turn
        // to end. Definitively rejected, it shows why and is tried again when
        // the agent next goes idle or the user sends it now. Either way it
        // keeps its place.
        const busy = error instanceof TurnBusyError;
        if (!busy) this.debugLog?.write('integrated', 'prompt.held_failed', { processId: key, messageId: row.message_id, uncertain: false, message });
        this.releaseHeld(key, row, identity.hash, busy ? row.error : message, 'held');
        return;
      } finally {
        this.dispatching.delete(key);
      }
      this.admitted(key, key, sequence, resolved, identity, result);
    }
  }

  private claimHeld(key: string, row: HeldPromptRow, hash: string): void {
    this.database.connection.transaction(() => {
      this.database.connection.prepare('delete from integrated_held_prompts where process_id = ? and message_id = ?').run(key, row.message_id);
      this.recordSubmission(key, row.message_id, hash, 'uncertain', null, null);
    })();
    this.queueChanged(key);
  }

  // Puts a claimed prompt back in its original place: held when it was
  // definitively not sent, unconfirmed when it may have been.
  private releaseHeld(key: string, row: HeldPromptRow, hash: string, error: string | null, state: 'held' | 'unconfirmed'): void {
    this.database.connection.transaction(() => {
      if (state === 'held') this.removeSubmission(key, row.message_id);
      else this.recordSubmission(key, row.message_id, hash, 'uncertain', null, error);
      this.database.connection.prepare(`insert into integrated_held_prompts (seq, process_id, message_id, payload, payload_hash, turn_kind, error, state, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.seq, key, row.message_id, row.payload, row.payload_hash, row.turn_kind, error, state, row.created_at);
    })();
    this.queueChanged(key);
  }

  // Unconfirmed prompts the native transcript shows arrived are settled.
  private confirmHeld(key: string, conversation: unknown): void {
    const unconfirmed = this.database.connection.prepare(`select message_id from integrated_held_prompts where process_id = ? and state = 'unconfirmed'`).all(key) as Array<{ message_id: string }>;
    if (!unconfirmed.length) return;
    const raw = record(conversation).messages;
    const messages = Array.isArray(raw) ? raw : record(raw).data;
    const arrived = new Set((Array.isArray(messages) ? messages : []).map((message) => record(message).clientMessageId));
    for (const row of unconfirmed) if (arrived.has(row.message_id)) this.settleUnconfirmed(key, row.message_id);
  }

  private settleUnconfirmed(key: string, messageId: string): void {
    const settled = this.database.connection.transaction(() => {
      const removed = this.database.connection.prepare(`delete from integrated_held_prompts where process_id = ? and message_id = ? and state = 'unconfirmed'`).run(key, messageId);
      if (removed.changes) this.database.connection.prepare(`update integrated_submissions set state = 'accepted', error = null where process_id = ? and message_id = ?`).run(key, messageId);
      return removed.changes > 0;
    })();
    if (settled) this.queueChanged(key);
  }

  private serially<T>(chains: Map<string, Promise<unknown>>, key: string, run: () => Promise<T>): Promise<T> {
    const next = (chains.get(key) ?? Promise.resolve()).then(run);
    const tail = next.catch(() => undefined);
    chains.set(key, tail);
    void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return next;
  }

  // Prompts held for an earlier process of the same native conversation move
  // to its resumed process, which sends them once it is idle. An unconfirmed
  // prompt's reservation moves with it, so it can never be sent again there.
  private adoptHeld(key: string): void {
    const earlier = `select earlier.process_id from sessions earlier join sessions latest on latest.process_id = ?
      where earlier.harness = latest.harness and earlier.resume_id = latest.resume_id
        and earlier.process_id != latest.process_id and earlier.exited_at is not null`;
    const moved = this.database.connection.transaction(() => {
      this.database.connection.prepare(`
        insert or ignore into integrated_submissions (process_id, message_id, payload_hash, state, result, error, created_at)
        select ?, submission.message_id, submission.payload_hash, submission.state, submission.result, submission.error, submission.created_at
        from integrated_submissions submission join integrated_held_prompts held
          on held.process_id = submission.process_id and held.message_id = submission.message_id
        where held.process_id in (${earlier})
      `).run(key, key);
      return this.database.connection.prepare(`update or ignore integrated_held_prompts set process_id = ? where process_id in (${earlier})`).run(key, key).changes;
    })();
    if (moved) this.queueChanged(key);
  }

  private nextHeld(key: string): HeldPromptRow | undefined {
    return this.database.connection.prepare(`${HELD_SELECT} where process_id = ? and state = 'held' order by seq limit 1`)
      .get(key) as HeldPromptRow | undefined;
  }

  private heldPrompt(key: string, messageId: string): HeldPromptRow | undefined {
    return this.database.connection.prepare(`${HELD_SELECT} where process_id = ? and message_id = ?`)
      .get(key, messageId) as HeldPromptRow | undefined;
  }

  private heldQueue(key: string): IntegratedQueuedMessage[] {
    const rows = this.database.connection.prepare(`${HELD_SELECT} where process_id = ? order by seq`).all(key) as HeldPromptRow[];
    return rows.map((row) => ({
      id: row.message_id, text: String(record(JSON.parse(row.payload)).text ?? ''), delivery: row.state, reason: row.turn_kind,
      ...(row.error ? { error: row.error } : {})
    }));
  }

  private removeHeld(key: string, messageId: string): void {
    this.database.connection.prepare('delete from integrated_held_prompts where process_id = ? and message_id = ?').run(key, messageId);
    this.queueChanged(key);
  }

  // Viewers re-read the snapshot, which carries the held queue. The event is
  // Patterm's own, outside the native revision order.
  private queueChanged(key: string): void {
    const event: IntegratedConversationEvent = { processId: key, revision: -1, kind: 'pending', id: HELD_QUEUE_EVENT_ID };
    for (const listener of this.conversationSubscriptions.get(key)?.listeners ?? []) {
      try { listener(event); } catch { /* listeners own their failures */ }
    }
  }

  // Canonical ledger key: the same native process can be addressed by process
  // id or session id, so both aliases must share one submission namespace.
  private ledgerKey(processId: string): string {
    const row = this.database.connection.prepare(`
      select coalesce(process_id, id) as key from sessions
      where (process_id = ? or id = ?) and interface_mode = 'integrated'
      order by exited_at is null desc, started_at desc limit 1
    `).get(processId, processId) as { key: string } | undefined;
    return row?.key ?? processId;
  }

  private async reconcileNative(processId: string, messageId: string): Promise<IntegratedDeliveryState> {
    const provider = this.forProcess(processId);
    if (!provider.reconcile) return 'unknown';
    return provider.reconcile(processId, messageId).catch((): IntegratedDeliveryState => 'unknown');
  }

  private submission(key: string, messageId: string): SubmissionRow | undefined {
    return this.database.connection.prepare('select message_id, payload_hash, state, result, error from integrated_submissions where process_id = ? and message_id = ?')
      .get(key, messageId) as SubmissionRow | undefined;
  }

  private recordSubmission(key: string, messageId: string, hash: string, state: 'accepted' | 'uncertain', result: string | null, error: string | null): void {
    this.database.connection.prepare(`
      insert into integrated_submissions (process_id, message_id, payload_hash, state, result, error, created_at)
      values (?, ?, ?, ?, ?, ?, ?)
      on conflict (process_id, message_id) do update set
        payload_hash = excluded.payload_hash, state = excluded.state, result = excluded.result,
        error = excluded.error, created_at = excluded.created_at
    `).run(key, messageId, hash, state, result, error, new Date().toISOString());
    this.pruneSubmissions(key);
  }

  private removeSubmission(key: string, messageId: string): void {
    this.database.connection.prepare('delete from integrated_submissions where process_id = ? and message_id = ?').run(key, messageId);
  }

  // Outcomes are compacted, never deleted. A repeated id stays known for the
  // life of the database, so neither eviction nor a restart can silently recycle
  // it into a fresh send. Forgotten rows keep only the id and payload hash.
  private pruneSubmissions(key: string): void {
    this.database.connection.prepare(`
      update integrated_submissions set state = 'forgotten', result = null, error = null
      where process_id = ? and state != 'forgotten' and message_id not in (
        select message_id from integrated_submissions where process_id = ? order by created_at desc, rowid desc limit ?
      )
    `).run(key, key, SUBMISSION_WINDOW);
  }

  // Native evidence that an ambiguous prompt was admitted. Absence from one
  // bounded read is unknown, never proof that nothing was admitted.
  async delivery(processId: string, messageId: string): Promise<{ state: IntegratedDeliveryState }> {
    const provider = this.forProcess(processId);
    if (!provider.reconcile) return { state: 'unknown' };
    const state = await provider.reconcile(processId, messageId);
    if (state === 'accepted') this.settleUnconfirmed(this.ledgerKey(processId), messageId);
    return { state };
  }

  // One provider subscription per process, shared by every listener (desktop
  // and browser clients). Returns a release function.
  async subscribeConversation(processId: string, listener: IntegratedConversationListener): Promise<() => void> {
    let entry = this.conversationSubscriptions.get(processId);
    if (!entry) {
      const provider = this.forProcess(processId);
      const subscribe = provider.subscribe;
      if (!subscribe) return () => {};
      const created: ConversationSubscription = { listeners: new Set(), unsubscribe: undefined, ready: Promise.resolve(), retry: null };
      this.conversationSubscriptions.set(processId, created);
      const fanOut = (event: IntegratedConversationEvent): void => {
        // One failing listener must neither escape into the provider's socket
        // handler nor starve the others.
        for (const current of created.listeners) {
          try { current(event); } catch { /* listeners own their failures */ }
        }
        // The provider gave up reconnecting. That is not proof the native
        // process exited, so open a fresh provider subscription later instead
        // of leaving every listener on a dead one.
        if (event.kind === 'error' && event.id === 'connection_error') resubscribe();
      };
      let attempts = 0;
      const resubscribe = (): void => {
        if (created.retry || this.conversationSubscriptions.get(processId) !== created) return;
        created.unsubscribe?.();
        created.unsubscribe = undefined;
        created.retry = setTimeout(() => {
          created.retry = null;
          if (this.conversationSubscriptions.get(processId) !== created || !created.listeners.size) return;
          void subscribe.call(provider, processId, fanOut).then((release) => {
            attempts = 0;
            if (this.conversationSubscriptions.get(processId) === created) created.unsubscribe = release;
            else release();
          }, resubscribe);
        }, resubscribeDelay(attempts++));
        created.retry.unref();
      };
      created.ready = subscribe.call(provider, processId, fanOut).then((release) => {
        created.unsubscribe = release;
      }).catch((error: unknown) => {
        if (this.conversationSubscriptions.get(processId) === created) this.conversationSubscriptions.delete(processId);
        throw error;
      });
      entry = created;
    }
    await entry.ready;
    // A concurrent last release may have torn the entry down while this call
    // was waiting for the provider; retry instead of joining a dead entry.
    if (this.conversationSubscriptions.get(processId) !== entry) return this.subscribeConversation(processId, listener);
    entry.listeners.add(listener);
    return () => {
      const current = this.conversationSubscriptions.get(processId);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size) return;
      if (current.retry) clearTimeout(current.retry);
      current.unsubscribe?.();
      this.conversationSubscriptions.delete(processId);
    };
  }

  files(processId: string, query: string, limit?: number): Promise<IntegratedWorktreeFile[]> {
    if (!this.inputs) throw new Error('Integrated file references are unavailable');
    return this.inputs.search(processId, query, limit);
  }

  interrupt(processId: string): Promise<void> {
    return this.forProcess(processId).interrupt(processId);
  }

  replyPermission(processId: string, requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    return this.forProcess(processId).replyPermission(processId, requestId, reply, message);
  }

  async updateQueued(processId: string, messageId: string, action: 'steer' | 'cancel'): Promise<void> {
    const key = this.ledgerKey(processId);
    if (this.dispatching.get(key)?.message_id === messageId) throw new Error('This message is already being sent');
    const held = this.heldPrompt(key, messageId);
    if (held) {
      // A held prompt cannot jump the turn it waits for; sending now retries.
      // Cancelling an unconfirmed one only dismisses it.
      if (action === 'cancel') this.removeHeld(key, messageId);
      else if (held.state === 'unconfirmed') throw new Error('This message may already have reached the agent; send it again as a new message if it did not.');
      else this.flushHeld(key);
      return;
    }
    const provider = this.forProcess(processId);
    const update = provider.updateQueued;
    if (!update) throw new Error('This agent has no message queue');
    return update.call(provider, processId, messageId, action);
  }

  stopTask(processId: string, taskId: string): Promise<void> {
    const provider = this.forProcess(processId);
    const stop = provider.stopTask;
    if (!stop) throw new Error('This agent cannot stop background tasks');
    return stop.call(provider, processId, taskId);
  }

  taskOutput(processId: string, taskId: string, since?: string | null, cursor?: string | null): Promise<unknown> {
    const provider = this.forProcess(processId);
    const read = provider.taskOutput;
    if (!read) throw new Error('This agent cannot show background task output');
    return read.call(provider, processId, taskId, since, cursor);
  }

  replyQuestion(processId: string, requestId: string, answers: string[][]): Promise<void> {
    return this.forProcess(processId).replyQuestion(processId, requestId, answers);
  }

  replyForm(processId: string, formId: string, answer: Record<string, unknown>, action: IntegratedFormAction = 'accept'): Promise<void> {
    const provider = this.forProcess(processId);
    const reply = provider.replyForm;
    if (!reply) throw new Error('This agent does not support native forms');
    return reply.call(provider, processId, formId, answer, action);
  }

  async controls(processId: string): Promise<IntegratedControls> {
    const native = await (this.forProcess(processId).controls?.(processId) ?? Promise.resolve({ selectors: [], commands: [] }));
    const owned = new Set(PATTERM_COMMANDS.map((command) => command.name));
    return { ...native, commands: [...PATTERM_COMMANDS, ...native.commands.filter((command) => !owned.has(command.name))] };
  }

  // A session is empty when it has no visible messages and no older history
  // to page in. Resumed sessions with archived turns are never empty.
  async isEmpty(processId: string): Promise<boolean> {
    const key = this.ledgerKey(processId);
    if (this.inflight.get(key)?.size || this.nextHeld(key)) return false;
    const conversation = record(await this.conversation(processId));
    if (conversation.history_truncated === true || record(conversation.history_cursor).next || typeof conversation.history_cursor === 'string') return false;
    const messages = Array.isArray(conversation.messages) ? conversation.messages : record(conversation.messages).data;
    return !Array.isArray(messages) || messages.length === 0;
  }

  configure(processId: string, selector: string, value: string): Promise<void> {
    const provider = this.forProcess(processId);
    const configure = provider.configure;
    if (!configure) throw new Error('This agent does not support changing that setting');
    return configure.call(provider, processId, selector, value).then(() => {
      if (selector === 'model') this.signal(this.ledgerKey(processId), 'model');
    });
  }

  command(processId: string, name: string, text: string): Promise<unknown> {
    return this.whileSending(processId, () => this.runCommand(processId, name, text));
  }

  private async runCommand(processId: string, name: string, text: string): Promise<unknown> {
    const provider = this.forProcess(processId);
    const command = provider.command;
    if (!command) throw new Error('This agent does not support slash commands');
    const key = this.ledgerKey(processId);
    const compacting = name === 'compact';
    if (compacting) this.signal(key, 'compact');
    let result: unknown;
    try {
      result = await command.call(provider, processId, name, text);
    } catch (error) {
      if (compacting) this.signal(key, 'compact_rejected');
      throw error;
    }
    if (!compacting) this.signal(key, 'turn');
    // Some commands start no turn, such as a rename or a local setting, so
    // read the native state rather than assume work started.
    this.refreshObserved(key);
    try { this.refreshTitle(processId, `/${name}${text ? ` ${text}` : ''}`); } catch { /* titles are best effort */ }
    return result;
  }

  // Native compaction outside a user turn. It bypasses custom commands that
  // share the name, leaves the title alone, and is only admitted while the
  // agent is idle with no prompt on its way.
  async compact(processId: string): Promise<void> {
    const provider = this.forProcess(processId);
    const compact = provider.compact;
    if (!compact) throw new Error('This agent cannot compact its conversation');
    const key = this.ledgerKey(processId);
    if (this.activity(key) !== 'idle' || this.sending.get(key)) throw new Error('The agent is busy');
    this.signal(key, 'compact');
    const sequence = this.sequence(key);
    try {
      await compact.call(provider, processId);
    } catch (error) {
      this.signal(key, 'compact_rejected');
      throw error;
    }
    this.markActivitySince(key, 'working', sequence);
  }

  // The model the next turn runs on. A native report wins over the selector,
  // which can be stale after a restart.
  async model(processId: string): Promise<string | null> {
    const provider = this.forProcess(processId);
    const native = provider.currentModel ? await provider.currentModel(processId) : null;
    return native ?? (await this.controls(processId)).selectors.find((selector) => selector.id === 'model')?.value ?? null;
  }

  // The settings the agent runs on now. The launch columns miss changes made
  // mid-conversation, so a restart resumes with these instead. Only settings
  // the agent reports are returned. A `default` model or effort means the
  // harness default; Codex's `default` speed is an explicit Standard tier.
  async liveSettings(processId: string): Promise<LiveSettings> {
    const provider = this.forProcess(processId);
    const native = provider.nativeSettings ? await provider.nativeSettings(processId) : {};
    if (native.model) return native;
    const { selectors } = await this.controls(processId);
    const setting = (id: string, keepDefault = false) => {
      const selector = selectors.find((item) => item.id === id);
      return selector ? { value: selector.value && (keepDefault || selector.value !== 'default') ? selector.value : null } : undefined;
    };
    const model = setting('model');
    const reasoning = setting('effort') ?? setting('variant');
    const tier = setting('speed', true);
    return {
      ...(model ? { model: model.value } : {}),
      ...(reasoning ? { reasoning: reasoning.value } : {}),
      ...(tier ? { service_tier: tier.value } : {})
    };
  }

  private signal(key: string, signal: CompactionSignal): void {
    for (const listener of this.compactionListeners) {
      try { listener(key, signal); } catch { /* a listener must not block the agent */ }
    }
  }

  async stop(processId: string): Promise<void> {
    const harness = this.sessionHarness(processId);
    if (harness && !presetHarnessInput.safeParse(harness).success) {
      await this.stopUnsupportedHosts([{ process_id: processId, harness }]);
      this.unobserve(this.ledgerKey(processId));
      return;
    }
    const provider = this.forProcess(processId);
    // A provider's stop is authoritative. It owns whether an interrupt is
    // needed and whether a failure is fatal, so a live host that refused to
    // stop is never reported as stopped, and stays observed.
    if (provider.stop) await provider.stop(processId);
    else await provider.interrupt(processId);
    this.unobserve(this.ledgerKey(processId));
  }

  async stopAll(): Promise<void> {
    this.dispose();
    for (const refresh of this.titleRefreshes.values()) if (refresh.timer) clearTimeout(refresh.timer);
    this.titleRefreshes.clear();
    const rows = this.database.connection.prepare(`select process_id, harness from sessions
      where interface_mode = 'integrated' and process_id is not null and harness is not null`).all() as Array<{ process_id: string; harness: string }>;
    const unsupported = rows.filter((row) => !presetHarnessInput.safeParse(row.harness).success);
    const results = await Promise.allSettled([
      ...Object.values(this.providers).map((provider) => provider?.stopAll?.()),
      this.stopUnsupportedHosts(unsupported)
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'Could not stop every Integrated agent');
  }

  async reconcile(): Promise<{ checked: number; failed: number; unreachable: number }> {
    const rows = this.database.connection.prepare(`
      select process_id, harness from sessions
      where interface_mode = 'integrated' and exited_at is null and process_id is not null
    `).all() as Array<{ process_id: string; harness: string }>;
    const results = await Promise.all(rows.map(async (row): Promise<'ok' | 'failed' | 'unreachable'> => {
      const unsupported = !presetHarnessInput.safeParse(row.harness).success;
      try {
        if (unsupported) await this.stopUnsupportedHosts([row]);
        else {
          await this.conversation(row.process_id);
          this.observe(row.process_id);
          return 'ok';
        }
      } catch {
        if (unsupported) return 'unreachable';
        // A supported host that still listens is still running its agent.
        // Keep it live and let observation retry instead of orphaning it.
        if (await this.hostListening(row.process_id)) {
          this.observe(row.process_id);
          return 'unreachable';
        }
      }
      const now = new Date().toISOString();
      this.database.connection.prepare(`update processes set status = 'failed', exited_at = coalesce(exited_at, ?), updated_at = ? where id = ?`).run(now, now, row.process_id);
      this.database.connection.prepare(`update sessions set exited_at = coalesce(exited_at, ?) where process_id = ?`).run(now, row.process_id);
      return 'failed';
    }));
    return {
      checked: rows.length,
      failed: results.filter((result) => result === 'failed').length,
      unreachable: results.filter((result) => result === 'unreachable').length
    };
  }

  // Removed providers keep no launch or conversation adapter. Their hosts use
  // the shared control protocol, and their supervised units still need cleanup.
  private async stopUnsupportedHosts(rows: Array<{ process_id: string; harness: string }>): Promise<void> {
    const stops = await Promise.allSettled(rows.map(async (row) => {
      const socketPath = this.hostSocketPath(row.process_id);
      if (socketPath) await callIntegratedHost(socketPath, 'stop', {});
    }));
    const supervised = await Promise.allSettled([...new Set(rows.map((row) => row.harness))].map((harness) => this.hostLauncher.stopAll(harness)));
    const errors = supervised.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    for (const [index, result] of stops.entries()) {
      if (result.status === 'rejected' && await this.hostListening(rows[index]!.process_id)) errors.push(result.reason);
    }
    if (errors.length) throw new AggregateError(errors, 'Could not stop unsupported Integrated hosts');
  }

  // Stops the host of an agent that is no longer marked running, such as one
  // reconciled as failed, when that host is in fact still alive.
  async stopIfLive(processId: string): Promise<void> {
    if (await this.hostListening(processId)) await this.stop(processId);
  }

  // A host is alive when its control socket accepts a connection. Unlike a PID
  // check, this cannot match an unrelated process after a reboot.
  private hostSocketPath(processId: string): string | null {
    const row = this.database.connection.prepare(`select argv from processes where id = ?`).get(this.ledgerKey(processId)) as { argv: string | null } | undefined;
    let socketPath: unknown;
    try { socketPath = (JSON.parse(row?.argv ?? 'null') as unknown[] | null)?.[2]; } catch { return null; }
    return typeof socketPath === 'string' && socketPath.endsWith('.sock') ? socketPath : null;
  }

  private async hostListening(processId: string): Promise<boolean> {
    const socketPath = this.hostSocketPath(processId);
    if (!socketPath) return false;
    return integratedHostListening(socketPath);
  }

  private forProcess(processId: string): IntegratedProviderService {
    return this.provider(this.harness(processId));
  }

  private sessionHarness(processId: string): string | null {
    const row = this.database.connection.prepare(`
      select harness from sessions
      where (process_id = ? or id = ?) and interface_mode = 'integrated'
      order by exited_at is null desc, started_at desc limit 1
    `).get(processId, processId) as { harness: string } | undefined;
    return row?.harness ?? null;
  }

  private harness(processId: string): 'claude' | 'codex' | 'opencode' {
    const parsed = presetHarnessInput.safeParse(this.sessionHarness(processId));
    if (!parsed.success) throw new Error('Integrated agent session not found');
    return parsed.data;
  }

  // Claude runtimes only hold turns from their own run, so earlier
  // turns come from imported history. Codex pages natively and needs the
  // archive only on builds that cannot list thread items.
  private archiveSession(processId: string, conversation: unknown): { provider: string; resumeId: string; projectId: string; startedAt: string } | null {
    const row = this.database.connection.prepare(`
      select harness, resume_id, project_id, started_at from sessions
      where (process_id = ? or id = ?) and interface_mode = 'integrated' and harness in ('claude', 'codex') and resume_id is not null
      order by exited_at is null desc, started_at desc limit 1
    `).get(processId, processId) as { harness: string; resume_id: string; project_id: string; started_at: string } | undefined;
    if (!row) return null;
    if (row.harness === 'codex' && conversation !== null && record(conversation).history_unavailable !== true) return null;
    return { provider: row.harness, resumeId: row.resume_id, projectId: row.project_id, startedAt: row.started_at };
  }

  private provider(harness: 'claude' | 'codex' | 'opencode'): IntegratedProviderService {
    const provider = this.providers[harness];
    if (!provider) throw new Error(`${harness} Integrated conversations are unavailable`);
    return provider;
  }

  // Keep one provider subscription open for a live agent and persist its
  // status. The subscription is shared with viewers; after each (re)connect an
  // authoritative snapshot covers events missed while it was being set up.
  observe(processId: string): void {
    let key: string;
    try {
      key = this.ledgerKey(processId);
      if (this.observers.has(key)) return;
      if (!this.isLive(key)) {
        this.observeAttempts.delete(key);
        return;
      }
      this.adoptHeld(key);
    } catch { return; /* observation is best effort */ }
    const observer: ActivityObserver = { release: null, retry: null, refreshing: null, again: false, stale: false, closed: false };
    this.observers.set(key, observer);
    void this.subscribeConversation(key, (event) => this.observed(key, observer, event)).then((release) => {
      if (observer.closed) release();
      else {
        this.observeAttempts.delete(key);
        observer.release = release;
        this.refreshActivity(key, observer);
      }
    }, () => this.retryObserve(key, observer));
  }

  // Release every observation without stopping native hosts, for example when
  // a persistent service shuts down and its agents keep running.
  dispose(): void {
    for (const key of [...this.observers.keys()]) this.unobserve(key);
  }

  private unobserve(key: string): void {
    this.loggedUnhandled.delete(key);
    this.observeAttempts.delete(key);
    const observer = this.observers.get(key);
    if (!observer) return;
    this.observers.delete(key);
    observer.closed = true;
    if (observer.retry) clearTimeout(observer.retry);
    observer.release?.();
  }

  private observed(key: string, observer: ActivityObserver, event: IntegratedConversationEvent): void {
    // Patterm's own held-queue notice is for viewers. Re-reading activity on it
    // would retry a rejected held prompt on every rejection.
    if (observer.closed || event.id === HELD_QUEUE_EVENT_ID) return;
    for (const listener of this.eventListeners) {
      try { listener(key, event); } catch { /* a listener must not break observation */ }
    }
    try {
      if (event.kind === 'reconnecting') {
        observer.stale = true;
      } else if (event.kind === 'error' && event.id === 'connection_error') {
        // The shared subscription reopens itself; re-read once it does.
        observer.stale = true;
      } else if (event.kind === 'status') {
        if (event.status && event.status !== 'unknown') {
          this.activitySequence.set(key, this.sequence(key) + 1);
          this.markActivity(key, event.status);
        }
        // A held prompt waits for a turn that takes no input. That turn can
        // end while background agents keep the status unchanged, so every
        // status retries it; a busy agent keeps it held.
        this.flushHeld(key);
        // A turn's end re-reads the tasks, or queues another read behind one
        // in flight: OpenCode ends a subagent task with a status alone.
        const ended = event.status === 'idle' || event.status === 'error';
        if (observer.stale || ended) this.refreshActivity(key, observer);
      } else if (event.kind === 'pending' || observer.stale) {
        // Pending carries permission changes a provider does not stream and
        // reconnect handoffs.
        this.refreshActivity(key, observer);
      }
    } catch { /* activity is best effort; a busy database must not break the stream */ }
  }

  // Re-reads activity through the agent's observer, or once directly while it
  // has none, for example while its stream is being opened again.
  private refreshObserved(key: string): void {
    const observer = this.observers.get(key);
    if (observer?.release) {
      this.refreshActivity(key, observer);
      return;
    }
    const sequence = this.sequence(key);
    void this.forProcess(key).conversation(key).then((conversation) => this.markSnapshot(key, conversation, sequence)).catch(() => undefined);
  }

  // Coalesced snapshot read. It never overwrites a newer streamed status.
  private refreshActivity(key: string, observer: ActivityObserver): void {
    observer.stale = false;
    if (observer.refreshing) {
      observer.again = true;
      return;
    }
    const sequence = this.sequence(key);
    observer.refreshing = this.forProcess(key).conversation(key).then((conversation) => {
      if (!observer.closed) {
        this.markSnapshot(key, conversation, sequence);
        // Only these reads set the task count: they run one at a time, so a
        // slower, older read cannot overwrite a newer count.
        this.markBackgroundTasks(key, runningTasks(record(conversation).tasks));
      }
      // Covers prompts held before a restart, when no transition follows.
      const status = record(conversation).status;
      if (!observer.closed && (status === 'idle' || status === 'error')) this.flushHeld(key);
      this.logUnhandled(key, conversation);
      this.recordLimits(key, conversation);
    }).catch(() => undefined).finally(() => {
      observer.refreshing = null;
      if (observer.again && !observer.closed) {
        observer.again = false;
        this.refreshActivity(key, observer);
      }
    });
  }

  private retryObserve(key: string, observer: ActivityObserver): void {
    if (observer.closed) return;
    const attempt = this.observeAttempts.get(key) ?? 0;
    this.unobserve(key);
    this.observeAttempts.set(key, attempt + 1);
    const retry = setTimeout(() => {
      if (this.observers.get(key) !== retrying) return;
      this.observers.delete(key);
      this.observe(key);
    }, resubscribeDelay(attempt));
    retry.unref();
    // Hold the slot so launch or reconcile does not start a competing loop.
    const retrying: ActivityObserver = { release: null, retry, refreshing: null, again: false, stale: false, closed: false };
    this.observers.set(key, retrying);
  }

  private isLive(processId: string): boolean {
    return Boolean(this.database.connection.prepare(`
      select 1 from processes join sessions on sessions.process_id = processes.id
      where processes.id = ? and processes.status = 'running' and sessions.interface_mode = 'integrated' and sessions.exited_at is null
    `).get(processId));
  }

  private sequence(key: string): number {
    return this.activitySequence.get(key) ?? 0;
  }

  private markSnapshot(key: string, conversation: unknown, since: number): void {
    const status = record(conversation).status;
    if (isActivityState(status)) this.markActivitySince(key, status, since, true);
  }

  // Background tasks only change how rows look, so activity, and the queues,
  // timers and notifications that follow it, leave them out. Hosts announce a
  // task change with a pending event, which re-reads the snapshot. The count
  // does not touch updated_at, which idle timers read as the agent's start.
  private markBackgroundTasks(processId: string, count: number): void {
    const result = this.database.connection.prepare(`update processes set background_tasks = ? where id = ? and status = 'running' and background_tasks != ?`)
      .run(count, processId, count);
    if (result.changes > 0) this.onWorkbenchChange?.();
  }

  // Synthetic and snapshot writes lose to any newer write since `since`. A
  // snapshot does not advance the sequence: it is older than a mark made after
  // it started, never newer.
  private markActivitySince(key: string, activity: string, since: number, snapshot = false): void {
    if (this.sequence(key) !== since) return;
    if (!snapshot) this.activitySequence.set(key, since + 1);
    this.markActivity(key, activity, snapshot);
  }

  private markActivity(processId: string, activity: string, snapshot = false): void {
    const previous = this.updateActivity(processId, activity);
    if (previous === null) return;
    this.debugLog?.write('integrated', 'activity', { processId, previous, activity, snapshot });
    if (activity === 'idle' || activity === 'error') this.flushHeld(processId);
    this.onWorkbenchChange?.();
    for (const listener of this.activityListeners) {
      try { listener({ processId, previous, activity, snapshot }); } catch { /* a listener must not break observation */ }
    }
  }

  private refreshTitle(processId: string, prompt: string): void {
    const provider = this.forProcess(processId);
    const title = provider.title;
    if (!title) return;
    const previous = this.titleRefreshes.get(processId);
    if (previous?.timer) clearTimeout(previous.timer);
    const refresh: { timer: NodeJS.Timeout | null } = { timer: null };
    this.titleRefreshes.set(processId, refresh);
    const attempt = (index: number): void => {
      refresh.timer = setTimeout(() => {
        refresh.timer = null;
        void title.call(provider, processId, prompt).catch((): null => null).then((value) => {
          if (this.titleRefreshes.get(processId) !== refresh) return;
          if (value) {
            this.titleRefreshes.delete(processId);
            try {
              if (new UpdateSessionTitleAction(this.database).forProcess(processId, value)) this.onWorkbenchChange?.();
            } catch { /* the next prompt refreshes it again */ }
          } else if (index + 1 < TITLE_RETRY_DELAYS_MS.length) attempt(index + 1);
          else this.titleRefreshes.delete(processId);
        });
      }, TITLE_RETRY_DELAYS_MS[index]);
      refresh.timer.unref();
    };
    attempt(0);
  }

  private activity(processId: string): string | undefined {
    return (this.database.connection.prepare('select activity from processes where id = ?').get(processId) as { activity: string } | undefined)?.activity;
  }

  // Returns the replaced activity, or null when nothing changed.
  private updateActivity(processId: string, activity: string): string | null {
    const db = this.database.connection;
    const row = db.prepare(`select activity from processes where id = ? and status = 'running' and activity != ?`).get(processId, activity) as { activity: string } | undefined;
    if (!row) return null;
    const result = db.prepare(`update processes set activity = ?, updated_at = ? where id = ? and status = 'running' and activity != ?`)
      .run(activity, new Date().toISOString(), processId, activity);
    return result.changes > 0 ? row.activity : null;
  }
}

function resubscribeDelay(attempt: number): number {
  return RESUBSCRIBE_DELAYS_MS[Math.min(attempt, RESUBSCRIBE_DELAYS_MS.length - 1)]!;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function archiveBoundary(conversation: unknown, startedAt: string): string {
  const data = record(record(conversation).messages).data;
  const messages = Array.isArray(data) ? data : [];
  for (const item of messages) {
    const createdAt = record(item).created_at;
    if (typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt))) return createdAt;
  }
  // Older live hosts have no message timestamps. When their window is full,
  // prefer an overlapping archive page over losing evicted messages entirely.
  return messages.length >= 400 ? new Date().toISOString() : startedAt;
}

function archiveCursor(before: string, end: number): string {
  return `${ARCHIVE_CURSOR_PREFIX}${JSON.stringify({ before, end })}`;
}

function parseArchiveCursor(cursor: string): { before: string; end: number } {
  let parsed: unknown;
  try { parsed = JSON.parse(cursor.slice(ARCHIVE_CURSOR_PREFIX.length)) as unknown; } catch { throw new Error('Invalid history cursor'); }
  const value = record(parsed);
  if (typeof value.before !== 'string' || !Number.isFinite(Date.parse(value.before)) || !Number.isSafeInteger(value.end) || (value.end as number) < 0) {
    throw new Error('Invalid history cursor');
  }
  return { before: value.before, end: value.end as number };
}

const SUBMISSION_WINDOW = 500;

interface SubmissionIdentity {
  key: string;
  messageId: string;
  hash: string;
}

interface ConversationSubscription {
  listeners: Set<IntegratedConversationListener>;
  unsubscribe: (() => void) | undefined;
  ready: Promise<void>;
  // Pending fresh provider subscription after the provider gave up.
  retry: NodeJS.Timeout | null;
}

interface ActivityObserver {
  release: (() => void) | null;
  retry: NodeJS.Timeout | null;
  refreshing: Promise<void> | null;
  // A refresh was requested while one was running.
  again: boolean;
  // The stream reconnected; the next event triggers a snapshot handoff.
  stale: boolean;
  closed: boolean;
}

interface InFlightSubmission {
  hash: string;
  legacy: string;
  promise: Promise<unknown>;
}

interface HeldPromptRow {
  seq: number;
  message_id: string;
  payload: string;
  payload_hash: string | null;
  turn_kind: string;
  error: string | null;
  state: 'held' | 'unconfirmed';
  created_at: string;
}

const HELD_SELECT = 'select seq, message_id, payload, payload_hash, turn_kind, error, state, created_at from integrated_held_prompts';

function heldResult(messageId: string, turnKind: string): unknown {
  const turn = turnKind === 'review' ? 'review' : turnKind === 'compact' ? 'compaction' : `${turnKind} turn`;
  return { delivery: 'queued', message_id: messageId, reason: turnKind,
    detail: `The agent is running a ${turn} and cannot take messages yet. Patterm queued this one and sends it when the ${turn} ends; do not resend it.` };
}

interface SubmissionRow {
  message_id: string;
  payload_hash: string;
  state: 'accepted' | 'uncertain' | 'forgotten';
  result: string | null;
  error: string | null;
}

function replaySubmission(row: SubmissionRow): unknown {
  if (row.result) {
    try { return JSON.parse(row.result); } catch { /* fall through to a generic acknowledgement */ }
  }
  return { delivery: 'accepted', message_id: row.message_id };
}

function submissionHash(input: ResolvedIntegratedPrompt): string {
  return createHash('sha256').update(canonicalPayload(input)).digest('hex');
}

// Rows written before payload hashes were cryptographic stored the canonical
// payload itself. Keep recognising them so an upgrade cannot misreport the same
// payload as a changed one.
function legacySubmissionHash(input: ResolvedIntegratedPrompt): string {
  return JSON.stringify([
    input.text,
    input.references.map((reference) => reference.path),
    input.attachments.map((attachment) => `${attachment.path}:${attachment.mime}:${attachment.size}`)
  ]);
}

function canonicalPayload(input: ResolvedIntegratedPrompt): string {
  return JSON.stringify([
    input.text,
    input.references.map((reference) => [reference.relativePath, reference.path]),
    input.attachments.map((attachment) => [attachment.path, attachment.mime, attachment.size])
  ]);
}

// Tasks a harness reports as still running, such as a background shell.
function runningTasks(tasks: unknown): number {
  if (!Array.isArray(tasks)) return 0;
  return tasks.filter((task) => {
    const status = record(task).status;
    return status === 'running' || status === 'pending';
  }).length;
}
