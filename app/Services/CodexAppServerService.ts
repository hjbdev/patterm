import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { awaitingActivity, awaitingUser } from './Activity';
import type { DatabaseService } from './DatabaseService';
import { detachedHostLauncher, hostConnectionError, integratedHostReady, stopHostProcess, stopRecordedHostProcess, type IntegratedHostLauncher } from './IntegratedHostLauncher';
import type { IntegratedControls, IntegratedFormAction, IntegratedLaunchInput, IntegratedLaunchResult } from './IntegratedAgentService';
import { elicitationContent, elicitationForm, type ElicitationForm } from './McpElicitation';
import { TurnBusyError, UncertainDeliveryError, type IntegratedDeliveryState } from './IntegratedDelivery';
import type { ResolvedIntegratedPrompt } from './IntegratedInput';
import type { MemoryUpdate } from './MemoryPushService';
import { containsPlainPath, quotedPath, replaceReferenceToken } from './PromptReferences';
import { messagesTaskOutput, textTaskOutput, type IntegratedConversationEvent, type IntegratedConversationMessage, type IntegratedTaskOutput } from './IntegratedConversation';
import {
  applyCodexConversationEvent,
  codexTimes,
  keepCodexTimes,
  CODEX_MESSAGE_WINDOW,
  mergeCodexSeedEvents,
  projectCodexDelta,
  codexOutputPlaceholder,
  subagentLabel,
  projectCodexError,
  projectCodexItem,
  projectCodexNotice,
  projectCodexPlan,
  projectCodexPatchUpdated,
  projectCodexStatus,
  codexThreadStatus,
  type CodexConversationEvent,
  type CodexDeliveryStatus,
  type CodexStatus,
  type CodexConversationState, restoreCodexWindowGap, CODEX_PLAN_TITLE } from './CodexTranscript';
import type { TranscriptImageStore } from './TranscriptImageStore';
import type { RealtimeVoiceOptions } from './AssistantVoiceProfile';
import { CODEX_MCP_PROXY_ENV, codexMcpOverrides as globalCodexMcpOverrides } from '../Harness/McpDelivery';
import { ipcPath } from '../Platform/Ipc';

type JsonRecord = Record<string, unknown>;
type RequestId = string | number;

interface CodexRuntime {
  executable: string;
  socketPath: string;
  pid: number | null;
  configPath: string | null;
  threadId: string;
  sessionId: string;
  model: string | null;
  reasoning: string | null;
  serviceTier: string | null;
}

interface PendingServerRequest {
  id: RequestId;
  method: string;
  params: JsonRecord;
}

interface CodexChannel {
  processId: string;
  threadId: string;
  socketPath: string;
  client: CodexRpcClient | null;
  listeners: Set<(event: IntegratedConversationEvent) => void>;
  queue: CodexConversationEvent[];
  timer: NodeJS.Timeout | null;
  reconnect: NodeJS.Timeout | null;
  attempts: number;
  closed: boolean;
  off: () => void;
  state: CodexConversationState | null;
  // The cursor refresh in progress, shared by concurrent snapshot readers.
  cursorRefresh?: Promise<void> | undefined;
  ready: Promise<void>;
  seed: number;
  // Subagent thread -> the spawnAgent item that started it, for nesting.
  children: Map<string, string>;
  // Notification methods this channel does not project, for the debug log.
  unhandled: Record<string, number>;
  // Subagent rows already created, so a delta before item/started nests.
  childRows: Set<string>;
  // The agent thread's own status from its turn and thread notifications,
  // before running subagents and pending requests are counted.
  own: CodexStatus;
  // The effective status last queued for listeners.
  emitted: CodexStatus | null;
  // The agent thread reported a status since the seed began, so the seed's
  // native read is older and must not replace it.
  liveOwn: boolean;
  // Every subagent thread seen starting under this agent, nested or not.
  // They keep the agent working while they run; only `children` nest rows.
  descendants: Set<string>;
}

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5_000;
const RECONNECT_ATTEMPTS = 8;
const CODEX_OLDER_PAGE = 50;
const CODEX_CHILD_THREADS = 8;
// Notifications consumed outside the channel projection (turn tracking, usage,
// rate limits, and requests), so they are not reported as unhandled.
const CODEX_OBSERVED = new Set(['thread/tokenUsage/updated', 'account/rateLimits/updated', 'serverRequest/resolved', 'thread/started']);
// Patterm's own notifications for a request arriving and being answered.
const REQUEST_ARRIVED = 'server/request';
const REQUEST_ANSWERED = 'server/answered';
// A subagent thread's notifications that change whether it is running.
const THREAD_ACTIVITY = new Set(['turn/started', 'turn/completed', 'thread/status/changed']);
const CODEX_CHILD_ITEMS = 40;
// Codex creates the voice call upstream before answering the browser's offer.
const REALTIME_ANSWER_MS = 20_000;
// Newest subagent items the task drawer shows; the app-server caps a page at 100.
const CODEX_TASK_ITEMS = 100;

