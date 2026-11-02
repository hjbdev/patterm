import { ASSISTANT_BOT_ID } from '../Bots/BotIdentity';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RegisterProcessAction } from '../Actions/RegisterProcessAction';
import { RegisterSessionAction } from '../Actions/RegisterSessionAction';
import type { HarnessProvider, McpServerSpec } from '../Harness/HarnessProvider';
import {
  resolveHarnessLaunchSelection,
  type HarnessLaunchSelection
} from '../Harness/HarnessPresets';
import type { ProjectLaunchFence } from './ProjectLaunchFence';
import type { WorkbenchRepository } from '../Repositories/WorkbenchRepository';
import { nativePath, storedPath } from '../Platform/PathIdentity';
import type { DatabaseService } from './DatabaseService';
import type { SearchService } from './SearchService';
import { sendAgentInput } from './AgentInputService';
import { AgentContextService } from './AgentContextService';
import type { TimelineService } from './TimelineService';
import type { DebugLogService } from './DebugLogService';
import type { IntegratedAgentService, IntegratedLaunchInput, IntegratedLaunchResult } from './IntegratedAgentService';
import { SettingsService, type AgentInterface } from './SettingsService';
import type { OpenCodeServerService } from './OpenCodeServerService';
import { prepareOpenCodeTheme } from './OpenCodeThemeService';
import type { McpServerRegistry } from './McpServerRegistry';
import { CLAUDE_CONTEXT_FILE, CLAUDE_MCP_CONFIG } from '../Harness/providers';
import type { LaunchingMcpIdentities } from '../MCP/McpHelperAccess';
import type { AssistantMemoryService } from './AssistantMemoryService';

export const launchHarnessInput = z.object({
  harness: z.enum(['claude', 'codex', 'opencode', 'rawpty']).optional(),
  preset: z.string().trim().min(1).max(160).nullable().default(null),
  model: z.string().trim().min(1).max(160).nullable().default(null),
  reasoning: z.string().trim().min(1).max(60).nullable().default(null),
  service_tier: z.string().trim().min(1).max(60).nullable().default(null),
  project_id: z.string().min(1),
  worktree_id: z.string().nullable().default(null),
  cwd: z.string().optional(),
  actor_id: z.string().nullable().default(null),
  parent_process_id: z.string().nullable().default(null),
  // `routine` is a workspace routine run: like the assistant it reaches every project.
  session_role: z.enum(['orchestrator', 'child', 'assistant', 'routine', 'bot']).default('orchestrator'),
  // The bot a 'bot' session runs; its context comes from the bot's settings.
  bot_id: z.string().min(1).nullable().default(null),
  name: z.string().optional(),
  initial_prompt: z.string().optional(),
  interface_mode: z.enum(['tui', 'integrated']).optional()
}).superRefine((value, context) => {
  if (!value.harness && !value.preset) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['harness'], message: 'harness or preset is required' });
  }
  // The assistant is the built-in bot; other roles never run a bot.
  if (value.session_role === 'bot' ? !value.bot_id : value.session_role !== 'assistant' && value.bot_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['bot_id'], message: 'bot sessions, and only they and the assistant, have a bot_id' });
  }
});

// Accept the pre-parse shape so callers can omit defaulted fields; launch()
// normalizes via the schema before use.
export type LaunchHarnessInput = z.input<typeof launchHarnessInput>;
type ParsedLaunchHarnessInput = z.infer<typeof launchHarnessInput>;

export interface LaunchHarnessResult {
  session_id: string;
  process_id: string;
  pty_process_id: string | null;
  interface_mode: AgentInterface;
  harness: string;
  name: string;
}

export interface HarnessResume {
  resume_id: string;
  conversation_id: string;
  source_session_id?: string;
  // Set by a restart, which should pick up changed MCP servers.
  reconnect_mcp?: boolean;
}

