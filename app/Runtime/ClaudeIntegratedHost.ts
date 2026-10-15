import './HostEnvironment';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { elicitationContent, elicitationForm, type ElicitationForm } from '../Services/McpElicitation';
import { envValue, withEnv } from '../Platform/Environment';
import { resolveCommand } from '../Platform/Executable';
import { ipcPath, removeStaleIpc, restrictIpc } from '../Platform/Ipc';
import { killProcessTree } from '../Platform/ProcessTree';
import { isTranscriptImageHash, TranscriptImageStore, type TranscriptImageRef } from '../Services/TranscriptImageStore';

interface HostConfig {
  socketPath: string;
  executable: string;
  cwd: string;
  sessionId: string;
  resume: boolean;
  context: string;
  mcpConfigPath: string;
  model?: string | null;
  reasoning?: string | null;
  // Absent for hosts launched before transcript images existed.
  imageDirectory?: string;
}

type JsonRecord = Record<string, unknown>;

const config = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as HostConfig;
// Windows caps a command line at 32767 characters, which a large assistant
// context can approach, so Claude reads it from a file there (as in terminal mode).
const contextPath = config.mcpConfigPath.replace(/-mcp\.json$/, '-context.md');
const images = config.imageDirectory ? new TranscriptImageStore(config.imageDirectory) : null;
const messages: JsonRecord[] = [];
const pending = new Map<string, JsonRecord>();
// Client uuids written to the native session but not yet acknowledged by a
// replay or reply frame. A local transcript row is not native acceptance.
const userMessages = new Map<string, boolean>();
// Subscribed clients receive targeted, revisioned transcript events instead of
// polling the snapshot. The revision is the snapshot boundary: a conversation
// read captures it before building its payload.
const subscribers = new Set<net.Socket>();
let revision = 0;
// Partial-message state per stream. The main agent and every running subagent
// (keyed by the Task tool id in parent_tool_use_id) stream independently, so
// one's message_start must not reset another's blocks.
interface StreamState {
  messageId: string | null;
  blocks: Map<number, string>;
  toolInput: Map<number, string>;
  // Native assistant frames arrive one per content block in block order (the
  // installed serializer strips the internal apiBlockIndex). Stopped block
  // indices queue here so each frame keeps the identity and order of its
  // stream block.
  stopped: number[];
}
const streams = new Map<string, StreamState>();
// A per-message fallback counter covers frames without stream events.
const nextBlockIndex = new Map<string, number>();
let child: ChildProcessWithoutNullStreams | null = null;
let childBuffer = '';
// idle, working, permission, or failed. Derived in updateStatus.
let status = 'idle';
// Claude ends an interrupted turn with an `error_during_execution` result; the
// flag lets that result settle the turn as idle instead of failed. An interrupt
// with no turn running produces no result, so the flag is only set while one
// runs and is cleared once Claude reports nothing running.
let interrupted = false;
// The last turn failed or the CLI exited with an error. Shown while nothing
// else is running, until the next turn ends.
let failed = false;
// Prompts written to Claude, by client uuid, until Claude reports their fate
// through command_lifecycle. A prompt Claude has not read yet keeps the agent
// working through an idle report that predates it.
const prompts = new Map<string, 'written' | 'queued' | 'started'>();
// Builds without command_lifecycle end every prompt with the turn's result.
let lifecycleReported = false;
// Claude's own session state, which CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS turns
// on: `running` while the main loop or a background agent works,
// `requires_action` while it waits on a prompt, and `idle` once nothing runs
// or is queued. Null until this CLI process reports one.
let sessionState: string | null = null;
// Live background agents from Claude's background_tasks_changed level signal,
// for builds that do not report session state. Null until reported.
let backgroundAgentLevel: number | null = null;
let model = config.model ?? 'default';
// Integrated sessions start in auto mode. Claude Code falls back to manual when
// the model or account lacks auto, so the mode shown is the one it reports.
let mode = 'auto';
// The native `initialize` reply lists the account's selectable models.
let models: JsonRecord[] = [];
// It also lists every slash command, including skills, plugins, and MCP prompts.
let commands: JsonRecord[] = [];
// A null effort leaves the level to Claude Code, which resolves it per model;
// `get_settings` reports that resolved level for the Default label.
let effort = config.reasoning ?? null;
let appliedEffort: string | null = null;
// Claude Code's own session title, generated and persisted the way the TUI
// does. A persisted title (AI or /rename) is returned without regenerating.
let title: string | null = null;
const titleRequests = new Map<string, (value: string | null) => void>();
// Shared usage telemetry: context from the main agent's latest request,
// totals and cost for this Claude process, account quota windows, and when
// the main agent's latest response started.
const usage: JsonRecord = {};
const limits = new Map<string, JsonRecord>();
// Notice rows for harness state. A retry run and a compaction each update one
// row in place rather than adding a line per attempt.
let retryNotice: { id: string; attempts: number } | null = null;
// Why the last turn failed, for the error banner.
let statusDetail: string | null = null;
// A main-agent turn is running, by Claude's evidence: its session started
// running or the main agent streamed. It ends with the turn's result. Prompts
// waiting for their turn are tracked in `prompts`.
let turnActive = false;
// Background work Claude reports: background shells, workflows, monitors, and
// background agents. The newest few finished tasks stay visible.
const tasks = new Map<string, JsonRecord>();
const TASK_LIMIT = 20;
// Claude also registers foreground tool calls as tasks so they can be moved to
// the background; those stay hidden until they are. Ambient tasks are
// internal and never shown.
const foregroundTasks = new Set<string>();
const ambientTasks = new Set<string>();
// Native message types this host does not project, counted so protocol drift
// shows up in the debug log instead of being silently dropped.
const unhandled: Record<string, number> = {};

function countUnhandled(type: string): void {
  if (Object.keys(unhandled).length < 100 || unhandled[type] !== undefined) unhandled[type] = (unhandled[type] ?? 0) + 1;
}
let compactNotice: string | null = null;
let noticeSequence = 0;
const TITLE_TIMEOUT_MS = 8_000;
const INITIALIZE_REQUEST_ID = 'patterm_initialize';
const SETTINGS_REQUEST_ID = 'patterm_settings';

removeStaleIpc(config.socketPath);
startClaude();

const server = net.createServer((socket) => {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let request: JsonRecord;
      try { request = record(JSON.parse(line)); }
      catch { respond(socket, null, undefined, new Error('Invalid host request')); continue; }
      void handle(socket, request).catch((error) => respond(socket, request.id, undefined, error));
    }
  });
});
server.listen(ipcPath(config.socketPath), () => restrictIpc(config.socketPath));

