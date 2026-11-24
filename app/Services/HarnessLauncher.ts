import { ASSISTANT_BOT_ID } from '../Bots/BotIdentity';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RegisterProcessAction } from '../Actions/RegisterProcessAction';
import { RegisterSessionAction } from '../Actions/RegisterSessionAction';
import type { HarnessId, HarnessProvider, McpServerSpec } from '../Harness/HarnessProvider';
import {
  presetHarnessInput,
  resolveHarnessLaunchSelection,
  type HarnessLaunchSelection
} from '../Harness/HarnessPresets';
import type { AgentCapabilities } from '../Agents/AgentProtocol';
import type { ProjectLaunchFence } from './ProjectLaunchFence';
import type { WorkbenchRepository } from '../Repositories/WorkbenchRepository';
import { nativePath, storedPath } from '../Platform/PathIdentity';
import type { DatabaseService } from './DatabaseService';
import type { SearchService } from './SearchService';
import { AgentContextService } from './AgentContextService';
import type { TimelineService } from './TimelineService';
import type { DebugLogService } from './DebugLogService';
import type { IntegratedAgentService, IntegratedLaunchInput, IntegratedLaunchResult } from './IntegratedAgentService';
import { resolveSessionRuntimeState, serializeRuntimeState } from '../Agents/SessionRuntimeState';
import { SettingsService } from './SettingsService';
import type { OpenCodeMcpSource } from './OpenCodeServerService';
import type { McpServerRegistry } from './McpServerRegistry';
import type { LaunchingMcpIdentities } from '../MCP/McpHelperAccess';
import type { AssistantMemoryService } from './AssistantMemoryService';