export class CodexAppServerService {
  // Threads that compacted, and app-servers reconnected after a drop, since
  // memory last reached them: either may have lost memory Patterm injected,
  // so their next update is the whole memory. Kept here, not on the
  // connection, so a reconnect cannot forget them.
  private readonly compactedThreads = new Set<string>();
  private readonly reconnectedSockets = new Set<string>();
  private readonly connectedSockets = new Set<string>();
  private readonly clients = new Map<string, CodexRpcClient>();
  private readonly models = new Map<string, string>();
  private readonly efforts = new Map<string, string>();
  // Speed chosen in the composer or with /fast; sent with every later turn.
  private readonly tiers = new Map<string, string>();
  // Collaboration mode chosen in the composer, sent with every later turn as
  // Codex's own TUI does. Plan mode is where Codex asks questions and proposes
  // a plan before editing.
  private readonly collaborationModes = new Map<string, CodexCollaborationMode>();
  // The proposed plan each agent last answered, so its card does not return.
  private readonly answeredPlans = new Map<string, string>();
  private readonly revisions = new Map<string, number>();
  private readonly channels = new Map<string, CodexChannel>();
  // Commands that outlived their tool call as background terminals, by item
  // id, with the Codex process id that stops them. Codex lists only running
  // terminals, so each is remembered to keep its row as a task after it exits.
  private readonly backgroundCommands = new Map<string, string>();
  private readonly modelLists = new WeakMap<CodexRpcClient, Promise<JsonRecord>>();
  private readonly configTiers = new WeakMap<CodexRpcClient, Promise<string | null>>();
  // Voice session listeners by Codex thread, kept across client reconnects.
  private readonly realtimeListeners = new Map<string, Set<(event: CodexRealtimeEvent) => void>>();
  private readonly mcpFailureListeners = new Set<(processId: string, failure: CodexMcpStartupFailure) => void>();
  // Codex retries a failed server on later turns; each agent reports it once.
  private readonly reportedMcpFailures = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly runtimeDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly nodePath = process.execPath,
    private readonly hostScript = path.resolve(__dirname, '../Runtime/CodexIntegratedHost.js'),
    // Request timeout is tunable so tests can model a lost reply without
    // waiting the full production timeout.
    private readonly options: { requestTimeoutMs?: number | undefined; launcher?: IntegratedHostLauncher; images?: TranscriptImageStore } = {}
  ) {}

  // Listed entries carry native item times when the producer recorded them.
  private readonly projectEntry = (entry: unknown): IntegratedConversationMessage[] => {
    const value = record(entry);
    const message = projectCodexItem(record(value.item), this.options.images);
    return message ? [{ ...message, ...codexTimes(value.startedAtMs, value.completedAtMs) }] : [];
  };

  async prepare(input: IntegratedLaunchInput): Promise<IntegratedLaunchResult> {
    const directory = path.join(this.runtimeDir, 'codex');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const key = randomUUID();
    const socketPath = path.join(directory, `${key}.sock`);
    // Codex's unix:// listener binds an AF_UNIX socket file on Windows, which
    // Node cannot connect to, so the host talks to app-server over stdio
    // there. Its own control socket still survives a Patterm restart.
    const appServerSocketPath = process.platform === 'win32' ? null : path.join(directory, `${key}-app.sock`);
    const logPath = path.join(directory, `${key}.log`);
    const overrides = [...globalCodexMcpOverrides(input.mcpServers ?? [], input.mcp), ...codexMcpOverrides(input.mcp)];
    const args = [
      '-c', 'approval_policy="on-request"',
      '-c', 'approvals_reviewer="auto_review"',
      ...overrides.flatMap((override) => ['-c', override]),
      ...(input.model ? ['-c', `model=${JSON.stringify(input.model)}`] : []),
      ...(input.reasoning ? ['-c', `model_reasoning_effort=${JSON.stringify(input.reasoning)}`] : []),
      ...(input.serviceTier ? ['-c', `service_tier=${JSON.stringify(input.serviceTier)}`] : []),
      'app-server', '--listen', appServerSocketPath ? `unix://${appServerSocketPath}` : 'stdio://'
    ];
    const configPath = path.join(directory, `${key}.json`);
    fs.writeFileSync(configPath, JSON.stringify({
      executable: input.executable, args, cwd: input.cwd, appServerSocketPath,
      controlSocketPath: socketPath, logPath
    }), { mode: 0o600 });
    const pid = await (this.options.launcher ?? detachedHostLauncher).launch({ harness: 'codex', key, nodePath: this.nodePath, script: this.hostScript, configPath, cwd: input.cwd, env: { ...this.env, ...CODEX_MCP_PROXY_ENV } });

    try {
      await waitForSocket(socketPath, pid);
      const client = await this.connect(socketPath);
      const response = await client.request(input.resumeId ? 'thread/resume' : 'thread/start', input.resumeId
        ? { threadId: input.resumeId, cwd: input.cwd, developerInstructions: input.context, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', excludeTurns: true, ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}) }
        : { cwd: input.cwd, developerInstructions: input.context, ephemeral: false, ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}) });
      const thread = record(record(response).thread);
      if (typeof thread.id !== 'string') throw new Error('Codex app-server did not return a thread ID');
      return {
        resumeId: thread.id,
        argv: [input.executable, 'app-server', socketPath, String(pid ?? ''), configPath]
      };
    } catch (error) {
      await stopHostProcess(pid);
      this.clients.get(socketPath)?.close();
      this.clients.delete(socketPath);
      const detail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().slice(-4_000) : '';
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `: ${detail}` : ''}`);
    }
  }

  async conversation(processId: string): Promise<unknown> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    const channel = this.channels.get(processId);
    if (channel) {
      // The subscribed path serves the projected state, so the snapshot and its
      // revision describe exactly the same boundary even while deltas arrive.
      await channel.ready;
      const state = channel.state;
      if (state?.cursorStale && !state.historyUnavailable) await this.refreshCursor(channel, client, runtime.threadId);
      // Events already received are applied first, so the snapshot never
      // reports a status older than the stream's.
      this.flushNow(channel);
      // Rows, cursor, and revision are read together before any later await:
      // a delta arriving meanwhile could otherwise evict the row the cursor
      // follows, and a reader paging back would skip it.
      const cursor = state?.cursor ?? null;
      const messages = [...(state?.messages ?? [])];
      const revision = state?.revision ?? this.revision(processId);
      const status = state?.status ?? 'unknown';
      const detail = state?.detail;
      const historyUnavailable = state?.historyUnavailable ?? false;
      const tasks = codexTasks(messages, client, await this.trackBackgroundTerminals(client, runtime.threadId, messages));
      const pending = client.pendingRequests();
      const plan = this.planApproval(processId, messages, !pending.length && (status === 'idle' || status === 'error'));
      return {
        process_id: processId,
        session_id: runtime.sessionId,
        provider_session_id: runtime.threadId,
        provider: 'codex',
        revision,
        history_truncated: Boolean(cursor),
        history_unavailable: historyUnavailable,
        history_cursor: cursor ? { next: cursor } : null,
        streaming: true,
        ...withPlan(pendingViews(pending, runtime.threadId, messages), plan),
        // Unknown until a native read says; the caller keeps what it had.
        status: snapshotStatus(pending, plan, status),
        ...(status === 'error' && detail ? { status_detail: detail } : {}),
        usage: client.usage(runtime.threadId),
        tasks,
        diagnostics: { unhandled: channel.unhandled },
        messages: { data: messages },
        mode: this.collaborationModes.get(processId) ?? 'default'
      };
    }
    const { response, unavailable } = await this.listItems(client, runtime.threadId);
    // Newest-first bounded read, reversed for chronological display. Pending
    // requests are read after the await so requests that arrived during the
    // read are included.
    const newest = Array.isArray(response.data) ? response.data : [];
    const entries = [...newest].reverse();
    const parentMessages = entries.flatMap(this.projectEntry);
    // Subagent rows are read before pending requests too, and approval cards
    // look up diffs across both.
    const spawned = spawnedThreads(parentMessages);
    const [childMessages, own] = await Promise.all([
      this.childMessages(client, spawned),
      this.ownStatus(client, runtime.threadId),
      this.readThreadStatuses(client, [...spawned.keys()])
    ]);
    const messages = [...parentMessages, ...childMessages];
    const pending = client.pendingRequests();
    const { status } = effectiveStatus(own, client, spawned.keys());
    const plan = this.planApproval(processId, messages, !pending.length && (status === 'idle' || status === 'error'));
    return {
      process_id: processId,
      session_id: runtime.sessionId,
      provider_session_id: runtime.threadId,
      provider: 'codex',
      revision: this.revision(processId),
      history_truncated: Boolean(nativeCursor(response)),
      history_unavailable: unavailable,
      history_cursor: nativeCursor(response) ? { next: nativeCursor(response) } : null,
      streaming: true,
      // A connection that has not seen this thread's turns reads them
      // natively; when that fails too, the caller keeps what it had.
      status: snapshotStatus(pending, plan, status),
      usage: client.usage(runtime.threadId),
      tasks: codexTasks(parentMessages, client, await this.trackBackgroundTerminals(client, runtime.threadId, parentMessages)),
      messages: { data: messages },
      mode: this.collaborationModes.get(processId) ?? 'default',
      ...withPlan(pendingViews(pending, runtime.threadId, messages), plan)
    };
  }

  // Readers that arrive while a refresh runs wait for the same one, so none
  // copies the trimmed window with the old cursor. A failed refresh leaves
  // the cursor stale for the next reader.
  private refreshCursor(channel: CodexChannel, client: CodexRpcClient, threadId: string): Promise<void> {
    channel.cursorRefresh ??= (async () => {
      const state = channel.state;
      if (!state) return;
      const { response } = await this.listItems(client, threadId);
      // Read after the await, so rows that arrived meanwhile are kept and
      // the rows the cursor follows are not lost.
      restoreCodexWindowGap(state, (Array.isArray(response.data) ? [...response.data].reverse() : []).flatMap(this.projectEntry));
      state.cursor = nativeCursor(response);
      state.cursorStale = false;
    })().finally(() => { channel.cursorRefresh = undefined; });
    return channel.cursorRefresh;
  }

  // Pages backwards from a snapshot's cursor, oldest page last.
  async olderMessages(processId: string, cursor: string): Promise<unknown> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    const response = record(await client.request('thread/items/list', {
      threadId: runtime.threadId, limit: CODEX_OLDER_PAGE, sortDirection: 'desc', cursor: parseNativeCursor(cursor)
    }));
    const newest = Array.isArray(response.data) ? response.data : [];
    return { messages: { data: [...newest].reverse().flatMap(this.projectEntry) }, cursor: nativeCursor(response) };
  }

  // Memory rides in hidden developer messages, which Codex keeps in the
  // thread and Patterm's transcripts never show. Compaction may drop them, so
  // the first update after one is the whole memory.
  async updateMemory(processId: string, update: MemoryUpdate): Promise<void> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    // A reconnect may have missed a compaction, so it refreshes too. The
    // markers are taken before the request, so a compaction reported while it
    // runs still refreshes the next update; a failed request puts them back.
    const compacted = this.compactedThreads.delete(runtime.threadId);
    const reconnected = this.reconnectedSockets.delete(runtime.socketPath);
    const text = compacted || reconnected ? update.snapshot() : update.changes;
    if (!text) return;
    try {
      await client.request('thread/inject_items', { threadId: runtime.threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }] });
    } catch (error) {
      if (compacted || reconnected) this.compactedThreads.add(runtime.threadId);
      throw error;
    }
  }

  async prompt(processId: string, input: ResolvedIntegratedPrompt): Promise<{ turnId: string }> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    const items: Array<Record<string, unknown>> = [];
    const text = promptText(input);
    if (text) items.push({ type: 'text', text, text_elements: [] });
    for (const attachment of input.attachments) {
      if (attachment.mime.startsWith('image/')) items.push({ type: 'localImage', path: attachment.path });
    }
    if (!items.length) throw new Error('Message is empty');
    await this.adoptThreadSettings(processId, runtime, client);
    const model = this.models.get(processId) ?? runtime.model;
    const effort = this.efforts.get(processId) ?? (this.models.has(processId) ? null : runtime.reasoning);
    const serviceTier = this.tiers.get(processId);
    // The mode's settings take precedence over the turn's model and effort;
    // null instructions keep Codex's built-in ones for the mode.
    const collaborationMode = {
      mode: this.collaborationModes.get(processId) ?? 'default',
      settings: { model: model ?? await this.defaultModel(client), reasoning_effort: effort ?? null, developer_instructions: null }
    };
    try {
      // clientUserMessageId is correlation only; Codex does not deduplicate.
      const response = record(await client.request('turn/start', {
        threadId: runtime.threadId,
        input: items,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...(collaborationMode.settings.model ? { collaborationMode } : {}),
        ...(input.messageId ? { clientUserMessageId: input.messageId } : {})
      }));
      const turn = record(response.turn);
      if (typeof turn.id !== 'string') throw new Error('Codex app-server did not start the turn');
      this.turnAccepted(processId, client, runtime.threadId, turn.id);
      return { turnId: turn.id };
    } catch (error) {
      if (isUncertainRpcFailure(error)) {
        throw new UncertainDeliveryError(error instanceof Error ? error.message : String(error), input.messageId);
      }
      const busy = notSteerableKind(error);
      if (busy) throw new TurnBusyError(error instanceof Error ? error.message : String(error), busy);
      throw error;
    }
  }

  // An accepted turn runs from now, though its turn/started may still be on
  // its way or in the batch, so the snapshot and stream say working at once.
  // A turn that already completed is not revived, and a thread waiting on
  // the user still waits.
  private turnAccepted(processId: string, client: CodexRpcClient, threadId: string, turnId: string): void {
    client.setActiveTurn(threadId, turnId);
    const channel = this.channels.get(processId);
    if (!channel || channel.closed || channel.client !== client) return;
    if (client.activeTurn(threadId) === turnId && channel.own.status !== 'working' && !awaitingUser(channel.own.status)) {
      channel.own = { status: 'working' };
      channel.liveOwn = true;
      this.updateStatus(channel);
    }
    this.flushNow(channel);
  }

  // Native evidence that an ambiguous turn was admitted. The bounded read can
  // only prove acceptance, never the absence of it.
  async reconcile(processId: string, messageId: string): Promise<IntegratedDeliveryState> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    const { response } = await this.listItems(client, runtime.threadId);
    const entries = Array.isArray(response.data) ? response.data : [];
    const admitted = entries.some((entry) => {
      const item = record(record(entry).item);
      return item.type === 'userMessage' && item.clientId === messageId;
    });
    return admitted ? 'accepted' : 'unknown';
  }

  // MCP servers that failed to start in an agent's thread. Integrated agents
  // never show Codex's own startup errors, so the agent just lacks the tools.
  onMcpStartupFailure(listener: (processId: string, failure: CodexMcpStartupFailure) => void): () => void {
    this.mcpFailureListeners.add(listener);
    return () => { this.mcpFailureListeners.delete(listener); };
  }

  private reportMcpFailure(processId: string, server: string, error: string): void {
    const key = `${processId}\0${server}`;
    if (this.reportedMcpFailures.has(key)) return;
    this.reportedMcpFailures.add(key);
    for (const listener of this.mcpFailureListeners) listener(processId, { server, error });
  }

  revision(processId: string): number {
    return this.revisions.get(processId) ?? 0;
  }

  // One native notification listener per process, shared by every client.
  // The channel projects events into a bounded state; snapshots are copies of
  // that state, so their revision matches their content.
  async subscribe(processId: string, listener: (event: IntegratedConversationEvent) => void): Promise<() => void> {
    const runtime = this.runtime(processId);
    let channel = this.channels.get(processId);
    if (!channel) {
      const client = await this.client(runtime);
      const created: CodexChannel = {
        processId,
        threadId: runtime.threadId,
        socketPath: runtime.socketPath,
        client,
        listeners: new Set(),
        queue: [],
        timer: null,
        reconnect: null,
        attempts: 0,
        closed: false,
        off: () => {},
        state: null,
        ready: Promise.resolve(),
        seed: 0,
        children: new Map(),
        unhandled: {},
        childRows: new Set(),
        own: { status: 'unknown' },
        emitted: null,
        liveOwn: false,
        descendants: new Set()
      };
      created.ready = this.seedChannel(created, client).catch((error: unknown) => {
        this.closeChannelObject(created);
        throw error;
      });
      this.channels.set(processId, created);
      channel = created;
    }
    await channel.ready;
    channel.listeners.add(listener);
    return () => {
      const current = this.channels.get(processId);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size) return;
      this.closeChannelObject(current);
      this.channels.delete(processId);
    };
  }

  // Reads the bounded native window into a projected state, then merges the
  // notifications that arrived while the read was in flight. Events sent after
  // the read are delivered normally; the merge keeps replaces and statuses and
  // drops ambiguous deltas, which completion replaces will restore in full.
  private async seedChannel(channel: CodexChannel, client: CodexRpcClient): Promise<void> {
    const generation = ++channel.seed;
    channel.client = client;
    channel.liveOwn = false;
    channel.off = client.onNotification((notification) => this.handleNotification(channel, notification));
    // Servers fail within a second of thread start, before the agent is observed.
    for (const [server, error] of client.mcpStartupFailures(channel.threadId)) this.reportMcpFailure(channel.processId, server, error);
    // Read status before the message snapshot. A delta delivered just after
    // the snapshot response must remain a live event, not be folded into the
    // seed while a second native request is still pending. A status that
    // streamed during the read is newer than it.
    const native = await this.nativeTurn(client, channel.threadId);
    if (channel.seed !== generation) return;
    if (!channel.liveOwn) {
      if (native.turnId !== undefined) client.setActiveTurn(channel.threadId, native.turnId);
      channel.own = { status: native.status };
    }
    const { response, unavailable } = await this.listItems(client, channel.threadId);
    if (channel.seed !== generation) return;
    const newest = Array.isArray(response.data) ? response.data : [];
    const entries = [...newest].reverse();
    const parentMessages = entries.flatMap(this.projectEntry);
    for (const [thread, item] of spawnedThreads(parentMessages)) channel.children.set(thread, item);
    const [childMessages] = await Promise.all([
      this.childMessages(client, channel.children),
      this.readThreadStatuses(client, descendantThreads(channel))
    ]);
    if (channel.seed !== generation) return;
    const cursor = nativeCursor(response);
    const state: CodexConversationState = {
      revision: this.revision(channel.processId),
      messages: [...parentMessages, ...childMessages],
      status: 'unknown',
      truncated: Boolean(cursor),
      historyUnavailable: unavailable,
      cursor
    };
    const queued = channel.queue;
    channel.queue = [];
    if (channel.timer) {
      clearTimeout(channel.timer);
      channel.timer = null;
    }
    mergeCodexSeedEvents(state, queued);
    // Everything received so far is in the channel and the client, so the
    // effective status replaces the statuses queued while it was unknown.
    const effective = effectiveStatus(channel.own, client, descendantThreads(channel));
    state.status = effective.status;
    state.detail = effective.detail;
    channel.emitted = effective.status === 'unknown' ? null : effective;
    channel.state = state;
  }

  private async listItems(client: CodexRpcClient, threadId: string): Promise<{ response: JsonRecord; unavailable: boolean }> {
    try {
      return {
        response: record(await client.request('thread/items/list', { threadId, limit: CODEX_MESSAGE_WINDOW, sortDirection: 'desc' })),
        unavailable: false
      };
    } catch (error) {
      // Codex 0.156.0 accepts app-server WebSocket requests but currently
      // returns this explicit error for the advertised transcript method.
      // Keep the live channel available and make missing history visible.
      if (error instanceof Error && error.message.includes('thread/items/list is not supported yet')) {
        // Codex 0.158 returns the same error for a new thread before its first
        // message. That thread has no history, which is not a missing feature.
        return { response: { data: [] }, unavailable: !(await this.unmaterialized(client, threadId)) };
      }
      throw error;
    }
  }

  private async unmaterialized(client: CodexRpcClient, threadId: string): Promise<boolean> {
    try {
      await client.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
      return false;
    } catch (error) {
      return error instanceof Error && error.message.includes('not materialized yet');
    }
  }

  // The thread's own status and in-progress turn. Only the newest turn can be
  // in progress; a one-turn page without items avoids hydrating the whole
  // thread, and builds without `thread/turns/list` fall back to the full
  // read. An undefined turn is not known, which is not the same as none.
  private async nativeTurn(client: CodexRpcClient, threadId: string): Promise<{ turnId?: string | null; status: CodexDeliveryStatus }> {
    try {
      const response = record(await client.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }));
      if (Array.isArray(response.data)) {
        const latest = response.data.map(record)[0];
        return latest?.status === 'inProgress' && typeof latest.id === 'string' ? { turnId: latest.id, status: 'working' } : { turnId: null, status: 'idle' };
      }
    } catch (error) {
      // A thread before its first message has no turn to be in progress.
      if (error instanceof Error && error.message.includes('not materialized yet')) return { turnId: null, status: 'idle' };
      // Only an app-server without the method needs the full thread read.
      // Newer builds warn that it is deprecated, so a timeout or other
      // failure uses the status-only read below.
      if (!(error instanceof Error && /not supported|unknown variant|method not found/i.test(error.message))) return this.threadState(client, threadId);
    }
    try {
      const response = record(await client.request('thread/read', { threadId, includeTurns: true }));
      const turns = record(response.thread).turns;
      if (!Array.isArray(turns)) return { status: 'unknown' };
      const active = turns.map(record).filter((turn) => turn.status === 'inProgress').at(-1);
      return typeof active?.id === 'string' ? { turnId: active.id, status: 'working' } : { turnId: null, status: 'idle' };
    } catch {
      return this.threadState(client, threadId);
    }
  }

  // The live thread status, which names no turn. An active thread is working
  // even when its turn list could not be read.
  private async threadState(client: CodexRpcClient, threadId: string): Promise<{ turnId?: null; status: CodexDeliveryStatus }> {
    try {
      const status = codexThreadStatus(record(record(await client.request('thread/read', { threadId, includeTurns: false })).thread).status) ?? 'unknown';
      return status === 'idle' ? { turnId: null, status } : { status };
    } catch { return { status: 'unknown' }; }
  }

  // The agent thread's own status as this connection knows it, read natively
  // when the connection has not seen the thread's turns.
  private async ownStatus(client: CodexRpcClient, threadId: string): Promise<CodexStatus> {
    const known = client.threadStatus(threadId);
    if (known) return { status: known };
    const native = await this.nativeTurn(client, threadId);
    if (native.turnId !== undefined && client.threadStatus(threadId) === null) client.setActiveTurn(threadId, native.turnId);
    return { status: client.threadStatus(threadId) ?? native.status };
  }

  // Subagent threads this connection has not seen run, read natively so a
  // restarted Patterm still counts the ones running. The newest few only.
  private async readThreadStatuses(client: CodexRpcClient, threads: string[]): Promise<void> {
    const unknown = threads.filter((thread) => client.threadStatus(thread) === null).slice(-CODEX_CHILD_THREADS);
    // An unreadable subagent does not keep the agent working.
    await Promise.all(unknown.map(async (thread) => {
      const { status } = await this.threadState(client, thread);
      if (status !== 'unknown') client.noteThreadStatus(thread, status);
    }));
  }

  private handleNotification(channel: CodexChannel, notification: { method: string; params: JsonRecord }): void {
    const { method, params } = notification;
    if (method === REQUEST_ARRIVED || method === REQUEST_ANSWERED || method === 'serverRequest/resolved') {
      this.enqueue(channel, { revision: 0, kind: 'pending' });
      this.updateStatus(channel);
      return;
    }
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    if (method === 'thread/started') {
      const thread = record(params.thread);
      if (typeof thread.id !== 'string' || typeof thread.parentThreadId !== 'string') return;
      // Nested subagents keep the agent working while they run.
      if (thread.parentThreadId === channel.threadId || isDescendant(channel, thread.parentThreadId)) {
        channel.descendants.add(thread.id);
        if (channel.descendants.size > 500) channel.descendants.delete(channel.descendants.values().next().value!);
        this.updateStatus(channel);
      }
      // A subagent thread may start before its spawnAgent item names it; nest
      // it under the newest spawn until the item does.
      if (thread.parentThreadId === channel.threadId && !channel.children.has(thread.id)) {
        const spawn = [...(channel.state?.messages ?? [])].reverse().find((message) => record(message.tool?.input).tool === 'spawnAgent' || isSubagentStart(message));
        if (spawn) channel.children.set(thread.id, spawn.id);
      }
      return;
    }
    if (threadId && threadId !== channel.threadId) {
      // A subagent still running after the agent's turn keeps it working,
      // and a thread's turn boundary settles its pending requests.
      if (THREAD_ACTIVITY.has(method)) this.updateStatus(channel);
      this.handleChildNotification(channel, threadId, method, params);
      return;
    }
    if (method === 'mcpServer/startupStatus/updated') {
      if (params.status === 'failed' && typeof params.name === 'string') this.reportMcpFailure(channel.processId, params.name, typeof params.error === 'string' ? params.error : '');
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const projected = projectCodexItem(params.item, this.options.images);
      const message = projected ? itemTimes(method, params, projected) : null;
      if (message) {
        const spawned = spawnedThreads([message]);
        for (const [thread, item] of spawned) channel.children.set(thread, item);
        this.enqueue(channel, { revision: 0, kind: 'replace', message });
        // A subagent may have reported running before its row named it.
        if (spawned.size) this.updateStatus(channel);
        // Only a snapshot carries the task list, so a task's row asks for one.
        if (message.tool?.name === 'subAgentActivity' || this.backgroundCommands.has(message.id)) this.enqueue(channel, { revision: 0, kind: 'pending' });
      }
      return;
    }
    if (method === 'item/fileChange/patchUpdated') {
      const message = projectCodexPatchUpdated(params);
      if (message) this.enqueue(channel, { revision: 0, kind: 'replace', message: firstSeen(message) });
      return;
    }
    if (method === 'turn/plan/updated') {
      const message = projectCodexPlan(params);
      if (message) this.enqueue(channel, { revision: 0, kind: 'replace', message: firstSeen(message) });
      return;
    }
    const delta = projectCodexDelta(method, params);
    if (delta) {
      if (delta.tool && !hasRow(channel, delta.id)) this.enqueue(channel, { revision: 0, kind: 'replace', message: codexOutputPlaceholder(delta.id, delta.tool, delta.delta) });
      else this.enqueue(channel, { revision: 0, kind: 'append', id: delta.id, delta: delta.delta });
      return;
    }
    const status = projectCodexStatus(method, params);
    if (status) {
      // A thread-level idle report cannot complete a known active turn.
      // Keep the projected snapshot consistent with the RPC client's state.
      if (method === 'thread/status/changed' && status.status === 'idle' && channel.client?.activeTurn(channel.threadId)) status.status = 'working';
      channel.own = status;
      channel.liveOwn = true;
      // A turn's end is announced even while running subagents keep the
      // status unchanged: held prompts wait for it, and the snapshot (its
      // tasks, a proposed plan) is read again.
      this.updateStatus(channel, status.status === 'idle' || status.status === 'error');
      if (status.status !== 'working') this.enqueue(channel, { revision: 0, kind: 'pending' });
      return;
    }
    if (method === 'error') {
      const notice = projectCodexError(params);
      if (notice) this.enqueue(channel, { revision: 0, kind: 'replace', message: firstSeen(notice) });
      return;
    }
    const notice = projectCodexNotice(method, params);
    if (notice) this.enqueue(channel, { revision: 0, kind: 'replace', message: firstSeen(notice) });
    else if (!CODEX_OBSERVED.has(method) && !method.startsWith('thread/realtime/') && (Object.keys(channel.unhandled).length < 100 || channel.unhandled[method] !== undefined)) {
      channel.unhandled[method] = (channel.unhandled[method] ?? 0) + 1;
    }
  }

  // Subagent threads contribute rows nested under the item that spawned them.
  // Their turn and status changes are theirs alone and never settle the
  // parent's turn.
  private handleChildNotification(channel: CodexChannel, threadId: string, method: string, params: JsonRecord): void {
    const parentId = channel.children.get(threadId);
    if (!parentId) return;
    // A subagent's own turn decides whether its task is running.
    if (method === 'turn/started' || method === 'turn/completed') {
      this.enqueue(channel, { revision: 0, kind: 'pending' });
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const projected = projectCodexItem(params.item, this.options.images);
      const message = projected ? itemTimes(method, params, projected) : null;
      if (message) {
        channel.childRows.add(message.id);
        this.enqueue(channel, { revision: 0, kind: 'replace', message: { ...message, parentId } });
      }
      return;
    }
    if (method === 'item/fileChange/patchUpdated') {
      const message = projectCodexPatchUpdated(params);
      if (message) {
        channel.childRows.add(message.id);
        this.enqueue(channel, { revision: 0, kind: 'replace', message: { ...firstSeen(message), parentId } });
      }
      return;
    }
    const delta = projectCodexDelta(method, params);
    if (!delta) return;
    // A delta that arrives before its item starts would otherwise create an
    // unnested row in the main transcript.
    if (channel.childRows.has(delta.id) || hasRow(channel, delta.id)) {
      this.enqueue(channel, { revision: 0, kind: 'append', id: delta.id, delta: delta.delta });
    } else {
      channel.childRows.add(delta.id);
      const message = delta.tool
        ? codexOutputPlaceholder(delta.id, delta.tool, delta.delta, parentId)
        : { id: delta.id, role: 'assistant' as const, kind: 'text' as const, text: delta.delta, parentId, createdAt: new Date().toISOString() };
      this.enqueue(channel, { revision: 0, kind: 'replace', message });
    }
    if (channel.childRows.size > 2_000) channel.childRows.delete(channel.childRows.values().next().value!);
  }

  // Recent rows of each spawned thread, so nesting survives a reload. Bounded:
  // the newest few threads and their newest items.
  private async childMessages(client: CodexRpcClient, children: Map<string, string>): Promise<IntegratedConversationMessage[]> {
    const threads = [...children].slice(-CODEX_CHILD_THREADS);
    const pages = await Promise.all(threads.map(async ([thread, parentId]) => {
      try {
        const response = record(await client.request('thread/items/list', { threadId: thread, limit: CODEX_CHILD_ITEMS, sortDirection: 'desc' }));
        const newest = Array.isArray(response.data) ? response.data : [];
        return [...newest].reverse().flatMap(this.projectEntry).map((message) => ({ ...message, parentId }));
      } catch { return []; }
    }));
    return pages.flat();
  }

  // Queues the effective status when it changes. An unknown status is never
  // streamed: listeners keep what they had.
  private updateStatus(channel: CodexChannel, announce = false): void {
    const next = effectiveStatus(channel.own, channel.client, descendantThreads(channel));
    const last = channel.emitted;
    if (next.status === 'unknown' || (!announce && last?.status === next.status && last.detail === next.detail)) return;
    channel.emitted = next;
    this.enqueue(channel, { revision: 0, kind: 'status', status: next.status, ...(next.detail ? { detail: next.detail } : {}) });
  }

  // Delivers queued events at once, so a snapshot or a caller never sees an
  // older state than the connection already received.
  private flushNow(channel: CodexChannel): void {
    if (!channel.state || !channel.queue.length) return;
    if (channel.timer) clearTimeout(channel.timer);
    this.flush(channel);
  }

  private enqueue(channel: CodexChannel, event: CodexConversationEvent): void {
    // One re-read per batch, after everything else in it.
    if (event.kind === 'pending') channel.queue = channel.queue.filter((queued) => queued.kind !== 'pending');
    channel.queue.push(event);
    if (channel.timer) return;
    channel.timer = setTimeout(() => this.flush(channel), 40);
  }

  private flush(channel: CodexChannel): void {
    channel.timer = null;
    // While the seed read is in flight the queue belongs to the merge step.
    if (!channel.state || !channel.queue.length) return;
    const queued = channel.queue;
    channel.queue = [];
    for (const event of queued) {
      const revision = (this.revisions.get(channel.processId) ?? 0) + 1;
      this.revisions.set(channel.processId, revision);
      const known = event.kind === 'replace' && event.message ? channel.state.messages.find((message) => message.id === event.message!.id) : undefined;
      // Clients get the row's start time even on the completion replace, and
      // a tool's start does not wipe output that streamed in before it.
      const keepOutput = known?.text && event.message?.kind === 'tool' && !event.message.text;
      const delivered: IntegratedConversationEvent = {
        ...event,
        ...(event.kind === 'replace' && event.message ? { message: keepCodexTimes(known, keepOutput ? { ...event.message, text: known.text } : event.message) } : {}),
        revision,
        processId: channel.processId
      };
      applyCodexConversationEvent(channel.state, delivered);
      channel.state.revision = revision;
      for (const listener of channel.listeners) listener(delivered);
    }
  }

  async controls(processId: string): Promise<IntegratedControls> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    const [response, configTier] = await Promise.all([this.modelList(client), this.configTier(client), this.adoptThreadSettings(processId, runtime, client)]);
    const models = (Array.isArray(response.data) ? response.data : []).flatMap((value) => {
      const model = record(value);
      const id = typeof model.id === 'string' ? model.id : typeof model.model === 'string' ? model.model : null;
      return id ? [{ value: id, label: typeof model.displayName === 'string' ? model.displayName : id }] : [];
    });
    const defaultModel = (Array.isArray(response.data) ? response.data : []).map(record).find((model) => model.isDefault === true);
    const selectedModel = this.models.get(processId) ?? runtime.model ?? String(defaultModel?.id ?? defaultModel?.model ?? models[0]?.value ?? '');
    const selectedMetadata = (Array.isArray(response.data) ? response.data : []).map(record)
      .find((model) => (model.id ?? model.model) === selectedModel);
    const efforts = (Array.isArray(selectedMetadata?.supportedReasoningEfforts) ? selectedMetadata.supportedReasoningEfforts : [])
      .map(record).flatMap((option) => typeof option.reasoningEffort === 'string'
        ? [{ value: option.reasoningEffort, label: option.reasoningEffort[0]!.toUpperCase() + option.reasoningEffort.slice(1) }]
        : []);
    const tiers = (Array.isArray(selectedMetadata?.serviceTiers) ? selectedMetadata.serviceTiers : []).map(record)
      .flatMap((tier) => typeof tier.id === 'string' && tier.id !== 'default'
        ? [{ value: tier.id, label: typeof tier.name === 'string' && tier.name ? tier.name : tier.id }]
        : []);
    const speeds = tiers.length ? [{ value: 'default', label: 'Standard' }, ...tiers] : [];
    // Codex still accepts the older `fast` alias for its first faster tier.
    const tierValue = (value: unknown) => typeof value !== 'string' ? null
      : speeds.some((option) => option.value === value) ? value : value === 'fast' ? tiers[0]?.value ?? null : null;
    return {
      selectors: [
        ...(models.length ? [{ id: 'model', label: 'Model', value: selectedModel, options: models }] : []),
        ...(efforts.length ? [{ id: 'effort', label: 'Thinking', value: this.efforts.get(processId)
          ?? (this.models.has(processId) ? null : runtime.reasoning)
          ?? String(selectedMetadata?.defaultReasoningEffort ?? efforts[0]!.value), options: efforts }] : []),
        ...(speeds.length ? [{ id: 'speed', label: 'Speed', value: tierValue(this.tiers.get(processId)) ?? tierValue(runtime.serviceTier)
          ?? tierValue(configTier) ?? tierValue(selectedMetadata?.defaultServiceTier) ?? 'default', options: speeds }] : []),
        { id: 'mode', label: 'Mode', value: this.collaborationModes.get(processId) ?? 'default', options: CODEX_MODES }
      ],
      commands: [
        { name: 'compact', description: 'Compact the current conversation' },
        ...(speeds.length ? [{ name: 'fast', description: 'Toggle Fast mode, or pass on or off' }] : []),
        { name: 'review', description: 'Review uncommitted changes, or base <branch>, commit <sha>, or instructions' },
        { name: 'undo', description: 'Remove the latest turn from the conversation history (files are not reverted)' },
        { name: 'rename', description: 'Rename the thread' },
        { name: 'goal', description: 'Set the thread goal' },
        { name: 'shell', description: 'Run a shell command outside the sandbox' }
      ]
    };
  }

  // Picks are kept in memory, so after a Patterm restart the picker would fall
  // back to the launch or catalogue default, and the next turn would switch
  // the thread to it. Codex keeps the model and effort the last turn ran with
  // on the thread, so those are the starting point instead. A failed read
  // keeps the launch settings.
  private async adoptThreadSettings(processId: string, runtime: CodexRuntime, client: CodexRpcClient): Promise<void> {
    if (this.models.has(processId)) return;
    const response = await client.request('thread/read', { threadId: runtime.threadId, includeTurns: false }).catch(() => null);
    const thread = record(record(response).thread);
    if (this.models.has(processId) || typeof thread.model !== 'string' || !thread.model) return;
    this.models.set(processId, thread.model);
    if (typeof thread.reasoningEffort === 'string' && thread.reasoningEffort && !this.efforts.has(processId)) this.efforts.set(processId, thread.reasoningEffort);
  }

  // The model catalogue is treated as fixed for one connection. A restarted
  // or reconnected app-server gets a new client and therefore a fresh read.
  private modelList(client: CodexRpcClient): Promise<JsonRecord> {
    let list = this.modelLists.get(client);
    if (!list) {
      list = client.request('model/list', { includeHidden: false }).then(record);
      this.modelLists.set(client, list);
      list.catch(() => { if (this.modelLists.get(client) === list) this.modelLists.delete(client); });
    }
    return list;
  }

  // The model a turn runs on when none was chosen; a collaboration mode must
  // name one.
  private async defaultModel(client: CodexRpcClient): Promise<string | null> {
    const list = (await this.modelList(client)).data;
    const models = (Array.isArray(list) ? list : []).map(record);
    const model = models.find((item) => item.isDefault === true) ?? models[0];
    const id = model?.id ?? model?.model;
    return typeof id === 'string' ? id : null;
  }

  // The tier the app-server was configured with, including a preset's launch
  // override. A failed read only loses the picker's starting value.
  private configTier(client: CodexRpcClient): Promise<string | null> {
    let tier = this.configTiers.get(client);
    if (!tier) {
      tier = client.request('config/read', {}).then((response) => {
        const value = record(record(response).config).service_tier;
        return typeof value === 'string' ? value : null;
      }, () => null);
      this.configTiers.set(client, tier);
    }
    return tier;
  }

  async configure(processId: string, selector: string, value: string): Promise<void> {
    if (selector === 'mode') {
      if (value !== 'default' && value !== 'plan') throw new Error('Unknown Codex mode');
      this.collaborationModes.set(processId, value);
      return;
    }
    if (selector !== 'model' && selector !== 'effort' && selector !== 'speed') throw new Error('Unknown Codex setting');
    const option = (await this.controls(processId)).selectors.find((item) => item.id === selector);
    if (!option?.options.some((item) => item.value === value)) throw new Error(`Unknown Codex ${selector}`);
    if (selector === 'model') {
      this.models.set(processId, value);
      this.efforts.delete(processId);
    } else if (selector === 'speed') this.tiers.set(processId, value);
    else this.efforts.set(processId, value);
  }

  async compact(processId: string): Promise<unknown> {
    const runtime = this.runtime(processId);
    return (await this.client(runtime)).request('thread/compact/start', { threadId: runtime.threadId });
  }

  // Codex records when each turn started, and a running turn is activity
  // now. Transcript rows without a native time carry the host's clock from
  // when it first saw them.
  async lastActivity(processId: string): Promise<number | null> {
    const runtime = this.runtime(processId);
    const turn = await this.latestTurn(await this.client(runtime), runtime.threadId);
    if (turn.status === 'inProgress') return Date.now();
    return typeof turn.startedAt === 'number' ? turn.startedAt * 1000 : null;
  }

  private async latestTurn(client: CodexRpcClient, threadId: string): Promise<JsonRecord> {
    const latest = record(await client.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }));
    return Array.isArray(latest.data) ? record(latest.data[0]) : {};
  }

  async command(processId: string, name: string, text: string): Promise<unknown> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    const argument = text.trim();
    if (name === 'compact') return this.compact(processId);
    if (name === 'fast') {
      const speed = (await this.controls(processId)).selectors.find((item) => item.id === 'speed');
      const fast = speed?.options.find((item) => item.value !== 'default');
      if (!speed || !fast) throw new Error('This model has no Fast mode');
      const mode = argument.toLowerCase();
      if (mode && mode !== 'on' && mode !== 'off') throw new Error('Use /fast, /fast on, or /fast off');
      const enable = mode ? mode === 'on' : speed.value === 'default';
      this.tiers.set(processId, enable ? fast.value : 'default');
      return { speed: enable ? fast.value : 'default' };
    }
    if (name === 'review') return client.request('review/start', { threadId: runtime.threadId, target: reviewTarget(argument), delivery: 'inline' });
    if (name === 'rename') {
      if (!argument) throw new Error('Give the new name after /rename');
      return client.request('thread/name/set', { threadId: runtime.threadId, name: argument });
    }
    if (name === 'goal') {
      if (!argument) throw new Error('Describe the goal after /goal');
      return client.request('thread/goal/set', { threadId: runtime.threadId, objective: argument });
    }
    if (name === 'shell') {
      if (!argument) throw new Error('Give a shell command after /shell');
      return client.request('thread/shellCommand', { threadId: runtime.threadId, command: argument });
    }
    if (name === 'undo') {
      const turn = await this.latestTurn(client, runtime.threadId);
      if (typeof turn.id !== 'string') throw new Error('There is no turn to undo');
      if (turn.status === 'inProgress') throw new Error('Stop the running turn before undoing it');
      const result = await client.request('thread/revert', { threadId: runtime.threadId, beforeTurnId: turn.id });
      // The history changed underneath the live projection; read it again.
      const channel = this.channels.get(processId);
      if (channel && !channel.closed) this.reattach(channel, client);
      return result;
    }
    throw new Error('Unknown Codex slash command');
  }

  // Codex never generates local thread names; this reports a native rename
  // (thread/name/set) from any client.
  async title(processId: string, _prompt: string): Promise<string | null> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    const name = record(record(await client.request('thread/read', { threadId: runtime.threadId, includeTurns: false })).thread).name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  }

  // Experimental GPT-Live voice (realtime v3 over WebRTC). The client owns the
  // peer connection and its media; Codex creates the call with the user's
  // ChatGPT sign-in and returns the answer, then delegates work to this thread.
  // Voice profile options pass through as given; omitted ones keep Codex's defaults.
  async realtimeStart(processId: string, input: { sdp: string; voice?: string | null; options?: RealtimeVoiceOptions; initialItems?: RealtimeInitialItem[] }): Promise<{ sdp: string }> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    let off = () => {};
    const answer = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex did not answer the voice call')), REALTIME_ANSWER_MS);
      off = client.onNotification(({ method, params }) => {
        if (params.threadId !== runtime.threadId) return;
        if (method === 'thread/realtime/sdp' && typeof params.sdp === 'string') {
          clearTimeout(timer);
          resolve(params.sdp);
        } else if (method === 'thread/realtime/error') {
          clearTimeout(timer);
          reject(new Error(realtimeErrorMessage(params.message)));
        }
      });
    });
    answer.catch(() => undefined);
    try {
      const response = record(await client.request('thread/realtime/start', {
        threadId: runtime.threadId,
        outputModality: 'audio',
        version: 'v3',
        includeStartupContext: false,
        transport: { type: 'webrtc', sdp: input.sdp },
        ...(input.voice ? { voice: input.voice } : {}),
        ...(input.initialItems?.length ? { initialItems: input.initialItems } : {}),
        ...input.options
      }));
      return { sdp: typeof response.sdp === 'string' ? response.sdp : await answer };
    } finally {
      off();
    }
  }

  async realtimeStop(processId: string): Promise<void> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    await client.request('thread/realtime/stop', { threadId: runtime.threadId });
  }

  // Text the voice model hears as context, such as a notification to announce.
  async realtimeAppendText(processId: string, text: string): Promise<void> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    await client.request('thread/realtime/appendText', { threadId: runtime.threadId, text, role: 'user' });
  }

  // thread/realtime/* notifications for one agent's thread.
  onRealtime(processId: string, listener: (event: CodexRealtimeEvent) => void): () => void {
    const { threadId } = this.runtime(processId);
    const listeners = this.realtimeListeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.realtimeListeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.realtimeListeners.delete(threadId);
    };
  }

  private dispatchRealtime({ method, params }: { method: string; params: JsonRecord }): void {
    if (!method.startsWith('thread/realtime/') || typeof params.threadId !== 'string') return;
    for (const listener of this.realtimeListeners.get(params.threadId) ?? []) listener({ method, params });
  }

  async interrupt(processId: string): Promise<void> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    const turnId = client.activeTurn(runtime.threadId) ?? (await this.nativeTurn(client, runtime.threadId)).turnId;
    if (turnId) await client.request('turn/interrupt', { threadId: runtime.threadId, turnId });
  }

  // A subagent thread is stopped by interrupting its own active turn; a
  // background terminal by terminating its process.
  async stopTask(processId: string, taskId: string): Promise<void> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    const terminal = this.backgroundCommands.get(taskId);
    if (terminal) {
      await client.request('thread/backgroundTerminals/terminate', { threadId: runtime.threadId, processId: terminal });
      return;
    }
    const turnId = client.activeTurn(taskId);
    if (taskId === runtime.threadId || !turnId) throw new Error('That subagent has no running turn');
    await client.request('turn/interrupt', { threadId: taskId, turnId });
  }

  // A subagent's own items, or a background terminal's output. A subagent
  // thread must be one this agent spawned; its rollout also holds a copy of
  // the parent's history, which the app-server leaves out.
  async taskOutput(processId: string, taskId: string, since?: string | null, cursor?: string | null): Promise<IntegratedTaskOutput> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    if (this.backgroundCommands.has(taskId)) return this.terminalOutput(processId, runtime, client, taskId, since);
    const thread = record(record(await client.request('thread/read', { threadId: taskId, includeTurns: false })).thread);
    if (taskId === runtime.threadId || thread.parentThreadId !== runtime.threadId) throw new Error('That subagent does not belong to this session');
    const response = record(await client.request('thread/items/list', {
      threadId: taskId, limit: CODEX_TASK_ITEMS, sortDirection: 'desc', ...(cursor ? { cursor: parseNativeCursor(cursor) } : {})
    }));
    const newest = Array.isArray(response.data) ? response.data : [];
    return messagesTaskOutput([...newest].reverse().flatMap(this.projectEntry), nativeCursor(response), since);
  }

  // The command's row carries its output: Codex streams a background
  // terminal's output into the item that started it until the process exits.
  private async terminalOutput(processId: string, runtime: CodexRuntime, client: CodexRpcClient, itemId: string, since?: string | null): Promise<IntegratedTaskOutput> {
    const live = this.channels.get(processId)?.state?.messages;
    const messages = live ?? (await this.listItems(client, runtime.threadId)).response.data;
    const row = (live ?? (Array.isArray(messages) ? messages : []).flatMap(this.projectEntry)).find((message) => message.id === itemId);
    if (!row) return { format: 'missing', version: null };
    const input = record(row.tool?.input);
    const exit = typeof input.exitCode === 'number' && row.tool?.state !== 'inProgress' ? `\n[exited with code ${input.exitCode}]\n` : '';
    return textTaskOutput(`${row.text}${exit}`, false, since);
  }

  // Records which running terminals are in the background. While the agent's
  // turn runs, a command stays in the foreground until the agent moves past it.
  private async trackBackgroundTerminals(client: CodexRpcClient, threadId: string, messages: IntegratedConversationMessage[]): Promise<Map<string, string>> {
    let terminals: JsonRecord[] = [];
    try {
      const response = record(await client.request('thread/backgroundTerminals/list', { threadId }));
      terminals = Array.isArray(response.data) ? response.data.map(record) : [];
    } catch {
      // Builds without the experimental method report no background terminals.
    }
    const active = Boolean(client.activeTurn(threadId));
    for (const terminal of terminals) {
      const item = typeof terminal.itemId === 'string' ? terminal.itemId : '';
      const processId = typeof terminal.processId === 'string' ? terminal.processId : '';
      const index = messages.findIndex((message) => message.id === item);
      if (!item || !processId || (active && (index < 0 || index === messages.length - 1))) continue;
      this.backgroundCommands.delete(item);
      this.backgroundCommands.set(item, processId);
      if (this.backgroundCommands.size > 500) this.backgroundCommands.delete(this.backgroundCommands.keys().next().value!);
    }
    return this.backgroundCommands;
  }

  async replyPermission(processId: string, requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    const runtime = this.runtime(processId);
    if (requestId.startsWith(PLAN_REQUEST_PREFIX)) {
      await this.replyPlan(processId, requestId.slice(PLAN_REQUEST_PREFIX.length), reply !== 'reject', message?.trim() ?? '');
      return;
    }
    const client = await this.client(runtime);
    const request = client.pending(requestId);
    if (!request || !isApproval(request.method)) throw new Error('Codex permission request is no longer pending');
    let result: unknown;
    if (request.method === 'item/permissions/requestApproval') {
      result = { permissions: reply === 'reject' ? {} : record(request.params.permissions), scope: reply === 'always' ? 'session' : 'turn' };
    } else if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
      result = { decision: reply === 'reject' ? 'decline' : reply === 'always' ? 'acceptForSession' : 'accept' };
    } else {
      result = reply === 'reject' ? { denied: { rejection: 'Rejected by user' } } : reply === 'always' ? 'approved_for_session' : 'approved';
    }
    client.respond(request.id, result);
  }

  // Codex's TUI asks whether to implement a proposed plan; approving leaves
  // Plan mode and asks Codex to implement it. Keeping planning sends the note,
  // if any, as the next Plan mode prompt.
  private async replyPlan(processId: string, planId: string, approved: boolean, note: string): Promise<void> {
    if (this.answeredPlans.get(processId) === planId) throw new Error('This plan was already answered');
    this.answeredPlans.set(processId, planId);
    const channel = this.channels.get(processId);
    if (channel) this.enqueue(channel, { revision: 0, kind: 'pending' });
    if (approved) {
      this.collaborationModes.set(processId, 'default');
      await this.prompt(processId, { text: note ? `Implement the plan. ${note}` : 'Implement the plan.', references: [], attachments: [] });
    } else if (note) await this.prompt(processId, { text: note, references: [], attachments: [] });
  }

  // A plan proposed in Plan mode waits for an answer once its turn ends,
  // until a later prompt or a reply settles it.
  private planApproval(processId: string, messages: IntegratedConversationMessage[], idle: boolean): JsonRecord[] {
    if (!idle || this.collaborationModes.get(processId) !== 'plan') return [];
    let plan: IntegratedConversationMessage | undefined;
    for (let index = messages.length - 1; index >= 0 && messages[index]!.role !== 'user'; index -= 1) {
      const message = messages[index]!;
      if (message.title === CODEX_PLAN_TITLE && !message.parentId) {
        plan = message;
        break;
      }
    }
    if (!plan?.text.trim() || this.answeredPlans.get(processId) === plan.id) return [];
    return [{
      id: `${PLAN_REQUEST_PREFIX}${plan.id}`, action: 'Implement this plan?', resources: [], plan: plan.text, feedback: true,
      always: false, once_label: 'Yes, implement it', reject_label: 'No, keep planning'
    }];
  }

  async replyQuestion(processId: string, requestId: string, answers: string[][]): Promise<void> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    const request = client.pending(requestId);
    if (!request || request.method !== 'item/tool/requestUserInput') throw new Error('Codex question is no longer pending');
    const questions = Array.isArray(request.params.questions) ? request.params.questions : [];
    if (answers.length !== questions.length) throw new Error('Provide one answer for every question');
    const answerMap: Record<string, { answers: string[] }> = {};
    for (const [index, question] of questions.entries()) {
      const id = record(question).id;
      if (typeof id === 'string') answerMap[id] = { answers: answers[index] ?? [] };
    }
    client.respond(request.id, { answers: answerMap });
  }

  async replyForm(processId: string, formId: string, answer: Record<string, unknown>, action: IntegratedFormAction = 'accept'): Promise<void> {
    const runtime = this.runtime(processId);
    const client = await this.client(runtime);
    const request = client.pending(formId);
    if (!request || request.method !== ELICITATION) throw new Error('Codex input request is no longer pending');
    const content = action === 'accept' ? elicitationContent(elicitationView(request), answer) : null;
    client.respond(request.id, { action, content, _meta: null });
  }

  async stop(processId: string): Promise<void> {
    this.closeChannel(processId);
    const runtime = this.runtime(processId);
    this.clients.get(runtime.socketPath)?.close();
    this.clients.delete(runtime.socketPath);
    await stopRecordedHostProcess(runtime.pid, runtime.socketPath);
    try { fs.unlinkSync(runtime.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    removeForcedHostConfig(runtime.configPath);
  }

  async cleanupLaunch(_input: IntegratedLaunchInput, result: IntegratedLaunchResult): Promise<void> {
    await stopRuntime(result.argv);
  }

  async stopAll(): Promise<void> {
    const rows = this.database.connection.prepare(`
      select processes.id from processes join sessions on sessions.process_id = processes.id
      where sessions.harness = 'codex' and sessions.interface_mode = 'integrated' and sessions.exited_at is null
    `).all() as Array<{ id: string }>;
    const results = await Promise.allSettled(rows.map(async (row) => { await this.interrupt(row.id); await this.stop(row.id); }));
    // Also stop hosts whose sessions were already reconciled as failed.
    results.push(...await Promise.allSettled([(this.options.launcher ?? detachedHostLauncher).stopAll('codex')]));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'Could not stop every Codex app-server');
  }

  disconnect(): void {
    for (const channel of this.channels.values()) this.closeChannelObject(channel);
    this.channels.clear();
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }

  private closeChannel(processId: string): void {
    const channel = this.channels.get(processId);
    if (!channel) return;
    this.closeChannelObject(channel);
    this.channels.delete(processId);
  }

  private closeChannelObject(channel: CodexChannel): void {
    channel.closed = true;
    channel.seed++;
    channel.off();
    if (channel.timer) clearTimeout(channel.timer);
    if (channel.reconnect) clearTimeout(channel.reconnect);
    channel.timer = null;
    channel.reconnect = null;
    channel.queue = [];
    channel.state = null;
  }

  private runtime(processId: string): CodexRuntime {
    const row = this.database.connection.prepare(`
      select processes.argv, sessions.resume_id, sessions.id as session_id, sessions.model, sessions.reasoning, sessions.service_tier
      from sessions join processes on processes.id = sessions.process_id
      where (sessions.process_id = ? or sessions.id = ?) and sessions.harness = 'codex'
        and sessions.interface_mode = 'integrated' and sessions.resume_id is not null
      order by sessions.exited_at is null desc, sessions.started_at desc limit 1
    `).get(processId, processId) as { argv: string; resume_id: string; session_id: string; model: string | null; reasoning: string | null; service_tier: string | null } | undefined;
    if (!row) throw new Error('Codex Integrated session not found');
    const argv = JSON.parse(row.argv) as unknown;
    if (!Array.isArray(argv) || argv[1] !== 'app-server' || typeof argv[0] !== 'string' || typeof argv[2] !== 'string') {
      throw new Error('Codex Integrated runtime metadata is invalid');
    }
    const pid = typeof argv[3] === 'string' && /^\d+$/.test(argv[3]) ? Number(argv[3]) : null;
    return { executable: argv[0], socketPath: argv[2], pid, configPath: typeof argv[4] === 'string' ? argv[4] : null, threadId: row.resume_id, sessionId: row.session_id, model: row.model, reasoning: row.reasoning, serviceTier: row.service_tier };
  }

  private async client(runtime: CodexRuntime): Promise<CodexRpcClient> {
    const existing = this.clients.get(runtime.socketPath);
    if (existing?.connected) return existing;
    return this.connect(runtime.socketPath);
  }

  private async connect(socketPath: string): Promise<CodexRpcClient> {
    const existing = this.clients.get(socketPath);
    if (existing?.connected) return existing;
    if (existing) this.clients.delete(socketPath);
    let client: CodexRpcClient;
    client = await CodexRpcClient.connect(socketPath, () => {
      // Only retire this client; a reconnect may already have replaced it.
      if (this.clients.get(socketPath) === client) this.clients.delete(socketPath);
      this.onClientClosed(socketPath);
    }, this.options.requestTimeoutMs ?? 15_000);
    this.clients.set(socketPath, client);
    if (this.connectedSockets.has(socketPath)) this.reconnectedSockets.add(socketPath);
    this.connectedSockets.add(socketPath);
    client.onNotification((notification) => {
      const threadId = notification.params.threadId;
      if (typeof threadId === 'string' && (notification.method === 'thread/compacted' || (notification.method === 'item/completed' && record(notification.params.item).type === 'contextCompaction'))) this.compactedThreads.add(threadId);
      this.dispatchRealtime(notification);
    });
    await client.request('initialize', {
      clientInfo: { name: 'patterm-desktop', title: 'Patterm', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false }
    }).catch((error: unknown) => {
      // The host keeps one app-server connection for its whole life, so after
      // a server restart that connection is already initialised.
      if (!(error instanceof Error && error.message === 'Already initialized')) throw error;
    });
    // A reconnected app-server has no knowledge of what was missed. Re-seed
    // every channel bound to this socket so the projected state catches up, and
    // let subscribers refresh from it.
    for (const channel of this.channels.values()) {
      if (channel.socketPath === socketPath) this.reattach(channel, client);
    }
    return client;
  }

  private reattach(channel: CodexChannel, client: CodexRpcClient): void {
    if (channel.closed) return;
    const previous = channel.state;
    channel.off();
    channel.client = client;
    channel.state = null;
    channel.queue = [];
    if (channel.timer) {
      clearTimeout(channel.timer);
      channel.timer = null;
    }
    if (channel.reconnect) {
      clearTimeout(channel.reconnect);
      channel.reconnect = null;
    }
    channel.ready = this.seedChannel(channel, client)
      .then(() => {
        channel.attempts = 0;
        if (!channel.listeners.size || !channel.state) return;
        // Listeners missed whatever changed while the stream was down.
        this.updateStatus(channel, true);
        this.enqueue(channel, { revision: 0, kind: 'pending' });
      })
      .catch(() => {
        // Losing the stream must not blank a visible transcript; keep the last
        // projection until a later reconnect reseeds it. Its status may be
        // stale by now, so snapshots stop reporting one until a live status.
        channel.state = previous ? { ...previous, status: 'unknown', detail: undefined } : previous;
        channel.own = { status: 'unknown' };
        channel.emitted = null;
        channel.queue = [];
        this.scheduleReconnect(channel);
      });
  }

  // A dropped native connection is announced to subscribers immediately, then
  // reconnected with bounded backoff while someone is still listening.
  private onClientClosed(socketPath: string): void {
    for (const channel of this.channels.values()) {
      if (channel.socketPath !== socketPath || channel.closed || channel.client?.connected) continue;
      // Connection loss is delivered at once, after any batched events, since
      // a reconnect reattaches the channel and discards its batch. Listeners
      // such as idle compaction must learn work may now start unseen.
      if (channel.timer) clearTimeout(channel.timer);
      this.flush(channel);
      const revision = (this.revisions.get(channel.processId) ?? 0) + 1;
      this.revisions.set(channel.processId, revision);
      const delivered: IntegratedConversationEvent = { kind: 'reconnecting', revision, processId: channel.processId };
      if (channel.state) channel.state.revision = revision;
      for (const listener of channel.listeners) listener(delivered);
      this.scheduleReconnect(channel);
    }
  }

  private scheduleReconnect(channel: CodexChannel): void {
    if (channel.closed || channel.reconnect || !channel.listeners.size || channel.client?.connected) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** channel.attempts, RECONNECT_MAX_MS);
    channel.attempts += 1;
    channel.reconnect = setTimeout(() => {
      channel.reconnect = null;
      void this.reconnect(channel);
    }, delay);
  }

  private async reconnect(channel: CodexChannel): Promise<void> {
    if (channel.closed || !channel.listeners.size) return;
    try {
      this.runtime(channel.processId);
    } catch {
      this.enqueue(channel, { revision: 0, kind: 'error', id: 'connection_error', delta: 'The native Codex session is no longer active.' });
      return;
    }
    try {
      // connect() reattaches every channel bound to this socket, including
      // this one, and reseeds its snapshot.
      await this.connect(channel.socketPath);
    } catch {
      if (channel.attempts >= RECONNECT_ATTEMPTS) {
        this.enqueue(channel, { revision: 0, kind: 'error', id: 'connection_error', delta: 'Could not reconnect to the Codex app-server; check the agent process.' });
        return;
      }
      this.scheduleReconnect(channel);
    }
  }
}

export interface CodexMcpStartupFailure {
  server: string;
  error: string;
}

// Context the voice model starts with. Realtime v3 only.
export interface RealtimeInitialItem {
  role: 'user' | 'assistant' | 'developer';
  text: string;
}

export interface CodexRealtimeEvent {
  method: string;
  params: JsonRecord;
}

// Rows without a native lifecycle (plans, notices, patch updates) begin when
// the host first sees them; a later replace keeps the earlier time.
function firstSeen(message: IntegratedConversationMessage): IntegratedConversationMessage {
  return message.createdAt ? message : { ...message, createdAt: new Date().toISOString() };
}

// item/started carries the native start and item/completed the native
// finish; the host's clock stands in when a build omits them. A row first seen
// at completion began no later than that.
function itemTimes(method: string, params: JsonRecord, message: IntegratedConversationMessage): IntegratedConversationMessage {
  const now = Date.now();
  if (method === 'item/started') return { ...message, ...codexTimes(params.startedAtMs ?? now, undefined) };
  const times = codexTimes(undefined, params.completedAtMs ?? now);
  return { ...message, createdAt: times.completedAt, ...times };
}

// Realtime errors carry the upstream JSON error body as a string.
function realtimeErrorMessage(message: unknown): string {
  if (typeof message !== 'string') return 'The voice session failed';
  try {
    const detail = record(record(JSON.parse(message)).error).message;
    if (typeof detail === 'string' && detail) return detail;
  } catch { /* plain text */ }
  return message;
}

export class CodexRpcClient {
  private sequence = 0;
  private buffer = '';
  private readonly requests = new Map<RequestId, { resolve(value: unknown): void; reject(error: Error): void; timeout: NodeJS.Timeout }>();
  private readonly serverRequests = new Map<string, PendingServerRequest>();
  private readonly notificationHandlers = new Set<(notification: { method: string; params: JsonRecord }) => void>();
  // Active turn per thread. Subagent threads run their own turns on the same
  // app-server; one must never be mistaken for the parent's.
  private readonly turns = new Map<string, string>();
  // How each thread's latest turn ended, so a subagent whose turn finished is
  // not shown as running forever.
  private readonly endedTurns = new Map<string, string>();
  // Turns that have completed. A turn/start reply can arrive in the same chunk
  // as the turn's completion and be handled after it; it must not revive it.
  private readonly completedTurns = new Set<string>();
  // Latest status per thread from its notifications, its turns, and native
  // reads. Running subagent threads keep their agent working.
  private readonly threadStatuses = new Map<string, CodexDeliveryStatus>();

  // Null when this connection has not learned the thread's status.
  threadStatus(threadId: string): CodexDeliveryStatus | null { return this.threadStatuses.get(threadId) ?? null; }

  // A status read natively, kept only when no notification said otherwise
  // while the read was in flight.
  noteThreadStatus(threadId: string, status: CodexDeliveryStatus): void {
    if (!this.threadStatuses.has(threadId)) this.setThreadStatus(threadId, status);
  }

  private setThreadStatus(threadId: string, status: CodexDeliveryStatus): void {
    // Only turn/completed clears an active turn. This also protects child
    // threads and reads outside a conversation subscription.
    if (status === 'idle' && this.turns.has(threadId)) status = 'working';
    this.threadStatuses.delete(threadId);
    this.threadStatuses.set(threadId, status);
    if (this.threadStatuses.size > 500) this.threadStatuses.delete(this.threadStatuses.keys().next().value!);
  }

  lastTurnStatus(threadId: string): string | null { return this.endedTurns.get(threadId) ?? null; }

  // Latest native token usage per thread and the account's quota windows.
  private readonly tokenUsage = new Map<string, JsonRecord>();
  private readonly rateLimits = new Map<string, JsonRecord>();
  private readonly modelActivity = new Map<string, string>();
  // Latest startup error per thread and MCP server, cleared when it starts again.
  private readonly mcpFailures = new Map<string, Map<string, string>>();

  mcpStartupFailures(threadId: string): Array<[string, string]> { return [...this.mcpFailures.get(threadId) ?? []]; }

  usage(threadId: string): JsonRecord {
    const tokens = record(this.tokenUsage.get(threadId));
    const last = record(tokens.last);
    const total = record(tokens.total);
    const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const limits = [...this.rateLimits.values()];
    return {
      ...(number(last.totalTokens) !== undefined ? { contextTokens: number(last.totalTokens) } : {}),
      ...(number(tokens.modelContextWindow) !== undefined ? { contextWindow: number(tokens.modelContextWindow) } : {}),
      ...(number(total.inputTokens) !== undefined ? { inputTokens: number(total.inputTokens) } : {}),
      ...(number(total.outputTokens) !== undefined ? { outputTokens: number(total.outputTokens) } : {}),
      ...(limits.length ? { limits } : {}),
      ...(this.modelActivity.has(threadId) ? { lastModelActivityAt: this.modelActivity.get(threadId) } : {})
    };
  }

  activeTurn(threadId: string): string | null { return this.turns.get(threadId) ?? null; }

  // A thread waiting on the user stays waiting when its turn is known.
  setActiveTurn(threadId: string, turnId: string | null): void {
    if (turnId && this.completedTurns.has(turnId)) return;
    if (turnId) {
      this.turns.set(threadId, turnId);
      if (!awaitingUser(this.threadStatuses.get(threadId))) this.setThreadStatus(threadId, 'working');
    } else {
      this.turns.delete(threadId);
      this.setThreadStatus(threadId, 'idle');
    }
  }

  private constructor(private readonly socket: net.Socket, onClose: () => void, private readonly timeoutMs: number) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => { this.fail(new Error('Codex app-server disconnected')); onClose(); });
  }

  static connect(socketPath: string, onClose: () => void, timeoutMs = 15_000): Promise<CodexRpcClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(ipcPath(socketPath));
      const fail = (error: Error) => reject(hostConnectionError(error, 'Codex'));
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.off('error', fail);
        resolve(new CodexRpcClient(socket, onClose, timeoutMs));
      });
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.sequence;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requests.delete(id);
        const failure = new Error(`Codex app-server timed out: ${method}`);
        reject(Object.assign(failure, { definitive: false }));
      }, this.timeoutMs);
      this.requests.set(id, { resolve, reject, timeout });
    });
  }

  pending(id: string): PendingServerRequest | undefined { return this.serverRequests.get(id); }

  // Each Integrated agent owns its app-server, so every pending request belongs
  // to its thread or to a subagent thread that it spawned. Filtering by the
  // parent thread hid subagent approvals while the parent turn waited on them.
  pendingRequests(): PendingServerRequest[] {
    return [...this.serverRequests.values()];
  }

  onNotification(handler: (notification: { method: string; params: JsonRecord }) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => { this.notificationHandlers.delete(handler); };
  }

  respond(id: RequestId, result: unknown): void {
    this.serverRequests.delete(String(id));
    this.write({ jsonrpc: '2.0', id, result });
    this.notify(REQUEST_ANSWERED, { requestId: id });
  }

  close(): void { this.socket.destroy(); }

  get connected(): boolean { return !this.socket.destroyed; }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRecord;
      try { message = record(JSON.parse(line)); } catch { continue; }
      if ('id' in message && typeof message.method === 'string') {
        const id = message.id as RequestId;
        // A request nobody can answer would stall the turn. Patterm registers
        // no dynamic tools and supplies no auth tokens or attestation, so
        // those are declined at once instead of stored.
        if (!ANSWERABLE_REQUESTS.has(message.method) && !isApproval(message.method)) {
          this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Patterm does not handle ${message.method}` } });
          continue;
        }
        this.serverRequests.set(String(id), { id, method: message.method, params: record(message.params) });
        this.notify(REQUEST_ARRIVED, { requestId: id });
      } else if ('id' in message) {
        const request = this.requests.get(message.id as RequestId);
        if (!request) continue;
        clearTimeout(request.timeout);
        this.requests.delete(message.id as RequestId);
        if (message.error) {
          const failure = new Error(String(record(message.error).message ?? 'Codex app-server request failed'));
          request.reject(Object.assign(failure, { definitive: true }));
        } else {
          request.resolve(message.result);
        }
      } else {
        const method = typeof message.method === 'string' ? message.method : '';
        const params = record(message.params);
        const threadId = typeof params.threadId === 'string' ? params.threadId : null;
        // App-server resolves a thread's requests when its turn starts or
        // ends, and announces each one later; none is answerable after.
        if ((method === 'turn/started' || method === 'turn/completed') && threadId) this.dropThreadRequests(threadId);
        if (method === 'turn/started' && threadId) {
          const turn = record(params.turn);
          if (typeof turn.id === 'string') this.setActiveTurn(threadId, turn.id);
        } else if (method === 'thread/status/changed' && threadId) {
          const status = codexThreadStatus(params.status);
          if (status) this.setThreadStatus(threadId, status);
        } else if (method === 'turn/completed' && threadId) {
          this.setActiveTurn(threadId, null);
          const turnId = record(params.turn).id;
          if (typeof turnId === 'string') {
            this.completedTurns.add(turnId);
            if (this.completedTurns.size > 500) this.completedTurns.delete(this.completedTurns.values().next().value!);
          }
          this.endedTurns.set(threadId, typeof record(params.turn).status === 'string' ? String(record(params.turn).status) : 'completed');
          if (this.endedTurns.size > 500) this.endedTurns.delete(this.endedTurns.keys().next().value!);
        } else if (method === 'thread/tokenUsage/updated' && threadId) {
          this.tokenUsage.set(threadId, record(params.tokenUsage));
          // Codex reports usage after each model response in the thread.
          this.modelActivity.set(threadId, new Date().toISOString());
        } else if (method === 'account/rateLimits/updated') {
          // Sparse update: merge the windows that are present.
          const snapshot = record(params.rateLimits);
          for (const key of ['primary', 'secondary'] as const) {
            const window = record(snapshot[key]);
            if (typeof window.usedPercent !== 'number') continue;
            const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null;
            const label = minutes === 300 ? '5h limit' : minutes === 10_080 ? 'Weekly limit' : minutes ? `${minutes}m limit` : `${key} limit`;
            const resets = typeof window.resetsAt === 'number' ? new Date(window.resetsAt < 1e12 ? window.resetsAt * 1000 : window.resetsAt).toISOString() : undefined;
            // Separate quotas (for example per model) update independently.
            const name = typeof snapshot.limitName === 'string' && snapshot.limitName ? `${snapshot.limitName} ` : '';
            this.rateLimits.set(`${String(snapshot.limitId ?? '')}:${key}`, { label: `${name}${label}`, usedPercent: window.usedPercent, ...(resets ? { resetsAt: resets } : {}), observedAt: new Date().toISOString() });
          }
        } else if (method === 'mcpServer/startupStatus/updated' && threadId && typeof params.name === 'string') {
          const failures = this.mcpFailures.get(threadId) ?? new Map<string, string>();
          if (params.status === 'failed') failures.set(params.name, typeof params.error === 'string' ? params.error : '');
          else failures.delete(params.name);
          if (failures.size) this.mcpFailures.set(threadId, failures);
          else this.mcpFailures.delete(threadId);
        } else if (method === 'serverRequest/resolved') {
          const requestId = params.requestId;
          if (typeof requestId === 'string' || typeof requestId === 'number') this.serverRequests.delete(String(requestId));
        }
        if (method) this.notify(method, params);
      }
    }
  }

  private dropThreadRequests(threadId: string): void {
    for (const [id, request] of this.serverRequests) {
      if (request.params.threadId === threadId) this.serverRequests.delete(id);
    }
  }

  private notify(method: string, params: JsonRecord): void {
    for (const handler of this.notificationHandlers) handler({ method, params });
  }

  private write(message: unknown): void { this.socket.write(`${JSON.stringify(message)}\n`); }

  private fail(error: Error): void {
    for (const request of this.requests.values()) {
      clearTimeout(request.timeout);
      request.reject(Object.assign(error, { definitive: false }));
    }
    this.requests.clear();
  }
}

