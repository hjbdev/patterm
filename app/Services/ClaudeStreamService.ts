import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { DatabaseService } from './DatabaseService';
import { detachedHostLauncher, hostConnectionError, type IntegratedHostLauncher } from './IntegratedHostLauncher';
import type { IntegratedControlSelector, IntegratedControls, IntegratedFormAction, IntegratedLaunchInput, IntegratedLaunchResult } from './IntegratedAgentService';
import { UncertainDeliveryError, type IntegratedDeliveryState } from './IntegratedDelivery';
import type { IntegratedConversationEvent, IntegratedConversationListener } from './IntegratedConversation';
import type { ResolvedIntegratedPrompt } from './IntegratedInput';
import { readClaudeTaskOutput, type ClaudeTaskOutput } from './ClaudeTaskOutput';
import { containsReferenceToken, referenceToken } from './PromptReferences';
import type { TranscriptImageStore } from './TranscriptImageStore';
import { claudeMcpServers } from '../Harness/McpDelivery';

const CLAUDE_RECONNECT_ATTEMPTS = 8;

interface ClaudeRuntime {
  executable: string;
  cwd: string;
  socketPath: string;
  pid: number | null;
  sessionId: string;
  pattermSessionId: string;
}

export class ClaudeStreamService {
  // Native model and command catalogue per host control socket. A relaunch
  // gets a new socket, so an entry never outlives the host it describes.
  private readonly catalogs = new Map<string, { models: unknown[]; commands: unknown[] }>();

  constructor(
    private readonly database: DatabaseService,
    private readonly runtimeDir: string,
    private readonly nodePath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly hostScript = path.resolve(__dirname, '../Runtime/ClaudeIntegratedHost.js'),
    private readonly launcher: IntegratedHostLauncher = detachedHostLauncher,
    private readonly images: TranscriptImageStore | null = null
  ) {}

  async prepare(input: IntegratedLaunchInput): Promise<IntegratedLaunchResult> {
    const directory = path.join(this.runtimeDir, 'claude');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const key = randomUUID();
    const sessionId = input.resumeId ?? randomUUID();
    if (input.resumeId) {
      const attached = this.database.connection.prepare('select id from sessions where harness = ? and resume_id = ? and exited_at is null').get('claude', input.resumeId);
      if (attached) throw new Error('Claude session is already attached to Patterm');
    }
    const socketPath = path.join(directory, `${key}.sock`);
    const configPath = path.join(directory, `${key}.json`);
    const mcpConfigPath = path.join(directory, `${key}-mcp.json`);
    const patterm = { command: input.mcp.command, args: input.mcp.args, env: input.mcp.env };
    const mcpConfig = { mcpServers: { ...claudeMcpServers(input.mcpServers ?? [], input.mcp), patterm } };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
    fs.writeFileSync(configPath, JSON.stringify({
      socketPath, executable: input.executable, cwd: input.cwd, sessionId,
      resume: Boolean(input.resumeId), context: input.context, mcpConfigPath,
      model: input.model ?? null, reasoning: input.reasoning ?? null,
      ...(this.images ? { imageDirectory: this.images.directory } : {})
    }), { mode: 0o600 });
    const pid = await this.launcher.launch({ harness: 'claude', key, nodePath: this.nodePath, script: this.hostScript, configPath, cwd: input.cwd, env: this.env });
    try {
      await waitForSocket(socketPath, pid);
      // Wait briefly for the child spawn outcome so a missing executable fails
      // the launch instead of looking like a healthy idle host.
      let state: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 20; attempt++) {
        state = record(await callHost(socketPath, 'conversation', {}));
        if (state.status !== 'starting') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (state.status === 'failed') {
        const hostMessages = Array.isArray(record(state.messages).data) ? record(state.messages).data as unknown[] : [];
        // Surface the native failure honestly: the CLI's own stderr message is
        // more useful than a generic launch error.
        const failure = hostMessages.map(record).filter((message) => {
          const id = typeof message.id === 'string' ? message.id : '';
          const text = typeof message.text === 'string' ? message.text : '';
          return text.startsWith('Claude Code could not start') || ((id.startsWith('error_') || id.startsWith('stderr_')) && text.length > 0);
        }).at(-1);
        throw new Error(String(failure?.text ?? 'Claude Code could not start; check the executable and authentication'));
      }
      return { resumeId: sessionId, argv: [input.executable, 'claude-host', socketPath, String(pid ?? ''), configPath] };
    } catch (error) {
      stopPid(pid);
      throw error;
    }
  }