// Minimal slice of TerminalService the launcher needs, so tests can supply a
// fake that captures the spawn params.
export interface SpawnSink {
  request(method: string, params: unknown): Promise<unknown>;
}

export interface HarnessLauncherDeps {
  database: DatabaseService;
  timeline: TimelineService;
  terminal: SpawnSink;
  workbench: WorkbenchRepository;
  providers: HarnessProvider[];
  fence?: ProjectLaunchFence;
  // Node-capable binary to run the bundled MCP shim. In Electron this is the
  // Electron binary plus ELECTRON_RUN_AS_NODE=1.
  nodePath: string;
  shimPath: string;
  socketPath: string;
  runtimeDir: string;
  // PATH the terminal sidecar passes to children; the xdg-open shim goes first.
  inheritedPath?: string | undefined;
  search?: SearchService;
  debugLog?: Pick<DebugLogService, 'write'>;
  openCodeServer?: Pick<OpenCodeServerService, 'prepare'> & Partial<Pick<OpenCodeServerService, 'prompt'>>;
  integrated?: Pick<IntegratedAgentService, 'prepare' | 'prompt' | 'stop' | 'cleanupLaunch' | 'observe'>;
  settings?: Pick<SettingsService, 'agentInterface' | 'figuresEnabled'>;
  // A bot session's system context: its SMS-style brief and purview, or the
  // assistant's brief.
  botContext?: (botId: string) => string;
  // Preset lookup for defaulting the model/reasoning at launch. Defaults to the
  // application settings table.
  presetSettings?: Pick<SettingsService, 'harnessPresets'>;
  // The user's global MCP servers, added to every launch beside Patterm's.
  mcpServers?: Pick<McpServerRegistry, 'forHarness'>;
  mcpHttpProxyUrl?: string;
  // Browsers on other machines view these terminals, so agent CLIs must not
  // expect a sign-in redirect to reach this machine's loopback listeners.
  // Lets MCP helpers of a launch that is still starting use its identity.
  launchingIdentities?: Pick<LaunchingMcpIdentities, 'reserve'>;
  assistantMemory?: Pick<AssistantMemoryService, 'snapshot'>;
}

// Launches an installed harness with the Patterm MCP server injected, spawns it
// through the terminal sidecar, and registers the session.
export class HarnessLauncher {
  private readonly attachingNativeSession = new Set<string>();
  constructor(private readonly deps: HarnessLauncherDeps) {}

  async launch(raw: LaunchHarnessInput): Promise<LaunchHarnessResult> {
    return this.start(raw, null);
  }

  async resume(raw: LaunchHarnessInput, resume: HarnessResume): Promise<LaunchHarnessResult> {
    return this.start(raw, resume);
  }

  private async start(raw: LaunchHarnessInput, resume: HarnessResume | null): Promise<LaunchHarnessResult> {
    const input = launchHarnessInput.parse(raw);
    const selection = this.resolveSelection(input, Boolean(resume));
    const key = selection.harness === 'opencode' ? resume?.resume_id : null;
    if (key && this.attachingNativeSession.has(key)) throw new Error(`${providerName(selection.harness)} session is already being attached`);
    if (key) this.attachingNativeSession.add(key);
    // The session is registered once the harness has started, and holds the
    // identity from then on.
    const identity = `mcp_${randomUUID()}`;
    const release = this.deps.launchingIdentities?.reserve(identity, selection.harness, input.session_role);
    const prepared = () => this.startPrepared(input, selection, resume, identity);
    try { return await (this.deps.fence ? this.deps.fence.run(input.project_id, prepared) : prepared()); }
    finally {
      release?.();
      if (key) this.attachingNativeSession.delete(key);
    }
  }