function codexMcpOverrides(mcp: IntegratedLaunchInput['mcp']): string[] {
  return [
    `mcp_servers.patterm.command=${JSON.stringify(mcp.command)}`,
    `mcp_servers.patterm.args=[${mcp.args.map((value) => JSON.stringify(value)).join(',')}]`,
    ...Object.entries(mcp.env).map(([key, value]) => `mcp_servers.patterm.env.${key}=${JSON.stringify(value)}`)
  ];
}

// Codex has no filesystem `mention` variant: those target app://, plugin://,
// and similar. Its TUI inserts file paths as plain text, quoting paths that
// contain whitespace, so filesystem references and non-image attachments ride
// in the prompt text while images stay localImage items.
function promptText(input: ResolvedIntegratedPrompt): string {
  let text = input.text;
  const append: string[] = [];
  for (const reference of input.references) {
    text = replaceReferenceToken(text, reference.relativePath, quotedPath(reference.relativePath));
    if (!containsPlainPath(text, reference.relativePath)) append.push(quotedPath(reference.relativePath));
  }
  for (const attachment of input.attachments) {
    if (attachment.mime.startsWith('image/')) continue;
    if (!containsPlainPath(text, attachment.path)) append.push(quotedPath(attachment.path));
  }
  return [text.trim(), ...append].filter(Boolean).join(' ');
}