async function handle(socket: net.Socket, request: JsonRecord): Promise<void> {
  const id = request.id;
  const params = record(request.params);
  if (request.method === 'conversation') {
    respond(socket, id, {
      messages: { data: messages },
      permissions: { data: [...pending.values()].filter((item) => item.kind === 'permission') },
      questions: { data: [...pending.values()].filter((item) => item.kind === 'question') },
      forms: { data: [...pending.values()].flatMap((item) => item.kind === 'form' ? [item.form] : []) },
      usage: { ...usage, ...(limits.size ? { limits: [...limits.values()] } : {}) },
      tasks: backgroundTasks(),
      diagnostics: { unhandled },
      ...(status === 'failed' && statusDetail ? { status_detail: statusDetail } : {}),
      status, model, mode, effort, appliedEffort, models, commands, revision
    });
    return;
  }
  // Composer controls need the native settings, not the transcript.
  if (request.method === 'controls') {
    respond(socket, id, { status, model, mode, effort, appliedEffort, models, commands, revision });
    return;
  }
  if (request.method === 'subscribe') {
    subscribers.add(socket);
    socket.once('close', () => subscribers.delete(socket));
    respond(socket, id, { revision });
    // The subscription hands the client a fresh boundary: it re-reads the
    // authoritative snapshot and then applies newer events.
    publish({ kind: 'pending' });
    return;
  }
  if (request.method === 'configure') {
    const selector = String(params.selector ?? '');
    const value = String(params.value ?? '');
    if (selector === 'model') {
      writeClaude({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_model', model: value } });
      model = value;
      requestSettings();
    } else if (selector === 'effort') {
      // The flag-settings layer is what Claude Code's own /effort changes for a
      // running session; null returns to the model's default level.
      effort = value === 'default' ? null : value;
      writeClaude({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'apply_flag_settings', settings: { effortLevel: effort } } });
      requestSettings();
    } else if (selector === 'mode') {
      writeClaude({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_permission_mode', mode: value } });
      mode = value;
    } else throw new Error('Unknown Claude setting');
    respond(socket, id, {});
    return;
  }
  if (request.method === 'title') {
    const prompt = String(params.prompt ?? '').trim();
    // Only a slash command such as /rename can change a persisted title.
    if (child && prompt && (!title || prompt.startsWith('/'))) title = await requestTitle(prompt) ?? title;
    respond(socket, id, { title });
    return;
  }
  if (request.method === 'delivery') {
    const clientMessageId = String(params.clientMessageId ?? '');
    respond(socket, id, { state: userMessages.get(clientMessageId) ? 'accepted' : 'unknown' });
    return;
  }
  if (request.method === 'prompt' || request.method === 'promptDocuments') {
    const text = String(params.text ?? '').trim();
    const images = (Array.isArray(params.images) ? params.images : []).flatMap((value) => {
      const image = record(value);
      const mediaType = String(image.media_type ?? '');
      const data = String(image.data ?? '');
      return mediaType.startsWith('image/') && data ? [{ type: 'image', source: { type: 'base64', media_type: mediaType, data } }] : [];
    });
    // PDFs travel as base64 documents and text files as plain-text documents.
    const documents = (Array.isArray(params.documents) ? params.documents : []).flatMap((value) => {
      const item = record(value);
      const title = typeof item.title === 'string' ? item.title.slice(0, 500) : undefined;
      const titled = title ? { title } : {};
      if (item.media_type === 'application/pdf' && typeof item.data === 'string' && item.data) {
        return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: item.data }, ...titled }];
      }
      if (item.media_type === 'text/plain' && typeof item.text === 'string') {
        return [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: item.text }, ...titled }];
      }
      return [];
    });
    const attachments = (Array.isArray(params.attachments) ? params.attachments : []).slice(0, 40).flatMap((value) => {
      const item = record(value);
      const name = typeof item.name === 'string' ? item.name.slice(0, 500) : '';
      if (!name) return [];
      return [{ name, ...(typeof item.type === 'string' ? { type: item.type } : {}),
        ...(typeof item.mime === 'string' ? { mime: item.mime } : {}),
        ...(typeof item.detail === 'string' ? { detail: item.detail.slice(0, 1000) } : {}),
        ...(isTranscriptImageHash(item.sha256) ? { sha256: item.sha256 } : {}) }];
    });
    if (!text && !images.length && !documents.length) throw new Error('Message is empty');
    if (!child || !child.stdin.writable) startClaude(true);
    // The submitted client uuid makes retries idempotent in the native session.
    const clientMessageId = typeof params.clientMessageId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.clientMessageId)
      ? params.clientMessageId
      : randomUUID();
    const messageId = `user_${clientMessageId}`;
    // A retried uuid must not add a second local transcript row.
    if (!messages.some((message) => message.id === messageId)) {
      upsertMessage({ id: messageId, role: 'user', kind: 'text', text: text || uploadLabel(images.length, documents.length),
        ...(attachments.length ? { attachments } : {}) }, true, true);
    }
    if (!userMessages.has(clientMessageId)) userMessages.set(clientMessageId, false);
    writeClaude({
      type: 'user',
      message: { role: 'user', content: [...(text ? [{ type: 'text', text }] : []), ...images, ...documents] },
      parent_tool_use_id: null,
      session_id: config.sessionId,
      uuid: clientMessageId
    });
    // A retry of a prompt Claude already accepted starts nothing new. A prompt
    // sent while a request waits keeps the agent waiting on that request.
    if (!prompts.has(clientMessageId) && !userMessages.get(clientMessageId)) prompts.set(clientMessageId, 'written');
    updateStatus();
    respond(socket, id, { id: messageId });
    return;
  }
  if (request.method === 'interrupt') {
    interrupted = turnActive || prompts.size > 0;
    writeClaude({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    respond(socket, id, {});
    return;
  }
  if (request.method === 'permission') {
    const requestId = String(params.requestId ?? '');
    const item = pending.get(requestId);
    if (!item) throw new Error('Claude permission request is no longer pending');
    const raw = record(item.raw);
    const permission = record(raw.request);
    const reply = params.reply;
    const allowed = reply === 'once' || reply === 'always';
    const feedback = typeof params.message === 'string' && params.message.trim() ? params.message.trim() : '';
    // Plan approval mirrors the TUI: approve with manual or auto-accepted
    // edits (a session mode change), or keep planning with feedback.
    const planMode = permission.tool_name === 'ExitPlanMode' ? (reply === 'always' ? 'acceptEdits' : 'default') : null;
    const updates = planMode
      ? [{ type: 'setMode', mode: planMode, destination: 'session' }]
      : reply === 'always' ? permission.permission_suggestions : undefined;
    writeClaude({
      type: 'control_response',
      response: {
        subtype: 'success', request_id: requestId,
        response: allowed
          ? { behavior: 'allow', updatedInput: permission.input, ...(updates ? { updatedPermissions: updates } : {}) }
          : { behavior: 'deny', message: feedback || (planMode ? 'Keep planning' : 'Rejected by user'), interrupt: false }
      }
    });
    if (allowed && planMode) mode = nativeMode(planMode);
    settlePending(requestId);
    respond(socket, id, {});
    return;
  }
  if (request.method === 'question') {
    const requestId = String(params.requestId ?? '');
    const item = pending.get(requestId);
    if (!item) throw new Error('Claude question is no longer pending');
    const raw = record(item.raw);
    const permission = record(raw.request);
    const input = record(permission.input);
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const answers = Array.isArray(params.answers) ? params.answers : [];
    if (answers.length !== questions.length) throw new Error('Provide one answer for every question');
    // AskUserQuestion keys answers by the full question text, and joins a
    // multi-select answer into one string.
    const answerMap: Record<string, string> = {};
    for (const [index, question] of questions.entries()) {
      const prompt = record(question);
      const key = String(prompt.question ?? prompt.header ?? index);
      const values = Array.isArray(answers[index]) ? answers[index] as unknown[] : [];
      answerMap[key] = values.map(String).join(', ');
    }
    writeClaude({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: { ...input, answers: answerMap } } } });
    settlePending(requestId);
    respond(socket, id, {});
    return;
  }
  if (request.method === 'stopTask') {
    const taskId = String(params.taskId ?? '');
    if (!tasks.has(taskId)) throw new Error('Claude background task is no longer known');
    writeClaude({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'stop_task', task_id: taskId } });
    respond(socket, id, {});
    return;
  }
  if (request.method === 'form') {
    const requestId = String(params.formId ?? '');
    const item = pending.get(requestId);
    if (!item || item.kind !== 'form') throw new Error('Claude input request is no longer pending');
    const action = params.action === 'decline' || params.action === 'cancel' ? params.action : 'accept';
    const content = action === 'accept' ? elicitationContent(item.form as ElicitationForm, record(params.answer)) : null;
    writeClaude({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { action, ...(content ? { content } : {}) } } });
    settlePending(requestId);
    respond(socket, id, {});
    return;
  }
  if (request.method === 'stop') {
    for (const subscriber of subscribers) subscriber.destroy();
    subscribers.clear();
    respond(socket, id, {});
    shutdown();
    return;
  }
  throw new Error(`Unknown Claude host method: ${String(request.method)}`);
}

