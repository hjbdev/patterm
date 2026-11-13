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
let stopping = false;
let loaded = false;
let failed = false;
let block: IntegratedConversationMessage | null = null;
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
child.stdout.on('data', (chunk: string) => {
  buffer += chunk;
  if (buffer.length > 32 * 1024 * 1024) { transportFailed(new Error('ACP frame exceeds limit')); void stop(); return; }
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    try { receive(JSON.parse(line)); } catch (error) { transportFailed(error instanceof Error ? error : new Error(String(error))); }
  }
});

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
function state(): void {
  status = failed ? 'error' : permissions.size ? 'permission' : active ? 'working' : loaded ? 'idle' : status;
  publish({ kind: 'status', status });
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
  failed = fatal;
  permissions.clear();
  finishTools(error.message);
  status = 'error'; statusDetail = error.message; publish({ kind: 'status', status, detail: statusDetail });
}
function finishTools(reason: string): void {
  for (const message of [...messages]) {
    const tool = message.tool;
    if (!tool || !['pending', 'in_progress'].includes((tool.state as Row | undefined)?.status)) continue;
    replace({ ...message, completedAt: new Date().toISOString(), tool: { ...tool, state: { ...(tool.state as Row), status: 'failed', error: reason } } });
  }
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
function chunk(kind: 'text' | 'reasoning', text: string, role: 'user' | 'assistant' = 'assistant'): void {
  if (role === 'user' && userEcho) { admit(); block = null; return; }
  if (role === 'assistant') admit();
  if (!block || block.kind !== kind || block.role !== role) {
    block = { id: randomUUID(), role, kind, text: '', createdAt: new Date().toISOString() };
    messages.push(block);
  }
  block.text += text;
  publish({ kind: 'append', id: block.id, messageKind: kind, delta: text });
}
function contentChunk(content: Row, kind: 'text' | 'reasoning', role: 'user' | 'assistant'): void {
  if (content.type === 'text') { chunk(kind, String(content.text ?? ''), role); return; }
  if (role === 'user' && userEcho) { admit(); return; }
  if (content.type === 'image' && typeof content.data === 'string') {
    const stored = images?.fromBase64(content.data);
    replace({ id: randomUUID(), role, kind: 'text', text: '', attachments: [{ type: 'image', mime: content.mimeType, ...(stored ? { sha256: stored.sha256 } : {}) }], createdAt: new Date().toISOString() });
    block = null;
  }
}
function diffPreview(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (part?.type !== 'diff' || typeof part.newText !== 'string' || typeof part.path !== 'string') continue;
    const before: string = typeof part.oldText === 'string' ? part.oldText : '';
    const after: string = part.newText;
    // Oversized files remain identified by path; never show a truncated patch
    // that pretends to describe the whole edit.
    if (before.length + after.length > 128_000) continue;
    const lines = (text: string) => text ? text.replace(/\n$/, '').split('\n') : [];
    const oldLines = lines(before), newLines = lines(after);
    parts.push(`--- ${part.oldText == null ? '/dev/null' : part.path}\n+++ ${part.path}\n@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n${[...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)].join('\n')}`);
  }
  return parts.length ? parts.join('\n') : null;
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
    if (frame.params?.sessionId !== sessionId || !active || cancelling) { write({ id: frame.id, result: { outcome: { outcome: 'cancelled' } } }); return; }
    const params = frame.params as Row;
    admit();
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
    block = null; state(); publish({ kind: 'pending' }); return;
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
      contentChunk(content, update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'text', update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant');
      break;
    }
    case 'tool_call': case 'tool_call_update': {
      admit();
      block = null;
      const id = `tool:${String(update.toolCallId)}`;
      const previous = messages.find((row) => row.id === id);
      const output = (update.content ?? []).map((part: Row) => part.type === 'content' && part.content?.type === 'text' ? part.content.text : part.type === 'diff' ? `${part.path}\n${part.newText ?? ''}` : '').filter(Boolean).join('\n');
      const rawInput = update.rawInput ?? previous?.tool?.input ?? {};
      const patch = diffPreview(update.content);
      const input = { ...rawInput, ...(typeof rawInput.Path === 'string' ? { path: rawInput.Path } : {}), ...(typeof rawInput.Content === 'string' ? { content: rawInput.Content } : {}), ...(patch ? { patch } : {}) };
      const toolState = { ...(previous?.tool?.state as Row | undefined), status: update.status ?? (previous?.tool?.state as Row | undefined)?.status ?? 'pending', ...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}) };
      replace({ id, role: 'assistant', kind: 'tool', text: output || previous?.text || '', createdAt: previous?.createdAt ?? new Date().toISOString(), ...(['completed', 'failed'].includes(toolState.status) ? { completedAt: previous?.completedAt ?? new Date().toISOString() } : {}), tool: { name: update.name ?? previous?.tool?.name ?? update.kind ?? 'Tool', input, state: toolState } });
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

