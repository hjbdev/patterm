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

type Row = Record<string, any>;
class NativeAcpTransportError extends Error {}
const BACKGROUND_QUIET_MS = Number(process.env.PATTERM_ACP_BACKGROUND_QUIET_MS) || 10_000;
const CANCEL_TIMEOUT_MS = Number(process.env.PATTERM_ACP_CANCEL_TIMEOUT_MS) || 15_000;
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

// ACP is a native CLI transport, not a model API. This host advertises no
// filesystem or terminal capabilities: the agent owns its tools and sandbox.
const config = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as Config;
const images = config.imageDirectory ? new TranscriptImageStore(config.imageDirectory) : null;
const subscribers = new Set<net.Socket>();
const requests = new Map<string, { resolve: (result: Row) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | null }>();
const permissions = new Map<string, Row>();
const messages: IntegratedConversationMessage[] = [];
const deliveries = new Set<string>();
let sessionId = config.resumeId ?? '';
let status = 'starting';
let statusDetail = '';
let revision = 0;
let controlsRevision = 0;
let active = false;
let backgroundQuiet: NodeJS.Timeout | null = null;
const runningTools = new Set<string>();
let cancelDeadline: NodeJS.Timeout | null = null;
let cancelWatchingTools = false;
let nativeClose = false;
let stopping = false;
let shutdown: Promise<void> | null = null;
let loaded = false;
let failed = false;
let block: IntegratedConversationMessage | null = null;
const nativeBlocks = new Map<string, IntegratedConversationMessage>();
let userEcho: IntegratedConversationMessage | null = null;
let userConfirmed = false;
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
const native = resolveCommand(config.executable, ['acp']);
const child = spawn(native.command, native.args, { cwd: config.cwd, env: process.env, stdio: 'pipe', windowsHide: true, windowsVerbatimArguments: native.verbatim });
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
const transportFailed = (error: Error) => fail(new NativeAcpTransportError(error.message, { cause: error }));
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
function busy(): boolean {
  return active || backgroundQuiet !== null || runningTools.size > 0 || permissions.size > 0 || cancelling;
}
function state(): void {
  const next = failed ? 'error' : permissions.size ? 'permission' : busy() ? 'working' : loaded ? 'idle' : status;
  if (next === status) return;
  status = next;
  publish({ kind: 'status', status });
}
function backgroundActivity(): void {
  if (!loaded || active || failed || cancelling || stopping) return;
  if (backgroundQuiet) clearTimeout(backgroundQuiet);
  // ACP has no stop reason for an unsolicited burst. Explicitly running tools
  // and open approvals outlive the quiet window; silence covers text alone.
  backgroundQuiet = setTimeout(() => { backgroundQuiet = null; state(); }, BACKGROUND_QUIET_MS);
  state();
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
function cancelPermissions(): void {
  for (const request of permissions.values()) write({ id: request.rpcId, result: { outcome: { outcome: 'cancelled' } } });
  permissions.clear();
}
function fail(error: Error, fatal = true): void {
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
  runningTools.clear();
  failed = fatal;
  permissions.clear();
  finishTools(error.message);
  status = 'error'; statusDetail = error.message; publish({ kind: 'status', status, detail: statusDetail });
}
function finishTools(reason: string): void {
  runningTools.clear();
  for (const message of [...messages]) {
    const tool = message.tool;
    if (!tool || !['pending', 'in_progress'].includes((tool.state as Row | undefined)?.status)) continue;
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

function allowsMcp(tool: Row): boolean {
  if (!active || cancelling || mcpPolicy !== 'allow' || options.find((option) => option.id === 'mode')?.currentValue !== 'auto') return false;
  const previous = messages.find((message) => message.id === `tool:${tool.toolCallId}`)?.tool;
  // Only native tool identifiers count, never a title, reason or argument
  // claiming to be MCP. agy namespaces direct MCP calls with mcp_<server>_.
  const name = typeof tool.name === 'string' ? tool.name : previous?.name;
  const servers = config.mcpServers as Array<{ name: string }>;
  if (servers.some((server) => name?.startsWith(`mcp_${server.name}_`))) return true;
  // Lazy MCP dispatch uses the native call_mcp_tool wrapper instead.
  const input = tool.rawInput ?? previous?.input;
  return name === 'call_mcp_tool' && typeof input?.ToolName === 'string' && servers.some((server) => input?.ServerName === server.name);
}
function admit(): void {
  if (userEcho && !userConfirmed) {
    userConfirmed = true;
    if (userEcho.clientMessageId) deliveries.add(userEcho.clientMessageId);
    replace(userEcho);
  }
  if (!admission) return;
  clearTimeout(admission.timer); admission.resolve(); admission = null;
}
function replace(message: IntegratedConversationMessage): void {
  const index = messages.findIndex((row) => row.id === message.id);
  if (index < 0) messages.push(message); else messages[index] = message;
  publish({ kind: 'replace', message });
}
function nativeMessageKey(role: string, kind: string, id: string): string {
  return JSON.stringify([role, kind, id]);
}
function chunk(kind: 'text' | 'reasoning', text: string, role: 'user' | 'assistant', nativeId?: string): void {
  if (role === 'user' && userEcho) { admit(); block = null; return; }
  if (role === 'assistant') admit();
  const key = nativeId === undefined ? null : nativeMessageKey(role, kind, nativeId);
  let row = key === null ? block : nativeBlocks.get(key);
  if (!row || row.kind !== kind || row.role !== role) {
    row = { id: randomUUID(), role, kind, text: '', createdAt: new Date().toISOString() };
    messages.push(row);
    if (key !== null) nativeBlocks.set(key, row);
  }
  block = key === null ? row : null;
  row.text += text;
  publish({ kind: 'append', id: row.id, messageKind: kind, delta: text });
}
function contentChunk(content: Row, kind: 'text' | 'reasoning', role: 'user' | 'assistant', nativeId?: string): void {
  if (role === 'assistant' && (content.type === 'text' || content.type === 'image')) {
    noteModelActivity();
    backgroundActivity();
  }
  if (content.type === 'text') { chunk(kind, String(content.text ?? ''), role, nativeId); return; }
  if (role === 'user' && userEcho) { admit(); return; }
  if (content.type === 'image' && typeof content.data === 'string') {
    if (role === 'assistant') admit();
    const stored = images?.fromBase64(content.data);
    const key = nativeId === undefined ? null : nativeMessageKey(role, kind, nativeId);
    const row = (key && nativeBlocks.get(key)) || { id: randomUUID(), role, kind, text: '', createdAt: new Date().toISOString() };
    const message = { ...row, attachments: [...(row.attachments ?? []), { type: 'image', mime: content.mimeType, ...(stored ? { sha256: stored.sha256 } : {}) }] };
    if (key !== null) nativeBlocks.set(key, message);
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
    if (active) admit();
    const tool = params.toolCall ?? {};
    const approval = (params.options ?? []).find((option: Row) => option.kind === 'allow_once');
    if (approval && allowsMcp(tool)) {
      write({ id: frame.id, result: { outcome: { outcome: 'selected', optionId: approval.optionId } } });
      return;
    }
    const patch = diffPreview(tool.content);
    const id = String(frame.id);
    const command = tool.rawInput?.command ?? tool.rawInput?.CommandLine;
    const once = (params.options ?? []).find((option: Row) => option.kind === 'allow_once');
    const always = (params.options ?? []).find((option: Row) => option.kind === 'allow_always');
    const reject = (params.options ?? []).find((option: Row) => option.kind === 'reject_once');
    permissions.set(id, { id, rpcId: frame.id, options: params.options ?? [], action: tool.title ?? 'Tool permission', resources: tool.locations?.map((location: Row) => location.path) ?? [], ...(patch ? { patch } : {}), ...(typeof command === 'string' ? { command } : {}), ...(typeof tool.rawInput?.Reason === 'string' ? { detail: tool.rawInput.Reason } : {}), always: Boolean(always), ...(once ? { onceLabel: once.name } : {}), ...(always ? { alwaysLabel: always.name } : {}), ...(reject ? { rejectLabel: reject.name } : {}) });
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
      admit();
      block = null;
      const id = `tool:${String(update.toolCallId)}`;
      const previous = messages.find((row) => row.id === id);
      // A diff part is shown through input.patch; its full file text stays out.
      const output = (update.content ?? []).map((part: Row) => part.type === 'content' && part.content?.type === 'text' ? part.content.text : part.type === 'diff' ? part.path : '').filter(Boolean).join('\n');
      const prior = previous?.tool?.input as Row | undefined;
      const rawInput = update.rawInput ?? {};
      const patch = diffPreview(update.content) ?? prior?.patch;
      const inputPath = rawInput.Path ?? rawInput.path;
      const preview = Buffer.byteLength(JSON.stringify(rawInput)) > TOOL_FIELD_BYTES
        ? { truncated: true, ...(typeof inputPath === 'string' ? { path: toolPreview(inputPath) } : {}) } : rawInput;
      const input = { ...(update.rawInput == null ? prior : preview), ...(typeof rawInput.Path === 'string' ? { path: toolPreview(rawInput.Path) } : {}), ...(patch ? { patch } : {}) };
      const toolState = { ...(previous?.tool?.state as Row | undefined), status: update.status ?? (previous?.tool?.state as Row | undefined)?.status ?? 'pending', ...(update.rawOutput !== undefined ? { output: toolOutput(update.rawOutput) } : {}) };
      if (loaded && !failed && !stopping) {
        if (toolState.status === 'pending' || toolState.status === 'in_progress') runningTools.add(id);
        else if (runningTools.delete(id) && !runningTools.size && cancelWatchingTools) finishCancellation();
        backgroundActivity();
      }
      replace({ id, role: 'assistant', kind: 'tool', text: output ? toolPreview(output) : previous?.text || '', createdAt: previous?.createdAt ?? new Date().toISOString(), ...(['completed', 'failed'].includes(toolState.status) ? { completedAt: previous?.completedAt ?? new Date().toISOString() } : {}), tool: { name: update.name ?? previous?.tool?.name ?? update.kind ?? 'Tool', input, state: toolState } });
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
  const saved = config.resumeId ? readAcpSettings(config.settingsDirectory, sessionId) : {};
  savedSettings = JSON.stringify(saved);
  mcpPolicy = saved.mcpPolicy ?? 'allow';
  const wantedModel = config.restoreSavedSettings && saved.model !== undefined ? saved.model : config.model ?? saved.model;
  // A combined model id can select its own effort (flash-low, for example).
  // Saved effort must not undo that explicit choice at resume.
  const wantedReasoning = config.restoreSavedSettings && saved.reasoning !== undefined ? saved.reasoning : config.reasoning ?? (config.model ? undefined : saved.reasoning);
  if (wantedModel) {
    const option = options.find((option) => option.id === 'model');
    if (optionValues(option).some((entry) => entry.value === wantedModel)) {
      const result = await rpc('session/set_config_option', { sessionId, configId: 'model', value: wantedModel });
      if (result.configOptions) options = result.configOptions;
    } else await rpc('session/set_model', { sessionId, modelId: wantedModel });
    model = wantedModel;
  }
  if (wantedReasoning) {
    const result = await rpc('session/set_config_option', { sessionId, configId: 'thought_level', value: wantedReasoning });
    if (result.configOptions) options = result.configOptions;
  }
  const wantedMode = saved.mode ?? 'auto';
  const mode = options.find((option) => option.id === 'mode');
  if (optionValues(mode).some((entry) => entry.value === wantedMode)) {
    const result = await rpc('session/set_config_option', { sessionId, configId: 'mode', value: wantedMode });
    if (result.configOptions) options = result.configOptions;
  } else {
    replace({ id: randomUUID(), role: 'assistant', kind: 'notice', level: 'warning', text: `Antigravity does not offer ${wantedMode} mode for this account or platform. Its native mode is unchanged; MCP requests still ask for approval.` });
  }
  saveSettings();
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
const PAGE_MESSAGES = 200;
const PAGE_BYTES = 1024 * 1024;
const hostId = randomUUID();

function pageStart(end: number): number {
  let start = end, bytes = 2;
  while (start > 0 && end - start < PAGE_MESSAGES) {
    const size = Buffer.byteLength(JSON.stringify(messages[start - 1])) + (start === end ? 0 : 1);
    if (start < end && bytes + size > PAGE_BYTES) break;
    bytes += size; start--;
  }
  return start;
}

function pageCursor(start: number): string | null {
  return start > 0 ? `${hostId}:${start}` : null;
}

function olderPage(cursor: unknown): Row {
  const match = typeof cursor === 'string' ? /^([0-9a-f-]+):(\d+)$/.exec(cursor) : null;
  const end = match ? Number(match[2]) : Number.NaN;
  if (!match || match[1] !== hostId || !Number.isSafeInteger(end) || end < 1 || end > messages.length) throw new Error('This history cursor is no longer valid; reopen the conversation');
  const start = pageStart(end);
  return { messages: { data: messages.slice(start, end) }, cursor: pageCursor(start) };
}

function snapshot(): Row {
  const start = pageStart(messages.length);
  const cursor = pageCursor(start);
  return {
    provider_session_id: sessionId,
    status,
    ...(statusDetail ? { status_detail: statusDetail } : {}),
    messages: { data: messages.slice(start) },
    history_truncated: cursor !== null,
    history_cursor: cursor ? { next: cursor } : null,
    permissions: { data: [...permissions.values()].map(({ rpcId: _rpcId, options: _options, ...permission }) => permission) },
    questions: { data: [] },
    usage,
    revision,
    ...controlState()
  };
}

async function handle(method: string, params: Row): Promise<unknown> {
  if (method === 'conversation') return snapshot();
  if (method === 'older') return olderPage(params.cursor);
  if (method === 'controls') return controlState();
  if (method === 'delivery') return { state: deliveries.has(params.clientMessageId) ? 'accepted' : 'unknown' };
  if (method === 'stop') {
    await stopNative();
    setImmediate(exitHost);
    return {};
  }
  if (!loaded || failed || stopping) throw new Error(statusDetail || 'ACP agent is not ready');
  if (method === 'prompt') {
    if (params.clientMessageId && deliveries.has(params.clientMessageId)) return { accepted: true };
    if (busy() || configuring) throw new Error('ACP turn is busy');
    if (!Array.isArray(params.prompt) || !params.prompt.length) throw new Error('Message is empty');
    active = true; cancelling = false; statusDetail = ''; block = null; userConfirmed = false;
    userEcho = { id: params.clientMessageId ?? randomUUID(), ...(params.clientMessageId ? { clientMessageId: params.clientMessageId } : {}), role: 'user', kind: 'text', text: String(params.text ?? ''), createdAt: new Date().toISOString(), attachments: params.attachments ?? [] };
    const accepted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { admission = null; reject(new Error('ACP prompt delivery is uncertain')); }, 8_000);
      admission = { resolve, reject, timer };
    });
    state();
    // The result arrives only at turn end. Keep the host socket responsive to
    // permissions and cancellation instead of awaiting it in this handler.
    const turn = rpc('session/prompt', { sessionId, prompt: params.prompt }, 0);
    usage.lastModelActivityAt = new Date().toISOString();
    void turn.then((result) => {
      if (failed || stopping) return;
      admit();
      if (result.stopReason === 'cancelled') finishTools('Response stopped');
      finishCancellation();
      const stopped = Object.hasOwn(STOP_REASONS, result.stopReason) ? STOP_REASONS[result.stopReason] : null;
      if (stopped) replace({ id: randomUUID(), role: 'assistant', kind: 'notice', level: 'warning', text: stopped });
      if (result.usage) {
        usage.inputTokens = (usage.inputTokens ?? 0) + (result.usage.inputTokens ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (result.usage.outputTokens ?? 0);
      }
      active = false; userEcho = null; block = null; cancelPermissions();
      setImmediate(() => { if (!stopping && status !== 'error') state(); });
      saveSettings();
    }, (error: Error) => {
      active = false; userEcho = null;
      if (!failed && !stopping) { cancelPermissions(); fail(error, error instanceof NativeAcpTransportError); publish({ kind: 'pending' }); }
    }).catch(fail);
    await accepted;
    return { accepted: true };
  }
  if (method === 'interrupt') {
    if (!busy() || cancelling) return {};
    cancelling = true;
    cancelWatchingTools = !active && runningTools.size > 0;
    write({ method: 'session/cancel', params: { sessionId } });
    cancelPermissions();
    cancelDeadline = setTimeout(() => {
      fail(new NativeAcpTransportError('Antigravity did not confirm cancellation. Restart the agent before sending another message.'));
      publish({ kind: 'pending' });
    }, CANCEL_TIMEOUT_MS);
    state(); publish({ kind: 'pending' }); return {};
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
      controlsRevision++; publish({ kind: 'pending' }); return {};
    }
    const option = options.find((entry) => entry.id === params.selector);
    if (!option) throw new Error('Unknown ACP setting');
    const values = optionValues(option);
    if (!values.some((entry: Row) => entry.value === params.value)) throw new Error('Unknown ACP setting value');
    configuring = true;
    try {
      const result = await rpc('session/set_config_option', { sessionId, configId: params.selector, value: params.value });
      if (result.configOptions) options = result.configOptions;
      if (params.selector === 'model') model = params.value;
      controlsRevision++; publish({ kind: 'pending' });
      try { rememberSettings(); }
      catch (error) { warnSettings(error); throw new Error('Antigravity applied the setting, but Patterm could not save it for resume'); }
      return {};
    } finally { configuring = false; }
  }
  throw new Error(`Unknown ACP host method: ${method}`);
}

removeStaleIpc(config.socketPath);
const server = net.createServer((socket) => {
  socket.on('error', () => { subscribers.delete(socket); socket.destroy(); });
  socket.on('close', () => subscribers.delete(socket));
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
      if (request.method === 'subscribe') { subscribers.add(socket); respond({ revision }); publish({ kind: 'pending' }); }
      else void handle(String(request.method), request.params ?? {}).then((result) => respond(result), (error) => respond(null, error));
    }
  });
});
server.listen(ipcPath(config.socketPath), () => restrictIpc(config.socketPath));
void start().catch(fail);

async function stop(): Promise<void> {
  await stopNative();
  exitHost();
}

function stopNative(): Promise<void> {
  if (shutdown) return shutdown;
  stopping = true;
  finishCancellation();
  shutdown = (async () => {
    if (nativeClose && loaded && child.exitCode === null && child.signalCode === null) {
      try { cancelPermissions(); } catch { /* the native pipe may already be closed */ }
      await rpc('session/close', { sessionId }, 2000).catch(() => undefined);
    }
    if (child.pid) await killProcessTree(child.pid).catch(() => undefined);
  })();
  return shutdown;
}

function exitHost(): never {
  for (const socket of subscribers) socket.destroy();
  server.close();
  removeStaleIpc(config.socketPath);
  fs.rmSync(process.argv[2]!, { force: true });
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