  // Fresh launches fall back to the harness default preset. Resuming a stored
  // conversation keeps its provider-side settings, overriding only those the
  // caller gives, such as a restart's live effort on a default model. Bots
  // keep their own settings, so a profile never fills in what a bot left out.
  private resolveSelection(input: ParsedLaunchHarnessInput, resuming: boolean): HarnessLaunchSelection {
    if ((resuming || input.bot_id) && !input.preset) {
      return {
        harness: input.harness!,
        model: input.model?.trim() || null,
        reasoning: input.reasoning?.trim() || null,
        serviceTier: input.service_tier?.trim() || null,
        presetId: null,
        presetName: null
      };
    }
    const presetSettings = this.deps.presetSettings ?? new SettingsService(this.deps.database);
    return resolveHarnessLaunchSelection({
      settings: presetSettings.harnessPresets(),
      harness: input.harness ?? null,
      preset: input.preset,
      model: input.model,
      reasoning: input.reasoning,
      serviceTier: input.service_tier
    });
  }

  private async startPrepared(input: ParsedLaunchHarnessInput, selection: HarnessLaunchSelection, resume: HarnessResume | null, identity: string): Promise<LaunchHarnessResult> {
    const timing = createLaunchTiming(this.deps.debugLog);
    const interfaceMode = input.interface_mode ?? this.deps.settings?.agentInterface() ?? 'tui';
    const harness = selection.harness;
    if (interfaceMode === 'integrated' && harness === 'rawpty') throw new Error('Raw terminal does not support Integrated conversations');
    if (selection.serviceTier && harness !== 'codex') throw new Error(`${providerName(harness)} does not support service tier overrides`);
    timing.mark('input.parsed', { harness, preset: selection.presetName, model: selection.model, interface_mode: interfaceMode });
    if (!fs.existsSync(this.deps.shimPath)) {
      throw new Error(`Patterm MCP shim is missing at ${this.deps.shimPath}; run pnpm run build:mcp`);
    }
    timing.mark('shim.checked');

    const provider = this.deps.providers.find((candidate) => candidate.id === harness);
    if (!provider) {
      throw new Error(`unknown harness: ${harness}`);
    }

    const install = this.deps.workbench.listHarnesses().find((row) => row.harness === harness);
    if (!install || install.status !== 'available' || !install.executablePath) {
      throw new Error(`harness not available: ${harness}`);
    }
    timing.mark('install.resolved');

    const mcp: McpServerSpec = {
      ...(this.deps.mcpHttpProxyUrl ? { httpProxyUrl: this.deps.mcpHttpProxyUrl } : {}),
      command: this.deps.nodePath,
      args: [this.deps.shimPath],
      env: { ELECTRON_RUN_AS_NODE: '1', PATTERM_MCP_SOCKET: this.deps.socketPath, PATTERM_MCP_IDENTITY: identity }
    };
    const mcpServers = harness === 'rawpty' ? [] : this.deps.mcpServers?.forHarness(harness) ?? [];
    const contextService = new AgentContextService();
    const agentContext = harness === 'rawpty' ? ''
      : input.session_role === 'assistant' ? (this.deps.botContext?.(input.bot_id ?? ASSISTANT_BOT_ID) || contextService.buildAssistant(this.deps.assistantMemory?.snapshot())).trim()
      : input.session_role === 'routine' ? contextService.buildRoutine((limit) => this.deps.assistantMemory?.snapshot(limit, { role: 'routine' }) ?? '').trim()
      : input.session_role === 'bot' ? (this.deps.botContext?.(input.bot_id!) ?? '').trim()
      : contextService.build(input.project_id, {
        figures: interfaceMode === 'integrated' && this.deps.settings?.figuresEnabled() !== false,
        memory: (limit) => this.deps.assistantMemory?.snapshot(limit, { role: 'agent', projectId: input.project_id }) ?? ''
      }).trim();
    timing.mark('context.built', { context_chars: agentContext.length });
    const project = this.deps.workbench.getProject(input.project_id);
    const worktree = input.worktree_id ? this.worktree(input.worktree_id) : null;
    const cwd = storedPath(input.cwd === undefined ? worktree?.worktree_path ?? project?.path ?? process.cwd() : nativePath(input.cwd));
    const displayName = input.name?.trim() || provider.displayName;
    let providerSessionId = resume?.resume_id ?? null;
    let integratedArgv: string[] | null = null;
    let integratedLaunch: { input: IntegratedLaunchInput; result: IntegratedLaunchResult } | null = null;
    if (interfaceMode === 'integrated') {
      if (!this.deps.integrated || harness === 'rawpty') throw new Error(`${providerName(harness)} Integrated conversations are unavailable`);
      const launchInput = {
        executable: install.executablePath, cwd, name: input.name?.trim() || null, context: agentContext, mcp, mcpServers, resumeId: providerSessionId,
        model: selection.model, reasoning: selection.reasoning, serviceTier: selection.serviceTier,
        reconnectMcp: resume?.reconnect_mcp === true,
        memoryPush: input.session_role === 'assistant' || input.session_role === 'bot'
      };
      const prepared = await this.deps.integrated.prepare(harness as 'claude' | 'codex' | 'opencode', launchInput);
      integratedLaunch = { input: launchInput, result: prepared };
      providerSessionId = prepared.resumeId;
      integratedArgv = prepared.argv;
    } else if (harness === 'opencode') {
      if (!this.deps.openCodeServer) throw new Error('OpenCode shared-server integration is unavailable');
      const prepared = await this.deps.openCodeServer.prepare({
        executable: install.executablePath, cwd, name: input.name?.trim() || null,
        context: agentContext, mcp, mcpServers, resumeId: providerSessionId,
        model: selection.model, reasoning: selection.reasoning
      });
      providerSessionId = prepared.resumeId;
    }

    if (interfaceMode === 'integrated') {
      return this.registerIntegrated(input, selection, resume, displayName, cwd, identity, integratedArgv!, providerSessionId!, agentContext, integratedLaunch!, timing);
    }
    const plan = provider.buildLaunch({
      executablePath: install.executablePath,
      mcp,
      mcpServers,
      runtimeDir: this.deps.runtimeDir,
      agentContext,
      resumeId: providerSessionId,
      model: selection.model,
      reasoning: selection.reasoning,
      serviceTier: selection.serviceTier
    });
    if (harness === 'opencode') {
      plan.agentContextInjected = true;
      plan.env.OPENCODE_CONFIG_DIR = prepareOpenCodeTheme(this.deps.runtimeDir);
    }
    Object.assign(plan.env, this.linkOpenerEnv(identity));
    timing.mark('plan.built', { file_count: plan.files.length });

    if (harness === 'claude') this.removeStaleClaudeMcpConfigs();
    if (plan.files.length > 0) {
      fs.mkdirSync(this.deps.runtimeDir, { recursive: true, mode: 0o700 });
      for (const file of plan.files) {
        fs.writeFileSync(file.path, file.contents, { mode: 0o600 });
      }
    }
    timing.mark('files.written');

    const response = (await this.deps.terminal.request('terminal.process.spawn', {
      name: displayName,
      kind: 'agent',
      command: plan.command,
      args: plan.args,
      env: plan.env,
      cwd
    })) as { process_id?: string; unavailable?: boolean } | null;
    timing.mark('terminal.spawned');

    if (!response?.process_id) {
      throw new Error('terminal core unavailable; cannot launch harness');
    }

    const ptyProcessId = response.process_id;
    let registered: { process_id: string; session_id: string };
    try {
      registered = this.deps.database.connection.transaction(() => {
        const { process_id } = new RegisterProcessAction(this.deps.database, this.deps.timeline).execute({
          project_id: input.project_id,
          parent_process_id: input.parent_process_id ?? null,
          pty_process_id: ptyProcessId,
          kind: 'agent',
          name: displayName,
          status: 'running',
          cwd,
          argv: [plan.command, ...plan.args],
          worktree_id: input.worktree_id ?? null,
          auto_restart: false,
          created_by_actor: input.actor_id ?? 'user'
        });
        timing.mark('process.registered', { process_id });

        const { session_id } = new RegisterSessionAction(this.deps.database, this.deps.timeline).execute({
          project_id: input.project_id,
          process_id,
          harness,
          interface_mode: interfaceMode,
          session_role: input.session_role,
          bot_id: input.bot_id ?? null,
          mcp_identity: identity,
          cwd,
          worktree_id: input.worktree_id ?? null,
          last_title: displayName,
          display_name: input.name?.trim() || null,
          resume_id: providerSessionId,
          resume_status: resume ? 'imported' : providerSessionId ? 'found' : 'unknown',
          model: selection.model,
          reasoning: selection.reasoning,
          service_tier: selection.serviceTier,
          resumed_conversation_id: resume?.conversation_id ?? null,
          resumed_from_session_id: resume?.source_session_id ?? null,
          created_by_actor: input.actor_id ?? 'user'
        });
        return { process_id, session_id };
      })();
    } catch (error) {
      // A failed registration rolls back inherited assignments before releasing the PTY.
      try {
        await this.deps.terminal.request('terminal.process.close', { process_id: ptyProcessId });
      } catch (closeError) {
        this.deps.debugLog?.write('harness-launch', 'registration.cleanup_failed', {
          pty_process_id: ptyProcessId,
          error: closeError instanceof Error ? closeError.message : String(closeError)
        });
      }
      throw error;
    }
    const { process_id, session_id } = registered;
    timing.mark('session.registered', { session_id });
    const initialPrompt = this.initialPrompt(input.initial_prompt);
    if (initialPrompt.trim()) {
      void this.injectWhenReady(process_id, ptyProcessId, initialPrompt).catch((error: unknown) => {
        this.deps.timeline.append({
          event_type: 'session.initial_prompt_failed',
          project_id: input.project_id,
          session_id,
          process_id,
          actor_type: 'system',
          metadata: { error: error instanceof Error ? error.message : String(error) }
        });
      });
    }
    if (this.deps.search) {
      setImmediate(() => {
        try {
          this.deps.search?.indexSession(session_id);
        } catch (error) {
          this.deps.timeline.append({
            event_type: 'session.index_failed',
            project_id: input.project_id,
            session_id,
            process_id,
            actor_type: 'system',
            metadata: { error: error instanceof Error ? error.message : String(error) }
          });
        }
      });
    }

    timing.mark('launch.returning');
    return { session_id, process_id, pty_process_id: ptyProcessId, interface_mode: interfaceMode, harness, name: displayName };
  }

