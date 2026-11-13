import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { DatabaseService } from './DatabaseService';
import type { IntegratedControls, IntegratedLaunchInput, IntegratedLaunchResult, IntegratedProviderService } from './IntegratedAgentService';
import type { ResolvedIntegratedPrompt } from './IntegratedInput';
import type { IntegratedConversationEvent, IntegratedConversationListener } from './IntegratedConversation';
import { TurnBusyError, UncertainDeliveryError } from './IntegratedDelivery';
import { callIntegratedHost, detachedHostLauncher, integratedHostReady, IntegratedHostTransportError, stopHostProcess, stopRecordedHostProcess, type IntegratedHostLauncher } from './IntegratedHostLauncher';
import { ipcPath } from '../Platform/Ipc';
import { claudeMcpServers } from '../Harness/McpDelivery';
import type { TranscriptImageStore } from './TranscriptImageStore';

type Row = Record<string, any>;

// One ACP process per conversation. The durable control socket is independent
// of browser connections and can be reattached after a Patterm server restart.
export class AcpProviderService implements IntegratedProviderService {
  constructor(
    private readonly database: DatabaseService,
    private readonly runtimeDir: string,
    private readonly nodePath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly hostScript = path.resolve(__dirname, '../Runtime/AcpIntegratedHost.js'),
    private readonly launcher: IntegratedHostLauncher = detachedHostLauncher,
    private readonly images: TranscriptImageStore | null = null
  ) {}