// Timeouts and socket failures may happen after the request reached the
// app-server; JSON-RPC error responses are definitive rejections.
// Codex rejects input while a compaction or review turn runs. 0.159 reports it
// only in the message: `failed to submit turn input: ActiveTurnNotSteerable {
// turn_kind: Compact }`.
function notSteerableKind(error: unknown): string | null {
  const match = /ActiveTurnNotSteerable\s*\{\s*turn_kind:\s*(\w+)/.exec(error instanceof Error ? error.message : '');
  return match ? match[1]!.toLowerCase() : null;
}

function isUncertainRpcFailure(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { definitive?: unknown }).definitive === false;
}

// The renderer carries cursors as strings. Codex 0.159 returns an opaque
// string, which happens to hold JSON, and accepts it back only as that string;
// builds that returned an object cursor get an object back, so it is marked.
// Only the cursor marks the start of the thread: Codex caps a page below the
// limit asked for (0.166 returns at most 100 items), so a short page can still
// have older items before it.
const OBJECT_CURSOR = 'object:';

function nativeCursor(response: JsonRecord): string | null {
  if (!Array.isArray(response.data) || !response.data.length) return null;
  const next = response.nextCursor;
  if (typeof next === 'string') return next || null;
  return next && typeof next === 'object' ? `${OBJECT_CURSOR}${JSON.stringify(next)}` : null;
}