  private async registerIntegrated(
    input: ParsedLaunchHarnessInput, selection: HarnessLaunchSelection, resume: HarnessResume | null, displayName: string, cwd: string,
    identity: string, argv: string[], providerSessionId: string, agentContext: string,
    launch: { input: IntegratedLaunchInput; result: IntegratedLaunchResult },
    timing: ReturnType<typeof createLaunchTiming>
  ): Promise<LaunchHarnessResult> {
    let registered: { process_id: string; session_id: string };
    try {
      registered = this.deps.database.connection.transaction(() => {
      const { process_id } = new RegisterProcessAction(this.deps.database, this.deps.timeline).execute({
        project_id: input.project_id, parent_process_id: input.parent_process_id ?? null, pty_process_id: null,
        kind: 'agent', name: displayName, status: 'running', cwd, argv,
        worktree_id: input.worktree_id ?? null, auto_restart: false, created_by_actor: input.actor_id ?? 'user'
      });
      const { session_id } = new RegisterSessionAction(this.deps.database, this.deps.timeline).execute({
        project_id: input.project_id, process_id, harness: selection.harness, interface_mode: 'integrated',
        session_role: input.session_role, bot_id: input.bot_id ?? null, mcp_identity: identity, cwd, worktree_id: input.worktree_id ?? null,
        last_title: displayName, display_name: input.name?.trim() || null, resume_id: providerSessionId,
        resume_status: resume ? 'imported' : 'found', model: selection.model, reasoning: selection.reasoning,
        service_tier: selection.serviceTier, resumed_conversation_id: resume?.conversation_id ?? null,
        resumed_from_session_id: resume?.source_session_id ?? null, created_by_actor: input.actor_id ?? 'user'
      });
      return { process_id, session_id };
      })();
    } catch (error) {
      await this.deps.integrated?.cleanupLaunch(selection.harness as 'claude' | 'codex' | 'opencode', launch.input, launch.result).catch(() => undefined);
      throw error;
    }
    timing.mark('integrated.registered', registered);
    // Observe before the first prompt so its turn is tracked even when nobody
    // opens the conversation.
    this.deps.integrated?.observe(registered.process_id);
    const initialPrompt = this.initialPrompt(input.initial_prompt);
    if (initialPrompt) {
      const service = this.deps.integrated;
      if (!service) throw new Error('Integrated messaging is unavailable');
      try {
        await service.prompt(registered.process_id, initialPrompt, agentContext);
      } catch (error) {
        const now = new Date().toISOString();
        this.deps.database.connection.prepare(`update processes set status = 'failed', exited_at = ?, updated_at = ? where id = ?`).run(now, now, registered.process_id);
        this.deps.database.connection.prepare(`update sessions set exited_at = ? where id = ?`).run(now, registered.session_id);
        await service.stop(registered.process_id).catch(() => undefined);
        throw error;
      }
    }
    return { ...registered, pty_process_id: null, interface_mode: 'integrated', harness: selection.harness, name: displayName };
  }