function snapshot(): Row {
  return {
    provider_session_id: sessionId,
    status,
    ...(statusDetail ? { status_detail: statusDetail } : {}),
    messages: { data: messages },
    permissions: { data: [...permissions.values()].map(({ rpcId: _rpcId, options: _options, ...permission }) => permission) },
    questions: { data: [] },
    usage,
    revision,
    ...controlState()
  };
}

async function handle(method: string, params: Row): Promise<unknown> {
  if (method === 'conversation') return snapshot();
  if (method === 'controls') return controlState();
  if (method === 'delivery') return { state: deliveries.has(params.clientMessageId) ? 'accepted' : 'unknown' };
  if (method === 'stop') { setImmediate(() => void stop()); return {}; }
  if (!loaded || failed) throw new Error(statusDetail || 'ACP agent is not ready');
  if (method === 'prompt') {
    if (active || configuring) throw new Error('ACP turn is busy');
    if (params.clientMessageId && deliveries.has(params.clientMessageId)) return { accepted: true };
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
      admit();
      if (result.stopReason === 'cancelled') finishTools('Response stopped');
      if (result.usage) {
        usage.inputTokens = (usage.inputTokens ?? 0) + (result.usage.inputTokens ?? 0);
        usage.outputTokens = (usage.outputTokens ?? 0) + (result.usage.outputTokens ?? 0);
      }
      active = false; userEcho = null; block = null; permissions.clear(); state(); publish({ kind: 'pending' });
      saveSettings();
    }, (error: Error) => { active = false; userEcho = null; permissions.clear(); fail(error, error instanceof NativeAcpTransportError); publish({ kind: 'pending' }); }).catch(fail);
    await accepted;
    return { accepted: true };
  }
  if (method === 'interrupt') {
    cancelling = true;
    write({ method: 'session/cancel', params: { sessionId } });
    for (const request of permissions.values()) write({ id: request.rpcId, result: { outcome: { outcome: 'cancelled' } } });
    permissions.clear(); state(); publish({ kind: 'pending' }); return {};
  }
  if (method === 'permission') {
    const request = permissions.get(String(params.requestId));
    if (!request) throw new Error('ACP permission request is no longer pending');
    const kind = params.reply === 'always' ? 'allow_always' : params.reply === 'once' ? 'allow_once' : 'reject_once';
    const option = request.options.find((entry: Row) => entry.kind === kind);
    if (!option && params.reply !== 'reject') throw new Error('This permission choice was not offered by the agent');
    write({ id: request.rpcId, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
    permissions.delete(String(params.requestId)); state(); publish({ kind: 'pending' }); return {};
  }
  if (method === 'configure') {
    if (active) throw new Error('Wait for the ACP turn to finish before changing settings');
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
  if (stopping) return;
  stopping = true;
  if (child.pid) await killProcessTree(child.pid).catch(() => undefined);
  for (const socket of subscribers) socket.destroy();
  server.close();
  removeStaleIpc(config.socketPath);
  fs.rmSync(process.argv[2]!, { force: true });
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
