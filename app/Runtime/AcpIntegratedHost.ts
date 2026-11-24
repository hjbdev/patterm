import './HostEnvironment';
import fs from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveCommand } from '../Platform/Executable';
import { ipcPath, removeStaleIpc, restrictIpc } from '../Platform/Ipc';
import { killProcessTree } from '../Platform/ProcessTree';
import type { IntegratedConversationMessage } from '../Services/IntegratedConversation';
import { TranscriptImageStore } from '../Services/TranscriptImageStore';
import { readAcpSettings, writeAcpSettings } from '../Services/AcpSessionSettings';
import { watchAntigravityPrompt } from './AntigravityPromptReceipt';
import { AntigravitySubagentTracker } from './AntigravitySubagents';

type Row = Record<string, any>;
class NativeAcpTransportError extends Error {}
const TOOL_FIELD_BYTES = 96 * 1024;
const STOP_REASONS: Record<string, string> = {
  max_tokens: 'Antigravity stopped at its token limit.',
  max_turn_requests: 'Antigravity stopped at its request limit.',
  refusal: 'Antigravity declined to continue.'
};
interface Config {
  socketPath: string;
  settingsDirectory: string;
  executable: string;
  cwd: string;
  resumeId: string | null;
  context: string;
  model: string | null;
  reasoning: string | null;
  restoreSavedSettings?: boolean;
  mcpServers: unknown[];
  imageDirectory?: string;
}

export interface AcpHostSession {
  socketPath: string;
  stop(): Promise<void>;
}

export interface AcpHostSessionOptions {
  onExit?: (code: number) => void;
}