function contextArgs(): string[] {
  if (process.platform !== 'win32') return ['--append-system-prompt', config.context];
  fs.writeFileSync(contextPath, config.context, { mode: 0o600 });
  return ['--append-system-prompt-file', contextPath];
}

function startClaude(forceResume = false): void {
  const args = [
    '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages',
    // User and project MCP servers load alongside Patterm's, as in terminal mode.
    '--replay-user-messages', '--permission-prompts', 'host', '--mcp-config', config.mcpConfigPath,
    // Headless Claude registers AskUserQuestion, EnterPlanMode, and
    // ExitPlanMode only when a permission prompt tool is named, as the SDK does.
    '--permission-prompt-tool', 'stdio',
    ...contextArgs(),
    '--permission-mode', mode,
    ...(model !== 'default' ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(config.resume || forceResume ? ['--resume', config.sessionId] : ['--session-id', config.sessionId])
  ];
  const env = claudeEnvironment(process.env);
  // npm installs Claude Code as a .cmd shim on Windows, which Node cannot spawn.
  const command = resolveCommand(config.executable, args, env);
  // A new process starts with nothing of its predecessor's, even one whose
  // input closed but has not exited yet; that one's late output and exit are
  // ignored.
  forgetProcess();
  childBuffer = '';
  const spawned = spawn(command.command, command.args, {
    cwd: config.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: command.verbatim
  });
  child = spawned;
  spawned.stdout.setEncoding('utf8');
  // Output can still drain after the exit event; only a successor's start
  // makes it stale.
  spawned.stdout.on('data', (chunk: string) => { if (child === spawned || !child) receiveClaude(chunk); });
  spawned.stderr.setEncoding('utf8');
  // Diagnostics on stderr are harness warnings, not something the model said.
  spawned.stderr.on('data', (chunk: string) => {
    const text = chunk.trim();
    if (text) upsertMessage({ id: `stderr_${randomUUID()}`, role: 'assistant', kind: 'notice', level: 'warning', text: boundText(text) }, true, true);
  });
  // A missing or unexecutable binary must not crash the host; keep the
  // transcript serviceable and surface the failure through status and a message.
  spawned.on('error', (error) => {
    if (child !== spawned) return;
    upsertMessage({ id: `error_${randomUUID()}`, role: 'assistant', kind: 'notice', level: 'error', text: `Claude Code could not start: ${error.message}` }, true, true);
    endProcess(true);
  });
  spawned.stdin.on('error', () => { /* a dead child closes stdin; prompt paths report it */ });
  // A replaced process's late exit must not end its successor's turn.
  spawned.on('exit', (code) => { if (child === spawned) endProcess(code !== 0); });
  writeClaude({ type: 'control_request', request_id: INITIALIZE_REQUEST_ID, request: { subtype: 'initialize' } });
}

function endProcess(failure: boolean): void {
  child = null;
  failed = failure;
  forgetProcess();
  updateStatus();
}

// Nothing outlives a CLI process: its turn, its prompts, what it reported,
// its background tasks, and requests it can no longer receive an answer for.
// A restart resumes the session afresh.
function forgetProcess(): void {
  turnActive = false;
  interrupted = false;
  prompts.clear();
  lifecycleReported = false;
  sessionState = null;
  backgroundAgentLevel = null;
  streams.clear();
  let changed = pending.size > 0;
  pending.clear();
  for (const [id, task] of tasks) {
    if (!task.stoppable) continue;
    tasks.set(id, { ...task, status: 'stopped', stoppable: false });
    changed = true;
  }
  if (changed) publish({ kind: 'pending' });
}

// Claude leaves the Artifact tool out of headless sessions unless asked, though
// terminal sessions have it. enableArtifact settings and deny rules still
// apply. Publishing must not open a browser on the machine hosting the agent.
// Headless Claude reports its session state (session_state_changed) only when
// asked; it is the one signal for turns Claude starts on its own.
function claudeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withEnv(env, {
    CLAUDE_CODE_ARTIFACT: envValue(env, 'CLAUDE_CODE_ARTIFACT') ?? '1',
    CLAUDE_CODE_ARTIFACT_AUTO_OPEN: envValue(env, 'CLAUDE_CODE_ARTIFACT_AUTO_OPEN') ?? '0',
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: envValue(env, 'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS') ?? '1'
  });
}