  async conversation(processId: string): Promise<unknown> {
    const runtime = this.runtime(processId);
    const result = record(await callHost(runtime.socketPath, 'conversation', {}));
    const messages = record(result.messages);
    return {
      process_id: processId, session_id: runtime.pattermSessionId, provider_session_id: runtime.sessionId, provider: 'claude',
      ...result,
      ...(Array.isArray(messages.data) ? { messages: { ...messages, data: messages.data.map(withoutOriginalFile) } } : {}),
      streaming: true,
      status: claudeActivity(result.status),
      questions: { data: claudeQuestionRequests(result.questions) }
    };
  }

  // The host streams targeted transcript events over a persistent connection.
  // Forwarded native events keep the host's revision, so the conversation
  // snapshot boundary (the host revision captured before its payload) is exact.
  // Local connection-state events carry revision 0 and are transport state, not
  // transcript content, so they never inflate the native revision domain.
  async subscribe(processId: string, listener: IntegratedConversationListener): Promise<() => void> {
    const runtime = this.runtime(processId);
    let stopped = false;
    let socket: net.Socket | null = null;
    let retry: NodeJS.Timeout | null = null;
    let attempts = 0;
    const forward = (event: Record<string, unknown>, revision: number): void => {
      const message = event.kind === 'replace' && event.message ? { message: withoutOriginalFile(event.message) } : {};
      listener({ ...event, ...message, processId, revision } as IntegratedConversationEvent);
    };
    const schedule = (): void => {
      if (stopped) return;
      forward({ kind: 'reconnecting' }, 0);
      attempts += 1;
      if (attempts > CLAUDE_RECONNECT_ATTEMPTS) {
        forward({ kind: 'error', id: 'connection_error', delta: 'Could not reconnect to the Claude host.' }, 0);
        return;
      }
      retry = setTimeout(() => {
        void connect().catch(() => {
          // A failed attempt before acknowledgement must keep the bounded
          // recovery alive instead of stopping after the first miss.
          if (!stopped) schedule();
        });
      }, Math.min(250 * 2 ** (attempts - 1), 5_000));
    };
    const connect = (): Promise<void> => new Promise((resolve, reject) => {
      const next = net.createConnection(runtime.socketPath);
      socket = next;
      let buffer = '';
      let acknowledged = false;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        next.destroy();
        reject(error);
      };
      next.setEncoding('utf8');
      next.once('error', (error) => { if (!acknowledged) fail(error); });
      next.once('close', () => {
        if (!acknowledged) fail(new Error('Claude host closed before acknowledging the subscription'));
        else if (!stopped) schedule();
      });
      next.once('connect', () => next.write(`${JSON.stringify({ id: randomUUID(), method: 'subscribe', params: {} })}\n`));
      next.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let frame: Record<string, unknown>;
          try { frame = record(JSON.parse(line)); } catch { continue; }
          if (!acknowledged) {
            if (frame.error !== undefined) { fail(new Error(String(frame.error))); return; }
            acknowledged = true;
            settled = true;
            attempts = 0;
            resolve();
            continue;
          }
          const event = record(frame.event);
          if (typeof event.kind !== 'string') continue;
          const revision = typeof event.revision === 'number' && Number.isFinite(event.revision) ? Number(event.revision) : 0;
          forward(event, revision);
        }
      });
    });
    await connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.destroy();
    };
  }

  async prompt(processId: string, input: ResolvedIntegratedPrompt): Promise<unknown> {
    // Claude accepts images as base64 content blocks and @path text references;
    // it has no generic file block, so other attachments are rejected clearly.
    const unsupported = input.attachments.filter((attachment) => !attachment.mime.startsWith('image/'));
    if (unsupported.length) {
      throw new Error(`Claude Code can attach images and @ file references, not ${unsupported.map((attachment) => attachment.name).join(', ')}`);
    }
    const references = input.references.filter((reference) => !containsReferenceToken(input.text, reference.relativePath));
    const text = [input.text.trim(), ...references.map((reference) => referenceToken(reference.relativePath))].filter(Boolean).join(' ');
    // Inline the exact bytes validated by UploadService rather than re-reading.
    const images = input.attachments.map((attachment) => ({
      media_type: attachment.mime,
      data: attachment.data ?? fs.readFileSync(attachment.path).toString('base64')
    }));
    // These small descriptors are for Patterm's user row only. Never send
    // server paths or base64 bytes back through the browser transcript; a
    // stored image is shown by its hash.
    const displayAttachments = [
      ...input.references.map((reference) => ({ type: 'reference', name: reference.name, detail: `@${reference.relativePath}` })),
      ...input.attachments.map((attachment, index) => {
        const stored = this.images?.fromBase64(images[index]!.data);
        return { type: 'image', name: attachment.name, mime: attachment.mime, ...(stored ? { sha256: stored.sha256 } : {}) };
      })
    ];
    if (!text && !images.length) throw new Error('Message is empty');
    try {
      return await callHost(this.runtime(processId).socketPath, 'prompt', {
        text,
        images,
        attachments: displayAttachments,
        ...(input.messageId ? { clientMessageId: input.messageId } : {})
      });
    } catch (error) {
      if (isUncertainHostFailure(error)) {
        throw new UncertainDeliveryError(error instanceof Error ? error.message : String(error), input.messageId);
      }
      throw error;
    }
  }

  // The host acknowledges native replay frames for a client uuid; the local
  // prompt write alone is not acceptance.
  async reconcile(processId: string, messageId: string): Promise<IntegratedDeliveryState> {
    const result = record(await callHost(this.runtime(processId).socketPath, 'delivery', { clientMessageId: messageId })) as { state?: unknown };
    return result.state === 'accepted' ? 'accepted' : 'unknown';
  }

  async controls(processId: string): Promise<IntegratedControls> {
    const state = await this.controlState(this.runtime(processId).socketPath);
    return {
      selectors: [claudeModelSelector(state), claudeEffortSelector(state), claudeModeSelector(state)]
        .filter((selector): selector is IntegratedControlSelector => selector !== null),
      commands: nativeCommands(state)
    };
  }

  async configure(processId: string, selector: string, value: string): Promise<void> {
    const socketPath = this.runtime(processId).socketPath;
    const state = await this.controlState(socketPath);
    const control = selector === 'model' ? claudeModelSelector(state)
      : selector === 'effort' ? claudeEffortSelector(state)
      : selector === 'mode' ? claudeModeSelector(state) : null;
    if (!control?.options.some((option) => option.value === value)) throw new Error('Unknown Claude setting');
    await callHost(socketPath, 'configure', { selector, value });
  }

  command(processId: string, name: string, text: string): Promise<unknown> {
    return this.prompt(processId, { text: `/${name}${text ? ` ${text}` : ''}`, references: [], attachments: [] });
  }

  // Claude Code's built-in /compact takes precedence over custom commands.
  compact(processId: string): Promise<unknown> {
    return this.command(processId, 'compact', '');
  }

  // Hosts from an older generation have no `title` method.
  async title(processId: string, prompt: string): Promise<string | null> {
    try {
      const value = record(await callHost(this.runtime(processId).socketPath, 'title', { prompt })).title;
      return typeof value === 'string' && value ? value : null;
    } catch (error) {
      if (error instanceof Error && /^Unknown \w+ host method: title$/.test(error.message)) return null;
      throw error;
    }
  }

  async interrupt(processId: string): Promise<void> {
    await callHost(this.runtime(processId).socketPath, 'interrupt', {});
  }

  async stopTask(processId: string, taskId: string): Promise<void> {
    await callHost(this.runtime(processId).socketPath, 'stopTask', { taskId });
  }

  async taskOutput(processId: string, taskId: string, since?: string | null, cursor?: string | null): Promise<ClaudeTaskOutput> {
    const runtime = this.runtime(processId);
    return readClaudeTaskOutput({ cwd: runtime.cwd, sessionId: runtime.sessionId, env: this.env }, taskId, since, cursor);
  }

  async replyPermission(processId: string, requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    await callHost(this.runtime(processId).socketPath, 'permission', { requestId, reply, message });
  }

  async replyQuestion(processId: string, requestId: string, answers: string[][]): Promise<void> {
    await callHost(this.runtime(processId).socketPath, 'question', { requestId, answers });
  }

  // MCP elicitations, answered or declined through the shared form dock.
  async replyForm(processId: string, formId: string, answer: Record<string, unknown>, action: IntegratedFormAction = 'accept'): Promise<void> {
    await callHost(this.runtime(processId).socketPath, 'form', { formId, answer, action });
  }

  async stop(processId: string): Promise<void> {
    const runtime = this.runtime(processId);
    // A host whose native CLI already failed or exited has nothing to
    // interrupt, but the host stop below still runs and cleans it up. A
    // failure of the host stop itself still propagates.
    try { await this.interrupt(processId); } catch { /* the host stop decides */ }
    try { await callHost(runtime.socketPath, 'stop', {}); } catch { stopPid(runtime.pid); }
    this.catalogs.delete(runtime.socketPath);
  }

  async cleanupLaunch(_input: IntegratedLaunchInput, result: IntegratedLaunchResult): Promise<void> {
    const pid = typeof result.argv[3] === 'string' && /^\d+$/.test(result.argv[3]) ? Number(result.argv[3]) : null;
    stopPid(pid);
  }

  async stopAll(): Promise<void> {
    const rows = this.database.connection.prepare(`
      select processes.id from processes join sessions on sessions.process_id = processes.id
      where sessions.harness = ? and sessions.interface_mode = 'integrated' and sessions.exited_at is null
    `).all('claude') as Array<{ id: string }>;
    const results = await Promise.allSettled(rows.map(async (row) => {
      // The Claude stop owns the best-effort interrupt and the host stop.
      await this.stop(row.id);
    }));
    // Also stop hosts whose sessions were already reconciled as failed.
    results.push(...await Promise.allSettled([this.launcher.stopAll('claude')]));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'Could not stop every Claude host');
  }

  // Current settings are always read from the host; only the native model and
  // command catalogue is remembered. The launch wait for the `initialize` reply
  // happens once per host, so a later switch never pays for it again, even
  // when a Claude build never reports a model list.
  private async controlState(socketPath: string): Promise<Record<string, unknown>> {
    let state = await readControls(socketPath);
    const cached = this.catalogs.get(socketPath);
    if (!nativeModels(state).length && cached) {
      return { ...state, models: cached.models, commands: Array.isArray(state.commands) && state.commands.length ? state.commands : cached.commands };
    }
    for (let attempt = 0; attempt < 20 && !nativeModels(state).length && state.status !== 'failed'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await readControls(socketPath);
    }
    this.catalogs.set(socketPath, { models: nativeModels(state), commands: Array.isArray(state.commands) ? state.commands : [] });
    return state;
  }

  private runtime(processId: string): ClaudeRuntime {
    const row = this.database.connection.prepare(`
      select processes.argv, sessions.resume_id, sessions.id as session_id, coalesce(sessions.cwd, processes.cwd) as cwd
      from sessions join processes on processes.id = sessions.process_id
      where (sessions.process_id = ? or sessions.id = ?) and sessions.harness = ?
        and sessions.interface_mode = 'integrated' and sessions.resume_id is not null
      order by sessions.exited_at is null desc, sessions.started_at desc limit 1
    `).get(processId, processId, 'claude') as { argv: string; resume_id: string; session_id: string; cwd: string | null } | undefined;
    if (!row) throw new Error('Claude Integrated session not found');
    const argv = JSON.parse(row.argv) as unknown;
    if (!Array.isArray(argv) || argv[1] !== 'claude-host' || typeof argv[2] !== 'string') throw new Error('Integrated runtime metadata is invalid');
    const pid = typeof argv[3] === 'string' && /^\d+$/.test(argv[3]) ? Number(argv[3]) : null;
    return { executable: String(argv[0]), cwd: row.cwd ?? process.cwd(), socketPath: argv[2], pid, sessionId: row.resume_id, pattermSessionId: row.session_id };
  }
}