function parseNativeCursor(cursor: string): unknown {
  if (!cursor.startsWith(OBJECT_CURSOR)) return cursor;
  try { return JSON.parse(cursor.slice(OBJECT_CURSOR.length)) as unknown; } catch { return cursor; }
}

const AGENT_STATUS: Record<string, string> = {
  pendingInit: 'pending', running: 'running', completed: 'completed', errored: 'failed', interrupted: 'stopped', shutdown: 'stopped', notFound: 'stopped'
};

// Spawned subagent threads and background terminals as tasks. Later collab
// calls (wait, send input) and subagent activity rows carry newer states, so
// the last state seen for a thread wins.
function codexTasks(messages: IntegratedConversationMessage[], client: CodexRpcClient, background: Map<string, string>): JsonRecord[] {
  const tasks = new Map<string, JsonRecord>();
  for (const message of messages) {
    const input = record(message.tool?.input);
    if (message.tool?.name === 'subAgentActivity' && typeof input.agentThreadId === 'string') {
      const task = tasks.get(input.agentThreadId) ?? { id: input.agentThreadId, label: subagentLabel(input.path), kind: 'subagent', status: 'running' };
      if (input.kind === 'completed') task.status = 'completed';
      else if (input.kind === 'interrupted') task.status = 'stopped';
      else if (input.kind === 'started') task.status = 'running';
      tasks.set(input.agentThreadId, task);
      continue;
    }
    if (message.tool?.name === 'commandExecution' && background.has(message.id)) {
      const state = message.tool.state;
      const status = state === 'inProgress' ? 'running' : state === 'declined' ? 'stopped' : state === 'failed' || (typeof input.exitCode === 'number' && input.exitCode !== 0) ? 'failed' : 'completed';
      tasks.set(message.id, { id: message.id, label: shellCommand(input.command), kind: 'shell', status, stoppable: status === 'running' });
      continue;
    }
    if (message.tool?.name !== 'agent') continue;
    if (input.tool === 'spawnAgent' && Array.isArray(input.receiverThreadIds)) {
      for (const thread of input.receiverThreadIds) {
        if (typeof thread === 'string') tasks.set(thread, { id: thread, label: String(input.description ?? 'Subagent'), kind: 'subagent', status: 'running' });
      }
    }
    for (const [thread, value] of Object.entries(record(input.agentsStates))) {
      const task = tasks.get(thread);
      const state = record(value);
      if (!task) continue;
      if (typeof state.status === 'string') task.status = AGENT_STATUS[state.status] ?? task.status;
      if (typeof state.message === 'string' && state.message) task.detail = state.message;
    }
  }
  return [...tasks.values()].slice(-20).map((task) => {
    if (task.kind === 'shell') return task;
    const id = String(task.id);
    const active = Boolean(client.activeTurn(id));
    // A thread whose own turn ended is not running, even if the parent never
    // asked for its state again.
    const ended = client.lastTurnStatus(id);
    const status = task.status === 'running' && !active && ended ? (ended === 'failed' ? 'failed' : ended === 'interrupted' ? 'stopped' : 'completed') : task.status;
    return { ...task, status, stoppable: status === 'running' && active };
  });
}

