import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { DatabaseService } from './DatabaseService';
import {
  defaultAgentCapabilities,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentConversationSnapshot,
  type AgentLaunchInput,
  type AgentLaunchResult,
  type AgentOlderMessagesPage,
  type AgentPromptResult
} from '../Agents/AgentProtocol';
import { resolveSessionRuntimeState } from '../Agents/SessionRuntimeState';
import { SupervisedHostClient } from '../Runtime/SupervisedHostClient';
import type { IntegratedControls } from './IntegratedAgentService';
import type { ResolvedIntegratedPrompt } from './IntegratedInput';
import type { IntegratedConversationListener } from './IntegratedConversation';
import { TurnBusyError, UncertainDeliveryError } from './IntegratedDelivery';
import { detachedHostLauncher, integratedHostReady, IntegratedHostTransportError, stopHostProcess, type IntegratedHostLauncher } from './IntegratedHostLauncher';
import { claudeMcpServers } from '../Harness/McpDelivery';
import { antigravityParentSubagentIds, readAntigravityTaskOutput, type AntigravityTaskOutput } from './AntigravityTaskOutput';
import type { TranscriptImageStore } from './TranscriptImageStore';

type Row = Record<string, any>;

export const ACP_CAPABILITIES: AgentCapabilities = defaultAgentCapabilities({
  hostKind: 'supervised-socket',
  hibernation: { supported: true },
  archiveFallback: 'never',
  input: { steering: true, nativeQueue: false, configureWhileBusy: false, routineDigest: false },
  interactions: { permissions: true, questions: false, forms: false, parentReadAutoApprove: true, choiceFormsAsQuestions: false },
  features: {
    goals: false,
    compact: true,
    slashCommands: true,
    memoryPush: false,
    quietReplies: false,
    voice: false,
    statelessGenerate: false,
    serviceTier: false,
    liveModels: false,
    sessionDirectory: false,
    olderMessages: true,
    taskOutput: true
  },
  selectors: { reasoning: 'thought_level' }
});

// One ACP process per conversation. The durable control socket is independent
// of browser connections and can be reattached after a Patterm server restart.
export class AcpProviderService implements AgentAdapter {
  readonly id = 'agy';
  readonly capabilities = ACP_CAPABILITIES;
  private readonly host = new SupervisedHostClient();

  constructor(
    private readonly database: DatabaseService,
    private readonly runtimeDir: string,
    private readonly nodePath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly hostScript = path.resolve(__dirname, '../Runtime/AcpIntegratedHost.js'),
    private readonly launcher: IntegratedHostLauncher = detachedHostLauncher,
    private readonly images: TranscriptImageStore | null = null
  ) {}