  async prepare(input: IntegratedLaunchInput): Promise<IntegratedLaunchResult> {
    if (input.serviceTier) throw new Error('Antigravity does not support Codex service tiers');
    if (input.resumeId && this.database.connection.prepare("select id from sessions where harness = 'agy' and resume_id = ? and exited_at is null").get(input.resumeId)) throw new Error('Antigravity session is already attached to Patterm');
    const directory = path.join(this.runtimeDir, 'acp');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const key = randomUUID();
    const socketPath = path.join(directory, `${key}.sock`);
    const configPath = path.join(directory, `${key}.json`);
    const servers = { ...claudeMcpServers(input.mcpServers ?? [], input.mcp), patterm: input.mcp };
    const mcpServers = Object.entries(servers).map(([name, value]) => {
      const server = value as { command: string; args: string[]; env: Record<string, string> };
      return { name, command: server.command, args: server.args, env: Object.entries(server.env).map(([name, value]) => ({ name, value })) };
    });
    fs.writeFileSync(configPath, JSON.stringify({ socketPath, executable: input.executable, cwd: input.cwd, resumeId: input.resumeId, context: input.context, model: input.model ?? null, reasoning: input.reasoning ?? null, mcpServers, ...(this.images ? { imageDirectory: this.images.directory } : {}) }), { mode: 0o600 });
    let pid: number | null = null;
    try {
      pid = await this.launcher.launch({ harness: 'agy', key, nodePath: this.nodePath, script: this.hostScript, configPath, cwd: input.cwd, env: this.env });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (pid) { try { process.kill(pid, 0); } catch { throw new Error('ACP host exited during startup'); } }
        if (await integratedHostReady(socketPath)) {
          const state = await callIntegratedHost(socketPath, 'conversation', {}) as Row;
          if (state.status === 'error') throw new Error(String(state.status_detail ?? 'Antigravity could not start'));
          if (state.status !== 'starting' && state.provider_session_id) return { resumeId: String(state.provider_session_id), argv: [input.executable, 'acp-host', socketPath, String(pid ?? ''), configPath] };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Antigravity did not initialise within 90 seconds');
    } catch (error) {
      await stopHostProcess(pid);
      fs.rmSync(configPath, { force: true });
      throw error;
    }
  }

  async conversation(processId: string): Promise<unknown> {
    const runtime = this.runtime(processId);
    const state = await callIntegratedHost(runtime.socketPath, 'conversation', {}) as Row;
    const { models: _models, modes: _modes, configOptions: _options, commands: _commands, ...snapshot } = state;
    return { ...snapshot, process_id: processId, session_id: runtime.sessionId, provider: 'agy', streaming: true };
  }

  async prompt(processId: string, input: ResolvedIntegratedPrompt): Promise<unknown> {
    const prompt: Row[] = [{ type: 'text', text: input.text }];
    const attachments: Row[] = input.references.map((reference) => ({ type: 'reference', name: reference.name, detail: `@${reference.relativePath}` }));
    for (const reference of input.references) prompt.push({ type: 'resource_link', uri: pathToFileURL(reference.path).href, name: reference.name });
    for (const attachment of input.attachments) {
      const data = attachment.data ?? fs.readFileSync(attachment.path).toString('base64');
      if (attachment.mime.startsWith('image/')) prompt.push({ type: 'image', mimeType: attachment.mime, data });
      else prompt.push({ type: 'resource', resource: { uri: `attachment:///${encodeURIComponent(attachment.name)}`, mimeType: attachment.mime, ...(attachment.mime === 'application/pdf' ? { blob: data } : { text: Buffer.from(data, 'base64').toString('utf8') }) } });
      const stored = attachment.mime.startsWith('image/') ? this.images?.fromBase64(data) : null;
      attachments.push({ type: stored ? 'image' : 'file', name: attachment.name, mime: attachment.mime, ...(stored ? { sha256: stored.sha256 } : {}) });
    }
    try {
      return await callIntegratedHost(this.runtime(processId).socketPath, 'prompt', { prompt, text: input.text, clientMessageId: input.messageId, attachments });
    } catch (error) {
      if (error instanceof Error && error.message === 'ACP turn is busy') throw new TurnBusyError(error.message, 'prompt');
      if (error instanceof Error && /^ACP prompt delivery is uncertain(?::|$)/.test(error.message)) throw new UncertainDeliveryError(error.message, input.messageId);
      if (error instanceof IntegratedHostTransportError || (error as NodeJS.ErrnoException)?.code) throw new UncertainDeliveryError(error instanceof Error ? error.message : String(error), input.messageId);
      throw error;
    }
  }
  async interrupt(processId: string): Promise<void> { await callIntegratedHost(this.runtime(processId).socketPath, 'interrupt', {}); }
  async replyPermission(processId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> { await callIntegratedHost(this.runtime(processId).socketPath, 'permission', { requestId, reply }); }
  async replyQuestion(): Promise<void> { throw new Error('Antigravity questions are answered in the conversation'); }
  async reconcile(processId: string, messageId: string) {
    const result = await callIntegratedHost(this.runtime(processId).socketPath, 'delivery', { clientMessageId: messageId }) as Row;
    return result.state === 'accepted' ? 'accepted' as const : 'unknown' as const;
  }
  async controls(processId: string): Promise<IntegratedControls> {
    const state = await callIntegratedHost(this.runtime(processId).socketPath, 'controls', {}) as Row;
    return {
      selectors: (state.configOptions ?? []).filter((option: Row) => option.type === 'select').map((option: Row) => ({ id: String(option.id), label: String(option.name), value: String(option.currentValue), options: (option.options ?? []).flatMap((entry: Row) => entry.options ?? [entry]).map((entry: Row) => ({ value: String(entry.value), label: String(entry.name), ...(entry.description ? { description: String(entry.description) } : {}) })) })),
      commands: (state.commands ?? []).map((command: Row) => ({ name: String(command.name), description: String(command.description ?? '') })), revision: state.controls_revision
    };
  }
  async configure(processId: string, selector: string, value: string): Promise<void> { await callIntegratedHost(this.runtime(processId).socketPath, 'configure', { selector, value }); }
  async command(processId: string, name: string, text: string): Promise<unknown> {
    return this.prompt(processId, { text: `/${name}${text ? ` ${text}` : ''}`, attachments: [], references: [] });
  }
  async compact(processId: string): Promise<unknown> { return this.command(processId, 'compact', ''); }
  async title(processId: string): Promise<string | null> {
    const state = await callIntegratedHost(this.runtime(processId).socketPath, 'controls', {}) as Row;
    return typeof state.title === 'string' ? state.title : null;
  }
  async nativeSettings(processId: string) {
    const state = await callIntegratedHost(this.runtime(processId).socketPath, 'controls', {}) as Row;
    const options: Row[] = state.configOptions ?? [];
    const reasoning = options.find((option) => option.id === 'thought_level')?.currentValue;
    return { model: state.model as string | null, ...(typeof reasoning === 'string' ? { reasoning } : {}) };
  }
  async subscribe(processId: string, listener: IntegratedConversationListener): Promise<() => void> {
    const { socketPath } = this.runtime(processId);
    let stopped = false;
    let socket: net.Socket | null = null;
    let retry: NodeJS.Timeout | null = null;
    let attempts = 0;
    const connect = (): Promise<void> => new Promise((resolve, reject) => {
      const next = net.createConnection(ipcPath(socketPath)); socket = next;
      let buffer = ''; let acknowledged = false;
      next.setEncoding('utf8');
      next.once('connect', () => next.write(`${JSON.stringify({ id: randomUUID(), method: 'subscribe', params: {} })}\n`));
      next.on('error', (error) => { if (!acknowledged) reject(error); next.destroy(); });
      next.once('close', () => {
        if (!acknowledged) reject(new Error('ACP host closed before subscription'));
        if (stopped) return;
        listener({ processId, revision: 0, kind: 'reconnecting' });
        if (++attempts > 8) { listener({ processId, revision: 0, kind: 'error', id: 'connection_error', delta: 'Could not reconnect to the ACP host.' }); return; }
        retry = setTimeout(() => { void connect().catch(() => undefined); }, Math.min(250 * 2 ** (attempts - 1), 5000));
      });
      next.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 32 * 1024 * 1024) { next.destroy(); return; }
        for (;;) {
          const newline = buffer.indexOf('\n'); if (newline < 0) return;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let frame: Row; try { frame = JSON.parse(line); } catch { next.destroy(); return; }
          if (!acknowledged) { if (frame.error) { reject(new Error(String(frame.error))); next.destroy(); return; } acknowledged = true; attempts = 0; resolve(); }
          else if (frame.event?.kind) listener({ ...frame.event, processId } as IntegratedConversationEvent);
        }
      });
    });
    try { await connect(); } catch (error) { stopped = true; if (retry) clearTimeout(retry); (socket as net.Socket | null)?.destroy(); throw error; }
    return () => { stopped = true; if (retry) clearTimeout(retry); socket?.destroy(); };
  }
  async stop(processId: string): Promise<void> {
    const runtime = this.runtime(processId);
    try { await callIntegratedHost(runtime.socketPath, 'stop', {}); } catch { await stopRecordedHostProcess(runtime.pid, runtime.socketPath); }
  }
  async cleanupLaunch(_input: IntegratedLaunchInput, result: IntegratedLaunchResult): Promise<void> { await stopHostProcess(Number(result.argv[3]) || null); }
  async stopAll(): Promise<void> {
    const rows = this.database.connection.prepare("select process_id as id from sessions where harness = 'agy' and interface_mode = 'integrated' and exited_at is null").all() as Array<{ id: string }>;
    const results = await Promise.allSettled([...rows.map((row) => this.stop(row.id)), this.launcher.stopAll('agy')]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'Could not stop every ACP host');
  }
  private runtime(processId: string) {
    const row = this.database.connection.prepare("select processes.argv, sessions.id as session_id from sessions join processes on processes.id = sessions.process_id where (sessions.process_id = ? or sessions.id = ?) and sessions.harness = 'agy' and sessions.interface_mode = 'integrated' order by sessions.exited_at is null desc, sessions.started_at desc limit 1").get(processId, processId) as { argv: string; session_id: string } | undefined;
    if (!row) throw new Error('Antigravity Integrated session not found');
    const argv = JSON.parse(row.argv) as unknown[];
    if (argv[1] !== 'acp-host' || typeof argv[2] !== 'string') throw new Error('ACP runtime metadata is invalid');
    return { socketPath: argv[2], pid: Number(argv[3]) || null, sessionId: row.session_id };
  }
}