export const launchHarnessInput = z.object({
  harness: z.enum(['claude', 'codex', 'opencode', 'agy']).optional(),
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
  initial_prompt: z.string().optional()
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
  harness: string;
  name: string;
}

export interface HarnessResume {
  resume_id: string;
  conversation_id: string;
  source_session_id?: string;
  // Set by a restart, which should pick up changed MCP servers.
  reconnect_mcp?: boolean;
  restore_saved_settings?: boolean;
}

export interface HarnessLauncherDeps {
  database: DatabaseService;
  timeline: TimelineService;
  workbench: WorkbenchRepository;
  providers: HarnessProvider[];
  fence?: ProjectLaunchFence;
  // Node-capable binary to run the bundled MCP shim. In Electron this is the
  // Electron binary plus ELECTRON_RUN_AS_NODE=1.
  nodePath: string;
  shimPath: string;
  // Optional compiled native Rust `patterm-mcp` binary; preferred over Node+JS shim when present.
  nativeMcpPath?: string | null;
  socketPath: string;
  runtimeDir: string;
  search?: SearchService;
  debugLog?: Pick<DebugLogService, 'write'>;
  integrated?: Pick<IntegratedAgentService, 'prepare' | 'prompt' | 'stop' | 'cleanupLaunch' | 'observe'> & {
    supportsHibernation?: (harness: string) => boolean;
    capabilities?: (harness: string) => AgentCapabilities;
  };
  settings?: Pick<SettingsService, 'figuresEnabled'>;
  // A bot session's system context: its SMS-style brief and purview, or the
  // assistant's brief.
  botContext?: (botId: string) => string;
  // Preset lookup for defaulting the model/reasoning at launch. Defaults to the
  // application settings table.
  presetSettings?: Pick<SettingsService, 'harnessPresets'>;
  // The user's global MCP servers, added to every launch beside Patterm's.
  mcpServers?: Pick<McpServerRegistry, 'forHarness'>;
  mcpHttpProxyUrl?: string;
  // Lets MCP helpers of a launch that is still starting use its identity.
  launchingIdentities?: Pick<LaunchingMcpIdentities, 'reserve'>;
  assistantMemory?: Pick<AssistantMemoryService, 'snapshot'>;
}

// Launches an installed harness in Integrated mode with the Patterm MCP server
// injected, and registers the session.
export class HarnessLauncher {
  private readonly attachingNativeSession = new Set<string>();
  constructor(private readonly deps: HarnessLauncherDeps) {}

  private nativeMcpBinary(): string | null {
    const candidate = this.deps.nativeMcpPath;
    if (candidate && fs.existsSync(candidate)) return candidate;
    return null;
  }

  // Patterm's MCP shim; shared OpenCode clients run it without an identity.
  private mcpSpec(identity: string | null): McpServerSpec {
    const native = this.nativeMcpBinary();
    if (native) {
      return {
        ...(this.deps.mcpHttpProxyUrl ? { httpProxyUrl: this.deps.mcpHttpProxyUrl } : {}),
        command: native,
        args: [],
        env: {
          PATTERM_MCP_SOCKET: this.deps.socketPath,
          ...(this.deps.shimPath ? { PATTERM_MCP_JS_SHIM: this.deps.shimPath } : {}),
          ...(this.deps.nodePath ? { PATTERM_NODE: this.deps.nodePath } : {}),
          ...(identity ? { PATTERM_MCP_IDENTITY: identity } : {})
        }
      };
    }
    return {
      ...(this.deps.mcpHttpProxyUrl ? { httpProxyUrl: this.deps.mcpHttpProxyUrl } : {}),
      command: this.deps.nodePath,
      args: [this.deps.shimPath],
      env: { ELECTRON_RUN_AS_NODE: '1', PATTERM_MCP_SOCKET: this.deps.socketPath, ...(identity ? { PATTERM_MCP_IDENTITY: identity } : {}) }
    };
  }

  // What OpenCode needs to restore a directory's MCP servers after it drops
  // them, read fresh at each restore.
  openCodeMcpSource(): OpenCodeMcpSource {
    return { spec: () => this.mcpSpec(null), servers: () => this.deps.mcpServers?.forHarness('opencode') ?? [] };
  }

  // Transparently wakes a hibernated Integrated host in place, preserving its
  // process_id, session_id, mcp_identity, resume_id, todos, worktrees, and timers.
  async wakeIntegrated(processId: string): Promise<void> {
    if (!this.deps.integrated) throw new Error('Integrated conversations are unavailable');
    const row = this.deps.database.connection.prepare(`
      select sessions.id as session_id, sessions.project_id, sessions.harness, sessions.resume_id,
        sessions.mcp_identity, sessions.session_role, sessions.bot_id, sessions.model, sessions.reasoning,
        sessions.service_tier, sessions.display_name, sessions.runtime_state, coalesce(sessions.cwd, processes.cwd) as cwd
      from sessions join processes on processes.id = sessions.process_id
      where sessions.process_id = ? and sessions.exited_at is null
      order by sessions.started_at desc limit 1
    `).get(processId) as {
      session_id: string; project_id: string; harness: string; resume_id: string | null;
      mcp_identity: string | null; session_role: string; bot_id: string | null;
      model: string | null; reasoning: string | null; service_tier: string | null;
      display_name: string | null; runtime_state: string | null; cwd: string | null;
    } | undefined;
    if (!row || !row.resume_id || !row.mcp_identity) throw new Error('Hibernated Integrated session cannot be woken');
    const parsedHarness = presetHarnessInput.safeParse(row.harness);
    const canWake = this.deps.integrated.supportsHibernation
      ? this.deps.integrated.supportsHibernation(row.harness)
      : this.deps.integrated.capabilities?.(row.harness).hibernation.supported ?? (row.harness === 'claude' || row.harness === 'codex' || row.harness === 'agy');
    if (!canWake || !parsedHarness.success) {
      throw new Error(`Cannot wake ${row.harness} session`);
    }
    const harness: HarnessId = parsedHarness.data;
    const install = this.deps.workbench.listHarnesses().find((entry) => entry.harness === row.harness);
    if (!install || install.status !== 'available' || !install.executablePath) {
      throw new Error(`harness not available: ${row.harness}`);
    }
    const mcp = this.mcpSpec(row.mcp_identity);
    const mcpServers = this.deps.mcpServers?.forHarness(row.harness) ?? [];
    const contextService = new AgentContextService();
    const agentContext = row.session_role === 'assistant'
      ? (this.deps.botContext?.(row.bot_id ?? ASSISTANT_BOT_ID) || contextService.buildAssistant(this.deps.assistantMemory?.snapshot())).trim()
      : row.session_role === 'routine'
        ? contextService.buildRoutine((limit) => this.deps.assistantMemory?.snapshot(limit, { role: 'routine' }) ?? '').trim()
        : row.session_role === 'bot'
          ? (this.deps.botContext?.(row.bot_id!) ?? '').trim()
          : contextService.build(row.project_id, {
            figures: this.deps.settings?.figuresEnabled() !== false,
            memory: (limit) => this.deps.assistantMemory?.snapshot(limit, { role: 'agent', projectId: row.project_id }) ?? ''
          }).trim();
    const cwd = storedPath(row.cwd ?? process.cwd());
    const prepared = await this.deps.integrated.prepare(harness, {
      executable: install.executablePath,
      cwd,
      name: row.display_name,
      context: agentContext,
      mcp,
      mcpServers,
      resumeId: row.resume_id,
      model: row.model,
      reasoning: row.reasoning,
      serviceTier: row.service_tier,
      restoreSavedSettings: true,
      memoryPush: row.session_role === 'assistant' || row.session_role === 'bot',
      quietNotificationReplies: row.session_role === 'assistant' && row.bot_id === ASSISTANT_BOT_ID,
      wakingSessionId: row.session_id
    });
    const previousState = resolveSessionRuntimeState(row.runtime_state, null);
    const nextRuntimeState = prepared.runtimeState
      ? {
          ...prepared.runtimeState,
          ...(previousState.adapterData || prepared.runtimeState.adapterData
            ? { adapterData: { ...(previousState.adapterData ?? {}), ...(prepared.runtimeState.adapterData ?? {}) } }
            : {})
        }
      : prepared.runtimeState;
    const now = new Date().toISOString();
    this.deps.database.connection.transaction(() => {
      this.deps.database.connection.prepare('update processes set argv = ?, updated_at = ? where id = ?')
        .run(JSON.stringify(prepared.argv), now, processId);
      this.deps.database.connection.prepare('update sessions set runtime_state = ? where id = ?')
        .run(serializeRuntimeState(nextRuntimeState), row.session_id);
    })();
  }

  async launch(raw: LaunchHarnessInput): Promise<LaunchHarnessResult> {
    return this.start(raw, null);
  }

  async resume(raw: LaunchHarnessInput, resume: HarnessResume): Promise<LaunchHarnessResult> {
    return this.start(raw, resume);
  }

  private async start(raw: LaunchHarnessInput, resume: HarnessResume | null): Promise<LaunchHarnessResult> {
    const input = launchHarnessInput.parse(raw);
    const selection = this.resolveSelection(input, Boolean(resume));
    const externalDaemon = this.deps.integrated?.capabilities
      ? this.deps.integrated.capabilities(selection.harness).hostKind === 'external-daemon'
      : selection.harness === 'opencode';
    const key = externalDaemon ? resume?.resume_id : null;
    if (key && this.attachingNativeSession.has(key)) throw new Error(`${this.providerName(selection.harness)} session is already being attached`);
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
    const harness = selection.harness;
    const supportsServiceTier = this.deps.integrated?.capabilities
      ? this.deps.integrated.capabilities(harness).features.serviceTier
      : harness === 'codex';
    if (selection.serviceTier && !supportsServiceTier) throw new Error(`${this.providerName(harness)} does not support service tier overrides`);
    timing.mark('input.parsed', { harness, preset: selection.presetName, model: selection.model });
    if (!this.nativeMcpBinary() && !fs.existsSync(this.deps.shimPath)) {
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

    const mcp = this.mcpSpec(identity);
    const mcpServers = this.deps.mcpServers?.forHarness(harness) ?? [];
    const contextService = new AgentContextService();
    const agentContext = input.session_role === 'assistant'
      ? (this.deps.botContext?.(input.bot_id ?? ASSISTANT_BOT_ID) || contextService.buildAssistant(this.deps.assistantMemory?.snapshot())).trim()
      : input.session_role === 'routine'
        ? contextService.buildRoutine((limit) => this.deps.assistantMemory?.snapshot(limit, { role: 'routine' }) ?? '').trim()
        : input.session_role === 'bot'
          ? (this.deps.botContext?.(input.bot_id!) ?? '').trim()
          : contextService.build(input.project_id, {
            figures: this.deps.settings?.figuresEnabled() !== false,
            memory: (limit) => this.deps.assistantMemory?.snapshot(limit, { role: 'agent', projectId: input.project_id }) ?? ''
          }).trim();
    timing.mark('context.built', { context_chars: agentContext.length });
    const project = this.deps.workbench.getProject(input.project_id);
    const worktree = input.worktree_id ? this.worktree(input.worktree_id) : null;
    const cwd = storedPath(input.cwd === undefined ? worktree?.worktree_path ?? project?.path ?? process.cwd() : nativePath(input.cwd));
    const displayName = input.name?.trim() || provider.displayName;
    if (!this.deps.integrated) throw new Error(`${this.providerName(harness)} Integrated conversations are unavailable`);
    const launchInput: IntegratedLaunchInput = {
      executable: install.executablePath, cwd, name: input.name?.trim() || null, context: agentContext, mcp, mcpServers, resumeId: resume?.resume_id ?? null,
      model: selection.model, reasoning: selection.reasoning, serviceTier: selection.serviceTier,
      reconnectMcp: resume?.reconnect_mcp === true,
      restoreSavedSettings: resume?.restore_saved_settings === true,
      memoryPush: input.session_role === 'assistant' || input.session_role === 'bot',
      quietNotificationReplies: input.session_role === 'assistant' && input.bot_id === ASSISTANT_BOT_ID
    };
    const prepared = await this.deps.integrated.prepare(harness, launchInput);
    return this.registerIntegrated(
      input,
      selection,
      resume,
      displayName,
      cwd,
      identity,
      prepared.argv,
      prepared.resumeId,
      agentContext,
      { input: launchInput, result: prepared },
      timing
    );
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
        service_tier: selection.serviceTier, runtime_state: serializeRuntimeState(launch.result.runtimeState),
        resumed_conversation_id: resume?.conversation_id ?? null,
        resumed_from_session_id: resume?.source_session_id ?? null, created_by_actor: input.actor_id ?? 'user'
      });
      return { process_id, session_id };
      })();
    } catch (error) {
      await this.deps.integrated?.cleanupLaunch(selection.harness, launch.input, launch.result).catch(() => undefined);
      throw error;
    }
    timing.mark('integrated.registered', registered);
    // Observe before the first prompt so its turn is tracked even when nobody
    // opens the conversation.
    this.deps.integrated?.observe(registered.process_id);
    if (this.deps.search) {
      setImmediate(() => {
        try {
          this.deps.search?.indexSession(registered.session_id);
        } catch (error) {
          this.deps.timeline.append({
            event_type: 'session.index_failed',
            project_id: input.project_id,
            session_id: registered.session_id,
            process_id: registered.process_id,
            actor_type: 'system',
            metadata: { error: error instanceof Error ? error.message : String(error) }
          });
        }
      });
    }
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
    return { ...registered, harness: selection.harness, name: displayName };
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

  private providerName(harness: string): string {
    return this.deps.providers.find((provider) => provider.id === harness)?.displayName ?? harness;
  }

  private initialPrompt(prompt: string | undefined): string {
    return prompt?.trim() ?? '';
  }
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