  // Agent CLIs open links with xdg-open, which is missing on headless servers
  // and would open on the wrong machine for remote browsers. The shim routes
  // web and mail links to whichever Patterm client controls this terminal and
  // leaves files and other targets to the system opener, if there is one.
  // Claude reads its MCP config, and on Windows its context file, at start.
  // Once its agent has exited, the identity in it is refused, so the file only
  // takes up space. Recent files may belong to a launch that hasn't
  // registered its session yet.
  private removeStaleClaudeMcpConfigs(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.runtimeDir);
    } catch {
      return;
    }
    const live = this.deps.database.connection.prepare('select 1 from sessions where mcp_identity = ? and exited_at is null');
    const cutoff = Date.now() - 10 * 60_000;
    for (const name of names) {
      const identity = (CLAUDE_MCP_CONFIG.exec(name) ?? CLAUDE_CONTEXT_FILE.exec(name))?.[1];
      if (!identity || live.get(identity)) continue;
      const file = path.join(this.deps.runtimeDir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch {
        // Another launch may have removed it.
      }
    }
  }

  private linkOpenerEnv(identity: string): Record<string, string> {
    // Windows CLIs open links through the shell (`start`, explorer.exe), not
    // xdg-open, so a PATH shim is never consulted. The desktop app shows its
    // terminals on this machine, where the shell opens them, and the remote
    // server that needs the redirect runs on Linux.
    if (process.platform === 'win32') return {};
    const binDir = path.join(this.deps.runtimeDir, 'bin');
    const opener = path.join(binDir, 'xdg-open');
    const inheritedPath = (this.deps.inheritedPath ?? process.env.PATH ?? '')
      .split(path.delimiter).filter((entry) => entry && path.resolve(entry) !== binDir).join(path.delimiter);
    const script = [
      '#!/bin/sh',
      'case "$1" in',
      `  http://*|https://*|mailto:*) PATTERM_MCP_SOCKET=${shellQuote(this.deps.socketPath)} PATTERM_MCP_IDENTITY="$PATTERM_TERMINAL_IDENTITY" \\`,
      `    ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(this.deps.nodePath)} ${shellQuote(this.deps.shimPath)} --open "$@" ;;`,
      'esac',
      `PATH=${shellQuote(inheritedPath)} exec xdg-open "$@"`,
      ''
    ].join('\n');
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(opener) || fs.readFileSync(opener, 'utf8') !== script) {
      const temporary = `${opener}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, script, { mode: 0o700 });
      fs.renameSync(temporary, opener);
    }
    // A dedicated variable keeps the agent's MCP identity out of the general
    // environment, where nested MCP shims would otherwise inherit it.
    return {
      PATH: [binDir, inheritedPath].filter(Boolean).join(path.delimiter),
      BROWSER: opener,
      PATTERM_TERMINAL_IDENTITY: identity
    };
  }

  private worktree(worktreeId: string): { worktree_path: string } {
    const row = this.deps.database.connection.prepare(`select worktree_path from worktrees where id = ?`).get(worktreeId) as
      | { worktree_path: string }
      | undefined;
    if (!row) {
      throw new Error(`unknown worktree: ${worktreeId}`);
    }
    return row;
  }

  private initialPrompt(prompt: string | undefined): string {
    return prompt?.trim() ?? '';
  }

  private async injectWhenReady(processId: string, ptyProcessId: string, prompt: string): Promise<void> {
    await waitForTerminalIdle(this.deps.terminal, ptyProcessId, 1000, 30_000);
    await sendAgentInput(this.deps.database, this.deps.terminal, {
      process_id: processId,
      kind: 'paste',
      text: prompt,
      submit: true
    });
  }
}

function providerName(harness: string): string {
  return harness === 'claude' ? 'Claude Code' : harness === 'codex' ? 'Codex' : harness === 'opencode' ? 'OpenCode' : harness;
}

async function waitForTerminalIdle(terminal: SpawnSink, processId: string, idleMs: number, maxMs: number): Promise<void> {
  const start = Date.now();
  let lastContent = '';
  let lastChangedAt = Date.now();
  let sawOutput = false;
  let delayMs = 100;

  while (Date.now() - start < maxMs) {
    try {
      const output = (await terminal.request('terminal.process.output', { process_id: processId, mode: 'grid' })) as TerminalOutputLike | null;
      const content = outputContent(output);
      if (content.trim()) {
        sawOutput = true;
      }
      if (content !== lastContent) {
        lastContent = content;
        lastChangedAt = Date.now();
      } else if (sawOutput && Date.now() - lastChangedAt >= idleMs) {
        return;
      }
      if (output?.status === 'exited' || output?.status === 'stopped') {
        return;
      }
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, 1000);
  }
}

interface TerminalOutputLike {
  screen?: string;
  content?: string;
  text?: string;
  lines?: unknown[];
  status?: string;
}

function outputContent(output: TerminalOutputLike | null): string {
  if (!output) {
    return '';
  }
  if (typeof output.screen === 'string') {
    return output.screen;
  }
  if (typeof output.content === 'string') {
    return output.content;
  }
  if (typeof output.text === 'string') {
    return output.text;
  }
  if (Array.isArray(output.lines)) {
    return output.lines.map((line) => (typeof line === 'string' ? line : String(line))).join('\n');
  }
  return '';
}

function createLaunchTiming(debugLog: Pick<DebugLogService, 'write'> | undefined): { mark(event: string, data?: Record<string, unknown>): void } {
  if (process.env.PATTERM_DEBUG_LAUNCH !== '1' || !debugLog) {
    return { mark() {} };
  }
  const startedAt = Date.now();
  let lastAt = startedAt;
  return {
    mark(event, data = {}) {
      const now = Date.now();
      debugLog.write('harness-launch', event, {
        elapsed_ms: now - startedAt,
        phase_ms: now - lastAt,
        ...data
      });
      lastAt = now;
    }
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