function callHost(socketPath: string, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error(`Claude host timed out: ${method}`)); }, 10_000);
    socket.setEncoding('utf8');
    socket.once('error', (error) => { clearTimeout(timeout); reject(hostConnectionError(error, 'Integrated agent')); });
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      const response = record(JSON.parse(buffer.slice(0, newline)));
      if (response.error) reject(new Error(String(response.error)));
      else resolve(response.result);
    });
  });
}

// Hosts from an older generation have no `controls` method; their full
// conversation read carries the same settings.
async function readControls(socketPath: string): Promise<Record<string, unknown>> {
  try {
    return record(await callHost(socketPath, 'controls', {}));
  } catch (error) {
    if (!(error instanceof Error) || !/^Unknown \w+ host method: controls$/.test(error.message)) throw error;
    return record(await callHost(socketPath, 'conversation', {}));
  }
}

async function waitForSocket(socketPath: string, pid: number | null): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(socketPath)) return;
    if (pid) {
      try { process.kill(pid, 0); } catch { throw new Error('Claude Integrated host exited during startup'); }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Claude Integrated host did not create its control socket');
}

function stopPid(pid: number | null): void {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

const FALLBACK_CLAUDE_MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'];
const FALLBACK_CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_MODES = [
  { value: 'auto', label: 'Auto' },
  { value: 'manual', label: 'Manual' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'dontAsk', label: "Don't ask" }
];

// Names with a leading `__` are Claude Code internals, not user commands.
function nativeCommands(state: Record<string, unknown>): IntegratedControls['commands'] {
  return (Array.isArray(state.commands) ? state.commands.map(record) : [])
    .filter((command) => typeof command.name === 'string' && command.name && !command.name.startsWith('__'))
    .map((command) => ({
      name: String(command.name),
      ...(typeof command.description === 'string' && command.description ? { description: command.description } : {})
    }));
}

function nativeModels(state: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(state.models) ? state.models.map(record).filter((model) => typeof model.value === 'string' && model.value) : [];
}

// Options come from Claude Code's own model list, so they name the account's
// versioned models. The default entry shows which model it resolves to.
function claudeModelSelector(state: Record<string, unknown>): IntegratedControlSelector {
  const value = String(state.model ?? 'default');
  const models = nativeModels(state);
  const options = models.length
    ? models.map((model) => {
        const displayName = typeof model.displayName === 'string' && model.displayName ? model.displayName : String(model.value);
        const resolved = typeof model.description === 'string' ? model.description.split(' · ')[0]?.trim() : '';
        return { value: String(model.value), label: model.value === 'default' && resolved ? `Default (${resolved})` : displayName };
      })
    : FALLBACK_CLAUDE_MODELS.map((alias) => ({ value: alias, label: alias[0]!.toUpperCase() + alias.slice(1) }));
  // A launch model typed as a full ID or alias outside the list stays selectable.
  if (!options.some((option) => option.value === value)) options.push({ value, label: value });
  return { id: 'model', label: 'Model', value, options };
}

// Levels come from the selected model's native `supportedEffortLevels`; a
// model without them (Haiku) has no effort control. A model outside the native
// list, or a list that has not arrived, falls back to the `--effort` levels.
function claudeEffortSelector(state: Record<string, unknown>): IntegratedControlSelector | null {
  const value = typeof state.effort === 'string' && state.effort ? state.effort : 'default';
  const models = nativeModels(state);
  const current = models.find((model) => model.value === String(state.model ?? 'default'));
  const levels = current
    ? (Array.isArray(current.supportedEffortLevels) ? current.supportedEffortLevels : []).filter((level): level is string => typeof level === 'string' && level.length > 0)
    : FALLBACK_CLAUDE_EFFORTS;
  if (!levels.length && value === 'default') return null;
  const resolved = value === 'default' && typeof state.appliedEffort === 'string' ? state.appliedEffort : '';
  const options = [
    { value: 'default', label: resolved ? `Default (${effortLabel(resolved)})` : 'Default' },
    ...levels.map((level) => ({ value: level, label: effortLabel(level) }))
  ];
  if (!options.some((option) => option.value === value)) options.push({ value, label: effortLabel(value) });
  return { id: 'effort', label: 'Effort', value, options };
}

function effortLabel(level: string): string {
  return level === 'xhigh' ? 'Extra high' : level[0]!.toUpperCase() + level.slice(1);
}

function claudeModeSelector(state: Record<string, unknown>): IntegratedControlSelector {
  const value = String(state.mode ?? 'manual');
  const current = nativeModels(state).find((model) => model.value === String(state.model ?? 'default'));
  // Claude Code marks the models that can run in auto mode.
  const autoAvailable = !current || current.supportsAutoMode === true || value === 'auto';
  return { id: 'mode', label: 'Mode', value, options: CLAUDE_MODES.filter((mode) => mode.value !== 'auto' || autoAvailable) };
}

// A Claude Edit result carries the whole file before the edit, which the
// transcript never shows. The host also dumped it into the row's text and
// output, so a session of edits to a large file grew snapshots past what the
// browser connection accepts. Rows from hosts already running still hold it.
function withoutOriginalFile(message: unknown): unknown {
  const row = record(message);
  const tool = record(row.tool);
  const { originalFile, ...result } = record(tool.result);
  if (typeof originalFile !== 'string') return message;
  const dumped = JSON.stringify(tool.result, null, 2);
  const text = JSON.stringify(result, null, 2);
  return {
    ...row,
    ...(row.text === dumped ? { text } : {}),
    tool: { ...tool, result, ...(tool.output === dumped ? { output: text } : {}) }
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// A lost host reply may happen after the host wrote the prompt to the native
// session; host error responses are definitive.
function isUncertainHostFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/^Claude host timed out:/.test(error.message)) return true;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code);
}