// ACP is a native CLI transport, not a model API. This host advertises no
// filesystem or terminal capabilities: the agent owns its tools and sandbox.
export function startAcpHostSession(
  configPath: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
  sessionOptions: AcpHostSessionOptions = {}
): AcpHostSession {
const BACKGROUND_QUIET_MS = Number(hostEnv.PATTERM_ACP_BACKGROUND_QUIET_MS) || 10_000;
const CANCEL_TIMEOUT_MS = Number(hostEnv.PATTERM_ACP_CANCEL_TIMEOUT_MS) || 15_000;
const PAGE_MESSAGES = 200;
const PAGE_BYTES = 1024 * 1024;
const MAX_MESSAGES = Math.max(PAGE_MESSAGES, Number(hostEnv.PATTERM_ACP_MAX_MESSAGES) || 1000);
const MAX_SUBAGENT_MESSAGES = Math.max(100, Number(hostEnv.PATTERM_ACP_MAX_SUBAGENT_MESSAGES) || 400);
const MAX_TRACKED_IDS = 1000;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Config;
const images = config.imageDirectory ? new TranscriptImageStore(config.imageDirectory) : null;
const subscribers = new Set<net.Socket>();
const requests = new Map<string, { resolve: (result: Row) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | null }>();
const permissions = new Map<string, Row>();
const messages: IntegratedConversationMessage[] = [];
const subagentMessages: IntegratedConversationMessage[] = [];
let droppedMessages = 0;
const deliveries = new Set<string>();
let sessionId = config.resumeId ?? '';
let subagents: AntigravitySubagentTracker | null = null;
let status = 'starting';
let statusDetail = '';
let workingDetail = '';
let revision = 0;
let controlsRevision = 0;
let active = false;
// A steer ends the session/prompt it joins; only the newest one ends the turn.
let turnSeq = 0;
let currentTurn = 0;
const openTurns = new Set<number>();
let backgroundQuiet: NodeJS.Timeout | null = null;
const runningTools = new Set<string>();
// Tools Patterm has already reported as failed: never auto-approve them later.
const abandonedToolIds = new Set<string>();
const stoppedToolIds = new Set<string>();
const backgroundCommands = new Map<string, { label: string; stopRequested: boolean }>();
const MAX_FINISHED_COMMANDS = 20;
let cancelDeadline: NodeJS.Timeout | null = null;
let cancelWatchingTools = false;
let nativeClose = false;
let stopping = false;
let shutdown: Promise<void> | null = null;
let exitPromise: Promise<void> | null = null;
let loaded = false;
let failed = false;
let block: IntegratedConversationMessage | null = null;
const nativeBlocks = new Map<string, IntegratedConversationMessage>();
let userEcho: IntegratedConversationMessage | null = null;
let userConfirmed = false;
let promptAnchorId: string | null = null;
let liveWindowFloorId: string | null = null;
let plainTextPrompt = false;
let stopWatchingPrompt: (() => void) | null = null;
let admission: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
let model: string | null = null;
let options: Row[] = [];
let commands: Row[] = [];
let title: string | null = null;
let mcpPolicy: 'allow' | 'ask' = 'allow';
let cancelling = false;
let configuring = false;
let savedSettings = '';
let saveWarning = false;
const usage: Row = {};
const native = resolveCommand(config.executable, ['acp'], hostEnv);
const child = spawn(native.command, native.args, { cwd: config.cwd, env: hostEnv, stdio: 'pipe', windowsHide: true, windowsVerbatimArguments: native.verbatim });
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
const transportFailed = (error: Error) => {
  if (stopping) return;
  fail(new NativeAcpTransportError(error.message, { cause: error }));
};
child.on('error', transportFailed);
child.stdin.on('error', transportFailed);
child.on('exit', (code) => {
  const error = new NativeAcpTransportError(`ACP agent exited (${code ?? 'signal'})${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
  for (const request of requests.values()) { if (request.timer) clearTimeout(request.timer); request.reject(error); }
  requests.clear();
  permissions.clear();
  active = false;
  if (!stopping) fail(error);
});
let buffer = '';
child.stdout.setEncoding('utf8');
let draining = false;
child.stdout.on('data', (chunk: string) => {
  buffer += chunk;
  void drain();
});

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    if (buffer.length > 32 * 1024 * 1024) { transportFailed(new Error('ACP frame exceeds limit')); void stop(); return; }
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const frame = JSON.parse(line);
        receive(frame);
        // Apply an RPC result before classifying later updates in the same read.
        if (!frame.method) await Promise.resolve();
      } catch (error) { transportFailed(error instanceof Error ? error : new Error(String(error))); }
    }
  } finally { draining = false; }
}

function write(frame: Row): void {
  if (child.exitCode !== null || child.killed || !child.stdin.writable) throw new Error('ACP agent is not running');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
}

function rpc(method: string, params: Row, timeoutMs = 60_000): Promise<Row> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = timeoutMs ? setTimeout(() => { requests.delete(id); reject(new Error(`ACP request timed out: ${method}`)); }, timeoutMs) : null;
    requests.set(id, { resolve, reject, timer });
    try { write({ id, method, params }); }
    catch (error) { requests.delete(id); if (timer) clearTimeout(timer); reject(error); }
  });
}

function publish(event: Row): void {
  const frame = `${JSON.stringify({ event: { ...event, revision: ++revision } })}\n`;
  for (const socket of subscribers) {
    if (socket.destroyed || socket.writableLength > 1024 * 1024) { subscribers.delete(socket); socket.destroy(); }
    else socket.write(frame);
  }
}
// agy takes a prompt while its own background tools run (dev servers, long
// tests) and queues one sent during an unsolicited reply. Since 1.5 it keeps a
// turn open until its background tasks and subagents finish, and a prompt sent
// into that turn steers it. It refuses one while an approval waits. A steer
// waits for the earlier prompt's receipt, which must not be mistaken for its
// own, and an unconfirmed Stop keeps input out.
function acceptsPrompt(): boolean {
  return !cancelling && permissions.size === 0 && !configuring && (!active || (userConfirmed && !admission));
}
// A tool left running after its turn is not model work: a daemon can outlive
// the session. Only fresh output or an approval keeps the agent working.
function busy(): boolean {
  return active || backgroundQuiet !== null || permissions.size > 0 || cancelling;
}
function state(): void {
  const next = failed ? 'error' : permissions.size ? 'permission' : busy() ? 'working' : loaded ? 'idle' : status;
  const detail = next !== 'working' ? '' : cancelling ? 'Stopping…' : active ? ''
    : runningTools.size ? 'Background tools running…' : 'Recent background activity';
  if (next === status && detail === workingDetail) return;
  status = next;
  workingDetail = detail;
  publish({ kind: 'status', status, detail: detail || undefined });
}
function backgroundActivity(): void {
  if (!loaded || active || failed || cancelling || stopping) return;
  if (backgroundQuiet) clearTimeout(backgroundQuiet);
  // ACP has no stop reason for an unsolicited burst. Explicitly running tools
  // and open approvals outlive the quiet window; silence covers text alone.
  backgroundQuiet = setTimeout(() => { backgroundQuiet = null; state(); }, BACKGROUND_QUIET_MS);
  state();
}
// Without a foreground turn ACP has no reply to confirm Stop. agy fails each
// background tool it kills; an unsolicited reply has no signal at all. Neither
// can leave a turn stuck, so this never fails the session.
function stopBackground(): void {
  write({ method: 'session/cancel', params: { sessionId } });
  cancelPermissions();
  if (backgroundQuiet) { clearTimeout(backgroundQuiet); backgroundQuiet = null; }
  for (const id of runningTools) { const command = backgroundCommands.get(id); if (command) command.stopRequested = true; }
  if (runningTools.size) {
    cancelling = true;
    cancelWatchingTools = true;
    cancelDeadline = setTimeout(() => {
      for (const id of runningTools) addBounded(stoppedToolIds, id);
      finishTools('Stopped');
      // finishTools reaches only rows still in the transcript.
      runningTools.clear();
      finishCancellation();
      state(); publish({ kind: 'pending', backgroundTasks: runningTaskCount() });
    }, CANCEL_TIMEOUT_MS);
  }
  state(); publish({ kind: 'pending', backgroundTasks: runningTaskCount() });
}
// Commands that outlive their turn, such as dev servers. Listing them as
// tasks keeps an idle agent from hibernating (which would kill them) and
// gives the task shelf a Stop.
// Kept apart from the transcript, whose oldest rows are evicted while a
// daemon can run for the life of the session. A finished command keeps its
// final state so an open task drawer settles.
// agy keeps its turn open while they run, so a command its reply or later
// tools have moved past is one too. Stopping it then ends that turn: ACP has no other way.
function backgroundTasks(): Row[] {
  for (const id of runningTools) {
    if (backgroundCommands.has(id)) continue;
    const index = messages.findIndex((message) => message.id === id);
    if (active && index >= 0 && !messages.slice(index + 1).some((message) => message.role === 'assistant')) continue;
    const row = messages[index];
    const input = (row?.tool?.input ?? {}) as Row;
    const command = input.CommandLine ?? input.command;
    const label = typeof command === 'string' && command ? command : String(row?.tool?.name ?? 'Background command');
    backgroundCommands.set(id, { label: label.slice(0, 200), stopRequested: false });
  }
  const finished = [...backgroundCommands.keys()].filter((id) => !runningTools.has(id));
  for (const id of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_COMMANDS))) backgroundCommands.delete(id);
  const running = [...backgroundCommands.keys()].filter((id) => runningTools.has(id)).length;
  return [...backgroundCommands].map(([id, command]) => {
    if (runningTools.has(id)) {
      return { id, label: command.label, kind: 'local_bash', status: 'running', stoppable: !cancelling,
        ...(active ? { detail: 'Stop also ends the current turn', stopsAll: true }
          : running > 1 ? { detail: 'Stop ends every background command', stopsAll: true } : {}) };
    }
    const state = messages.find((message) => message.id === id)?.tool?.state as Row | undefined;
    const status = command.stopRequested || stoppedToolIds.has(id) ? 'stopped' : state?.status === 'failed' ? 'failed' : 'completed';
    return { id, label: command.label, kind: 'local_bash', status, stoppable: false };
  });
}
function runningTaskCount(): number {
  return [...(subagents?.tasks() ?? []), ...backgroundTasks()]
    .filter((task) => task.status === 'running' || task.status === 'pending').length;
}
function noteModelActivity(): void {
  if (loaded && !failed && !stopping) usage.lastModelActivityAt = new Date().toISOString();
}
function finishCancellation(): void {
  if (cancelDeadline) clearTimeout(cancelDeadline);
  cancelDeadline = null;
  cancelWatchingTools = false;
  cancelling = false;
}
function endTurn(stopReason: string | null): void {
  admit();
  if (stopReason === 'cancelled') finishTools('Response stopped');
  else finishTools('Antigravity ended the turn before this tool started', true);
  if (stopReason !== 'cancelled' && cancelling && runningTools.size) {
    // A natural prompt end is not an acknowledgement of Stop for tools
    // still running. Watch those tools without resetting the deadline.
    cancelWatchingTools = true;
  } else finishCancellation();
  const stopped = stopReason && Object.hasOwn(STOP_REASONS, stopReason) ? STOP_REASONS[stopReason] : null;
  if (stopped) replace({ id: randomUUID(), role: 'assistant', kind: 'notice', level: 'warning', text: stopped });
  active = false; userEcho = null; promptAnchorId = null; block = null; cancelPermissions();
  subagents?.syncNow();
  setImmediate(() => { if (!stopping && status !== 'error') { state(); if (runningTools.size) publish({ kind: 'pending', backgroundTasks: runningTaskCount() }); } });
  saveSettings();
}
function cancelTurn(): void {
  write({ method: 'session/cancel', params: { sessionId } });
  cancelPermissions();
  cancelling = true;
  cancelWatchingTools = false;
  cancelDeadline = setTimeout(() => {
    fail(new NativeAcpTransportError('Antigravity did not confirm cancellation. Restart the agent before sending another message.'));
    publish({ kind: 'pending' });
  }, CANCEL_TIMEOUT_MS);
  state(); publish({ kind: 'pending' });
}
function cancelPermissions(): void {
  for (const request of permissions.values()) {
    try { write({ id: request.rpcId, result: { outcome: { outcome: 'cancelled' } } }); }
    catch { /* native stdin may already be closed */ }
  }
  permissions.clear();
}
function fail(error: Error, fatal = true): void {
  clearPromptWatch();
  promptAnchorId = null;
  if (admission) {
    clearTimeout(admission.timer);
    // A native RPC error is a definitive rejection. Losing the native pipe
    // after dispatch cannot prove whether the agent already did the work.
    admission.reject(error instanceof NativeAcpTransportError
      ? new Error(`ACP prompt delivery is uncertain: ${error.message}`)
      : error);
    admission = null;
  }
  finishCancellation();
  if (backgroundQuiet) clearTimeout(backgroundQuiet);
  backgroundQuiet = null;
  workingDetail = '';
  failed = fatal;
  permissions.clear();
  finishTools(error.message);
  status = 'error'; statusDetail = error.message; publish({ kind: 'status', status, detail: statusDetail, backgroundTasks: runningTaskCount() });
}
function finishTools(reason: string, pendingOnly = false): void {
  for (const message of [...messages]) {
    const tool = message.tool;
    const status = (tool?.state as Row | undefined)?.status;
    if (!tool || (pendingOnly ? status !== 'pending' || runningTools.has(message.id)
      : status !== 'pending' && status !== 'in_progress')) continue;
    runningTools.delete(message.id);
    addBounded(abandonedToolIds, message.id);
    replace({ ...message, completedAt: new Date().toISOString(), tool: { ...tool, state: { ...(tool.state as Row), status: 'failed', error: reason } } });
  }
}

const TRUNCATED_TOOL = '\n[Antigravity tool data truncated in Patterm]';
function toolPreview(value: string): string {
  // Allow for JSON escaping as well as multibyte text.
  if (Buffer.byteLength(JSON.stringify(value)) <= TOOL_FIELD_BYTES) return value;
  const end = Math.floor((TOOL_FIELD_BYTES - TRUNCATED_TOOL.length - 2) / 6);
  return value.slice(0, end).replace(/[\uD800-\uDBFF]$/, '') + TRUNCATED_TOOL;
}
function toolOutput(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) <= TOOL_FIELD_BYTES) return value;
  const text = typeof value === 'string' ? value : typeof (value as Row | null)?.output === 'string' ? (value as Row).output : json;
  return { output: toolPreview(`${text}${TRUNCATED_TOOL}`) };
}
function optionValues(option: Row | undefined): Row[] {
  return (option?.options ?? []).flatMap((entry: Row) => entry.options ?? [entry]);
}

function rememberSettings(policy = mcpPolicy): void {
  const settings = {
    model: options.find((option) => option.id === 'model')?.currentValue ?? model,
    reasoning: options.find((option) => option.id === 'thought_level')?.currentValue ?? null,
    mode: options.find((option) => option.id === 'mode')?.currentValue,
    mcpPolicy: policy
  };
  const value = JSON.stringify(settings);
  if (value === savedSettings) return;
  writeAcpSettings(config.settingsDirectory, sessionId, settings);
  savedSettings = value;
  if (saveWarning) {
    saveWarning = false;
    replace({ id: 'acp-settings-save', role: 'assistant', kind: 'notice', level: 'info', text: 'Antigravity controls are saved again.' });
  }
}

function warnSettings(error: unknown): void {
  saveWarning = true;
  const code = (error as NodeJS.ErrnoException)?.code;
  replace({ id: 'acp-settings-save', role: 'assistant', kind: 'notice', level: 'warning', text: `Could not save Antigravity controls${code ? ` (${code})` : ''}. Current controls still apply, but resume may use older settings.` });
}

function saveSettings(): void {
  try { rememberSettings(); } catch (error) { warnSettings(error); }
}

function matchConfiguredMcpTool(name: string): { server: string; tool: string } | null {
  const servers = (config.mcpServers as Array<{ name: string }>).filter((server) => typeof server?.name === 'string' && server.name);
  const lowerName = name.toLowerCase();
  const normalizedName = lowerName.replace(/-/g, '_');
  let best: { server: string; tool: string; len: number } | null = null;
  for (const server of servers) {
    const expected = server.name.toLowerCase();
    const candidates: Array<[string, string]> = [
      [`mcp_${expected}_`, lowerName],
      [`mcp_${expected.replace(/-/g, '_')}_`, normalizedName]
    ];
    for (const [prefix, target] of candidates) {
      if (target.startsWith(prefix) && name.length > prefix.length && (!best || prefix.length > best.len)) {
        best = { server: server.name, tool: name.slice(prefix.length), len: prefix.length };
      }
    }
  }
  return best ? { server: best.server, tool: best.tool } : null;
}

function allowsMcp(tool: Row): boolean {
  // The policy covers the whole session, including work agy does after a
  // prompt ends, so it never depends on whether a foreground turn is active.
  if (cancelling || mcpPolicy !== 'allow' || options.find((option) => option.id === 'mode')?.currentValue !== 'auto') return false;
  if (typeof tool.toolCallId !== 'string' || abandonedToolIds.has(`tool:${tool.toolCallId}`)) return false;
  const previous = messages.find((message) => message.id === `tool:${tool.toolCallId}`)?.tool;
  // Only native tool identifiers count, never a title, reason or argument
  // claiming to be MCP. agy namespaces direct MCP calls with mcp_<server>_.
  const nativeName = typeof tool.name === 'string' && tool.name ? tool.name : undefined;
  const priorName = typeof previous?.name === 'string' && previous.name ? previous.name : undefined;
  if (nativeName && priorName && nativeName !== priorName && priorName !== 'other' && priorName !== 'Tool') return false;
  const name = nativeName ?? priorName;
  if (!name) return false;
  if (matchConfiguredMcpTool(name)) return true;
  const servers = config.mcpServers as Array<{ name: string }>;
  const matchesServer = (candidate: string): boolean => {
    const lower = candidate.toLowerCase();
    const normalized = lower.replace(/-/g, '_');
    return servers.some((server) => {
      const expected = server.name.toLowerCase();
      return lower === expected || normalized === expected.replace(/-/g, '_');
    });
  };
  // Lazy MCP dispatch uses the native call_mcp_tool wrapper instead.
  const input = tool.rawInput ?? previous?.input;
  return name === 'call_mcp_tool' && typeof input?.ToolName === 'string' && typeof input?.ServerName === 'string' && matchesServer(input.ServerName);
}
function addBounded(set: Set<string>, value: string): void {
  if (set.has(value)) set.delete(value);
  set.add(value);
  while (set.size > MAX_TRACKED_IDS) set.delete(set.values().next().value!);
}
function setNativeBlock(key: string, row: IntegratedConversationMessage): void {
  if (nativeBlocks.has(key)) nativeBlocks.delete(key);
  nativeBlocks.set(key, row);
  while (nativeBlocks.size > MAX_TRACKED_IDS) nativeBlocks.delete(nativeBlocks.keys().next().value!);
}
function trimMessages(preserveId?: string): void {
  if (messages.length <= MAX_MESSAGES) return;
  const excess = messages.length - MAX_MESSAGES;
  const preserveIndex = preserveId ? messages.findIndex((row) => row.id === preserveId) : -1;
  let removed: IntegratedConversationMessage[];
  if (preserveIndex >= 0 && preserveIndex < excess) {
    // Keep a newly admitted prompt when trimming its own oversized turn.
    const before = messages.splice(0, preserveIndex);
    const after = messages.splice(1, excess - preserveIndex);
    removed = [...before, ...after];
  } else {
    removed = messages.splice(0, excess);
  }
  droppedMessages += removed.length;
  if (subagentMessages.length) {
    const droppedIds = new Set(removed.map((row) => row.id));
    const kept = subagentMessages.filter((row) => !row.parentId || !droppedIds.has(row.parentId));
    if (kept.length !== subagentMessages.length) subagentMessages.splice(0, subagentMessages.length, ...kept);
  }
}
function upsertSubagentMessage(message: IntegratedConversationMessage): void {
  const index = subagentMessages.findIndex((row) => row.id === message.id);
  if (index < 0) {
    subagentMessages.push(message);
    if (subagentMessages.length > MAX_SUBAGENT_MESSAGES) {
      subagentMessages.splice(0, subagentMessages.length - MAX_SUBAGENT_MESSAGES);
    }
  } else {
    subagentMessages[index] = message;
  }
  publish({ kind: 'replace', message });
}
function removeSubagentMessages(subagentId: string): void {
  const prefix = `sub:${subagentId}:`;
  const kept = subagentMessages.filter((row) => !row.id.startsWith(prefix));
  if (kept.length !== subagentMessages.length) {
    subagentMessages.splice(0, subagentMessages.length, ...kept);
    publish({ kind: 'pending' });
  }
}
function childrenFor(page: IntegratedConversationMessage[]): IntegratedConversationMessage[] {
  if (!subagentMessages.length || !page.length) return [];
  const ids = new Set(page.map((row) => row.id));
  return subagentMessages.filter((row) => row.parentId !== undefined && ids.has(row.parentId));
}
function rawOutputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => rawOutputText(item)).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const row = value as Row;
  for (const key of ['output', 'text', 'content', 'result']) {
    if (row[key] !== undefined) {
      const nested = rawOutputText(row[key]);
      if (nested) return nested;
    }
  }
  return '';
}
function admit(): void {
  // Assistant output and tool requests can belong to background work. Only
  // evidence tied to this input (or its own RPC response) confirms delivery.
  clearPromptWatch();
  if (userEcho && !userConfirmed) {
    userConfirmed = true;
    if (userEcho.clientMessageId) addBounded(deliveries, userEcho.clientMessageId);
    const existing = messages.findIndex((row) => row.id === userEcho!.id);
    if (existing >= 0) {
      messages[existing] = userEcho;
      publish({ kind: 'replace', message: userEcho });
    } else {
      const insertAt = promptAnchorId === null ? 0 : (() => {
        const anchor = messages.findIndex((row) => row.id === promptAnchorId);
        return anchor >= 0 ? anchor + 1 : 0;
      })();
      const outOfOrder = insertAt < messages.length;
      if (outOfOrder) {
        messages.splice(insertAt, 0, userEcho);
        liveWindowFloorId = userEcho.id;
        trimMessages(userEcho.id);
        // Assistant rows for this turn already streamed to live subscribers;
        // ask them to refresh so the user prompt sits before its response.
        publish({ kind: 'pending' });
      } else {
        replace(userEcho);
      }
    }
    // A late receipt opens the turn to steering. Every status retries held
    // input, and nothing else announces this.
    if (active && !admission) publish({ kind: 'status', status, detail: workingDetail || undefined });
  }
  if (!admission) return;
  clearTimeout(admission.timer); admission.resolve(); admission = null;
}
function clearPromptWatch(): void {
  stopWatchingPrompt?.();
  stopWatchingPrompt = null;
}
function replace(message: IntegratedConversationMessage): void {
  const index = messages.findIndex((row) => row.id === message.id);
  if (index < 0) { messages.push(message); trimMessages(); } else messages[index] = message;
  publish({ kind: 'replace', message });
  if (index < 0 && message.role === 'assistant' && loaded && !failed && !stopping && active && [...runningTools].some((id) => !backgroundCommands.has(id))) {
    const known = backgroundCommands.size;
    const count = runningTaskCount();
    if (backgroundCommands.size > known) publish({ kind: 'pending', backgroundTasks: count });
  }
}
function nativeMessageKey(role: string, kind: string, id: string): string {
  return JSON.stringify([role, kind, id]);
}
function chunk(kind: 'text' | 'reasoning', text: string, role: 'user' | 'assistant', nativeId?: string): void {
  if (role === 'user' && userEcho) {
    if (plainTextPrompt && text === userEcho.text) admit();
    block = null;
    return;
  }
  const key = nativeId === undefined ? null : nativeMessageKey(role, kind, nativeId);
  let row = key === null ? block : nativeBlocks.get(key);
  let added = false;
  if (!row || row.kind !== kind || row.role !== role) {
    row = { id: randomUUID(), role, kind, text: '', createdAt: new Date().toISOString() };
    messages.push(row);
    trimMessages();
    if (key !== null) setNativeBlock(key, row);
    added = true;
  }
  block = key === null ? row : null;
  row.text += text;
  publish({ kind: 'append', id: row.id, messageKind: kind, delta: text });
  if (added && role === 'assistant' && loaded && !failed && !stopping && active && [...runningTools].some((id) => !backgroundCommands.has(id))) {
    const known = backgroundCommands.size;
    const count = runningTaskCount();
    if (backgroundCommands.size > known) publish({ kind: 'pending', backgroundTasks: count });
  }
}
function contentChunk(content: Row, kind: 'text' | 'reasoning', role: 'user' | 'assistant', nativeId?: string): void {
  if (role === 'assistant' && (content.type === 'text' || content.type === 'image')) {
    noteModelActivity();
    backgroundActivity();
  }
  if (content.type === 'text') { chunk(kind, String(content.text ?? ''), role, nativeId); return; }
  if (role === 'user' && userEcho) return;
  if (content.type === 'image' && typeof content.data === 'string') {
    const stored = images?.fromBase64(content.data);
    const key = nativeId === undefined ? null : nativeMessageKey(role, kind, nativeId);
    const row = (key && nativeBlocks.get(key)) || { id: randomUUID(), role, kind, text: '', createdAt: new Date().toISOString() };
    const message = { ...row, attachments: [...(row.attachments ?? []), { type: 'image', mime: content.mimeType, ...(stored ? { sha256: stored.sha256 } : {}) }] };
    if (key !== null) setNativeBlock(key, message);
    replace(message);
    block = null;
  }
}
// ACP diffs carry whole files. Keep only the changed hunks: a transcript that
// stores every edited file in full grows past what the pane can load.
function diffPreview(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (part?.type !== 'diff' || typeof part.newText !== 'string' || typeof part.path !== 'string') continue;
    const before: string = typeof part.oldText === 'string' ? part.oldText : '';
    const after: string = part.newText;
    // A last line without its newline differs from the same line with one.
    const lines = (text: string) => {
      if (!text) return [];
      const rows = text.replace(/\n$/, '').split('\n');
      if (!text.endsWith('\n')) rows[rows.length - 1] += NO_EOL;
      return rows;
    };
    const hunks = unifiedHunks(lines(before), lines(after));
    // Oversized changes remain identified by path; never show a truncated
    // patch that pretends to describe the whole edit.
    if (hunks && hunks.length <= 128_000) parts.push(`--- ${part.oldText == null ? '/dev/null' : part.path}\n+++ ${part.path}\n${hunks}`);
  }
  return parts.length ? parts.join('\n') : null;
}

const DIFF_CONTEXT = 3;
const NO_EOL = '\u0000';
const MAX_DIFF_EDITS = 1_000;

// One edit script entry per line: ' ' kept, '-' removed, '+' added.
function lineEdits(before: string[], after: string[]): Array<[' ' | '-' | '+', string]> {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length, endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  const a = before.slice(start, endBefore), b = after.slice(start, endAfter);
  const kept = (rows: string[]) => rows.map((line): [' ', string] => [' ', line]);
  return [...kept(before.slice(0, start)), ...myers(a, b), ...kept(before.slice(endBefore))];
}

// Myers' O(ND) diff. Past MAX_DIFF_EDITS the changed middle is shown as one
// replacement, which is still correct, only less precise.
function myers(a: string[], b: string[]): Array<[' ' | '-' | '+', string]> {
  const replace = (): Array<[' ' | '-' | '+', string]> => [...a.map((line): ['-', string] => ['-', line]), ...b.map((line): ['+', string] => ['+', line])];
  if (!a.length || !b.length) return replace();
  const offset = Math.min(a.length + b.length, MAX_DIFF_EDITS) + 1;
  const v = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  for (let d = 0; d < offset; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= a.length && y >= b.length) return backtrack(trace, a, b, offset);
    }
  }
  return replace();
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): Array<[' ' | '-' | '+', string]> {
  const edits: Array<[' ' | '-' | '+', string]> = [];
  let x = a.length, y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const previous = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const previousX = v[offset + previous]!, previousY = previousX - previous;
    while (x > previousX && y > previousY) { edits.push([' ', a[--x]!]); y--; }
    if (x > previousX) edits.push(['-', a[--x]!]);
    else edits.push(['+', b[--y]!]);
  }
  while (x > 0 && y > 0) { edits.push([' ', a[--x]!]); y--; }
  return edits.reverse();
}

function unifiedHunks(before: string[], after: string[]): string | null {
  const edits = lineEdits(before, after);
  const changed = edits.flatMap((edit, index) => edit[0] === ' ' ? [] : [index]);
  if (!changed.length) return null;
  const output: string[] = [];
  let cursor = 0;
  while (cursor < changed.length) {
    const first = changed[cursor]!;
    let last = first;
    while (cursor + 1 < changed.length && changed[cursor + 1]! - last <= DIFF_CONTEXT * 2 + 1) last = changed[++cursor]!;
    cursor++;
    const from = Math.max(0, first - DIFF_CONTEXT), to = Math.min(edits.length, last + DIFF_CONTEXT + 1);
    let oldLine = 0, newLine = 0;
    for (const [kind] of edits.slice(0, from)) { if (kind !== '+') oldLine++; if (kind !== '-') newLine++; }
    const body = edits.slice(from, to);
    const oldCount = body.filter(([kind]) => kind !== '+').length, newCount = body.filter(([kind]) => kind !== '-').length;
    output.push(`@@ -${oldCount ? oldLine + 1 : oldLine},${oldCount} +${newCount ? newLine + 1 : newLine},${newCount} @@`);
    for (const [kind, line] of body) {
      if (line.endsWith(NO_EOL)) output.push(`${kind}${line.slice(0, -1)}`, '\\ No newline at end of file');
      else output.push(`${kind}${line}`);
    }
  }
  return output.join('\n');
}
function receive(frame: Row): void {
  if (!frame.method) {
    const pending = requests.get(String(frame.id));
    if (!pending) return;
    requests.delete(String(frame.id)); if (pending.timer) clearTimeout(pending.timer);
    if (frame.error) pending.reject(new Error(String(frame.error.message ?? 'ACP request failed')));
    else pending.resolve(frame.result ?? {});
    return;
  }
  if (frame.method === 'session/request_permission' && frame.id !== undefined) {
    if (frame.params?.sessionId !== sessionId || !loaded || cancelling || failed || stopping) { write({ id: frame.id, result: { outcome: { outcome: 'cancelled' } } }); return; }
    const params = frame.params as Row;
    const tool = params.toolCall ?? {};
    const approval = (params.options ?? []).find((option: Row) => option.kind === 'allow_once');
    if (approval && allowsMcp(tool)) {
      write({ id: frame.id, result: { outcome: { outcome: 'selected', optionId: approval.optionId } } });
      return;
    }
    const patch = diffPreview(tool.content);
    const id = String(frame.id);
    const command = tool.rawInput?.command ?? tool.rawInput?.CommandLine;
    const target = tool.rawInput?.Path ?? tool.rawInput?.path;
    const resources = tool.locations?.map((location: Row) => location.path) ?? [];
    if (typeof target === 'string' && !resources.includes(target)) resources.push(target);
    const toolKind = tool.kind === 'read' || ((tool.kind == null || tool.kind === 'other') && ['view_file', 'read_file'].includes(tool.name)) ? 'read' : tool.kind ?? tool.name;
    const once = (params.options ?? []).find((option: Row) => option.kind === 'allow_once');
    const always = (params.options ?? []).find((option: Row) => option.kind === 'allow_always');
    const reject = (params.options ?? []).find((option: Row) => option.kind === 'reject_once');
    permissions.set(id, { id, rpcId: frame.id, options: params.options ?? [], action: tool.title ?? 'Tool permission', resources, tool_kind: toolKind, ...(patch ? { patch } : {}), ...(typeof command === 'string' ? { command } : {}), ...(typeof tool.rawInput?.Reason === 'string' ? { detail: tool.rawInput.Reason } : {}), once: Boolean(once), always: Boolean(always), ...(once ? { onceLabel: once.name } : {}), ...(always ? { alwaysLabel: always.name } : {}), ...(reject ? { rejectLabel: reject.name } : {}) });
    block = null; backgroundActivity(); state(); publish({ kind: 'pending' }); return;
  }
  if (frame.method !== 'session/update') {
    if (frame.id !== undefined) write({ id: frame.id, error: { code: -32601, message: 'Client capability not supported by Patterm' } });
    return;
  }
  const params = frame.params ?? {};
  // session/load may replay updates before its result gives us the id.
  if (sessionId && params.sessionId !== sessionId) return;
  const update = params.update ?? {};
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': case 'agent_thought_chunk': case 'user_message_chunk': {
      const content = update.content ?? {};
      contentChunk(content, update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'text', update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant', typeof update.messageId === 'string' ? update.messageId : undefined);
      break;
    }
    case 'tool_call': case 'tool_call_update': {
      block = null;
      const id = `tool:${String(update.toolCallId)}`;
      const previous = messages.find((row) => row.id === id);
      // A diff part is shown through input.patch; its full file text stays out.
      const output = (update.content ?? []).map((part: Row) => part.type === 'content' && part.content?.type === 'text' ? part.content.text : part.type === 'diff' ? part.path : '').filter(Boolean).join('\n');
      const { patch: priorPatch, ...prior } = (previous?.tool?.input ?? {}) as Row;
      const rawInput = update.rawInput ?? {};
      const replacesContent = Array.isArray(update.content);
      const patch = replacesContent ? diffPreview(update.content) : priorPatch;
      const inputPath = rawInput.Path ?? rawInput.path;
      const preview = Buffer.byteLength(JSON.stringify(rawInput)) > TOOL_FIELD_BYTES
        ? {
          truncated: true,
          ...(typeof inputPath === 'string' ? { path: toolPreview(inputPath) } : {}),
          ...(typeof rawInput.ServerName === 'string' ? { ServerName: toolPreview(rawInput.ServerName) } : {}),
          ...(typeof rawInput.ToolName === 'string' ? { ToolName: toolPreview(rawInput.ToolName) } : {})
        } : rawInput;
      const input = { ...(update.rawInput == null ? prior : preview), ...(typeof rawInput.Path === 'string' ? { path: toolPreview(rawInput.Path) } : {}), ...(patch ? { patch } : {}) };
      const toolState = { ...(previous?.tool?.state as Row | undefined), status: update.status ?? (previous?.tool?.state as Row | undefined)?.status ?? 'pending', ...(update.rawOutput !== undefined ? { output: toolOutput(update.rawOutput) } : {}) };
      const terminal = toolState.status === 'completed' || toolState.status === 'failed';
      // A late update cannot revive a tool Patterm settled after an
      // unanswered background Stop.
      if (stoppedToolIds.has(id) && !terminal) break;
      let runningToolsChanged = false;
      if (loaded && !failed && !stopping) {
        const tracked = runningTools.size;
        // The update that confirms Stop is not fresh work, and a tool Patterm
        // already settled as stopped stays stopped.
        if (toolState.status === 'in_progress') { runningTools.add(id); backgroundActivity(); }
        else if (terminal && runningTools.delete(id) && !runningTools.size && cancelWatchingTools) finishCancellation();
        else backgroundActivity();
        runningToolsChanged = runningTools.size !== tracked;
        state();
      }
      const rawText = !output && (replacesContent || !previous?.text) && update.rawOutput !== undefined ? rawOutputText(update.rawOutput) : '';
      const rowText = replacesContent
        ? (output ? toolPreview(output) : rawText ? toolPreview(rawText) : '')
        : previous?.text || (rawText ? toolPreview(rawText) : '');
      const toolName = update.name ?? previous?.tool?.name ?? update.kind ?? 'Tool';
      const mcpParts = matchConfiguredMcpTool(String(toolName));
      replace({ id, role: 'assistant', kind: 'tool', text: rowText, createdAt: previous?.createdAt ?? new Date().toISOString(), ...(terminal ? { completedAt: previous?.completedAt ?? new Date().toISOString() } : {}), tool: { name: toolName, input, state: toolState, ...(mcpParts ? { server: mcpParts.server, tool: mcpParts.tool } : {}) } });
      subagents?.observeToolCall(id, String(toolName), input as Record<string, unknown>, rowText, update.rawOutput);
      // Running tools are tasks: publish after replace() so backgroundTasks()
      // sees the tool's message row and label when computing the task count.
      if (runningToolsChanged) publish({ kind: 'pending', backgroundTasks: runningTaskCount() });
      break;
    }
    case 'available_commands_update': commands = update.availableCommands ?? []; controlsRevision++; publish({ kind: 'pending' }); break;
    case 'config_option_update': options = update.configOptions ?? []; controlsRevision++; publish({ kind: 'pending' }); break;
    case 'current_mode_update': {
      const mode = options.find((option) => option.id === 'mode');
      if (mode) mode.currentValue = update.currentModeId;
      controlsRevision++; publish({ kind: 'pending' }); break;
    }
    case 'session_info_update': title = update.title ?? title; break;
    case 'usage_update': usage.contextTokens = update.used; usage.contextWindow = update.size; publish({ kind: 'pending' }); break;
  }
}

async function start(): Promise<void> {
  const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Patterm', version: '0.5.0' } });
  if (init.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
  const capabilities = init.agentCapabilities ?? {};
  nativeClose = Boolean(capabilities.sessionCapabilities?.close ?? capabilities.session_capabilities?.close);
  const supportsContext = capabilities._meta?.antigravity?.systemPrompt?.append === true;
  // Never silently drop Patterm's identity and safety context.
  if (config.context && !supportsContext) throw new Error('This ACP agent does not support appending Patterm system context');
  const params = { cwd: config.cwd, mcpServers: config.mcpServers, ...(supportsContext ? { _meta: { antigravity: { systemPrompt: { append: config.context } } } } : {}) };
  if (config.resumeId && !capabilities.loadSession && !capabilities.load_session) throw new Error('This ACP agent cannot load sessions');
  const session = await rpc(config.resumeId ? 'session/load' : 'session/new', { ...params, ...(config.resumeId ? { sessionId: config.resumeId } : {}) });
  sessionId = session.sessionId ?? config.resumeId;
  if (!sessionId) throw new Error('ACP agent returned no session id');
  options = session.configOptions ?? [];
  model = session.models?.currentModelId ?? null;
  let saved: ReturnType<typeof readAcpSettings> = {};
  if (config.resumeId) {
    try {
      saved = readAcpSettings(config.settingsDirectory, sessionId);
    } catch (error) {
      // Fail closed on unreadable saved settings so a resumed Auto session
      // cannot silently auto-approve MCP calls after an Ask policy was lost.
      saved = { mcpPolicy: 'ask' };
      replace({ id: randomUUID(), role: 'assistant', kind: 'notice', level: 'warning', text: `Saved Antigravity settings could not be read and were reset to ask for MCP approvals (${error instanceof Error ? error.message : String(error)}).` });
    }
  }
  savedSettings = JSON.stringify(saved);
  mcpPolicy = saved.mcpPolicy ?? 'allow';
  const modelFromSaved = Boolean(config.restoreSavedSettings && saved.model !== undefined) || (!config.model && saved.model !== undefined);
  const wantedModel = config.restoreSavedSettings && saved.model !== undefined ? saved.model : config.model ?? saved.model;
  // A combined model id can select its own effort (flash-low, for example).
  // Saved effort must not undo that explicit choice at resume.
  const reasoningFromSaved = Boolean(config.restoreSavedSettings && saved.reasoning !== undefined) || (!config.reasoning && !config.model && saved.reasoning !== undefined);
  const wantedReasoning = config.restoreSavedSettings && saved.reasoning !== undefined ? saved.reasoning : config.reasoning ?? (config.model ? undefined : saved.reasoning);
  if (wantedModel) {
    const option = options.find((option) => option.id === 'model');
    if ((option?.currentValue ?? model) !== wantedModel) {
      try {
        if (optionValues(option).some((entry) => entry.value === wantedModel)) {
          const result = await rpc('session/set_config_option', { sessionId, configId: 'model', value: wantedModel });
          if (result.configOptions) options = result.configOptions;
        } else await rpc('session/set_model', { sessionId, modelId: wantedModel });
        model = wantedModel;
      } catch (error) {
        if (!modelFromSaved) throw error;
        replace({ id: randomUUID(), role: 'assistant', kind: 'notice', level: 'warning', text: `Saved Antigravity model “${wantedModel}” is no longer available; keeping its current model.` });
      }
    }
  }
  if (wantedReasoning) {
    const thoughtOption = options.find((option) => option.id === 'thought_level');
    if (thoughtOption?.currentValue !== wantedReasoning) {
      const offered = !thoughtOption || optionValues(thoughtOption).some((entry) => entry.value === wantedReasoning);
      if (offered) {
        try {
          const result = await rpc('session/set_config_option', { sessionId, configId: 'thought_level', value: wantedReasoning });
          if (result.configOptions) options = result.configOptions;
        } catch (error) {
          if (!reasoningFromSaved) throw error;
          replace({ id: randomUUID(), role: 'assistant', kind: 'notice', level: 'warning', text: `Saved Antigravity reasoning level “${wantedReasoning}” could not be restored; keeping its current setting.` });
        }
      } else if (reasoningFromSaved) {
        replace({ id: randomUUID(), role: 'assistant', kind: 'notice', level: 'warning', text: `Saved Antigravity reasoning level “${wantedReasoning}” is no longer offered; keeping its current setting.` });
      }
    }
  }
  const wantedMode = saved.mode ?? 'auto';
  const mode = options.find((option) => option.id === 'mode');
  if (optionValues(mode).some((entry) => entry.value === wantedMode)) {
    if (mode?.currentValue !== wantedMode) {
      const result = await rpc('session/set_config_option', { sessionId, configId: 'mode', value: wantedMode });
      if (result.configOptions) options = result.configOptions;
    }
  } else {
    replace({ id: randomUUID(), role: 'assistant', kind: 'notice', level: 'warning', text: `Antigravity does not offer ${wantedMode} mode for this account or platform. Its native mode is unchanged; MCP requests still ask for approval.` });
  }
  if (config.mcpServers.length > 1) replace({
    id: randomUUID(), role: 'assistant', kind: 'notice', level: 'warning',
    text: 'Antigravity may omit MCP tools when the combined catalogue is large. Patterm sent all configured servers but cannot tell which tools Antigravity makes available.'
  });
  saveSettings();
  const pollMs = Number(hostEnv.PATTERM_ACP_SUBAGENT_POLL_MS);
  subagents = new AntigravitySubagentTracker({
    sessionId,
    hostEnv,
    ...(Number.isFinite(pollMs) && pollMs > 0 ? { pollMs } : {}),
    onMessage: upsertSubagentMessage,
    onSubagentDetached: removeSubagentMessages,
    onTasksChanged: () => publish({ kind: 'pending', backgroundTasks: runningTaskCount() })
  });
  for (const row of messages) {
    if (row.kind === 'tool' && row.tool) {
      subagents.observeToolCall(row.id, row.tool.name, (row.tool.input ?? {}) as Record<string, unknown>, row.text, (row.tool.state as Row | undefined)?.output);
    }
  }
  subagents.syncNow(true);
  controlsRevision++; loaded = true; block = null; state();
}

function controlState(): Row {
  // Model and thought level are separate native options. Persist those rather
  // than a stale combined model id after a thinking-level change.
  const mcpOption = { id: 'patterm_mcp', name: 'MCP in Auto', type: 'select', currentValue: mcpPolicy, options: [
    { value: 'allow', name: 'Allow MCP tools', description: 'In Auto mode, approve reads and writes on MCP servers supplied to this session. Other tool requests still follow agy permissions.' },
    { value: 'ask', name: 'Ask for MCP tools', description: 'Show native MCP approval requests, including in Auto mode.' }
  ] };
  return { model: options.find((option) => option.id === 'model')?.currentValue ?? model, configOptions: [...options, mcpOption], commands, title, controls_revision: String(controlsRevision) };
}

// Snapshots carry the newest rows only; older ones are read a page at a time.
// Rows are only ever appended or replaced in place, so an index into
// `messages` stays valid for this host's lifetime. The host id makes a cursor
// from an earlier host, before a restart replayed the session, fail instead of
// pointing at different rows.
const hostId = randomUUID();

function pageStart(end: number, floor = Math.max(0, end - PAGE_MESSAGES)): number {
  let start = end, bytes = 2;
  const minStart = Math.max(0, floor);
  while (start > minStart) {
    const size = Buffer.byteLength(JSON.stringify(messages[start - 1])) + (start === end ? 0 : 1);
    if (start < end && bytes + size > PAGE_BYTES) break;
    bytes += size; start--;
  }
  return start;
}

function pageCursor(start: number): string | null {
  return start > 0 ? `${hostId}:${start + droppedMessages}` : null;
}

function olderPage(cursor: unknown): Row {
  const match = typeof cursor === 'string' ? /^([0-9a-f-]+):(\d+)$/.exec(cursor) : null;
  const globalEnd = match ? Number(match[2]) : Number.NaN;
  const end = globalEnd - droppedMessages;
  if (!match || match[1] !== hostId || !Number.isSafeInteger(globalEnd) || end < 1 || end > messages.length) throw new Error('This history cursor is no longer valid; reopen the conversation');
  const start = pageStart(end);
  const page = messages.slice(start, end);
  return { messages: { data: [...page, ...childrenFor(page)] }, cursor: pageCursor(start) };
}

let lastTurnBoundaryAt: string | null = null;

function snapshot(): Row {
  let start = pageStart(messages.length);
  let splicedBeforeWindow: string | null = null;
  if (liveWindowFloorId) {
    const floor = messages.findIndex((row) => row.id === liveWindowFloorId);
    if (floor < 0) liveWindowFloorId = null;
    else if (floor < start) {
      start = pageStart(messages.length, floor);
      if (floor < start) splicedBeforeWindow = liveWindowFloorId;
    }
  }
  const cursor = pageCursor(start);
  const page = messages.slice(start);
  return {
    provider_session_id: sessionId,
    status,
    ...(status === 'working' && workingDetail ? { status_detail: workingDetail } : status === 'error' && statusDetail ? { status_detail: statusDetail } : {}),
    ...(lastTurnBoundaryAt ? { last_turn_boundary_at: lastTurnBoundaryAt } : {}),
    messages: { data: [...page, ...childrenFor(page)] },
    history_truncated: cursor !== null,
    history_cursor: cursor ? { next: cursor } : null,
    ...(splicedBeforeWindow ? { history_spliced_id: splicedBeforeWindow } : {}),
    permissions: { data: [...permissions.values()].map(({ rpcId: _rpcId, options: _options, ...permission }) => permission) },
    questions: { data: [] },
    tasks: [...(subagents?.tasks() ?? []), ...backgroundTasks()],
    usage,
    revision,
    ...controlState()
  };
}

async function handle(method: string, params: Row): Promise<unknown> {
  if (method === 'conversation') return snapshot();
  if (method === 'older') return olderPage(params.cursor);
  if (method === 'controls') return controlState();
  if (method === 'hasTask') return { owned: Boolean(subagents?.hasTask(String(params.taskId ?? ''))) };
  if (method === 'delivery') return { state: deliveries.has(params.clientMessageId) ? 'accepted' : 'unknown' };
  if (method === 'stop') {
    await stopNative();
    setImmediate(exitHost);
    return {};
  }
  if (!loaded || failed || stopping) throw new Error(statusDetail || 'ACP agent is not ready');
  if (method === 'prompt') {
    if (params.clientMessageId && deliveries.has(params.clientMessageId)) return { accepted: true };
    if (!acceptsPrompt()) throw new Error('ACP turn is busy');
    if (!Array.isArray(params.prompt) || !params.prompt.length) throw new Error('Message is empty');
    const wasWorking = status === 'working';
    const joined = active ? { turn: currentTurn, echo: userEcho, anchor: promptAnchorId, plain: plainTextPrompt } : null;
    const turnId = ++turnSeq;
    currentTurn = turnId;
    openTurns.add(turnId);
    if (backgroundQuiet) { clearTimeout(backgroundQuiet); backgroundQuiet = null; }
    active = true; cancelling = false; statusDetail = ''; block = null; userConfirmed = false;
    liveWindowFloorId = null;
    promptAnchorId = messages.length ? messages[messages.length - 1]!.id : null;
    userEcho = { id: params.clientMessageId ?? randomUUID(), ...(params.clientMessageId ? { clientMessageId: params.clientMessageId } : {}), role: 'user', kind: 'text', text: String(params.text ?? ''), createdAt: new Date().toISOString(), attachments: params.attachments ?? [] };
    const accepted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { admission = null; reject(new Error('ACP prompt delivery is uncertain')); }, 8_000);
      admission = { resolve, reject, timer };
    });
    // Text alone cannot confirm references or attachments. Inline images are
    // recorded in agy's transcript receipt; references and text files are not,
    // so leave those on the ACP acknowledgement path.
    const leadsWithText = params.prompt[0]?.type === 'text' && params.prompt[0].text === userEcho.text;
    const rest: Row[] = params.prompt.slice(1);
    plainTextPrompt = leadsWithText && !rest.length;
    if (leadsWithText && rest.every((part) => part?.type === 'image' && typeof part.mimeType === 'string')) {
      stopWatchingPrompt = watchAntigravityPrompt(sessionId, userEcho.text, rest.map((part) => part.mimeType as string), admit);
    }
    state();
    if (wasWorking) {
      lastTurnBoundaryAt = new Date().toISOString();
      publish({ kind: 'turn_boundary', detail: lastTurnBoundaryAt });
    }
    // A turn changes what Stop on a background command task does.
    if (runningTools.size) publish({ kind: 'pending', backgroundTasks: runningTaskCount() });
    // The result arrives only at turn end. Keep the host socket responsive to
    // permissions and cancellation instead of awaiting it in this handler.
    const turn = rpc('session/prompt', { sessionId, prompt: params.prompt }, 0);
    usage.lastModelActivityAt = new Date().toISOString();
    void turn.then((result) => {
      openTurns.delete(turnId);
      if (failed || stopping) return;
      if (result.usage) {
        usage.inputTokens = (usage.inputTokens ?? 0) + (result.usage.inputTokens ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (result.usage.outputTokens ?? 0);
      }
      // A steer ends the prompt it joined with end_turn while the work goes on.
      if (turnId !== currentTurn) return;
      endTurn(result.stopReason);
    }, (error: Error) => {
      openTurns.delete(turnId);
      if (failed || stopping) {
        if (turnId === currentTurn) { active = false; userEcho = null; promptAnchorId = null; }
        return;
      }
      // agy refuses a steer that races an approval request. The turn it would
      // have joined goes on, and the message waits like any other.
      if (joined && turnId === currentTurn && admission && !(error instanceof NativeAcpTransportError)) {
        clearPromptWatch();
        clearTimeout(admission.timer); admission.reject(new Error('ACP turn is busy')); admission = null;
        currentTurn = joined.turn; userEcho = joined.echo; userConfirmed = true; promptAnchorId = joined.anchor; plainTextPrompt = joined.plain;
        if (!openTurns.has(joined.turn)) endTurn(null);
        return;
      }
      if (turnId !== currentTurn) return;
      active = false; userEcho = null; promptAnchorId = null;
      cancelPermissions(); fail(error, error instanceof NativeAcpTransportError); publish({ kind: 'pending' });
    }).catch(fail);
    await accepted;
    return { accepted: true };
  }
  if (method === 'interrupt') {
    if ((!busy() && !runningTools.size) || cancelling) return {};
    if (!active) { stopBackground(); return {}; }
    cancelTurn();
    return {};
  }
  if (method === 'stopTask') {
    // ACP has no per-task cancel: session/cancel ends all background work,
    // and the turn agy holds open for it.
    if (cancelling || !runningTools.has(String(params.taskId ?? ''))) throw new Error('That background command is not running');
    if (!active) { stopBackground(); return {}; }
    for (const id of runningTools) { const command = backgroundCommands.get(id); if (command) command.stopRequested = true; }
    cancelTurn();
    return {};
  }
  if (method === 'permission') {
    const request = permissions.get(String(params.requestId));
    if (!request) throw new Error('ACP permission request is no longer pending');
    const kind = params.reply === 'always' ? 'allow_always' : params.reply === 'once' ? 'allow_once' : 'reject_once';
    const option = request.options.find((entry: Row) => entry.kind === kind);
    if (!option && params.reply !== 'reject') throw new Error('This permission choice was not offered by the agent');
    write({ id: request.rpcId, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
    permissions.delete(String(params.requestId)); backgroundActivity(); state(); publish({ kind: 'pending' }); return {};
  }
  if (method === 'configure') {
    if (busy()) throw new Error('Wait for the ACP turn to finish before changing settings');
    if (configuring) throw new Error('Wait for the ACP settings update to finish');
    if (params.selector === 'patterm_mcp') {
      if (params.value !== 'allow' && params.value !== 'ask') throw new Error('Unknown ACP setting value');
      // Do not enable write approvals after a rejected save while the UI
      // still shows Ask. Commit the policy only after persistence succeeds.
      try { rememberSettings(params.value); }
      catch (error) { warnSettings(error); throw new Error('MCP policy was not changed because its settings could not be saved'); }
      mcpPolicy = params.value;
      controlsRevision++; publish({ kind: 'pending' });
      const current = controlState();
      return { model: current.model ?? null, reasoning: options.find((entry) => entry.id === 'thought_level')?.currentValue ?? null };
    }
    const option = options.find((entry) => entry.id === params.selector);
    if (!option) throw new Error('Unknown ACP setting');
    const values = optionValues(option);
    if (!values.some((entry: Row) => entry.value === params.value)) throw new Error('Unknown ACP setting value');
    configuring = true;
    try {
      // Match the 10s host RPC timeout so a stalled configure releases the lock
      // before the caller retries instead of wedging prompts for 60s.
      const result = await rpc('session/set_config_option', { sessionId, configId: params.selector, value: params.value }, 8_500);
      if (result.configOptions) options = result.configOptions;
      if (params.selector === 'model') model = params.value;
      controlsRevision++; publish({ kind: 'pending' });
      try { rememberSettings(); }
      catch (error) { warnSettings(error); throw new Error('Antigravity applied the setting, but Patterm could not save it for resume'); }
      const current = controlState();
      return { model: current.model ?? null, reasoning: options.find((entry) => entry.id === 'thought_level')?.currentValue ?? null };
    } finally { configuring = false; }
  }
  throw new Error(`Unknown ACP host method: ${method}`);
}

removeStaleIpc(config.socketPath);
const sockets = new Set<net.Socket>();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on('error', () => { sockets.delete(socket); subscribers.delete(socket); socket.destroy(); });
  socket.on('close', () => { sockets.delete(socket); subscribers.delete(socket); });
  let incoming = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    incoming += chunk;
    if (incoming.length > 32 * 1024 * 1024) { socket.destroy(); return; }
    for (;;) {
      const newline = incoming.indexOf('\n'); if (newline < 0) return;
      const line = incoming.slice(0, newline); incoming = incoming.slice(newline + 1);
      let request: Row;
      try { request = JSON.parse(line); } catch { socket.destroy(); return; }
      const respond = (result: unknown, error?: unknown) => {
        if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, ...(error ? { error: error instanceof Error ? error.message : String(error) } : { result }) })}\n`);
      };
      if (request.method === 'subscribe') { subscribers.add(socket); respond({ revision }); publish({ kind: 'pending', backgroundTasks: runningTaskCount() }); }
      else void handle(String(request.method), request.params ?? {}).then((result) => respond(result), (error) => respond(null, error));
    }
  });
});
server.listen(ipcPath(config.socketPath), () => restrictIpc(config.socketPath));
void start().catch(fail);