// A row the channel has, or will have once its queued events flush.
function hasRow(channel: CodexChannel, id: string): boolean {
  return Boolean(channel.state?.messages.some((message) => message.id === id) || channel.queue.some((event) => event.message?.id === id));
}

function isSubagentStart(message: IntegratedConversationMessage): boolean {
  return message.tool?.name === 'subAgentActivity' && record(message.tool.input).kind === 'started';
}

// Codex runs commands through a login shell; show the command itself.
function shellCommand(command: unknown): string {
  const text = typeof command === 'string' ? command : '';
  const wrapped = /^\/bin\/(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/.exec(text);
  return (wrapped ? wrapped[2]! : text) || 'Command';
}

// "/review" alone reviews uncommitted changes; "base <branch>" and
// "commit <sha>" pick those targets; anything else is custom instructions.
function reviewTarget(argument: string): JsonRecord {
  if (!argument) return { type: 'uncommittedChanges' };
  const base = argument.match(/^base\s+(\S+)$/i);
  if (base) return { type: 'baseBranch', branch: base[1] };
  const commit = argument.match(/^commit\s+([0-9a-f]{7,40})$/i);
  if (commit) return { type: 'commit', sha: commit[1], title: null };
  return { type: 'custom', instructions: argument };
}

// The agent's status: a request waiting for the user, then its own turn,
// then any subagent thread still running after that turn. Background
// terminals never count; a dev server can run for as long as it likes.
export function effectiveStatus(own: CodexStatus, client: CodexRpcClient | null, threads: Iterable<string>): CodexStatus {
  if (!client) return own;
  // An approval anywhere outranks a question; a question outranks work.
  const pending = pendingStatus(client.pendingRequests(), []);
  if (pending === 'permission') return { status: 'permission' };
  if (own.status === 'permission' || (own.status === 'working' && !pending)) return own;
  let working = false;
  let question = pending === 'question' || own.status === 'question';
  for (const thread of threads) {
    const status = client.threadStatus(thread);
    if (status === 'permission') return { status: 'permission' };
    if (status === 'question') question = true;
    if (status === 'working') working = true;
  }
  return question ? { status: 'question' } : working ? { status: 'working' } : own;
}

function isDescendant(channel: CodexChannel, threadId: string): boolean {
  return channel.children.has(threadId) || channel.descendants.has(threadId);
}

// Spawned subagent threads, oldest first, and the threads they started.
function descendantThreads(channel: CodexChannel): string[] {
  return [...new Set([...channel.children.keys(), ...channel.descendants])];
}

// spawnAgent rows, and the subagent activity rows newer Codex builds report
// instead, name the threads they started.
function spawnedThreads(messages: IntegratedConversationMessage[]): Map<string, string> {
  const threads = new Map<string, string>();
  for (const message of messages) {
    const input = record(message.tool?.input);
    if (isSubagentStart(message) && typeof input.agentThreadId === 'string') {
      threads.set(input.agentThreadId, message.id);
      continue;
    }
    if (message.tool?.name !== 'agent' || input.tool !== 'spawnAgent' || !Array.isArray(input.receiverThreadIds)) continue;
    for (const thread of input.receiverThreadIds) if (typeof thread === 'string') threads.set(thread, message.id);
  }
  return threads;
}


const ELICITATION = 'mcpServer/elicitation/request';
const PLAN_REQUEST_PREFIX = 'plan:';
type CodexCollaborationMode = 'default' | 'plan';
const CODEX_MODES = [{ value: 'default', label: 'Default' }, { value: 'plan', label: 'Plan' }];

function withPlan(views: JsonRecord, plan: JsonRecord[]): JsonRecord {
  return plan.length ? { ...views, permissions: { data: [...record(views.permissions).data as unknown[], ...plan] } } : views;
}
const ANSWERABLE_REQUESTS = new Set(['item/tool/requestUserInput', ELICITATION]);

// What pending requests wait on: an approval, including a plan to approve,
// or else only questions and forms. Undefined while nothing is pending.
function pendingStatus(pending: Array<{ method: string }>, plan: unknown[]): 'permission' | 'question' | undefined {
  if (!pending.length && !plan.length) return undefined;
  return awaitingActivity(plan.length + pending.filter((request) => !ANSWERABLE_REQUESTS.has(request.method)).length);
}

// A snapshot's status: pending requests and the effective status together,
// an approval in either first. Undefined while unknown.
export function snapshotStatus(pending: Array<{ method: string }>, plan: unknown[], status: CodexDeliveryStatus): CodexDeliveryStatus | undefined {
  const waiting = pendingStatus(pending, plan);
  if (waiting === 'permission' || status === 'permission') return 'permission';
  return waiting ?? (status === 'unknown' ? undefined : status);
}

function pendingViews(pending: PendingServerRequest[], threadId: string, messages: IntegratedConversationMessage[]): JsonRecord {
  return {
    permissions: { data: pending.filter((request) => isApproval(request.method)).map((request) => permissionView(request, threadId, messages)) },
    questions: { data: pending.filter((request) => request.method === 'item/tool/requestUserInput').map(questionView) },
    forms: { data: pending.filter((request) => request.method === ELICITATION).map(elicitationView) }
  };
}

function elicitationView(request: PendingServerRequest): ElicitationForm {
  const params = request.params;
  return elicitationForm({
    id: String(request.id),
    message: typeof params.message === 'string' ? params.message : '',
    source: typeof params.serverName === 'string' ? `the ${params.serverName} MCP server` : undefined,
    mode: typeof params.mode === 'string' ? params.mode : undefined,
    schema: params.requestedSchema,
    url: typeof params.url === 'string' ? params.url : undefined
  });
}

function isApproval(method: string): boolean {
  return method.includes('requestApproval') || method === 'applyPatchApproval' || method === 'execCommandApproval';
}

function permissionView(request: PendingServerRequest, threadId: string, messages: IntegratedConversationMessage[]): JsonRecord {
  const params = request.params;
  const command = typeof params.command === 'string' ? params.command : Array.isArray(params.command) ? params.command.map(String).join(' ') : '';
  const fileChange = request.method === 'item/fileChange/requestApproval' || request.method === 'applyPatchApproval';
  const action = fileChange ? 'Apply these file changes?'
    : request.method === 'item/permissions/requestApproval' ? 'Grant additional permissions?'
      : command ? 'Run this command?' : String(params.reason ?? request.method);
  const network = record(params.networkApprovalContext);
  const detail = [
    typeof params.reason === 'string' ? params.reason : '',
    typeof network.host === 'string' ? `Network access to ${network.host}` : '',
    typeof params.grantRoot === 'string' ? `Write access under ${params.grantRoot} for this session` : ''
  ].filter(Boolean).join('\n');
  // File change approvals name the item; its projected row holds the diff.
  const item = typeof params.itemId === 'string' ? messages.find((message) => message.id === params.itemId) : undefined;
  const changes = fileChange && Array.isArray(record(item?.tool?.input).changes) ? record(item?.tool?.input).changes as unknown[] : [];
  const patch = changes.map(record).map((change) => [`+++ ${String(change.path ?? '')}`, typeof change.diff === 'string' ? change.diff : ''].filter(Boolean).join('\n')).join('\n');
  // A subagent's request pauses the parent turn too; say whose it is.
  const child = typeof params.threadId === 'string' && params.threadId !== threadId;
  // Codex supports session-scoped approval, so Always allow is native and is
  // labelled with its real scope rather than promising a permanent rule.
  return {
    id: String(request.id), action: child ? `Subagent: ${action}` : action, resources: command ? [command] : [],
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
    ...(patch ? { patch } : {}),
    always: true, always_label: 'Allow for this session'
  };
}

function questionView(request: PendingServerRequest): JsonRecord {
  const questions = Array.isArray(request.params.questions) ? request.params.questions.flatMap((value, index) => {
    const question = record(value);
    if (typeof question.question !== 'string') return [];
    return [{
      id: String(question.id ?? index),
      header: String(question.header ?? ''),
      question: question.question,
      options: Array.isArray(question.options) ? question.options.flatMap((option) => {
        const value = record(option);
        return typeof value.label === 'string'
          ? [{ label: value.label, ...(typeof value.description === 'string' ? { description: value.description } : {}) }]
          : [];
      }) : [],
      // Codex requestUserInput has no multi-select; isOther allows a typed answer.
      multiple: false,
      custom: question.isOther === true
    }];
  }) : [];
  return { id: String(request.id), questions };
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

async function waitForSocket(socketPath: string, pid: number | null): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await integratedHostReady(socketPath)) return;
    if (pid) {
      try { process.kill(pid, 0); } catch { throw new Error('Codex app-server exited during startup'); }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Codex app-server did not create its control socket');
}

async function stopRuntime(argv: string[]): Promise<void> {
  const pid = typeof argv[3] === 'string' && /^\d+$/.test(argv[3]) ? Number(argv[3]) : null;
  await stopHostProcess(pid);
  if (typeof argv[2] === 'string') {
    try { fs.unlinkSync(argv[2]); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  removeForcedHostConfig(typeof argv[4] === 'string' ? argv[4] : null);
}

// A POSIX host removes its launch config as SIGTERM stops it. A Windows host
// is ended without running its own cleanup.
function removeForcedHostConfig(configPath: string | null): void {
  if (process.platform === 'win32' && configPath?.endsWith('.json')) fs.rmSync(configPath, { force: true });
}