// The Claude host reports process status, not Patterm's activity vocabulary.
// Map only the states that have a verified activity meaning.
function claudeActivity(value: unknown): string | undefined {
  if (value === 'working') return 'working';
  if (value === 'permission') return 'permission';
  if (value === 'idle') return 'idle';
  if (value === 'failed' || value === 'error') return 'error';
  return undefined;
}

// AskUserQuestion uses `multiSelect` and always offers a free-text answer, so
// project native questions into the shared shape once, here rather than in the
// renderer.
function claudeQuestionRequests(value: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(record(value).data) ? record(value).data as unknown[] : [];
  return rows.flatMap((raw) => {
    const row = record(raw);
    if (typeof row.id !== 'string' || !Array.isArray(row.questions)) return [];
    const questions = row.questions.flatMap((item, index) => {
      const question = record(item);
      if (typeof question.question !== 'string') return [];
      return [{
        id: String(question.question ?? question.header ?? index),
        question: question.question,
        header: typeof question.header === 'string' ? question.header : '',
        options: Array.isArray(question.options) ? question.options.flatMap((option) => {
          const value = record(option);
          return typeof value.label === 'string'
            ? [{ label: value.label, ...(typeof value.description === 'string' ? { description: value.description } : {}) }]
            : [];
        }) : [],
        multiple: question.multiSelect === true,
        custom: true
      }];
    });
    return [{ id: row.id, questions }];
  });
}