function requestTitle(description: string): Promise<string | null> {
  const requestId = `patterm_title_${randomUUID()}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { titleRequests.delete(requestId); resolve(null); }, TITLE_TIMEOUT_MS);
    titleRequests.set(requestId, (value) => { clearTimeout(timer); titleRequests.delete(requestId); resolve(value); });
    try {
      writeClaude({ type: 'control_request', request_id: requestId, request: { subtype: 'generate_session_title', description, persist: true } });
    } catch { titleRequests.get(requestId)?.(null); }
  });
}

function requestSettings(): void {
  writeClaude({ type: 'control_request', request_id: SETTINGS_REQUEST_ID, request: { subtype: 'get_settings' } });
}

function receiveClaude(chunk: string): void {
  childBuffer += chunk;
  for (;;) {
    const newline = childBuffer.indexOf('\n');
    if (newline < 0) return;
    const line = childBuffer.slice(0, newline).trim();
    childBuffer = childBuffer.slice(newline + 1);
    if (!line) continue;
    let event: JsonRecord;
    try { event = record(JSON.parse(line)); } catch { continue; }
    if (event.type === 'assistant') {
      acknowledgeUserMessage(event.user_message_uuid);
      if (!parentOf(event)) recordContext(record(record(event.message).usage));
      applyAssistantMessage(event, parentOf(event));
    } else if (event.type === 'user') {
      // --replay-user-messages echoes an accepted client uuid; tool_result
      // blocks pair with their streamed or final tool_use row.
      acknowledgeUserMessage(event.uuid);
      // The echo shows Claude read the prompt; a duplicate it drops gets no
      // lifecycle frame, only the echo and an idle report.
      if (typeof event.uuid === 'string' && prompts.get(event.uuid) === 'written') prompts.set(event.uuid, 'queued');
      applyToolResults(event);
      applySubagentPrompt(event, parentOf(event));
    } else if (event.type === 'stream_event') {
      acknowledgeUserMessage(event.user_message_uuid);
      applyStreamEvent(record(event.event), parentOf(event));
    } else if (event.type === 'control_response') {
      const response = record(event.response);
      const titleRequest = typeof response.request_id === 'string' ? titleRequests.get(response.request_id) : undefined;
      if (titleRequest) {
        const value = record(response.response).title;
        titleRequest(response.subtype === 'success' && typeof value === 'string' && value.trim() ? value.trim() : null);
      } else if (response.request_id === INITIALIZE_REQUEST_ID && response.subtype === 'success') {
        const result = record(response.response);
        if (Array.isArray(result.models)) models = result.models.map(record);
        if (Array.isArray(result.commands)) commands = result.commands.map(record);
        if (typeof result.current_permission_mode === 'string') mode = nativeMode(result.current_permission_mode);
        publish({ kind: 'pending' });
        requestSettings();
      } else if (response.request_id === SETTINGS_REQUEST_ID && response.subtype === 'success') {
        const applied = record(record(response.response).applied);
        appliedEffort = typeof applied.effort === 'string' ? applied.effort : null;
        publish({ kind: 'pending' });
      }
    } else if (event.type === 'system') {
      receiveSystem(event);
    } else if (event.type === 'control_cancel_request' && (typeof event.request_id === 'string' || typeof event.request_id === 'number')) {
      // Claude withdrew the request (for example the turn was interrupted), so
      // its prompt must not linger or accept a late answer.
      if (pending.has(String(event.request_id))) settlePending(String(event.request_id));
    } else if (event.type === 'control_request' && (typeof event.request_id === 'string' || typeof event.request_id === 'number')) {
      receiveControlRequest(String(event.request_id), event);
    } else if (event.type === 'rate_limit_event') {
      recordRateLimit(record(event.rate_limit_info));
      publish({ kind: 'pending' });
    } else if (event.type === 'command_lifecycle') {
      receiveLifecycle(event);
    } else if (event.type !== 'result') {
      countUnhandled(String(event.type ?? 'unknown'));
    } else {
      acknowledgeUserMessage(event.user_message_uuid);
      recordResultUsage(event);
      // `is_error` decides the state; a `success` subtype with is_error set is
      // still a failed turn (for example an expired credential).
      const stopped = interrupted && event.subtype === 'error_during_execution';
      interrupted = false;
      turnActive = false;
      // The result settles the prompt that started its turn. Prompts folded
      // into the turn settled before it; queued ones are still to run.
      if (typeof event.user_message_uuid === 'string') prompts.delete(event.user_message_uuid);
      if (!lifecycleReported) prompts.clear();
      // The main agent's prompts end with its turn and each gets an explicit
      // reply; background subagents keep running and keep theirs.
      closeMainPrompts();
      streams.delete('');
      // A finished turn has no in-flight tools; any still running were cut short.
      // Background subagents keep working after the main turn ends, so their
      // tools are left alone unless the turn was interrupted.
      settleRunningTools(stopped ? 'Interrupted' : 'Turn ended before the tool finished', !stopped);
      failed = !stopped && Boolean(event.is_error);
      if (failed) {
        statusDetail = String(event.result ?? event.subtype ?? 'Claude turn failed');
        upsertMessage({ id: `result_${randomUUID()}`, role: 'assistant', kind: 'notice', level: 'error', text: statusDetail }, true, true);
      }
      // A background agent still running or waiting on a prompt keeps the
      // agent working or waiting; there is no idle in between.
      updateStatus();
      settleRetryNotice(!event.is_error);
    }
  }
}

// The fate of a prompt this host sent: queued, started into a turn, then
// completed, cancelled, discarded, or refused. Commands Claude enqueues
// itself are covered by its session state.
function receiveLifecycle(event: JsonRecord): void {
  const id = typeof event.command_uuid === 'string' ? event.command_uuid : '';
  if (!id) return;
  lifecycleReported = true;
  if (!prompts.has(id)) return;
  if (event.state === 'queued' || event.state === 'started') prompts.set(id, event.state);
  else prompts.delete(id);
  updateStatus();
}

function sessionRunning(): boolean {
  return sessionState === 'running' || sessionState === 'requires_action';
}

// The main agent only starts a model request during a turn. While a session
// runs only for a background agent, this marks the turn that agent's finish
// wakes, so interrupting it is not reported as a failure.
function markMainTurnRunning(): void {
  if (turnActive || !sessionRunning()) return;
  turnActive = true;
  updateStatus();
}

// Claude's report of what runs: a turn it starts on its own (for example when
// a background task finishes and wakes it) shows as working, and background
// agents keep it running after the main turn's result.
function receiveSessionState(state: unknown): void {
  if (typeof state !== 'string') return;
  const started = state === 'running' && !sessionRunning();
  sessionState = state;
  if (started) turnActive = true;
  if (state === 'idle') {
    turnActive = false;
    interrupted = false;
    // A prompt Claude has not read yet is newer than this report; one it
    // queued or started has run, since Claude idles only with an empty queue.
    for (const [id, fate] of prompts) if (fate !== 'written') prompts.delete(id);
  }
  updateStatus();
}

// Tasks shown as background work: neither a foreground tool nor ambient.
function backgroundTasks(): JsonRecord[] {
  return [...tasks.values()].filter((task) => !foregroundTasks.has(String(task.id)) && !ambientTasks.has(String(task.id)));
}

// Background agents keep the agent working after its turn. Background shells
// and monitors do not: a dev server can run for as long as the session.
function backgroundAgentCount(): number {
  if (backgroundAgentLevel !== null) return backgroundAgentLevel;
  return backgroundTasks().filter((task) => task.kind === 'local_agent' && task.stoppable === true).length;
}

function busy(): boolean {
  if (!child) return false;
  if (turnActive || prompts.size > 0) return true;
  // Claude's session state already covers background agents.
  if (sessionState !== null) return sessionState !== 'idle';
  return backgroundAgentCount() > 0;
}

// The one place status is decided. A pending prompt needs a person; otherwise
// the agent works while a turn, an unsettled prompt, or a background agent
// runs; a failure shows once nothing does.
function updateStatus(): void {
  setStatus(pending.size ? 'permission' : busy() ? 'working' : failed ? 'failed' : 'idle');
}

// Only requests a person can answer become pending prompts. Every other
// subtype gets the reply the protocol defines for a host that does not handle
// it, so the turn never waits on a prompt nobody can see or answer correctly.
function receiveControlRequest(requestId: string, event: JsonRecord): void {
  const request = record(event.request);
  const input = record(request.input);
  if (request.subtype === 'can_use_tool' && request.tool_name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    pending.set(requestId, { id: requestId, kind: 'question', raw: event, questions: input.questions });
  } else if (request.subtype === 'can_use_tool') {
    // Claude only persists a rule when the native request offers permission
    // suggestions; otherwise Always allow would silently degrade to once.
    const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
    const plan = request.tool_name === 'ExitPlanMode' && typeof input.plan === 'string' ? input.plan : null;
    const action = plan ? 'Approve the plan?' : String(request.title ?? request.tool_name ?? 'Permission');
    const detail = [
      typeof request.description === 'string' ? request.description : '',
      typeof request.decision_reason === 'string' ? request.decision_reason : '',
      typeof request.blocked_path === 'string' ? `Outside the allowed directories: ${request.blocked_path}` : ''
    ].filter(Boolean).join('\n');
    const command = typeof input.command === 'string' ? input.command : '';
    const patch = editPreview(input);
    pending.set(requestId, {
      id: requestId, kind: 'permission', raw: event,
      // A subagent's request pauses the whole turn; say whose it is.
      action: typeof request.agent_id === 'string' && request.agent_id ? `Subagent: ${action}` : action,
      resources: command || patch || plan ? [] : [request.input].filter(Boolean).map((value) => JSON.stringify(value)),
      ...(detail ? { detail } : {}),
      ...(command ? { command } : {}),
      ...(patch ? { patch } : {}),
      feedback: true,
      ...(plan
        ? { plan, always: true, always_label: 'Yes, auto-accept edits', once_label: 'Yes, approve edits manually', reject_label: 'No, keep planning' }
        : { always: suggestions.length > 0 })
    });
  } else if (request.subtype === 'elicitation') {
    const server = typeof request.mcp_server_name === 'string' ? request.mcp_server_name : '';
    pending.set(requestId, {
      id: requestId, kind: 'form', raw: event,
      form: elicitationForm({
        id: requestId,
        message: String(request.message ?? ''),
        title: typeof request.title === 'string' ? request.title : undefined,
        source: server ? `the ${String(request.display_name ?? server)} MCP server` : undefined,
        mode: typeof request.mode === 'string' ? request.mode : undefined,
        schema: request.requested_schema,
        url: typeof request.url === 'string' ? request.url : undefined
      })
    });
  } else {
    // Unrecognised dialogs must be answered as cancelled; hook callbacks and
    // SDK MCP messages have no registered handler here.
    writeClaude({
      type: 'control_response',
      response: request.subtype === 'request_user_dialog'
        ? { subtype: 'success', request_id: requestId, response: { behavior: 'cancelled' } }
        : { subtype: 'error', request_id: requestId, error: `Patterm does not handle ${String(request.subtype ?? 'this request')}` }
    });
    return;
  }
  updateStatus();
  publish({ kind: 'pending' });
}

// A readable preview of what an Edit, MultiEdit, or Write would change.
// Bounded so a large file cannot flood the permission card.
function editPreview(input: JsonRecord): string {
  const file = typeof input.file_path === 'string' ? input.file_path : '';
  const lines: string[] = [];
  const hunk = (before: unknown, after: unknown): void => {
    lines.push('@@');
    if (typeof before === 'string' && before) lines.push(...before.split('\n').map((line) => `-${line}`));
    if (typeof after === 'string' && after) lines.push(...after.split('\n').map((line) => `+${line}`));
  };
  if (typeof input.old_string === 'string' || typeof input.new_string === 'string') hunk(input.old_string, input.new_string);
  else if (Array.isArray(input.edits)) for (const edit of input.edits.map(record)) hunk(edit.old_string, edit.new_string);
  else if (typeof input.content === 'string') hunk('', input.content);
  if (!lines.length) return '';
  const bounded = lines.length > 200 ? [...lines.slice(0, 200), `… ${lines.length - 200} more lines`] : lines;
  return [file ? `+++ ${file}` : '', ...bounded].filter(Boolean).join('\n');
}

// Answering or withdrawing the last prompt resumes whatever still runs: the
// main turn or a background agent. A background agent's prompt answered
// after both have ended returns to idle.
function settlePending(requestId: string): void {
  pending.delete(requestId);
  updateStatus();
  publish({ kind: 'pending' });
}

// A request is a background subagent's when it names one.
function fromSubagent(item: JsonRecord): boolean {
  const agent = record(record(item.raw).request).agent_id;
  return typeof agent === 'string' && agent.length > 0;
}

// Replies the protocol expects when a prompt goes unanswered, so nothing
// waits on a reply that will never come.
function closeMainPrompts(): void {
  for (const [requestId, item] of [...pending]) {
    if (fromSubagent(item)) continue;
    const response = item.kind === 'form'
      ? { action: 'cancel' }
      : { behavior: 'deny', message: 'The turn ended before this was answered', interrupt: false };
    try {
      writeClaude({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    } catch { /* a dead process has nothing waiting */ }
    pending.delete(requestId);
  }
  if (pending.size) publish({ kind: 'pending' });
}

// The final assistant frames repeat the streamed blocks one block at a time
// (or as one cumulative array in the non-streaming fallback). Rows are keyed by
// the native message id and the block's stream index, or by the native tool id,
// so reconciliation replaces them instead of appending duplicates and a later
// block never overwrites an earlier one.
function applyAssistantMessage(event: JsonRecord, parent: string | null): void {
  const message = record(event.message);
  const messageId = String(message.id ?? randomUUID());
  const content = Array.isArray(message.content) ? message.content : [];
  const cumulative = content.length > 1;
  const nested = parent ? { parentId: parent } : {};
  for (const [position, part] of content.entries()) {
    const block = record(part);
    if (block.type === 'text') {
      const index = cumulative ? position : takeBlockIndex(messageId, parent);
      upsertMessage({ id: `${messageId}_${index}`, role: 'assistant', kind: 'text', text: String(block.text ?? ''), ...nested }, true, true);
      continue;
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      const index = cumulative ? position : takeBlockIndex(messageId, parent);
      upsertMessage({ id: `${messageId}_${index}`, role: 'assistant', kind: 'reasoning', text: String(block.thinking ?? ''), ...nested }, true, true);
      continue;
    }
    if (block.type === 'tool_use') {
      if (!cumulative) takeBlockIndex(messageId, parent);
      const toolId = String(block.id ?? randomUUID());
      const existing = messages[messageIndex(toolId)];
      const tool = record(record(existing).tool);
      const state = record(tool.state);
      const settled = state.status === 'completed' || state.status === 'error';
      upsertMessage({
        id: toolId, role: 'assistant', kind: 'tool',
        title: String(block.name ?? 'Tool'),
        text: String(record(existing).text ?? ''),
        tool: {
          name: String(block.name ?? 'Tool'),
          input: record(block.input),
          state: settled ? state : { status: 'running' },
          ...(tool.result !== undefined ? { result: tool.result } : {})
        },
        ...nested
      }, true);
    }
  }
}

// Prefer the stream index of the block that just stopped; fall back to the next
// free index for the message so a frame without stream events still gets a
// stable, non-colliding identity.
function takeBlockIndex(messageId: string, parent: string | null): number {
  const stream = streams.get(parent ?? '');
  const streamed = stream?.messageId === messageId && stream.stopped.length ? stream.stopped.shift() : undefined;
  const next = nextBlockIndex.get(messageId) ?? 0;
  const index = streamed !== undefined ? Math.max(streamed, next) : next;
  nextBlockIndex.set(messageId, index + 1);
  return index;
}

// Partial native frames: text and reasoning append to their stable rows, tool
// input accumulates as a partial JSON string, and each change is published as a
// targeted event. Completion is not required for the partial state to be
// readable.
function applyStreamEvent(event: JsonRecord, parent: string | null): void {
  const type = String(event.type ?? '');
  const key = parent ?? '';
  if (type === 'message_start') {
    streams.set(key, { messageId: String(record(event.message).id ?? randomUUID()), blocks: new Map(), toolInput: new Map(), stopped: [] });
    if (!parent) {
      usage.lastModelActivityAt = new Date().toISOString();
      markMainTurnRunning();
    }
    return;
  }
  if (type === 'message_stop') {
    streams.delete(key);
    return;
  }
  const stream = streams.get(key);
  if (!stream) return;
  const nested = parent ? { parentId: parent } : {};
  const index = typeof event.index === 'number' ? event.index : -1;
  if (index < 0) return;
  if (type === 'content_block_start') {
    const block = record(event.content_block);
    if (!stream.messageId) return;
    const id = `${stream.messageId}_${index}`;
    if (block.type === 'text') {
      stream.blocks.set(index, id);
      upsertMessage({ id, role: 'assistant', kind: 'text', text: String(block.text ?? ''), ...nested }, true);
      return;
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      stream.blocks.set(index, id);
      upsertMessage({ id, role: 'assistant', kind: 'reasoning', text: String(block.thinking ?? ''), ...nested }, true);
      return;
    }
    if (block.type === 'tool_use') {
      const toolId = String(block.id ?? randomUUID());
      stream.blocks.set(index, toolId);
      stream.toolInput.set(index, '');
      upsertMessage({
        id: toolId, role: 'assistant', kind: 'tool',
        title: String(block.name ?? 'Tool'), text: '',
        tool: { name: String(block.name ?? 'Tool'), input: '', state: { status: 'running' } },
        ...nested
      }, true);
    }
    return;
  }
  const id = stream.blocks.get(index);
  if (!id) return;
  if (type === 'content_block_delta') {
    const delta = record(event.delta);
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      appendText(id, delta.text);
      publish({ kind: 'append', id, delta: delta.text });
      return;
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      appendText(id, delta.thinking);
      publish({ kind: 'append', id, delta: delta.thinking });
      return;
    }
    if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const partial = `${stream.toolInput.get(index) ?? ''}${delta.partial_json}`;
      stream.toolInput.set(index, partial);
      patchMessage(id, { tool: { ...record(record(messages[messageIndex(id)]).tool), input: partial, state: { status: 'running' } } }, true);
    }
    return;
  }
  if (type === 'content_block_stop') {
    if (!stream.stopped.includes(index)) stream.stopped.push(index);
    const row = messages[messageIndex(id)];
    // A text or thinking block is finished here; a tool finishes with its result.
    if (row && row.kind !== 'tool' && typeof row.completed_at !== 'string') patchMessage(id, { completed_at: new Date().toISOString() }, true);
    else if (row) publish({ kind: 'replace', message: row });
  }
}

// Tool results pair by the native tool_use id. The structured
// `tool_use_result` frame wins when present; content blocks are the fallback.
// No user row is added for a result frame.
function applyToolResults(event: JsonRecord): void {
  const message = record(event.message);
  const content = Array.isArray(message.content) ? message.content : [];
  const results = content.filter((part) => record(part).type === 'tool_result');
  // Native frames carry one tool result and its structured twin; only pair the
  // structured result when the frame has exactly one result.
  const structured = results.length === 1 ? event.tool_use_result : undefined;
  let applied = false;
  for (const part of results) {
    const block = record(part);
    const toolUseId = String(block.tool_use_id ?? '');
    const index = messageIndex(toolUseId);
    if (index < 0) continue;
    const row = messages[index]!;
    const tool = record(row.tool);
    // An image result (Read of a PNG, an MCP screenshot) keeps a stored
    // reference; its base64 never becomes output text or the structured result.
    const shown = toolResultImages(block.content, structured);
    const imageResult = record(structured).type === 'image';
    const output = boundText(imageResult ? '' : toolResultText(structured) || toolResultText(block.content));
    const failed = block.is_error === true;
    const result = imageResult ? undefined : boundResult(withoutImageData(structured));
    const next: JsonRecord = {
      ...row,
      completed_at: typeof row.completed_at === 'string' ? row.completed_at : new Date().toISOString(),
      text: output,
      tool: {
        ...tool,
        output,
        ...(result !== undefined ? { result } : {}),
        ...(shown.length ? { images: shown } : {}),
        state: failed ? { status: 'error', error: { message: output || 'Tool failed' } } : { status: 'completed' }
      }
    };
    messages[index] = next;
    publish({ kind: 'replace', message: next });
    applied = true;
  }
  if (applied) trimMessages();
}

function receiveSystem(event: JsonRecord): void {
  if (typeof event.permissionMode === 'string') {
    mode = nativeMode(event.permissionMode);
    publish({ kind: 'pending' });
  }
  if (event.subtype === 'task_started' || event.subtype === 'task_progress' || event.subtype === 'task_updated' || event.subtype === 'task_notification') {
    receiveTask(event);
    return;
  }
  if (event.subtype === 'session_state_changed') {
    receiveSessionState(event.state);
    return;
  }
  // The full set of live background tasks; only agents keep the agent working.
  if (event.subtype === 'background_tasks_changed') {
    backgroundAgentLevel = (Array.isArray(event.tasks) ? event.tasks.map(record) : [])
      .filter((task) => task.task_type === 'local_agent' && task.ambient !== true).length;
    updateStatus();
    return;
  }
  if (event.subtype === 'api_retry') {
    retryNotice ??= { id: `retry_${++noticeSequence}`, attempts: 0 };
    retryNotice.attempts = typeof event.attempt === 'number' ? event.attempt : retryNotice.attempts + 1;
    const max = typeof event.max_retries === 'number' ? ` of ${event.max_retries}` : '';
    const delay = typeof event.retry_delay_ms === 'number' ? ` in ${Math.max(1, Math.round(event.retry_delay_ms / 1000))}s` : '';
    const reason = [typeof event.error_status === 'number' ? String(event.error_status) : '', typeof event.error === 'string' ? event.error.replace(/_/g, ' ') : ''].filter(Boolean).join(' ');
    upsertMessage({ id: retryNotice.id, role: 'assistant', kind: 'notice', level: 'warning', text: `API request failed${reason ? ` (${reason})` : ''}; retrying${delay} (attempt ${retryNotice.attempts}${max})` }, true);
    return;
  }
  if (event.subtype === 'status') {
    if (event.status === 'compacting' && !compactNotice) {
      compactNotice = `compact_${++noticeSequence}`;
      upsertMessage({ id: compactNotice, role: 'assistant', kind: 'notice', level: 'info', text: 'Compacting the conversation…' }, true);
    } else if (event.compact_result === 'failed') {
      upsertMessage({ id: compactNotice ?? `compact_${++noticeSequence}`, role: 'assistant', kind: 'notice', level: 'error', text: `Compaction failed${typeof event.compact_error === 'string' ? `: ${event.compact_error}` : ''}` }, true, true);
      compactNotice = null;
    }
    return;
  }
  if (event.subtype === 'compact_boundary') {
    const metadata = record(event.compact_metadata);
    const before = typeof metadata.pre_tokens === 'number' ? ` from ${Math.round(metadata.pre_tokens / 1000)}k tokens` : '';
    const after = typeof metadata.post_tokens === 'number' ? ` to ${Math.round(metadata.post_tokens / 1000)}k` : '';
    upsertMessage({ id: compactNotice ?? `compact_${++noticeSequence}`, role: 'assistant', kind: 'notice', level: 'info', text: `Conversation compacted${metadata.trigger === 'auto' ? ' automatically' : ''}${before}${after}` }, true, true);
    compactNotice = null;
    return;
  }
  // Output of local slash commands such as /cost or /context.
  if (event.subtype === 'local_command_output' && typeof event.content === 'string' && event.content.trim()) {
    upsertMessage({ id: `command_${typeof event.uuid === 'string' ? event.uuid : randomUUID()}`, role: 'assistant', kind: 'text', text: boundText(event.content) }, true, true);
    return;
  }
  if (event.subtype === 'notification' && typeof event.text === 'string' && event.text.trim()) {
    upsertMessage({ id: `notification_${typeof event.uuid === 'string' ? event.uuid : randomUUID()}`, role: 'assistant', kind: 'notice', level: event.priority === 'high' || event.priority === 'immediate' ? 'warning' : 'info', text: event.text }, true, true);
    return;
  }
  countUnhandled(`system/${String(event.subtype ?? 'unknown')}`);
}

function receiveTask(event: JsonRecord): void {
  const id = typeof event.task_id === 'string' ? event.task_id : '';
  if (!id) return;
  const current = tasks.get(id) ?? { id, label: 'Background task', status: 'running', stoppable: true };
  const next: JsonRecord = { ...current };
  if (event.subtype === 'task_started') {
    next.label = String(event.workflow_name ?? event.description ?? current.label);
    const kind = event.task_type ?? event.subagent_type;
    if (typeof kind === 'string') next.kind = kind;
    next.status = 'running';
    if (event.is_backgrounded === false) foregroundTasks.add(id);
    if (event.ambient === true) ambientTasks.add(id);
  } else if (event.subtype === 'task_progress') {
    const detail = event.summary ?? (typeof event.last_tool_name === 'string' ? `Using ${event.last_tool_name}` : undefined);
    if (typeof detail === 'string') next.detail = detail;
  } else if (event.subtype === 'task_updated') {
    const patch = record(event.patch);
    if (typeof patch.status === 'string') next.status = patch.status === 'killed' ? 'stopped' : patch.status;
    if (typeof patch.description === 'string') next.label = patch.description;
    if (typeof patch.error === 'string') next.detail = patch.error;
    if (patch.is_backgrounded === true) foregroundTasks.delete(id);
    if (patch.is_backgrounded === false) foregroundTasks.add(id);
  } else {
    next.status = event.status === 'failed' ? 'failed' : event.status === 'stopped' ? 'stopped' : 'completed';
    if (typeof event.summary === 'string' && event.summary) next.detail = event.summary;
  }
  next.stoppable = next.status === 'running' || next.status === 'pending' || next.status === 'paused';
  tasks.delete(id);
  tasks.set(id, next);
  // Drop the oldest finished tasks beyond the limit; running ones stay.
  for (const [key, task] of tasks) {
    if (tasks.size <= TASK_LIMIT) break;
    if (task.stoppable) continue;
    tasks.delete(key);
    foregroundTasks.delete(key);
    ambientTasks.delete(key);
  }
  // Without native session state, a background agent's tasks decide whether
  // the agent still works after its turn.
  updateStatus();
  publish({ kind: 'pending' });
}

// A retry run that ends in a finished turn says it recovered.
function settleRetryNotice(recovered: boolean): void {
  if (!retryNotice) return;
  if (recovered) {
    const attempts = retryNotice.attempts;
    upsertMessage({ id: retryNotice.id, role: 'assistant', kind: 'notice', level: 'info', text: `Recovered after ${attempts} ${attempts === 1 ? 'retry' : 'retries'}` }, true, true);
  }
  retryNotice = null;
}

function recordContext(value: JsonRecord): void {
  const tokens = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .reduce((sum, key) => sum + (typeof value[key] === 'number' ? value[key] as number : 0), 0);
  if (tokens > 0) usage.contextTokens = tokens;
}

// total_cost_usd and modelUsage are totals for this Claude process.
function recordResultUsage(event: JsonRecord): void {
  if (typeof event.total_cost_usd === 'number') usage.costUsd = event.total_cost_usd;
  const models = Object.values(record(event.modelUsage)).map(record);
  if (!models.length) return;
  const sum = (key: string): number => models.reduce((total, model) => total + (typeof model[key] === 'number' ? model[key] as number : 0), 0);
  usage.inputTokens = sum('inputTokens') + sum('cacheReadInputTokens') + sum('cacheCreationInputTokens');
  usage.outputTokens = sum('outputTokens');
  const window = Math.max(0, ...models.map((model) => typeof model.contextWindow === 'number' ? model.contextWindow : 0));
  if (window > 0) usage.contextWindow = window;
}

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5h limit', seven_day: 'Weekly limit', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet', overage: 'Overage'
};

// Claude Code 2.1 reports every quota window under unifiedWindows; older
// builds sent one window with a top-level utilization.
function recordRateLimit(info: JsonRecord): void {
  const windows = record(info.unifiedWindows);
  for (const [type, window] of Object.entries(windows)) recordLimitWindow(type, record(window));
  if (!Object.keys(windows).length) recordLimitWindow(typeof info.rateLimitType === 'string' ? info.rateLimitType : 'limit', info);
}

function recordLimitWindow(type: string, info: JsonRecord): void {
  if (typeof info.utilization !== 'number') return;
  // Utilisation is a fraction; tolerate a percentage too.
  const usedPercent = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
  const resets = typeof info.resetsAt === 'number' ? new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt).toISOString() : undefined;
  // observedAt dates the reading, so an idle session's old quota cannot pass for a new one.
  limits.set(type, { label: LIMIT_LABELS[type] ?? type, usedPercent, ...(resets ? { resetsAt: resets } : {}), observedAt: new Date().toISOString() });
}

function parentOf(event: JsonRecord): string | null {
  return typeof event.parent_tool_use_id === 'string' && event.parent_tool_use_id ? event.parent_tool_use_id : null;
}

// A subagent's opening prompt arrives as a user frame under its Task tool.
// It is shown nested (the main agent's own prompts are local rows already).
function applySubagentPrompt(event: JsonRecord, parent: string | null): void {
  if (!parent) return;
  const content = record(event.message).content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map(record).filter((part) => part.type === 'text').map((part) => String(part.text ?? '')).join('\n') : '';
  if (!text.trim()) return;
  const id = typeof event.uuid === 'string' ? `subagent_${event.uuid}` : `subagent_${randomUUID()}`;
  upsertMessage({ id, role: 'user', kind: 'text', text, parentId: parent }, true, true);
}

function settleRunningTools(message: string, keepSubagents = false): void {
  for (const [index, row] of messages.entries()) {
    const tool = record(row.tool);
    if (row.kind !== 'tool' || record(tool.state).status !== 'running') continue;
    if (keepSubagents && typeof row.parentId === 'string') continue;
    const next: JsonRecord = { ...row, completed_at: typeof row.completed_at === 'string' ? row.completed_at : new Date().toISOString(), tool: { ...tool, state: { status: 'error', error: { message } } } };
    messages[index] = next;
    publish({ kind: 'replace', message: next });
  }
}

// Claude Code reports manual mode under its older name.
function nativeMode(value: string): string {
  return value === 'default' ? 'manual' : value;
}

function writeClaude(message: unknown): void {
  if (!child?.stdin.writable) throw new Error('Claude process is not running');
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function respond(socket: net.Socket, id: unknown, result?: unknown, error?: unknown): void {
  socket.write(`${JSON.stringify(error ? { id, error: error instanceof Error ? error.message : String(error) } : { id, result })}\n`);
}

// Subagents can stream hundreds of rows, so they get their own budget and
// cannot evict the main thread. Rows under a trimmed tool row go with it;
// otherwise they would render in the main thread.
const MAIN_ROW_LIMIT = 400;
const SUBAGENT_ROW_LIMIT = 400;

function trimMessages(): void {
  if (messages.length <= MAIN_ROW_LIMIT) return;
  let main = 0;
  let nested = 0;
  for (const row of messages) {
    if (typeof row.parentId === 'string') nested += 1; else main += 1;
  }
  if (main <= MAIN_ROW_LIMIT && nested <= SUBAGENT_ROW_LIMIT) return;
  let dropMain = main - MAIN_ROW_LIMIT;
  let dropNested = nested - SUBAGENT_ROW_LIMIT;
  const dropped = new Set<string>();
  const kept = messages.filter((row) => {
    const parent = typeof row.parentId === 'string' ? row.parentId : null;
    const drop = parent ? dropNested-- > 0 || dropped.has(parent) : dropMain-- > 0;
    if (drop) dropped.add(String(row.id));
    return !drop;
  });
  messages.splice(0, messages.length, ...kept);
}

function acknowledgeUserMessage(value: unknown): void {
  if (typeof value !== 'string' || !userMessages.has(value)) return;
  userMessages.set(value, true);
}

// Every published event advances one revision. The conversation snapshot
// captures the current revision before building its payload, so a client can
// drop events the snapshot already contains and apply newer ones afterwards.
function publish(event: JsonRecord): void {
  revision += 1;
  const line = `${JSON.stringify({ event: { ...event, revision } })}\n`;
  for (const socket of subscribers) {
    try { socket.write(line); } catch { subscribers.delete(socket); }
  }
}

function messageIndex(id: string): number {
  return messages.findIndex((message) => message.id === id);
}

// created_at marks where the live window starts, so older turns can be
// filled in from imported history without overlapping it. Stream-json frames
// carry no native times, so both stamps are the host's: created_at when the
// row is first seen, completed_at once (when `complete`, or later when the
// block stops or the tool result arrives). Neither is overwritten.
function upsertMessage(message: JsonRecord, notify: boolean, complete = false): void {
  const index = messageIndex(String(message.id));
  const existing = index >= 0 ? messages[index]! : undefined;
  const now = new Date().toISOString();
  const completedAt = typeof existing?.completed_at === 'string' ? existing.completed_at : complete ? now : undefined;
  const row = {
    ...message,
    created_at: typeof existing?.created_at === 'string' ? existing.created_at : now,
    ...(completedAt ? { completed_at: completedAt } : {})
  };
  if (index >= 0) messages[index] = row; else messages.push(row);
  trimMessages();
  if (notify) publish({ kind: 'replace', message: row });
}

function patchMessage(id: string, changes: JsonRecord, notify: boolean): void {
  const index = messageIndex(id);
  if (index < 0) return;
  const row = { ...messages[index], ...changes };
  messages[index] = row;
  if (notify) publish({ kind: 'replace', message: row });
}

function appendText(id: string, delta: string): void {
  const index = messageIndex(id);
  if (index < 0) return;
  const row = messages[index]!;
  messages[index] = { ...row, text: `${String(row.text ?? '')}${delta}` };
}

// Streamed as working, permission, idle, or error. The snapshot reports the
// raw status, and ClaudeStreamService maps failed to error there.
function setStatus(next: string): void {
  if (status === next) return;
  status = next;
  publish({ kind: 'status', status: next === 'failed' ? 'error' : next });
}

function toolResultImages(content: unknown, structured: unknown): TranscriptImageRef[] {
  if (!images || !Array.isArray(content)) return [];
  const dimensions = record(record(record(structured).file).dimensions);
  const width = Number(dimensions.displayWidth ?? dimensions.originalWidth);
  const height = Number(dimensions.displayHeight ?? dimensions.originalHeight);
  return content.slice(0, 20).flatMap((part) => {
    const block = record(part);
    const source = record(block.source);
    if (block.type !== 'image' || source.type !== 'base64') return [];
    const image = images.fromBase64(source.data);
    if (!image) return [];
    return [{ ...image, ...(width > 0 && height > 0 ? { width, height } : {}) }];
  });
}

// Structured results can embed image blocks (MCP tools) whose base64 must not
// be kept as the displayed result.
function withoutImageData(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => withoutImageData(item, depth + 1));
  const row = value as JsonRecord;
  if (row.type === 'image' || row.type === 'base64') return { type: row.type };
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'base64').map(([key, item]) => [key, withoutImageData(item, depth + 1)]));
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const block = record(item);
      if (typeof block.text === 'string') return [block.text];
      if (typeof block.content === 'string') return [block.content];
      return [];
    }).join('\n');
  }
  const row = record(value);
  if (typeof row.text === 'string') return row.text;
  if (typeof row.content === 'string') return row.content;
  if (typeof row.stdout === 'string' || typeof row.stderr === 'string') {
    return [typeof row.stdout === 'string' ? row.stdout : '', typeof row.stderr === 'string' ? row.stderr : ''].filter(Boolean).join('\n');
  }
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return ''; }
}

function boundText(value: string): string {
  return value.length > 200_000 ? `${value.slice(0, 200_000)}\n… output truncated` : value;
}

// Structured native results (a Claude Edit carries filePath, originalFile,
// structuredPatch, and sometimes gitDiff) are preserved for real tool and diff
// rendering, bounded so one result cannot flood the channel.
function boundResult(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return boundText(value);
  let serialized: string;
  try { serialized = JSON.stringify(value) ?? ''; } catch { return undefined; }
  if (serialized.length <= 200_000) return value;
  return { truncated: true, text: toolResultText(value).slice(0, 200_000) };
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function cleanup(): void {
  for (const filename of [config.socketPath, config.mcpConfigPath, contextPath, process.argv[2]!]) {
    try { fs.unlinkSync(filename); } catch {}
  }
}
process.on('exit', cleanup);
process.on('SIGTERM', shutdown);
// Windows never delivers SIGTERM; Ctrl+Break is its console stop request. A
// host ended outright takes claude.exe with it through Node's job object.
if (process.platform === 'win32') process.on('SIGBREAK', shutdown);

function shutdown(): void {
  for (const subscriber of subscribers) subscriber.destroy();
  subscribers.clear();
  const stopped = stopClaude();
  server.close(() => void stopped.then(() => process.exit(0)));
}

// Windows has no SIGTERM, and ending claude.exe alone would orphan its MCP
// servers and tool shells, so its whole tree ends there.
function stopClaude(): Promise<void> {
  if (process.platform !== 'win32') {
    child?.kill('SIGTERM');
    return Promise.resolve();
  }
  return child?.pid ? killProcessTree(child.pid) : Promise.resolve();
}

function uploadLabel(images: number, documents: number): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return [images ? count(images, 'image') : '', documents ? count(documents, 'file') : ''].filter(Boolean).join(', ');
}