  async prepare(input: AgentLaunchInput): Promise<AgentLaunchResult> {
    if (input.serviceTier) throw new Error('Antigravity does not support Codex service tiers');
    if (input.resumeId) {
      const attached = input.wakingSessionId
        ? this.database.connection.prepare("select id from sessions where harness = 'agy' and resume_id = ? and exited_at is null and id != ?").get(input.resumeId, input.wakingSessionId)
        : this.database.connection.prepare("select id from sessions where harness = 'agy' and resume_id = ? and exited_at is null").get(input.resumeId);
      if (attached) throw new Error('Antigravity session is already attached to Patterm');
    }
    const directory = path.join(this.runtimeDir, 'acp');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const key = randomUUID();
    const socketPath = path.join(directory, `${key}.sock`);
    const configPath = path.join(directory, `${key}.json`);
    // agy drops the largest MCP tools once their declarations pass its size
    // budget, so Patterm's own tools advertise without usage notes.
    const patterm = { ...input.mcp, env: { ...input.mcp.env, PATTERM_MCP_COMPACT: '1' } };
    const servers = { ...claudeMcpServers(input.mcpServers ?? [], input.mcp, { httpNative: false }), patterm };
    const mcpServers = Object.entries(servers).map(([name, value]) => {
      const server = value as { command: string; args: string[]; env: Record<string, string> };
      return { name, command: server.command, args: server.args, env: Object.entries(server.env).map(([name, value]) => ({ name, value })) };
    });
    fs.writeFileSync(configPath, JSON.stringify({ socketPath, settingsDirectory: path.join(directory, 'settings'), restoreSavedSettings: input.restoreSavedSettings === true, executable: input.executable, cwd: input.cwd, resumeId: input.resumeId, context: input.context, model: input.model ?? null, reasoning: input.reasoning ?? null, mcpServers, ...(this.images ? { imageDirectory: this.images.directory } : {}) }), { mode: 0o600 });
    let pid: number | null = null;
    try {
      pid = await this.launcher.launch({ harness: 'agy', key, nodePath: this.nodePath, script: this.hostScript, configPath, cwd: input.cwd, env: this.env });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (pid) { try { process.kill(pid, 0); } catch { throw new Error('ACP host exited during startup'); } }
        if (await integratedHostReady(socketPath)) {
          let state: Row;
          try {
            state = await this.host.call<Row>(socketPath, 'conversation', {});
          } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (error instanceof IntegratedHostTransportError || code === 'ENOENT' || code === 'ECONNREFUSED') {
              await new Promise((resolve) => setTimeout(resolve, 100));
              continue;
            }
            throw error;
          }
          if (state.status === 'error') throw new Error(String(state.status_detail ?? 'Antigravity could not start'));
          if (state.status !== 'starting' && state.provider_session_id) {
            return {
              resumeId: String(state.provider_session_id),
              argv: [input.executable],
              runtimeState: { hostKind: 'acp-host', executable: input.executable, socketPath, pid, configPath }
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Antigravity did not initialise within 90 seconds');
    } catch (error) {
      if (this.launcher.stop) await this.launcher.stop(socketPath, pid).catch(() => undefined);
      else await stopHostProcess(pid);
      fs.rmSync(configPath, { force: true });
      throw error;
    }
  }

  async conversation(processId: string): Promise<AgentConversationSnapshot> {
    const runtime = this.runtime(processId);
    const state = await this.host.call<Row>(runtime.socketPath, 'conversation', {});
    const { models: _models, modes: _modes, configOptions: _options, commands: _commands, ...snapshot } = state;
    return { ...snapshot, process_id: processId, session_id: runtime.sessionId, provider: 'agy', streaming: true } as AgentConversationSnapshot;
  }

  // Pages backwards from a snapshot's history cursor, oldest page last.
  async olderMessages(processId: string, cursor: string): Promise<AgentOlderMessagesPage> {
    return this.host.call<AgentOlderMessagesPage>(this.runtime(processId).socketPath, 'older', { cursor });
  }

  async prompt(processId: string, input: ResolvedIntegratedPrompt): Promise<AgentPromptResult> {
    const prompt: Row[] = [{ type: 'text', text: input.text }];
    const attachments: Row[] = input.references.map((reference) => ({ type: 'reference', name: reference.name, detail: `@${reference.relativePath}` }));
    for (const reference of input.references) prompt.push({ type: 'resource_link', uri: pathToFileURL(reference.path).href, name: reference.name });
    for (const attachment of input.attachments) {
      // agy 1.5.8 silently ignores embedded PDF blobs. A real file reference
      // reaches its native reader instead, with its normal file permissions.
      if (attachment.mime === 'application/pdf') {
        try {
          const stat = await fs.promises.stat(attachment.path);
          if (!stat.isFile()) throw new Error('Attachment is not a file');
          await fs.promises.access(attachment.path, fs.constants.R_OK);
        } catch {
          throw new Error(`Antigravity cannot read “${attachment.name}” on this host. Attach the PDF again before sending.`);
        }
        prompt.push({ type: 'resource_link', uri: pathToFileURL(attachment.path).href, name: attachment.name, mimeType: attachment.mime });
        attachments.push({ type: 'file', name: attachment.name, mime: attachment.mime });
        continue;
      }
      const data = attachment.data ?? (await fs.promises.readFile(attachment.path)).toString('base64');
      if (attachment.mime.startsWith('image/')) prompt.push({ type: 'image', mimeType: attachment.mime, data });
      else prompt.push({ type: 'resource', resource: { uri: `attachment:///${encodeURIComponent(attachment.name)}`, mimeType: attachment.mime, text: Buffer.from(data, 'base64').toString('utf8') } });
      const stored = attachment.mime.startsWith('image/') ? this.images?.fromBase64(data) : null;
      attachments.push({ type: stored ? 'image' : 'file', name: attachment.name, mime: attachment.mime, ...(stored ? { sha256: stored.sha256 } : {}) });
    }
    let promptText = input.text;
    if (input.admitGuard) {
      const checked = input.admitGuard();
      if (!checked) return { delivery: 'dropped' };
      if (!checked.text.trim() && prompt.length === 1) return { delivery: 'dropped' };
      promptText = checked.text;
      prompt[0] = { type: 'text', text: promptText };
    }
    try {
      return await this.host.call<AgentPromptResult>(this.runtime(processId).socketPath, 'prompt', { prompt, text: promptText, clientMessageId: input.messageId, attachments });
    } catch (error) {
      if (error instanceof Error && error.message === 'ACP turn is busy') throw new TurnBusyError(error.message, 'prompt');
      if (error instanceof Error && /^ACP prompt delivery is uncertain(?::|$)/.test(error.message)) throw new UncertainDeliveryError(error.message, input.messageId);
      if (error instanceof IntegratedHostTransportError || (error as NodeJS.ErrnoException)?.code) throw new UncertainDeliveryError(error instanceof Error ? error.message : String(error), input.messageId);
      throw error;
    }
  }
  async interrupt(processId: string): Promise<void> { await this.host.call(this.runtime(processId).socketPath, 'interrupt', {}); }
  // Background commands stop through session/cancel, which ends all of agy's
  // background work: ACP has no per-task cancel.
  async stopTask(processId: string, taskId: string): Promise<void> { await this.host.call(this.runtime(processId).socketPath, 'stopTask', { taskId }); }
  async taskOutput(processId: string, taskId: string, since?: string | null, cursor?: string | null): Promise<AntigravityTaskOutput> {
    // A background command's output arrives on its tool row when it ends.
    if (taskId.startsWith('tool:')) return { format: 'missing', version: null };
    const runtime = this.runtime(processId);
    let owned = false;
    try {
      const reply = await this.host.call<Row>(runtime.socketPath, 'hasTask', { taskId });
      owned = reply?.owned === true;
    } catch {
      // Older hosts without hasTask fall back to the parent session transcript.
    }
    if (!owned && (!runtime.resumeId || !antigravityParentSubagentIds(runtime.resumeId, this.env).has(taskId))) {
      throw new Error('That subagent does not belong to this session');
    }
    return readAntigravityTaskOutput(taskId, this.env, since, cursor);
  }
  async replyPermission(processId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<void> { await this.host.call(this.runtime(processId).socketPath, 'permission', { requestId, reply }); }
  async replyQuestion(): Promise<void> { throw new Error('Antigravity questions are answered in the conversation'); }
  async reconcile(processId: string, messageId: string) {
    const result = await this.host.call<Row>(this.runtime(processId).socketPath, 'delivery', { clientMessageId: messageId });
    return result.state === 'accepted' ? 'accepted' as const : 'unknown' as const;
  }
  async controls(processId: string): Promise<IntegratedControls> {
    const state = await this.host.call<Row>(this.runtime(processId).socketPath, 'controls', {});
    return {
      selectors: (state.configOptions ?? []).filter((option: Row) => option.type === 'select').map((option: Row) => ({ id: String(option.id), label: String(option.name), value: String(option.currentValue), options: (option.options ?? []).flatMap((entry: Row) => entry.options ?? [entry]).map((entry: Row) => ({ value: String(entry.value), label: String(entry.name), ...(entry.description ? { description: String(entry.description) } : {}) })) })),
      commands: (state.commands ?? []).map((command: Row) => ({ name: String(command.name), description: String(command.description ?? '') })), revision: state.controls_revision
    };
  }
  async configure(processId: string, selector: string, value: string): Promise<void> {
    const runtime = this.runtime(processId);
    const updated = await this.host.call<Row>(runtime.socketPath, 'configure', { selector, value });
    // Recovery of an ended host falls back to these columns. Do not leave its
    // original launch model/effort behind after the user changes the pickers.
    const settings = updated && 'model' in updated
      ? { model: (typeof updated.model === 'string' ? updated.model : null), reasoning: (typeof updated.reasoning === 'string' ? updated.reasoning : null) }
      : await this.nativeSettings(processId);
    this.database.connection.prepare('update sessions set model = ?, reasoning = ? where id = ?').run(settings.model ?? null, settings.reasoning ?? null, runtime.sessionId);
  }
  async command(processId: string, name: string, text: string): Promise<AgentPromptResult> {
    return this.prompt(processId, { text: `/${name}${text ? ` ${text}` : ''}`, attachments: [], references: [] });
  }
  async compact(processId: string): Promise<AgentPromptResult> { return this.command(processId, 'compact', ''); }
  async title(processId: string): Promise<string | null> {
    const state = await this.host.call<Row>(this.runtime(processId).socketPath, 'controls', {});
    return typeof state.title === 'string' ? state.title : null;
  }
  async nativeSettings(processId: string) {
    const state = await this.host.call<Row>(this.runtime(processId).socketPath, 'controls', {});
    const options: Row[] = state.configOptions ?? [];
    const reasoning = options.find((option) => option.id === 'thought_level')?.currentValue;
    return { model: state.model as string | null, ...(typeof reasoning === 'string' ? { reasoning } : {}) };
  }
  async subscribe(processId: string, listener: IntegratedConversationListener): Promise<() => void> {
    const { socketPath } = this.runtime(processId);
    return this.host.subscribe({
      processId,
      socketPath,
      label: 'ACP host',
      reconnectErrorMessage: 'Could not reconnect to the ACP host.',
      listener
    });
  }
  async stop(processId: string): Promise<void> {
    const runtime = this.runtime(processId);
    try {
      await this.host.stop(runtime.socketPath, runtime.pid, this.launcher);
    } finally {
      if (runtime.configPath) {
        try { fs.rmSync(runtime.configPath, { force: true }); } catch { /* host may already have removed it */ }
      }
    }
  }
  async cleanupLaunch(_input: AgentLaunchInput, result: AgentLaunchResult): Promise<void> {
    const socketPath = result.runtimeState?.socketPath ?? (typeof result.argv[2] === 'string' ? result.argv[2] : undefined);
    const pid = result.runtimeState?.pid ?? (Number(result.argv[3]) || null);
    const configPath = result.runtimeState?.configPath ?? (typeof result.argv[4] === 'string' ? result.argv[4] : undefined);
    try {
      await this.host.cleanupLaunch(socketPath, pid, this.launcher);
    } finally {
      if (configPath) {
        try { fs.rmSync(configPath, { force: true }); } catch { /* best-effort cleanup */ }
      }
    }
  }
  async stopAll(): Promise<void> {
    const rows = this.database.connection.prepare("select process_id as id from sessions where harness = 'agy' and exited_at is null and process_id is not null").all() as Array<{ id: string }>;
    await this.host.stopAll('agy', rows.map((row) => row.id), (id) => this.stop(id), this.launcher, 'Could not stop every ACP host');
  }
  private runtime(processId: string) {
    const row = this.database.connection.prepare(`
      select processes.argv, sessions.runtime_state, sessions.id as session_id, sessions.resume_id
      from sessions join processes on processes.id = sessions.process_id
      where (sessions.process_id = ? or sessions.id = ?) and sessions.harness = 'agy'
      order by sessions.exited_at is null desc, sessions.started_at desc limit 1
    `).get(processId, processId) as { argv: string | null; runtime_state: string | null; session_id: string; resume_id: string | null } | undefined;
    if (!row) throw new Error('Antigravity Integrated session not found');
    const state = resolveSessionRuntimeState(row.runtime_state, row.argv);
    if (state.hostKind !== 'acp-host' || !state.socketPath) throw new Error('ACP runtime metadata is invalid');
    return { socketPath: state.socketPath, pid: state.pid ?? null, configPath: state.configPath ?? null, sessionId: row.session_id, resumeId: row.resume_id };
  }
}