async function stop(): Promise<void> {
  if (exitPromise) return exitPromise;
  exitPromise = (async () => {
    await stopNative();
    await exitHost();
  })();
  return exitPromise;
}

function stopNative(): Promise<void> {
  if (shutdown) return shutdown;
  stopping = true;
  clearPromptWatch();
  subagents?.stop();
  finishCancellation();
  if (backgroundQuiet) { clearTimeout(backgroundQuiet); backgroundQuiet = null; }
  if (admission) { clearTimeout(admission.timer); admission.reject(new NativeAcpTransportError('ACP host stopped')); admission = null; }
  const stopError = new NativeAcpTransportError('ACP host stopped');
  for (const request of requests.values()) { if (request.timer) clearTimeout(request.timer); request.reject(stopError); }
  requests.clear();
  shutdown = (async () => {
    if (nativeClose && loaded && child.exitCode === null && child.signalCode === null) {
      try { cancelPermissions(); } catch { /* the native pipe may already be closed */ }
      await rpc('session/close', { sessionId }, 2000).catch(() => undefined);
    }
    if (child.pid) await killProcessTree(child.pid).catch(() => undefined);
  })();
  return shutdown;
}

async function exitHost(): Promise<void> {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  subscribers.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  removeStaleIpc(config.socketPath);
  fs.rmSync(configPath, { force: true });
  sessionOptions.onExit?.(0);
}

return {
  socketPath: config.socketPath,
  stop
};
}

if (require.main === module) {
  const session = startAcpHostSession(process.argv[2]!, process.env, { onExit: (code) => process.exit(code) });
  process.on('SIGTERM', () => void session.stop());
  process.on('SIGINT', () => void session.stop());
  if (process.platform === 'win32') process.on('SIGBREAK', () => void session.stop());
}
