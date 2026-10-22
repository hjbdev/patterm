import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerAssistantMemoryTools } from './registerAssistantMemoryTools';
import type { AssistantMemoryService } from '../Services/AssistantMemoryService';
import type { LaunchingMcpIdentities } from './McpHelperAccess';
import { RenameProcessAction, renameSessionInput } from '../Actions/RenameProcessAction';
import { closeRequestAnswerInput, requestCloseInput, type CloseRequestActions } from '../Actions/CloseRequestActions';
import { snoozeInput, snoozeTargetInput, type SnoozeActions } from '../Actions/SnoozeActions';
import { projectSnoozeInput, projectWakeInput, type ProjectSnoozeActions } from '../Actions/ProjectSnoozeActions';
import { createProjectInput } from '../Actions/CreateProjectAction';
import { listDirectoriesInput } from '../Actions/ListDirectoriesAction';
import { projectLogoCandidatesInput, setProjectLogoInput } from '../Actions/ProjectLogoAction';
import { NewAgentSessionAction } from '../Actions/NewAgentSessionAction';
import { ResumeConversationAgentAction } from '../Actions/ResumeConversationAgentAction';
import { RestartAgentSessionAction } from '../Actions/RestartAgentSessionAction';
import { abandonWorktreeInput } from '../Actions/AbandonWorktreeAction';
import { createWorktreeInput } from '../Actions/CreateWorktreeAction';
import { getCurrentDiffInput } from '../Actions/GetCurrentDiffAction';
import { getDiffFileInput } from '../Actions/GetDiffFileAction';
import { linkWorktreeInput } from '../Actions/LinkWorktreeAction';
import { listWorktreesInput } from '../Actions/ListWorktreesAction';
import { searchArtifactsInput } from '../Actions/SearchArtifactsAction';
import type { RegistryActions } from '../Actions/RegistryActions';
import type { DatabaseService } from '../Services/DatabaseService';
import type { HarnessDiscoveryService } from '../Services/HarnessDiscoveryService';
import { type HarnessLauncher, launchHarnessInput } from '../Services/HarnessLauncher';
import { sendAgentInput } from '../Services/AgentInputService';
import { notificationListInput, notifyUserInput, type NotificationActions } from '../Actions/NotificationActions';
import { AgentHistoryDeleteService } from '../Services/AgentHistory/AgentHistoryDeleteService';
import { AgentHistoryImportService, historyConfigureInput, historyImportInput } from '../Services/AgentHistory/AgentHistoryImportService';
import type { AgentHistoryImportQueueService } from '../Services/AgentHistory/AgentHistoryImportQueueService';
import { ConversationMediaService, mediaGetInput, mediaListInput } from '../Services/AgentHistory/ConversationMediaService';
import type { HybridHistorySearchService } from '../Services/SemanticSearch/HybridHistorySearchService';
import { AgentHistoryReadService, type ConversationSessionState, conversationHistorySearchInput, conversationSearchInput, historyGetInput, historyListInput } from '../Services/AgentHistory/AgentHistoryReadService';
import type { AgentHistorySourceService } from '../Services/AgentHistory/AgentHistorySourceService';
import type { AgentHistoryWatcherService } from '../Services/AgentHistory/AgentHistoryWatcherService';
import { resolvePtyProcessId, withResolvedPtyProcessId } from '../Services/ProcessIdentity';
import { type ProcessLauncher, processCreateInput, processUpdateInput } from '../Services/ProcessLauncher';
import type { SearchService } from '../Services/SearchService';
import type { IntegratedAgentService } from '../Services/IntegratedAgentService';
import type { SettingsService } from '../Services/SettingsService';
import type { TerminalService } from '../Services/TerminalService';
import { TimerService } from '../Services/TimerService';
import { ConversationOutputService, conversationOutputInput } from '../Services/ConversationOutputService';
import { snapshotText, tailUtf8 } from '../Services/ConversationText';
import type { TimelineService } from '../Services/TimelineService';
import type { WorkbenchRepository } from '../Repositories/WorkbenchRepository';
import type { HarnessPresetService } from '../Services/HarnessPresetService';
import type { HarnessModelCatalogService } from '../Services/HarnessModelCatalogService';
import type { AutoSummaryService } from '../Services/AutoSummaryService';
import type { TranscriptImageStore } from '../Services/TranscriptImageStore';
import { McpToolRegistry, type McpCallContext } from './ToolRegistry';
import { RenderHtmlFigureAction } from '../Actions/RenderHtmlFigureAction';
import { PreviewHtmlFigureAction, type PagePreviewer } from '../Actions/PreviewHtmlFigureAction';
import { FIGURE_BRIDGE_GUIDE, FIGURE_HEIGHT, FIGURE_LAYOUT_GUIDE, FIGURE_THEME_GUIDE, HTML_PREVIEW_TOOL, HTML_RENDER_TOOL, MAX_FIGURE_HTML_CHARS, PREVIEW_WIDTH } from '../Services/HtmlFigure';
import { registerProjectContextTools } from './registerProjectContextTools';
import { registerUsageTools } from './registerUsageTools';
import { registerRoutineTools } from './registerRoutineTools';
import type { RoutineService } from '../Services/RoutineService';
import type { GetUsageSummaryAction } from '../Actions/UsageActions';
import type { AssistantService } from '../Services/AssistantService';
import type { AssistantInbox } from '../Services/AssistantInbox';
import { queuedDetail, SendMessageAction } from '../Actions/SendMessageAction';
import { REMOTE_READ_TOOLS, type CrossHostService } from '../Services/CrossHostService';
import { isUserProjectKind } from '../Services/PersonalProject';
import type { SandboxService } from '../Services/Sandbox/SandboxService';
import { registerSandboxTools } from './sandboxTools';

const CONVERSATION_OUTPUT_HINT = 'Use get_conversation_output for the latest answer, turn state, last report, and older messages.';

// The assistant registers and renames workspace projects. Removal stays an
// owner action behind the UI's confirmation, so no agent can remove one.
const assistantProjectCreateInput = z.object({
  path: z.string().min(1).describe('Absolute directory path on the machine Patterm runs on, or one starting with ~/ for the home directory.'),
  name: z.string().trim().max(200).optional().describe('Display name for a new project; defaults to the directory name. Ignored when the path is already a project.'),
  create_directory: z.boolean().default(false).describe('Create the directory first if it is missing. Its parent must already exist. Leave false to register only an existing directory.')
}).strict();
const assistantProjectRenameInput = z.object({
  project_id: z.string().min(1).describe('The project to rename, from assistant_project_list.'),
  name: z.string().trim().min(1).max(200).describe('The new display name. The folder is not renamed.')
}).strict();

const jsonSchema = zodToJsonSchema as unknown as (schema: z.ZodTypeAny, options: { $refStrategy: 'none' }) => Record<string, unknown>;

export { McpToolRegistry } from './ToolRegistry';

interface RegistryServices {
  actions: RegistryActions;
  database: DatabaseService;
  terminal: TerminalService;
  timeline: TimelineService;
  workbench: WorkbenchRepository;
  harnessDiscovery: HarnessDiscoveryService;
  harnessLauncher: HarnessLauncher;
  integrated?: Pick<IntegratedAgentService, 'conversation' | 'peekConversation' | 'olderMessages' | 'prompt' | 'files' | 'delivery' | 'interrupt' | 'stopTask' | 'taskOutput' | 'updateQueued' | 'replyPermission' | 'replyQuestion' | 'replyForm' | 'controls' | 'configure' | 'command' | 'isEmpty' | 'liveSettings'>;
  transcriptImages?: Pick<TranscriptImageStore, 'read' | 'fromFile'>;
  // Draws pages off screen for html_preview; only the desktop app has one.
  pagePreviewer?: PagePreviewer;
  settings?: Pick<SettingsService, 'agentInterface' | 'updateAgentInterface' | 'figuresEnabled' | 'updateFiguresEnabled'>;
  harnessPresets?: HarnessPresetService;
  modelCatalog?: HarnessModelCatalogService;
  // Hidden Integrated tools are called only by the UI, so their prompts count
  // as the user input that makes an agent eligible for automatic summaries.
  autoSummaries?: Pick<AutoSummaryService, 'userInput'>;
  processLauncher: ProcessLauncher;
  searchService: SearchService;
  historyImportService?: AgentHistoryImportService;
  historySourceService?: AgentHistorySourceService;
  historyImportQueue?: AgentHistoryImportQueueService;
  historyReadService?: AgentHistoryReadService;
  // Keyword search fused with semantic search when this host has it on.
  historySearch?: Pick<HybridHistorySearchService, 'search' | 'searchConversations'>;
  historyMedia?: ConversationMediaService;
  historyDeleteService?: AgentHistoryDeleteService;
  historyWatcher?: AgentHistoryWatcherService;
  timers?: TimerService;
  notifications?: NotificationActions;
  closeRequests?: Pick<CloseRequestActions, 'request' | 'answer' | 'clear'>;
  projectSnoozes?: Pick<ProjectSnoozeActions, 'snooze' | 'wake'>;
  snoozes?: Pick<SnoozeActions, 'snooze' | 'unsnooze' | 'dismissReminder' | 'userInput'>;
  usage?: GetUsageSummaryAction;
  assistant?: Pick<AssistantService, 'deliverAgentMessage'> & Partial<Pick<AssistantService, 'setFocus' | 'focusItems'>>;
  assistantInbox?: Pick<AssistantInbox, 'hold'>;
  assistantMemory?: AssistantMemoryService;
  launchingIdentities?: Pick<LaunchingMcpIdentities, 'role'> & Partial<Pick<LaunchingMcpIdentities, 'sandbox'>>;
  sandboxes?: SandboxService;
  routines?: RoutineService;
  crossHost?: CrossHostService;
}

const processRestartInput = z.object({ process_id: z.string().min(1) });
const assistantFocusSetInput = z.object({ enabled: z.boolean() }).strict();
const assistantFocusItemsInput = z.object({
  digest_id: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0)
}).strict();
const spawnAgentInput = z.object({
  agent: z.enum(['claude', 'codex', 'opencode', 'rawpty']).optional(),
  conversation_id: z.string().min(1).optional(),
  preset: z.string().trim().min(1).max(160).optional(),
  model: z.string().trim().min(1).max(160).optional(),
  reasoning: z.string().trim().min(1).max(60).optional(),
  service_tier: z.string().trim().min(1).max(60).optional(),
  agent_instructions: z.string().default(''),
  prompt: z.string().optional(),
  name: z.string().optional(),
  worktree_id: z.string().nullable().optional(),
  detached: z.boolean().default(false),
  sandbox: z.boolean().default(false),
  // Only the assistant may name another project; other agents spawn in their own.
  project_id: z.string().min(1).optional()
}).superRefine((input, context) => {
  if (!input.agent && !input.conversation_id && !input.preset) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'spawn_agent requires agent, preset, or conversation_id' });
  }
  if (input.conversation_id && input.agent) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'spawn_agent infers agent from conversation_id' });
  }
  if (input.conversation_id && input.worktree_id !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'spawn_agent infers worktree_id from conversation_id' });
  }
  if (input.conversation_id && (input.preset || input.model || input.reasoning || input.service_tier)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'spawn_agent cannot switch model while resuming a conversation' });
  }
});
const spawnProcessInput = z.object({
  kind: z.enum(['terminal', 'command']).default('command'),
  argv: z.array(z.string()).default([]),
  name: z.string().optional(),
  working_dir: z.string().optional(),
  shell: z.boolean().default(false),
  detached: z.boolean().default(false),
  project_id: z.string().optional(),
  worktree_id: z.string().nullable().default(null)
});
const processIdInput = z.object({ process_id: z.string().min(1) });
const integratedReferenceInput = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(255).optional()
});
const integratedAttachmentInput = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(255).optional(),
  mime: z.string().min(1).max(255).optional()
});
const integratedSendInput = processIdInput.extend({
  text: z.string().trim().max(262_144).default(''),
  references: z.array(integratedReferenceInput).max(20).optional(),
  attachments: z.array(integratedAttachmentInput).max(20).optional(),
  message_id: z.string().min(1).max(80).optional()
}).superRefine((input, context) => {
  if (!input.text && !input.references?.length && !input.attachments?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'integrated_send requires text, references, or attachments' });
  }
});
const integratedFilesSearchInput = processIdInput.extend({
  query: z.string().max(200).default(''),
  limit: z.number().int().min(1).max(50).optional()
});
const integratedDeliveryInput = processIdInput.extend({ message_id: z.string().min(1).max(80) });
const integratedHistoryInput = processIdInput.extend({ cursor: z.string().min(1).max(4096) });
// `transcript_only` reads ahead of the user: the transcript without the
// command and model lists, and without the snapshot bookkeeping a pane's read
// does, so it changes nothing on the server.
const integratedGetInput = processIdInput.extend({ transcript_only: z.boolean().optional() });
const integratedConfigureInput = processIdInput.extend({ selector: z.string().min(1).max(50), value: z.string().min(1).max(500) });
const integratedCommandInput = processIdInput.extend({ name: z.string().min(1).max(100), text: z.string().max(262_144).default('') });
const integratedPermissionInput = processIdInput.extend({ request_id: z.string().min(1), reply: z.enum(['once', 'always', 'reject']), message: z.string().max(10_000).optional() });
const integratedTaskInput = processIdInput.extend({ task_id: z.string().min(1).max(500) });
const integratedTaskOutputInput = integratedTaskInput.extend({ since: z.string().max(100).nullish(), cursor: z.string().max(2_000).nullish() });
const integratedQueueInput = processIdInput.extend({ message_id: z.string().min(1).max(500), action: z.enum(['steer', 'cancel']) });
const integratedQuestionInput = processIdInput.extend({ request_id: z.string().min(1), answers: z.array(z.array(z.string().max(10_000)).max(20)).max(20) });
const integratedFormInput = processIdInput.extend({
  form_id: z.string().min(1).max(200),
  // Native form values: string, number, boolean, or string[] for multiselect.
  answer: z.record(z.union([z.string().max(100_000), z.number(), z.boolean(), z.array(z.string().max(10_000)).max(100)])),
  // Elicitations can be declined or cancelled without an answer.
  action: z.enum(['accept', 'decline', 'cancel']).default('accept')
});
const conversationDeleteInput = z.object({ conversation_id: z.string().min(1) });
const historyResetInput = z.object({ reimport: z.boolean().default(true) });
const renameProcessInput = z.object({ process_id: z.string().min(1), name: z.string().min(1) });
const listProcessesInput = z.object({
  kind: z.string().optional(),
  project_id: z.string().min(1).optional(),
  // Exited agents stay listed for resuming, so the full list grows without bound.
  status: z.enum(['running', 'all']).default('running'),
  limit: z.number().int().positive().max(500).default(100)
});
const projectStatusInput = z.object({ project_id: z.string().min(1).optional() });
const cliProcessOutputInput = z.object({
  process_id: z.string().min(1),
  mode: z.enum(['grid', 'stream']).default('grid'),
  since_offset: z.number().int().nonnegative().default(0),
  max_bytes: z.number().int().positive().optional(),
  max_lines: z.number().int().positive().optional()
});
const searchOutputInput = z.object({
  process_id: z.string().min(1),
  pattern: z.string().min(1),
  limit: z.number().int().positive().default(10)
});
const waitForPatternInput = z.object({
  process_id: z.string().min(1).describe('Process whose output to watch.'),
  pattern: z.string().min(1).describe('Literal, case-sensitive text, matched within one output line. Not a regex: "a|b" matches only that exact text.'),
  timeout_seconds: z.number().positive().optional().describe('Optional rescue timeout. Omit it to wait until the text appears or the process ends.'),
  // Older callers' spelling of timeout_seconds.
  timeout_ms: z.number().positive().optional(),
  body: z.string().default('').describe('Optional text added to the callback, such as what to do next.'),
  label: z.string().optional().describe('Optional timer label.')
});
const sendInputInput = z.object({
  process_id: z.string().min(1),
  kind: z.enum(['text', 'paste', 'key']),
  text: z.string().optional(),
  key: z.string().optional(),
  submit: z.boolean().optional(),
  wait_ms: z.number().int().nonnegative().default(0),
  tail_mode: z.enum(['none', 'stream', 'grid']).default('none'),
  tail_max_bytes: z.number().int().positive().default(8000)
});
const messageInput = z.object({ target_process_id: z.string().min(1), message: z.string() });
const hostReadInput = z.object({ host: z.string().min(1).max(40), tool: z.string().min(1).max(100), arguments: z.record(z.string(), z.unknown()).default({}) }).strict();
const reportToParentInput = z.object({
  body: z.string().min(1),
  status: z.enum(['completed', 'blocked', 'failed', 'no_findings']).default('completed'),
  title: z.string().optional()
});
const timerIdInput = z.object({ timer_id: z.string().min(1) });
const timerSetInput = z.object({ seconds: z.number().nonnegative(), body: z.string().optional(), label: z.string().optional(), owner_process_id: z.string().optional() });
const timerIdleInput = z.object({
  watched: z.array(z.string()).default([]),
  body: z.string().default(''),
  label: z.string().optional(),
  max_wait_seconds: z.number().nonnegative().optional(),
  owner_process_id: z.string().optional()
});
const timerReportInput = timerIdleInput;

const projectIdInput = z.object({ project_id: z.string().min(1) });
const helpInput = z.object({ tool: z.string().min(1) });

const terminalProcessInput = z.object({
  process_id: z.string().min(1),
  kind: z.enum(['text', 'paste', 'key']),
  text: z.string().optional(),
  key: z.string().optional(),
  submit: z.boolean().optional()
});

const terminalProcessSpawn = z.object({
  name: z.string().default('terminal'),
  argv: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional()
});

const terminalProcessOutput = z.object({
  process_id: z.string().min(1),
  mode: z.enum(['grid', 'stream']).default('grid'),
  since_offset: z.number().int().nonnegative().default(0)
});
const terminalProcessSearch = z.object({
  process_id: z.string().min(1),
  query: z.string(),
  case_sensitive: z.boolean().default(false)
});
const terminalProcessSelect = z.object({
  process_id: z.string().min(1),
  start_col: z.number().int().nonnegative().optional(),
  start_row: z.number().int().nonnegative().optional(),
  end_col: z.number().int().nonnegative().optional(),
  end_row: z.number().int().nonnegative().optional(),
  clear: z.boolean().optional()
});
const terminalProcessScroll = z.object({
  process_id: z.string().min(1),
  lines: z.number().int()
});
const historyResumeInput = z.object({
  conversation_id: z.string().min(1),
  project_id: z.string().min(1).optional(),
  interface_mode: z.enum(['tui', 'integrated']).optional(),
  replace_process_id: z.string().min(1).optional()
});
const restartAgentSessionInput = z.object({ process_id: z.string().min(1), project_id: z.string().min(1).optional(), force: z.boolean().optional() });
const newAgentSessionInput = z.object({
  process_id: z.string().min(1),
  project_id: z.string().min(1).optional()
});
const conversationHistoryToolInput = conversationHistorySearchInput.omit({ project_id: true });

export function createMcpRegistry(services: RegistryServices): McpToolRegistry {
  const registry = new McpToolRegistry();
  registerProjectContextTools(registry, services.actions.projectContext);
  if (services.usage) registerUsageTools(registry, services.usage);
  const caller = (context: McpCallContext) => context.remote ? remoteCaller(services.database, context.remote) : resolveCaller(services.database, context.identity ?? null);
  // An identity must name a running agent, even for tools that ignore it.
  registry.setCallerCheck((context) => { if (!context.remote) resolveCaller(services.database, context.identity ?? null); });
  // Native MCP discovery happens during prepare, before session registration.
  // Catalogue filtering must not use the strict tool-call authorizer.
  const visibleToAssistant = (context: McpCallContext) => {
    if (context.remote || !context.identity) return false;
    const session = services.database.connection.prepare('select session_role from sessions where mcp_identity = ? and exited_at is null').get(context.identity) as { session_role: string } | undefined;
    return (session?.session_role ?? services.launchingIdentities?.role(context.identity)) === 'assistant';
  };
  if (services.assistantMemory) registerAssistantMemoryTools(registry, services.assistantMemory,
    (context) => !context.remote && isAssistant(caller(context)), visibleToAssistant);
  if (services.routines) {
    const routines = services.routines;
    registerRoutineTools(registry, routines, (context) => {
      const current = caller(context);
      return current ? { sessionId: current.session_id, projectId: current.project_id, workspace: hasWorkspaceScope(current) } : null;
    }, services.crossHost ? (host, tool, args, context) => {
      // Agents in a linked project save routines on the other host; it owns
      // and runs them.
      const current = caller(context);
      if (!current || !current.process_id || hasWorkspaceScope(current) || context.remote) throw new Error(`${tool}: only agents in a linked project can use routines on other hosts`);
      const peer = services.crossHost!.host(host);
      return services.crossHost!.routine(current.project_id, peer.host_id, tool, args, { session_id: current.session_id, process_id: current.process_id, name: current.title ?? 'An agent' });
    } : undefined);
  }
  const timerService = services.timers ?? new TimerService(services.database, services.terminal, services.integrated ? { integrated: services.integrated } : {});
  const resumeConversationAgent = services.historyReadService
    ? new ResumeConversationAgentAction(services.database, services.historyReadService, services.harnessLauncher,
      services.integrated ? { integrated: services.integrated, closeProcess: services.actions.closeProcess } : undefined)
    : null;
  const newAgentSession = new NewAgentSessionAction(services.database, services.harnessLauncher, services.actions.closeProcess);
  const restartAgentSession = new RestartAgentSessionAction(services.database, services.harnessLauncher, {
    stop: (processId) => services.actions.stopProcess.execute(processId),
    close: (processId) => services.actions.closeProcess.execute(processId),
    holdTimers: (processId) => timerService.holdOwner(processId),
    releaseTimers: (timerIds) => { for (const id of timerIds) timerService.resume(id); },
    transferTimers: (from, to) => timerService.transferOwner(from, to),
    ...(services.integrated ? { liveSettings: (processId: string) => services.integrated!.liveSettings(processId) } : {})
  });
  const sendMessage = new SendMessageAction(services.database, services.terminal, services.timeline,
    { integrated: services.integrated, assistant: services.assistant, notifications: services.notifications });
  const conversationOutput = new ConversationOutputService(services.database, services.integrated ?? null, services.historyReadService ?? null);

  // A host:process address, for callers that may reach other hosts.
  const remoteAddress = (value: unknown) => typeof value === 'string' && services.crossHost ? services.crossHost.parseAddress(value) : null;
  // Agents on other hosts are read and messaged, never controlled.
  registry.setRouter((toolName, args, context) => {
    const processId = args && typeof args === 'object' ? (args as Record<string, unknown>).process_id : undefined;
    if (context.remote || !services.crossHost) return null;
    const target = remoteAddress(processId);
    if (!target) return null;
    if (!REMOTE_READ_TOOLS.has(toolName)) {
      return Promise.reject(new Error(`${toolName} cannot act on ${target.address}, an agent on another host. Send it a message with send_message instead.`));
    }
    const current = caller(context);
    if (!current || hasWorkspaceScope(current)) return Promise.reject(new Error('Only agents in a linked project can read agents on other hosts.'));
    return services.crossHost.read(current.project_id, target.host.host_id, toolName, { ...(args as Record<string, unknown>), process_id: target.process_id });
  });
  // Owner calls without a project fall back to the oldest repository project,
  // so the Personal project, listed first, never catches them by accident.
  const defaultProjectId = () => {
    const projects = services.workbench.listProjects();
    return (projects.find((project) => project.kind !== 'personal') ?? projects[0])?.id ?? null;
  };
  const projectFor = (context: McpCallContext, explicit?: string) => {
    const current = caller(context);
    if (hasWorkspaceScope(current)) return explicit ? workspaceProjectId(services.database, explicit) : null;
    return explicit ? scopedProjectId(services.database, current, explicit) : current?.project_id ?? defaultProjectId();
  };
  const processFor = (context: McpCallContext, processId: string) => scopedProcessId(services.database, caller(context), processId);
  const worktreeFor = (context: McpCallContext, worktreeId: string) => scopedWorktreeId(services.database, caller(context), worktreeId);
  // The authenticated agent session behind a call, or null for owner and UI
  // calls. The assistant works in other projects, so nothing links to it there.
  const agentFor = (context: McpCallContext) => {
    const current = caller(context);
    return current && !hasWorkspaceScope(current) ? { sessionId: current.session_id, projectId: current.project_id } : null;
  };
  // Agents on the hosts the caller's project is linked with. Reads made for
  // another host never reach back out, so two hosts never list each other
  // in a loop.
  const remoteProcessesFor = async (context: McpCallContext, projectId: string | null, args: Record<string, unknown>) => {
    const current = caller(context);
    if (!services.crossHost || context.remote || !projectId || !current || hasWorkspaceScope(current)) return { processes: [], unavailable: [] as string[] };
    return services.crossHost.remoteProcesses(projectId, args);
  };
  // Report timers can watch agents on other hosts, which answer by message.
  const watchedFor = (context: McpCallContext, processId: string, kind: 'idle' | 'report') => {
    const remote = remoteAddress(processId);
    if (!remote) return processFor(context, processId);
    if (kind === 'idle') throw new Error(`Idle timers cannot watch ${remote.address} on another host. Use timer_fire_when_reported_any, which fires when it messages you.`);
    const current = caller(context);
    if (!current || hasWorkspaceScope(current)) throw new Error('Only agents in a linked project can watch agents on other hosts.');
    services.crossHost!.remoteProject(remote.host.host_id, current.project_id);
    // The host's ID, not its name, so renaming the host does not lose the watch.
    return `${remote.host.host_id}:${remote.process_id}`;
  };
  const ptyFor = (processId: string) => resolvePtyProcessId(services.database, processId);
  const ptyForScoped = (context: McpCallContext, processId: string) => ptyFor(processFor(context, processId));
  const processInfo = (processId: string, kind: string, name: string, status: string, parentProcessId: string | null = null) => ({
    process_id: processId,
    name,
    kind,
    status,
    ...(parentProcessId ? { parent_process_id: parentProcessId } : {})
  });

  registry.register(
    {
      name: 'spawn_agent',
      namespace: 'cli.process',
      description: 'Spawn a new Patterm-managed sub-agent, optionally with a configured model preset, or resume an imported conversation by conversation_id.',
      inputSchema: { type: 'object', anyOf: [{ required: ['agent'] }, { required: ['preset'] }, { required: ['conversation_id'] }] },
      usageNotes: [
        'Pass agent (claude, codex, opencode, or rawpty), a preset, or a conversation_id. harness_list shows which agents are installed.',
        'Any agent can spawn child agents, including a sub-agent splitting up its own delegated task. The new agent is your child: it reports to you, and closing you closes it.',
        'Spawn only for work within your current task. A delegated sub-agent must not start unrelated work; ask your parent or the user first.',
        'Do not use this to replace an unavailable host-native subagent; continue planning directly unless the user explicitly requests Patterm delegation.',
        'Children join the caller\'s project, and their worktree must belong to it. Only the assistant passes project_id, to choose a workspace project.',
        'Before spawning, check list_processes for a running child that already worked on this, such as a reviewer that reported. Send it the follow-up with send_message instead of spawning a replacement; it keeps its earlier context.',
        'Pass preset to launch with one of the user\'s configured model presets by name (case-insensitive); call harness_presets to list them. Omit preset to use the harness default.',
        'A user message token such as [patterm_preset:<name>], [patterm_preset:<harness>/<name>], or [patterm_harness:<agent>] asks you to spawn with that preset or agent.',
        'Codex only: pass service_tier to override the preset speed, such as priority for Fast or default for Standard. harness_models lists the tiers each model supports.',
        'To continue prior work, pass a conversation_id returned by search_conversation_history. Provider, worktree, and cwd are inferred; presets cannot be switched while resuming.',
        'Pass detached: true to open the agent as a regular top-level tab that outlives the calling agent. It also works with conversation_id. A detached agent has no parent: it cannot call report_to_parent, its notify_user requests go straight to the user, and you cannot wait for it with timer_fire_when_reported_any/all.',
        'Only spawn detached agents when the user has specifically asked for one; never detach on your own initiative.',
        'A child of an agent running in a sandbox shares that sandbox unless you pass another worktree_id. Pass sandbox: true to give the child its own new sandbox and worktree; only do so when the user asks.'
      ]
    },
    async (args, context) => {
      const input = spawnAgentInput.parse(args);
      const projectId = projectFor(context, input.project_id);
      if (!projectId) {
        throw new Error(hasWorkspaceScope(caller(context)) ? 'spawn_agent: pass the project_id to spawn in' : 'spawn_agent: no project is available');
      }
      const parent = caller(context);
      const instructions = childAgentInstructions(input.agent_instructions, input.prompt, input.detached, Boolean(input.conversation_id));
      // Detaching only drops the parent link; project, worktree and actor still come from the caller.
      const parentProcessId = input.detached ? null : parent?.process_id ?? null;
      if (input.conversation_id) {
        if (!parent?.process_id) throw new Error('spawn_agent: resuming a conversation requires an active agent');
        if (!resumeConversationAgent) throw new Error('spawn_agent: conversation history is not available');
        const launched = await resumeConversationAgent.execute({
          conversation_id: input.conversation_id,
          project_id: hasWorkspaceScope(parent) ? projectId : parent.project_id,
          actor_id: parent.session_id,
          parent_process_id: parentProcessId,
          name: input.name,
          initial_prompt: instructions
        });
        return processInfo(launched.process_id, 'agent', launched.name, 'running', parentProcessId);
      }
      // A sandboxed parent's children work in its sandbox by default.
      const inherited = input.worktree_id === undefined && !input.sandbox && parent?.worktree_id && services.sandboxes?.forWorktree(parent.worktree_id) ? parent.worktree_id : null;
      const worktreeId = inherited ?? scopedNullableWorktreeId(services.database, parent, input.worktree_id);
      const launched = await services.harnessLauncher.launch({
        sandbox: input.sandbox,
        harness: input.agent,
        preset: input.preset ?? null,
        model: input.model ?? null,
        reasoning: input.reasoning ?? null,
        service_tier: input.service_tier ?? null,
        project_id: projectId,
        worktree_id: worktreeId,
        actor_id: parent?.session_id ?? null,
        parent_process_id: parentProcessId,
        session_role: parent && !input.detached ? 'child' : 'orchestrator',
        name: input.name,
        initial_prompt: instructions
      });
      return processInfo(launched.process_id, 'agent', input.name ?? launched.harness, 'running', parentProcessId);
    }
  );

  registry.register(
    { name: 'integrated_get', namespace: 'integrated', description: 'Read the bounded native transcript and pending requests for an Integrated agent session. Pass transcript_only for a side-effect-free read of the transcript alone.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['process_id'] } },
    async (args, context) => {
      const input = integratedGetInput.parse(args);
      const processId = processFor(context, input.process_id);
      return input.transcript_only ? requireIntegrated(services).peekConversation(processId) : requireIntegrated(services).conversation(processId);
    }
  );
  registry.register(
    { name: 'integrated_history', namespace: 'integrated', description: 'Load an older page of native Integrated conversation messages.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['process_id', 'cursor'] } },
    (args, context) => {
      const input = integratedHistoryInput.parse(args);
      return requireIntegrated(services).olderMessages(processFor(context, input.process_id), input.cursor);
    }
  );
  registry.register(
    { name: 'integrated_image', namespace: 'integrated', description: 'Read one stored Integrated transcript image by its hash.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['sha256'] } },
    (args) => {
      const { sha256 } = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).parse(args);
      const image = services.transcriptImages?.read(sha256);
      if (!image) throw new Error('This image is no longer stored');
      return image;
    }
  );
  registry.register(
    { name: 'settings_agent_interface_get', namespace: 'settings', description: 'Read the saved interface for new agent conversations.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    () => ({ interface_mode: requireSettings(services).agentInterface() })
  );
  registry.register(
    { name: 'settings_agent_interface_update', namespace: 'settings', description: 'Save the interface for later agent conversations.', hidden: true, changes: ['settings'], inputSchema: { type: 'object', required: ['interface_mode'] } },
    (args) => ({ interface_mode: requireSettings(services).updateAgentInterface(z.object({ interface_mode: z.enum(['tui', 'integrated']) }).parse(args).interface_mode) })
  );
  registry.register(
    { name: 'settings_figures_get', namespace: 'settings', description: 'Read whether agents can save figures for their replies.', hidden: true, changes: [], inputSchema: { type: 'object' } },
    () => ({ enabled: requireSettings(services).figuresEnabled() })
  );
  registry.register(
    { name: 'settings_figures_update', namespace: 'settings', description: 'Turn figures in agent replies on or off.', hidden: true, changes: ['settings'], inputSchema: { type: 'object', required: ['enabled'] } },
    (args) => ({ enabled: requireSettings(services).updateFiguresEnabled(z.object({ enabled: z.boolean() }).strict().parse(args).enabled) })
  );
  registry.register(
    { name: 'integrated_send', namespace: 'integrated', description: 'Queue one message for an Integrated agent session.', hidden: true, inputSchema: { type: 'object', required: ['process_id'] } },
    (args, context) => {
      const input = integratedSendInput.parse(args);
      const processId = processFor(context, input.process_id);
      services.autoSummaries?.userInput(processId);
      // A message, even one queued mid-turn, withdraws a close request and
      // wakes a snoozed agent.
      services.closeRequests?.clear(processId);
      services.snoozes?.userInput(processId);
      return requireIntegrated(services).prompt(processId, {
        text: input.text,
        ...(input.references ? { references: input.references } : {}),
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.message_id ? { messageId: input.message_id } : {})
      });
    }
  );
  registry.register(
    { name: 'integrated_files_search', namespace: 'integrated', description: 'Search files in an Integrated agent worktree for @ references.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['process_id'] } },
    (args, context) => {
      const input = integratedFilesSearchInput.parse(args);
      return requireIntegrated(services).files(processFor(context, input.process_id), input.query, input.limit);
    }
  );
  registry.register(
    { name: 'integrated_delivery', namespace: 'integrated', description: 'Reconcile an ambiguous Integrated prompt against native admission evidence.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['process_id', 'message_id'] } },
    (args, context) => {
      const input = integratedDeliveryInput.parse(args);
      return requireIntegrated(services).delivery(processFor(context, input.process_id), input.message_id);
    }
  );
  registry.register(
    { name: 'integrated_controls', namespace: 'integrated', description: 'List native controls and slash commands for an Integrated agent session.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['process_id'] } },
    (args, context) => requireIntegrated(services).controls(processFor(context, processIdInput.parse(args).process_id))
  );
  registry.register(
    { name: 'integrated_configure', namespace: 'integrated', description: 'Change one native Integrated agent setting.', hidden: true, inputSchema: { type: 'object', required: ['process_id', 'selector', 'value'] } },
    (args, context) => { const input = integratedConfigureInput.parse(args); return requireIntegrated(services).configure(processFor(context, input.process_id), input.selector, input.value); }
  );
  registry.register(
    { name: 'integrated_command', namespace: 'integrated', description: 'Run one native slash command for an Integrated agent session.', hidden: true, inputSchema: { type: 'object', required: ['process_id', 'name'] } },
    (args, context) => { const input = integratedCommandInput.parse(args); return requireIntegrated(services).command(processFor(context, input.process_id), input.name, input.text); }
  );
  registry.register(
    { name: 'integrated_interrupt', namespace: 'integrated', description: 'Interrupt the active turn for an Integrated agent session.', hidden: true, inputSchema: { type: 'object', required: ['process_id'] } },
    (args, context) => requireIntegrated(services).interrupt(processFor(context, processIdInput.parse(args).process_id))
  );
  registry.register(
    { name: 'integrated_queue_update', namespace: 'integrated', description: 'Steer or cancel one queued prompt of an Integrated agent session.', hidden: true, inputSchema: { type: 'object', required: ['process_id', 'message_id', 'action'] } },
    (args, context) => {
      const input = integratedQueueInput.parse(args);
      const processId = processFor(context, input.process_id);
      if (input.action === 'steer') {
        services.autoSummaries?.userInput(processId);
        services.closeRequests?.clear(processId);
        services.snoozes?.userInput(processId);
      }
      return requireIntegrated(services).updateQueued(processId, input.message_id, input.action);
    }
  );
  registry.register(
    { name: 'integrated_task_output', namespace: 'integrated', description: 'Read the transcript or output of one background task of an Integrated agent session.', hidden: true, changes: [], inputSchema: { type: 'object', required: ['process_id', 'task_id'] } },
    (args, context) => { const input = integratedTaskOutputInput.parse(args); return requireIntegrated(services).taskOutput(processFor(context, input.process_id), input.task_id, input.since, input.cursor); }
  );
  registry.register(
    { name: 'integrated_task_stop', namespace: 'integrated', description: 'Stop one background task of an Integrated agent session.', hidden: true, inputSchema: { type: 'object', required: ['process_id', 'task_id'] } },
    (args, context) => { const input = integratedTaskInput.parse(args); return requireIntegrated(services).stopTask(processFor(context, input.process_id), input.task_id); }
  );
  registry.register(
    { name: 'integrated_permission_reply', namespace: 'integrated', description: 'Resolve a pending native permission request.', hidden: true, inputSchema: { type: 'object', required: ['process_id', 'request_id', 'reply'] } },
    (args, context) => { const input = integratedPermissionInput.parse(args); return requireIntegrated(services).replyPermission(processFor(context, input.process_id), input.request_id, input.reply, input.message); }
  );
  registry.register(
    { name: 'integrated_question_reply', namespace: 'integrated', description: 'Answer a pending native question request.', hidden: true, inputSchema: { type: 'object', required: ['process_id', 'request_id', 'answers'] } },
    (args, context) => { const input = integratedQuestionInput.parse(args); return requireIntegrated(services).replyQuestion(processFor(context, input.process_id), input.request_id, input.answers); }
  );
  registry.register(
    { name: 'integrated_form_reply', namespace: 'integrated', description: 'Answer a pending native form with typed field values.', hidden: true, inputSchema: { type: 'object', required: ['process_id', 'form_id', 'answer'] } },
    (args, context) => { const input = integratedFormInput.parse(args); return requireIntegrated(services).replyForm(processFor(context, input.process_id), input.form_id, input.answer, input.action); }
  );

  registry.register(
    {
      name: 'spawn_process',
      namespace: 'cli.process',
      description: 'Spawn a terminal or command process.',
      inputSchema: { type: 'object' },
      usageNotes: [
        'Processes are children of the calling agent: they nest under it and close when it closes.',
        'Pass detached: true to open the process as a regular tab that outlives the calling agent.',
        'Only spawn detached processes when the user has specifically asked for one; never detach on your own initiative.'
      ]
    },
    async (args, context) => {
      const input = spawnProcessInput.parse(args);
      const projectId = projectFor(context, input.project_id);
      if (!projectId) {
        throw new Error('spawn_process: no project is available');
      }
      const parent = caller(context);
      const commandText = input.kind === 'terminal' ? undefined : commandFromArgv(input.argv, input.shell);
      const worktreeId = scopedNullableWorktreeId(services.database, parent, input.worktree_id);
      const parentProcessId = input.detached ? null : parent?.process_id ?? null;
      const result = await services.processLauncher.create({
        project_id: projectId,
        worktree_id: worktreeId,
        name: input.name,
        command: commandText,
        cwd: input.working_dir,
        actor_id: parent?.session_id ?? null,
        parent_process_id: parentProcessId
      });
      return processInfo(result.process_id, input.kind, input.name ?? commandText ?? 'terminal', 'running', parentProcessId);
    }
  );

  registry.register({
    name: 'list_processes',
    namespace: 'cli.process',
    description: 'List visible processes. Use this before messaging or reading another process.',
    inputSchema: { type: 'object' },
    usageNotes: [
      'Lists running processes by default. Pass status all to include exited and closed ones, such as agents to resume.',
      'Agents come first, then other processes, each newest first. At most limit rows (default 100) are returned; omitted counts the rest.',
      'Agents on paired hosts whose project is linked with yours follow, addressed as host:process with a host field. Read them with the usual read tools and message them with send_message; you cannot control them. unavailable_hosts lists linked hosts that did not answer.'
    ]
  }, async (args, context) => {
    const input = listProcessesInput.parse(args ?? {});
    const current = caller(context);
    const projectId = hasWorkspaceScope(current) ? projectFor(context, input.project_id) : current?.project_id ?? null;
    if (hasWorkspaceScope(current) && !projectId) throw new Error('list_processes: pass a project_id; assistant_overview lists every project');
    const local = listCliProcesses(services.database, input.kind, projectId, current?.process_id ?? null)
      .filter((row) => input.status === 'all' || row.status === 'running' || row.is_current);
    const remote = await remoteProcessesFor(context, projectId, { ...(input.kind ? { kind: input.kind } : {}), status: input.status, limit: input.limit });
    const all = [...local, ...remote.processes];
    const processes = all.slice(0, input.limit);
    return {
      current_process_id: current?.process_id ?? '',
      processes,
      ...(all.length > processes.length ? { omitted: all.length - processes.length } : {}),
      ...(remote.unavailable.length ? { unavailable_hosts: remote.unavailable } : {})
    };
  });

  registry.register({ name: 'get_process_status', namespace: 'cli.process', description: 'Return process status.', inputSchema: { type: 'object', required: ['process_id'] } }, async (args, context) => {
    const input = processIdInput.parse(args);
    const processId = processFor(context, input.process_id);
    const integrated = isIntegratedProcess(services.database, processId);
    const status = integrated ? {} : asRecord(await services.terminal.request('terminal.process.status', { process_id: ptyFor(processId) }));
    return { ...findCliProcess(services.database, processId), ...status };
  });

  registry.register({ name: 'get_project_status', namespace: 'cli.project', description: 'Return project, caller, and process orientation.', inputSchema: { type: 'object' } }, async (args, context) => {
    const input = projectStatusInput.parse(args ?? {});
    const current = caller(context);
    if (hasWorkspaceScope(current) && !input.project_id) return assistantOverview(services, current!);
    const projectId = hasWorkspaceScope(current) ? projectFor(context, input.project_id) : projectFor(context);
    const remote = await remoteProcessesFor(context, current?.project_id ?? null, {});
    return {
      project: projectMeta(services.workbench.getProject(projectId ?? '') ?? null),
      caller: whoami(services.database, context.identity ?? null, false, registry),
      current_process_id: current?.process_id ?? '',
      processes: [...listCliProcesses(services.database, undefined, hasWorkspaceScope(current) ? projectId : current?.project_id ?? null, current?.process_id ?? null), ...remote.processes],
      ...(remote.unavailable.length ? { unavailable_hosts: remote.unavailable } : {})
    };
  });

  registry.register({
    name: 'host_read',
    namespace: 'cli.hosts',
    description: 'Run a read-only tool on a paired host, within the project linked with yours.',
    changes: [],
    inputSchema: {
      type: 'object',
      required: ['host', 'tool'],
      properties: {
        host: { type: 'string', description: 'Paired host name, as in the host field of list_processes.' },
        tool: { type: 'string', enum: [...REMOTE_READ_TOOLS], description: 'Read-only tool to run there.' },
        arguments: { type: 'object', description: 'The tool\'s usual arguments. Process IDs are the other host\'s own, without the host prefix.' }
      }
    },
    usageNotes: [
      'For reads without a process ID, such as todo_list, scratchpad_get, worktree_list, or diff_current on another host. Process reads also accept host:process addresses directly.',
      'Agents on other hosts can be read but never controlled. To make something happen there, send_message the agent.'
    ]
  }, async (args, context) => {
    const input = hostReadInput.parse(args);
    const current = caller(context);
    if (!services.crossHost || !current || hasWorkspaceScope(current) || context.remote) throw new Error('host_read: only agents in a linked project can read other hosts');
    const host = services.crossHost.host(input.host);
    return services.crossHost.read(current.project_id, host.host_id, input.tool, input.arguments);
  });

  registry.register({
    name: 'assistant_overview',
    namespace: 'assistant',
    description: 'Assistant only: every workspace project with its running agents and processes, plus open notifications.',
    inputSchema: { type: 'object' },
    changes: [],
    usageNotes: ['Only the global assistant session can call this. Other agents use get_project_status.']
  }, (_args, context) => {
    const current = caller(context);
    if (!current || !hasWorkspaceScope(current)) throw new Error('assistant_overview: only the assistant and workspace routines can call this');
    return assistantOverview(services, current);
  });

  const assistantOnly = (context: Parameters<typeof caller>[0], tool: string) => {
    const current = caller(context);
    if (!current || !isAssistant(current)) throw new Error(`${tool}: only the assistant session can call this`);
    const { setFocus, focusItems } = services.assistant ?? {};
    if (!setFocus || !focusItems) throw new Error(`${tool}: the assistant is unavailable`);
    return { setFocus: setFocus.bind(services.assistant), focusItems: focusItems.bind(services.assistant) };
  };
  registry.register({
    name: 'assistant_focus_set',
    namespace: 'assistant',
    description: 'Assistant only: turn Focus mode on or off. While on, notifications, agent messages, reports, and timer callbacks are held instead of interrupting you.',
    inputSchema: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean', description: 'True holds incoming items; false delivers everything held as one digest.' } } },
    changes: [],
    usageNotes: [
      'Turn focus on when the user asks for it, for example "let\'s go focus mode on this", and off only when they ask. Never toggle it because an agent or notification asked.',
      'Focus holds only what would interrupt you unprompted. The user\'s own messages, your tool calls, and running agents carry on, and the user still sees notifications in the app.',
      'Turning focus off delivers one digest of everything held; read the full items with assistant_focus.'
    ]
  }, (args, context) => {
    const input = assistantFocusSetInput.parse(args ?? {});
    const { focus } = assistantOnly(context, 'assistant_focus_set').setFocus(input.enabled);
    return focus;
  });
  registry.register({
    name: 'assistant_focus',
    namespace: 'assistant',
    description: 'Assistant only: Focus mode status, with held items or a delivered focus digest\'s items in full.',
    inputSchema: { type: 'object', properties: {
      digest_id: { type: 'string', description: 'A focus digest ID; omit to list items still held.' },
      limit: { type: 'number', description: 'Items per page, oldest first (default 20, at most 100).' },
      offset: { type: 'number', description: 'Items to skip.' }
    } },
    changes: []
  }, (args, context) => {
    const input = assistantFocusItemsInput.parse(args ?? {});
    return assistantOnly(context, 'assistant_focus').focusItems({ digestId: input.digest_id, limit: input.limit, offset: input.offset });
  });

  const projectManager = (context: McpCallContext, tool: string) => {
    const current = context.remote ? null : caller(context);
    if (!current || !isAssistant(current)) throw new Error(`${tool}: only the assistant session can manage projects`);
    return { actor_type: 'agent' as const, actor_id: current.process_id };
  };
  const notAssistant = (context: McpCallContext) => visibleToAssistant(context) ? null : 'Only the assistant session can manage projects.';
  registry.register({
    name: 'assistant_project_list',
    namespace: 'assistant.project',
    description: 'Assistant only: every workspace project with its ID, name, and directory path.',
    inputSchema: { type: 'object', properties: {} },
    changes: [],
    unavailable: notAssistant
  }, (_args, context) => {
    projectManager(context, 'assistant_project_list');
    return { projects: services.workbench.listProjects().map(({ id, name, path, kind }) => ({ project_id: id, name, path, kind })) };
  });
  registry.register({
    name: 'assistant_project_create',
    namespace: 'assistant.project',
    description: 'Assistant only: register a directory as a Patterm project, optionally creating the directory first. Idempotent by path.',
    inputSchema: jsonSchema(assistantProjectCreateInput, { $refStrategy: 'none' }),
    changes: ['workbench'],
    unavailable: notAssistant,
    usageNotes: [
      'To register an existing folder, pass its path. A missing path fails unless create_directory is true.',
      'To make a new folder and project together, as in "create ~/Dev/app and add it to Patterm", pass create_directory: true. Only the last folder is created; a missing parent fails.',
      'A path that is already a project returns that project with existed: true, unchanged; created_directory says whether this call made the folder.',
      'Paths are on the machine Patterm runs on. Nothing is cloned or initialised: run git init or git clone yourself first if the user wants a repository.'
    ]
  }, (args, context) => {
    const actor = projectManager(context, 'assistant_project_create');
    const input = assistantProjectCreateInput.parse(args ?? {});
    return services.actions.createProject.execute({ path: input.path, name: input.name ?? '', create_directory: input.create_directory, ...actor });
  });
  registry.register({
    name: 'assistant_project_rename',
    namespace: 'assistant.project',
    description: 'Assistant only: rename a workspace project. Its folder is not renamed.',
    inputSchema: jsonSchema(assistantProjectRenameInput, { $refStrategy: 'none' }),
    changes: ['workbench', 'routines'],
    unavailable: notAssistant,
    usageNotes: ['Projects cannot be removed through MCP. Ask the user to remove one from the project menu, which confirms first.']
  }, (args, context) => {
    const actor = projectManager(context, 'assistant_project_rename');
    const input = assistantProjectRenameInput.parse(args ?? {});
    return services.actions.renameProject.execute({ ...input, ...actor });
  });

  registry.register({
    name: 'get_process_output',
    namespace: 'cli.process',
    description: 'Read a process once: the rendered terminal viewport, or the end of an Integrated agent conversation as text.',
    inputSchema: {
      type: 'object',
      required: ['process_id'],
      properties: {
        process_id: { type: 'string', description: 'Process ID to read.' },
        mode: { type: 'string', enum: ['grid', 'stream'], description: 'Terminal processes: rendered grid output. Stream mode is currently canonicalized from the rendered viewport. Integrated agents always return mode conversation.' },
        since_offset: { type: 'number', description: 'Optional stream offset for incremental reads.' },
        max_bytes: { type: 'number', description: 'Optional output byte limit.' },
        max_lines: { type: 'number', description: 'Optional output line limit.' }
      }
    },
    usageNotes: [
      'A point-in-time read of the end of the output, not a durable transcript or final-answer transport. To read what an agent said, use get_conversation_output.',
      'Integrated agents return their recent conversation as [user], [assistant], [tool], and [notice] lines with mode conversation; max_lines and max_bytes keep the end.',
      'Do not loop get_process_output while waiting; use report timers for delegated agents and idle timers only for quietness/readiness checks.'
    ]
  }, async (args, context) => {
    const input = cliProcessOutputInput.parse(args);
    const processId = processFor(context, input.process_id);
    return limitOutput(await readProcessOutput(services, processId, input.mode, input.since_offset), input.max_bytes, input.max_lines);
  });

  registry.register({
    name: 'get_conversation_output',
    namespace: 'cli.process',
    description: 'Read an agent\'s conversation in bounded pages, newest first, with its turn state, latest answer, and last report.',
    changes: [],
    inputSchema: { type: 'object', required: ['process_id'] },
    usageNotes: [
      'The main way to read what an agent said. The first page holds the newest messages and latest_answer; pass next_before as before for the page before it, until has_more is false.',
      'Pages hold user and assistant text by default; include adds tool calls with their output, reasoning, or notices. A page has at most limit messages and max_bytes of text, so a long message can start the next page or be cut (truncated).',
      'turn.state ended means the agent stopped its turn, not that its task is done. Treat work as done after its report (last_report) or a clear final answer.',
      'Live Integrated agents are read from their runtime, then from older native or imported pages (sources). Other agents are read from imported history, which may be behind them; stale says so. A cursor that no longer matches returns an error; read again without before.',
      'Read after a report timer fires or when asked. Do not loop it while waiting; wait for timer callbacks.'
    ]
  }, async (args, context) => {
    const input = conversationOutputInput.parse(args);
    return conversationOutput.read({ ...input, process_id: processFor(context, input.process_id) });
  });

  registry.register({ name: 'search_output', namespace: 'cli.process', description: 'Search process output: the terminal viewport, or the conversation text of an Integrated agent.', inputSchema: { type: 'object', required: ['process_id', 'pattern'] } }, async (args, context) => {
    const input = searchOutputInput.parse(args);
    const processId = processFor(context, input.process_id);
    if (isIntegratedProcess(services.database, processId)) {
      const content = (await readProcessOutput(services, processId, 'conversation', 0)).content;
      const all = content.split('\n').filter((line) => line.toLowerCase().includes(input.pattern.toLowerCase()));
      return { matches: all.slice(0, input.limit), truncated: all.length > input.limit, format: 'conversation' };
    }
    const result = await services.terminal.request('terminal.process.search', {
      process_id: ptyFor(processId),
      query: input.pattern,
      case_sensitive: false
    });
    const rawMatches = asRecord(result).matches;
    const matches: unknown[] = Array.isArray(rawMatches) ? rawMatches : [];
    return { matches: matches.slice(0, input.limit), truncated: matches.length > input.limit };
  });

  registry.register({
    name: 'wait_for_pattern',
    namespace: 'cli.process',
    description: 'Watch a process for literal text without blocking. Returns at once: matched or exited when that is already true, otherwise watching with a timer_id. Patterm then messages you once, when the text appears, the process ends without it, or timeout_seconds passes.',
    inputSchema: { type: 'object', required: ['process_id', 'pattern'] },
    usageNotes: [
      'This tool never waits. When it returns watching, end your turn; the callback arrives as a new message. Do not poll get_process_output meanwhile.',
      'Output the process printed before the call counts, scrollback included, so a pattern already printed returns matched straight away.',
      'Use it for readiness ("ready on port") and for completion of long commands. Cancel a watch with timer_cancel; timer_list shows pending watches.'
    ]
  }, async (args, context) => {
    const input = waitForPatternInput.parse(args);
    const processId = processFor(context, input.process_id);
    const owner = caller(context)?.process_id;
    if (!owner) throw new Error('wait_for_pattern sends its result to the calling agent, so only agents can call it.');
    const now = await timerService.outputState(processId, input.pattern);
    if (now.state === 'matched') return { status: 'matched', process_id: now.process_id, line: now.line };
    if (now.state === 'exited') return { status: 'exited', process_id: now.process_id, process_status: now.status, exit_code: now.exit_code };
    if (now.state === 'missing') throw new Error(`unknown process: ${input.process_id}`);
    // Output printed between this check and the watch's first search is
    // still found: the watch searches everything the terminal retains.
    const timeoutMs = input.timeout_ms ?? (input.timeout_seconds === undefined ? undefined : input.timeout_seconds * 1000);
    const timer = timerService.setOutput({ processId, pattern: input.pattern, ownerProcessId: owner, body: input.body, maxWaitSeconds: timeoutMs === undefined ? undefined : timeoutMs / 1000, label: input.label });
    return { status: 'watching', timer_id: timer.id, process_id: processId, pattern: input.pattern, next: 'End your turn. Patterm will message you when the text appears, the process ends, or the timeout passes.' };
  });

  // Input changes no stored state. The activity that follows is reported by the
  // runtime and the Integrated service.
  registry.register({ name: 'send_input', namespace: 'cli.process', description: 'Send text, paste, or key input to a process.', changes: [], inputSchema: { type: 'object', required: ['process_id', 'kind'] } }, async (args, context) => {
    const input = sendInputInput.parse(args);
    const processId = processFor(context, input.process_id);
    const integrated = isIntegratedProcess(services.database, processId);
    const text = input.kind === 'key' ? keyText(input.key) : input.text ?? '';
    const kind = input.kind === 'paste' ? 'paste' : 'text';
    if (input.kind === 'key') {
      if (integrated) throw new Error('Key input is not supported for Integrated conversations');
      const ptyId = ptyFor(processId);
      await services.terminal.request('terminal.process.input', { process_id: ptyId, kind, text, submit: input.submit });
    } else {
      await sendAgentInput(services.database, services.terminal, { process_id: processId, kind, text, submit: input.submit }, services.integrated);
    }
    // Input answers whatever the process was waiting on, as typing does.
    services.notifications?.userInput(processId);
    if (input.wait_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, input.wait_ms));
    }
    const tail = input.tail_mode === 'none' ? null : integrated
      ? limitOutput(await readProcessOutput(services, processId, 'conversation', 0), input.tail_max_bytes)
      : limitOutput(normalizeOutput(await services.terminal.request('terminal.process.output', { process_id: ptyFor(processId), mode: input.tail_mode }), input.tail_mode), input.tail_max_bytes);
    return tail ? { ok: true, tail } : { ok: true };
  });

  registry.register({ name: 'restart_process', namespace: 'cli.process', description: 'Restart a persistent process.', inputSchema: { type: 'object', required: ['process_id'] } }, async (args, context) => {
    const input = processIdInput.parse(args);
    return services.processLauncher.relaunch(processFor(context, input.process_id));
  });

  registry.register({ name: 'stop_process', namespace: 'cli.process', description: 'Stop a process.', inputSchema: { type: 'object', required: ['process_id'] } }, async (args, context) => {
    const input = processIdInput.parse(args);
    return services.actions.stopProcess.execute(processFor(context, input.process_id));
  });

  registry.register({ name: 'close_process', namespace: 'cli.process', description: 'Close a process entry.', inputSchema: { type: 'object', required: ['process_id'] }, usageNotes: ['Keep a reported child such as a reviewer open while its review loop may still need follow-ups; close it once the work is settled.'] }, async (args, context) => {
    const input = processIdInput.parse(args);
    return services.actions.closeProcess.execute(processFor(context, input.process_id));
  });

  const renameProcess = new RenameProcessAction(services.database, () => services.historyImportQueue?.syncTitles());
  registry.register({
    name: 'session_rename',
    namespace: 'session',
    description: 'Rename your own agent session to describe your current work. Discards renames after a user sets the title.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['name'], additionalProperties: false },
    usageNotes: ['Requires authenticated agent identity. Returns {renamed:false,reason:"user_override"} when the user has renamed this session. The override persists across application restarts.']
  }, (args, context) => {
    const input = renameSessionInput.parse(args);
    const current = caller(context);
    if (!current) throw new Error('session_rename requires an authenticated agent session');
    return renameProcess.execute(current.session_id, input.name, 'agent');
  });

  registry.register({ name: 'rename_process', namespace: 'cli.process', description: 'Rename a process.', inputSchema: { type: 'object', required: ['process_id', 'name'] } }, (args, context) => {
    const input = renameProcessInput.parse(args);
    const result = renameProcess.execute(processFor(context, input.process_id), input.name, context.identity ? 'agent' : 'user');
    return result.renamed ? 'ok' : result;
  });

  registry.register({ name: 'get_process_ports', namespace: 'cli.process', description: 'Return port sightings.', inputSchema: { type: 'object', required: ['process_id'] } }, async (args, context) => {
    const input = processIdInput.parse(args);
    const processId = processFor(context, input.process_id);
    if (isIntegratedProcess(services.database, processId)) return { ports: [], unsupported: 'Integrated conversations do not expose a terminal viewport' };
    const out = normalizeOutput(await services.terminal.request('terminal.process.output', { process_id: ptyFor(processId), mode: 'grid' }), 'grid');
    return { ports: extractPorts(out.content) };
  });
  registry.register({
    name: 'send_message',
    namespace: 'cli.coordination',
    description: 'Send a terminal message to another visible process, or to the global assistant.',
    changes: [],
    inputSchema: { type: 'object', required: ['target_process_id', 'message'] },
    usageNotes: [
      'Messages are delivered to the target terminal. Only messages to or from the assistant, and messages to other hosts, are recorded.',
      'Agents on a paired host are addressed as host:process, such as workstation:process_7, as list_processes shows them. A message to another host waits while that host is offline, and is delivered when it reconnects. status says delivered, queued, uncertain, or bounced; a bounce also reaches you as a message.',
      'Child agents may pass target_process_id "parent" to message their parent agent.',
      'Any agent may pass target_process_id "assistant" to message the user\'s global assistant, for example to answer a question it sent you. Messages to the assistant are limited to 8 KB and a few per minute.',
      'Do not message a running child to check its status, hurry it, or ask it to wrap up. Wait for its report instead.',
      'Message a running child only with genuinely new task information or to cancel at the user\'s request.',
      'After a child reports, it stays available. Send follow-ups, fixes to re-check, or re-review requests to that same child rather than spawning a new agent, then wait with timer_fire_when_reported_any. Only reports made after the timer was created count.'
    ]
  }, async (args, context) => {
    const input = messageInput.parse(args);
    const sender = caller(context);
    const remote = remoteAddress(input.target_process_id);
    if (remote) {
      if (!sender || hasWorkspaceScope(sender)) throw new Error('send_message: only agents in a linked project can message agents on other hosts');
      const result = await services.crossHost!.send(sender, remote, input.message);
      return { ok: result.status === 'delivered', ...result };
    }
    return sendMessage.execute(sender, input.target_process_id, input.message, (processId) => scopedProcessId(services.database, sender, processId));
  });
  registry.register({
    name: 'report_to_parent',
    namespace: 'cli.coordination',
    description: 'Report a child agent final result to its parent agent and persist the completion signal.',
    // The report is a timeline event, which no client view shows; report timers
    // announce their own firing.
    changes: [],
    inputSchema: {
      type: 'object',
      required: ['body'],
      properties: {
        body: { type: 'string', description: 'Final result, findings, blocker, or no-findings summary.' },
        status: { type: 'string', enum: ['completed', 'blocked', 'failed', 'no_findings'], description: 'Report outcome.' },
        title: { type: 'string', description: 'Optional short report title.' }
      }
    },
    usageNotes: [
      'Child agents should call this once per delegated request when done, blocked, failed, or when they have no findings. If the parent sends a follow-up, report again when that is done.',
      'Include URLs of any PRs or issues you opened so the parent can attach them to its todos.',
      'Parents should wait for child completion with timer_fire_when_reported_any/all instead of treating terminal idle as completion.',
      'Agents without a parent, such as user-opened or detached agents, cannot report; the call fails without side effects. Reply to the user in your conversation instead, and use notify_user if you need their attention.'
    ]
  }, async (args, context) => {
    const input = reportToParentInput.parse(args);
    const sender = caller(context);
    if (!sender?.process_id) {
      throw new Error('report_to_parent: caller has no process');
    }
    // A routine run reports to the scheduler that started it.
    const routineReport = services.routines?.report(sender.process_id, input);
    if (routineReport) {
      services.notifications?.reported(sender.process_id);
      return routineReport;
    }
    if (!sender.parent_process_id) {
      throw new Error('report_to_parent: you have no parent agent (opened by the user or spawned detached), so nothing was reported. Reply to the user in your conversation instead, or call notify_user if you need their attention.');
    }

    const eventId = services.timeline.append({
      event_type: 'agent.reported',
      project_id: sender.project_id,
      session_id: sender.session_id,
      process_id: sender.process_id,
      actor_type: 'agent',
      actor_id: sender.session_id,
      metadata: {
        parent_process_id: sender.parent_process_id,
        status: input.status,
        title: input.title ?? null,
        body: input.body
      }
    });
    services.notifications?.reported(sender.process_id);
    const heading = [`[report from ${sender.process_id}: ${input.status}]`, input.title?.trim()].filter(Boolean).join('\n');
    // A parent assistant in Focus mode reads the report when focus ends.
    if (services.assistantInbox?.hold(sender.parent_process_id, { kind: 'report', sourceProcessId: sender.process_id, title: `Report from ${sender.process_id}: ${input.status}${input.title?.trim() ? ` — ${input.title.trim()}` : ''}`, body: input.body, dedupeKey: `report:${eventId}` })) {
      return { ok: true, event_id: eventId, delivery: 'queued', detail: 'Your parent assistant is in Focus mode. The report is saved and reaches it when focus ends; do not resend it.' };
    }
    const delivered = await sendAgentInput(services.database, services.terminal, {
      process_id: sender.parent_process_id,
      kind: 'text',
      text: `${heading}\n${input.body}`,
      submit: true
    }, services.integrated);
    const queued = queuedDetail(delivered);
    return queued ? { ok: true, event_id: eventId, delivery: 'queued', detail: queued } : { ok: true, event_id: eventId };
  });
  registry.register({
    name: 'notify_user',
    namespace: 'cli.coordination',
    description: 'Ask the user for attention when you are blocked on a human decision. Root agents reach the user in the app, on the desktop, and on subscribed phones; child agents are routed to their parent agent.',
    inputSchema: { type: 'object', required: ['title'] },
    changes: [],
    usageNotes: [
      'Use only when you need the user: a decision, credentials, approval, or a blocker you cannot resolve. Do not use it for routine progress updates.',
      'The notification belongs to your own process and clears when the user answers you.',
      'Child agents: the request goes to your parent as a message and the result has status routed_to_parent. Report final results with report_to_parent as usual.',
      'Agents without a parent, including detached agents, reach the user directly.',
      'Requests are rate-limited per process. Keep title short and put details in message.'
    ]
  }, async (args, context) => {
    if (!services.notifications) throw new Error('notify_user: notifications are unavailable');
    const current = caller(context);
    if (!current?.process_id) throw new Error('notify_user requires an authenticated agent process');
    const result = await services.notifications.notifyUser(current.process_id, args);
    return 'notification' in result ? { status: result.status, notification_id: result.notification.id } : result;
  });
  const renderFigure = new RenderHtmlFigureAction(services.transcriptImages);
  const figureUnavailable = (tool: string) => (context: McpCallContext): string | null => {
    if (services.settings?.figuresEnabled() === false) return `${tool} is turned off in Patterm settings. Answer in text instead.`;
    // Only Integrated transcripts draw pages. OpenCode's shared helpers
    // carry no identity and serve only Integrated sessions.
    const session = context.identity ? services.database.connection.prepare('select interface_mode from sessions where mcp_identity = ? and exited_at is null').get(context.identity) as { interface_mode: string | null } | undefined : undefined;
    return session && session.interface_mode !== 'integrated' ? `${tool} works only in Integrated mode. Answer in text instead.` : null;
  };
  const html = { type: 'string', description: `A complete, self-contained HTML document, up to ${MAX_FIGURE_HTML_CHARS} characters. Inline <style> and <script>; CDN scripts load. Local images in <img src> or CSS url() must be in your working directory.` };
  registry.register({
    name: HTML_RENDER_TOOL,
    namespace: 'cli.ui',
    // Claude Code cuts tool descriptions at about 2,000 characters, notes included.
    description: 'Show a chart, table, diagram, mockup, or small interactive tool in your reply as an HTML page. It returns ref [patterm_figure:id]; put it on its own line in your reply where the page belongs. Unplaced, it never shows.',
    inputSchema: {
      type: 'object',
      required: ['title', 'html'],
      properties: {
        id: { type: 'string', description: 'Reuse an id to replace that page everywhere it appears.' },
        title: { type: 'string', description: 'Shown above the page; do not repeat it inside.' },
        html,
        height: { type: 'integer', description: `Initial height in px (${FIGURE_HEIGHT.min}-${FIGURE_HEIGHT.max}); the frame then follows the page.` }
      }
    },
    changes: [],
    unavailable: figureUnavailable(HTML_RENDER_TOOL),
    usageNotes: [FIGURE_LAYOUT_GUIDE, FIGURE_THEME_GUIDE, FIGURE_BRIDGE_GUIDE, 'Do not describe or restate what the page shows.']
  }, (args, context) => {
    // Images are read on the caller's own host, never across hosts.
    const current = context.remote ? null : caller(context);
    return renderFigure.execute(args, { cwd: current?.cwd ?? null, project_path: current?.project_path ?? null });
  });
  // Only the desktop app can draw a page off screen, so the server never lists it.
  if (services.pagePreviewer) {
    const previewFigure = new PreviewHtmlFigureAction(services.pagePreviewer, services.transcriptImages);
    registry.register({
      name: HTML_PREVIEW_TOOL,
      namespace: 'cli.ui',
      description: 'Screenshot an HTML page as html_render would show it, with its height and console output, before you render it. The user never sees a preview.',
      inputSchema: {
        type: 'object',
        required: ['html'],
        properties: {
          html,
          width: { type: 'integer', description: `Viewport width in px (${PREVIEW_WIDTH.min}-${PREVIEW_WIDTH.max}, default ${PREVIEW_WIDTH.initial}, the reply column).` }
        }
      },
      changes: [],
      unavailable: figureUnavailable(HTML_PREVIEW_TOOL),
      usageNotes: ['Check a new or changed page once before html_render: fix console errors, overflow, and clipped text. Try width 360 for phones.']
    }, (args, context) => {
      const current = context.remote ? null : caller(context);
      return previewFigure.execute(args, { cwd: current?.cwd ?? null, project_path: current?.project_path ?? null });
    });
  }
  registry.register({
    name: 'request_close',
    namespace: 'cli.coordination',
    description: 'Ask to be closed because your task is fully complete. Root agents wait for the user to allow it; child agents are routed to their parent agent.',
    inputSchema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string', description: 'What you finished and anything left for the user, shown beside the Close button.' } } },
    usageNotes: [
      'Call it only when nothing is left to do: the work is finished, verified, and handed off (for example a PR is opened or merged), and you are not waiting on anything. Do not call it to end a turn or when you have open questions.',
      'Root agents: the user sees the request and chooses Close or Keep open. Keep open may arrive as a message with their reason; otherwise you simply stay open. A new message from the user withdraws the request.',
      'Child agents: the request goes to your parent as a message and the result has status routed_to_parent. Report results with report_to_parent first.'
    ]
  }, async (args, context) => {
    if (!services.closeRequests) throw new Error('request_close: close requests are unavailable');
    const current = caller(context);
    if (!current?.process_id) throw new Error('request_close requires an authenticated agent process');
    return services.closeRequests.request(current.process_id, args);
  });
  registry.register(
    { name: 'close_request_answer', namespace: 'process', description: 'Close an agent that asked to be closed, or keep it open.', hidden: true, inputSchema: { type: 'object', required: ['process_id', 'decision'] } },
    (args, context) => {
      if (!services.closeRequests) throw new Error('close_request_answer: close requests are unavailable');
      const input = closeRequestAnswerInput.parse(args);
      return services.closeRequests.answer({ ...input, process_id: processFor(context, input.process_id) });
    }
  );
  // Snoozing is the user's choice about their own attention, so agents
  // neither see nor call these.
  const snoozesFor = (tool: string) => {
    if (!services.snoozes) throw new Error(`${tool}: snoozing is unavailable`);
    return services.snoozes;
  };
  registry.register(
    { name: 'agent_snooze', namespace: 'process', description: 'Snooze an agent until its next message, with an optional reminder.', hidden: true, inputSchema: { type: 'object', required: ['process_id'] } },
    (args, context) => {
      const input = snoozeInput.parse(args);
      return snoozesFor('agent_snooze').snooze({ ...input, process_id: processFor(context, input.process_id) });
    }
  );
  registry.register(
    { name: 'agent_unsnooze', namespace: 'process', description: 'Wake a snoozed agent and drop its reminder.', hidden: true, inputSchema: { type: 'object', required: ['process_id'] } },
    (args, context) => snoozesFor('agent_unsnooze').unsnooze({ process_id: processFor(context, snoozeTargetInput.parse(args).process_id) })
  );
  registry.register(
    { name: 'agent_snooze_reminder_dismiss', namespace: 'process', description: 'Dismiss the reminder a woken agent shows.', hidden: true, inputSchema: { type: 'object', required: ['process_id'] } },
    (args, context) => snoozesFor('agent_snooze_reminder_dismiss').dismissReminder({ process_id: processFor(context, snoozeTargetInput.parse(args).process_id) })
  );
  registry.register({
    name: 'notification_list',
    namespace: 'notification',
    description: 'List notifications for your project, open ones by default, to check whether a request is still waiting for the user.',
    inputSchema: { type: 'object' },
    changes: [],
    usageNotes: ['Read-only. Agents cannot mark notifications read or resolved; the user does that.']
  }, (args, context) => {
    if (!services.notifications) throw new Error('notification_list: notifications are unavailable');
    const input = notificationListInput.parse(args ?? {});
    const projectId = projectFor(context, input.project_id);
    if (!projectId && hasWorkspaceScope(caller(context))) {
      const { project_id: _omitted, ...rest } = input;
      return services.notifications.list(rest);
    }
    if (!projectId) throw new Error('notification_list: no project is available');
    return services.notifications.list({ ...input, project_id: projectId });
  });
  registry.register({
    name: 'timer_set',
    namespace: 'cli.timer',
    description: 'Schedule a one-shot timer.',
    inputSchema: {
      type: 'object',
      required: ['seconds'],
      properties: {
        seconds: { type: 'number', description: 'Elapsed seconds before the timer fires.' },
        body: { type: 'string', description: 'Optional exact callback message; defaults to a timer notification.' },
        label: { type: 'string', description: 'Optional timer label.' },
        owner_process_id: { type: 'string', description: 'Optional process that should receive the callback body.' }
      }
    },
    usageNotes: [
      'If you set body, include what to inspect next when the timer fires.',
      'Use only when elapsed time is the condition; for delegated-agent completion use timer_fire_when_reported_any/all, and for quietness/readiness checks use timer_fire_when_idle_any/all.'
    ]
  }, (args, context) => {
    const input = timerSetInput.parse(args);
    const owner = input.owner_process_id ? processFor(context, input.owner_process_id) : caller(context)?.process_id;
    const timer = timerService.setDelay({ seconds: input.seconds, ownerProcessId: owner, body: input.body ?? `[system] timer${input.label ? ` ${input.label}` : ''} fired`, label: input.label });
    return { timer_id: timer.id };
  });
  registry.register({
    name: 'timer_fire_when_idle_any',
    namespace: 'cli.timer',
    description: 'Fire when any watched process becomes terminal-idle; use for readiness, quietness, or first-result-wins checks.',
    inputSchema: {
      type: 'object',
      required: ['watched', 'body'],
      properties: {
        watched: { type: 'array', items: { type: 'string' }, description: 'Process IDs to watch.' },
        body: { type: 'string', description: 'Exact message Patterm should send when the timer fires.' },
        max_wait_seconds: { type: 'number', description: 'Optional rescue timeout if no watched process becomes idle; omit it unless you need a true fallback for a stalled readiness or quietness wait.' },
        label: { type: 'string', description: 'Optional timer label.' },
        owner_process_id: { type: 'string', description: 'Optional process that should receive the callback body.' }
      }
    },
    usageNotes: [
      'Use when work can continue as soon as one watched process becomes terminal-quiet or stops running, such as readiness checks or first-result-wins tasks.',
      'For delegated sub-agent completion, prefer timer_fire_when_reported_any/all.',
      'Prefer idle detection callbacks over elapsed timer polling for quietness/readiness; max_wait_seconds is a rescue timeout, not a progress check.',
      'Substantive LLM work, including adversarial reviews, can be quiet for 20+ minutes. Do not use tiny 5-30 second fallbacks; omit max_wait_seconds or use a true rescue value such as 1200+ seconds.',
      'After setting the timer, wait for the callback; do not loop get_process_output while waiting.'
    ]
  }, (args, context) => {
    const input = timerIdleInput.parse(args);
    const owner = input.owner_process_id ? processFor(context, input.owner_process_id) : caller(context)?.process_id;
    const watched = input.watched.map((processId) => watchedFor(context, processId, 'idle'));
    const timer = timerService.setIdle({ kind: 'idle_any', watched, ownerProcessId: owner, body: input.body, maxWaitSeconds: input.max_wait_seconds, label: input.label });
    return { timer_id: timer.id, status: watched.length === 0 ? 'already_satisfied' : 'pending', waiting_on: watched };
  });
  registry.register({
    name: 'timer_fire_when_idle_all',
    namespace: 'cli.timer',
    description: 'Fire when all watched processes become terminal-idle; use for quietness checks, not delegated-agent completion.',
    inputSchema: {
      type: 'object',
      required: ['watched', 'body'],
      properties: {
        watched: { type: 'array', items: { type: 'string' }, description: 'Process IDs to watch.' },
        body: { type: 'string', description: 'Exact message Patterm should send when the timer fires.' },
        max_wait_seconds: { type: 'number', description: 'Optional rescue timeout if watched processes do not all become idle; omit it unless you need a true fallback for a stalled quietness wait.' },
        label: { type: 'string', description: 'Optional timer label.' },
        owner_process_id: { type: 'string', description: 'Optional process that should receive the callback body.' }
      }
    },
    usageNotes: [
      'Use when work should resume after every watched process becomes terminal-quiet or stops running.',
      'For delegated sub-agent completion, prefer timer_fire_when_reported_all.',
      'Prefer idle detection callbacks over elapsed timer polling for quietness/readiness; max_wait_seconds is a rescue timeout, not a progress check.',
      'Substantive LLM work, including adversarial reviews, can be quiet for 20+ minutes. Do not use tiny 5-30 second fallbacks; omit max_wait_seconds or use a true rescue value such as 1200+ seconds.',
      'After setting the timer, wait for the callback; do not loop get_process_output while waiting.'
    ]
  }, (args, context) => {
    const input = timerIdleInput.parse(args);
    const owner = input.owner_process_id ? processFor(context, input.owner_process_id) : caller(context)?.process_id;
    const watched = input.watched.map((processId) => watchedFor(context, processId, 'idle'));
    const timer = timerService.setIdle({ kind: 'idle_all', watched, ownerProcessId: owner, body: input.body, maxWaitSeconds: input.max_wait_seconds, label: input.label });
    return { timer_id: timer.id, status: watched.length === 0 ? 'already_satisfied' : 'pending', waiting_on: watched };
  });
  registry.register({
    name: 'timer_fire_when_reported_any',
    namespace: 'cli.timer',
    description: 'Fire when any watched agent reports or stops running; for the assistant, also when one messages it.',
    inputSchema: {
      type: 'object',
      required: ['watched', 'body'],
      properties: {
        watched: { type: 'array', items: { type: 'string' }, description: 'Process IDs to watch.' },
        body: { type: 'string', description: 'Exact message Patterm should send when the timer fires.' },
        max_wait_seconds: { type: 'number', description: 'Optional rescue timeout if no watched process reports; omit it for normal delegated work or use a true long-running rescue value.' },
        label: { type: 'string', description: 'Optional timer label.' },
        owner_process_id: { type: 'string', description: 'Optional process that should receive the callback body.' }
      }
    },
    usageNotes: [
      'Use after spawning delegated agents when work can continue after the first child calls report_to_parent.',
      'A watched process that exits or stops without reporting also wakes the timer. For the assistant\'s timers, a watched agent\'s send_message to the assistant does too. The callback says which.',
      'LLM-heavy reviews and investigations can be quiet for 20+ minutes. max_wait_seconds is a rescue timeout, not a polling interval; omit it or use a true rescue value such as 1200+ seconds.',
      'After setting the timer, wait for its callback. Do not nudge watched children for status or ask them to wrap up.'
    ]
  }, (args, context) => {
    const input = timerReportInput.parse(args);
    const owner = input.owner_process_id ? processFor(context, input.owner_process_id) : caller(context)?.process_id;
    const watched = input.watched.map((processId) => watchedFor(context, processId, 'report'));
    const timer = timerService.setReport({ kind: 'report_any', watched, ownerProcessId: owner, body: input.body, maxWaitSeconds: input.max_wait_seconds, label: input.label });
    return { timer_id: timer.id, status: watched.length === 0 ? 'already_satisfied' : 'pending', waiting_on: watched };
  });
  registry.register({
    name: 'timer_fire_when_reported_all',
    namespace: 'cli.timer',
    description: 'Fire when every watched agent has reported or stopped running; for the assistant, also when one has messaged it.',
    inputSchema: {
      type: 'object',
      required: ['watched', 'body'],
      properties: {
        watched: { type: 'array', items: { type: 'string' }, description: 'Process IDs to watch.' },
        body: { type: 'string', description: 'Exact message Patterm should send when the timer fires.' },
        max_wait_seconds: { type: 'number', description: 'Optional rescue timeout if watched processes do not all report; omit it for normal delegated work or use a true long-running rescue value.' },
        label: { type: 'string', description: 'Optional timer label.' },
        owner_process_id: { type: 'string', description: 'Optional process that should receive the callback body.' }
      }
    },
    usageNotes: [
      'Use after delegating work to sub-agents when work should resume only after every child calls report_to_parent.',
      'A watched process that exits or stops without reporting also wakes the timer. For the assistant\'s timers, a watched agent\'s send_message to the assistant does too. The callback says which.',
      'LLM-heavy reviews and investigations can be quiet for 20+ minutes. max_wait_seconds is a rescue timeout, not a polling interval; omit it or use a true rescue value such as 1200+ seconds.',
      'After setting the timer, wait for its callback. An early report does not justify nudging the remaining children or asking them to wrap up.'
    ]
  }, (args, context) => {
    const input = timerReportInput.parse(args);
    const owner = input.owner_process_id ? processFor(context, input.owner_process_id) : caller(context)?.process_id;
    const watched = input.watched.map((processId) => watchedFor(context, processId, 'report'));
    const timer = timerService.setReport({ kind: 'report_all', watched, ownerProcessId: owner, body: input.body, maxWaitSeconds: input.max_wait_seconds, label: input.label });
    return { timer_id: timer.id, status: watched.length === 0 ? 'already_satisfied' : 'pending', waiting_on: watched };
  });
  registry.register({ name: 'timer_cancel', namespace: 'cli.timer', description: 'Cancel a timer.', inputSchema: { type: 'object', required: ['timer_id'] } }, (args) => timerService.cancel(timerIdInput.parse(args).timer_id));
  registry.register({ name: 'timer_pause', namespace: 'cli.timer', description: 'Pause a timer.', inputSchema: { type: 'object', required: ['timer_id'] } }, (args) => timerService.pause(timerIdInput.parse(args).timer_id));
  registry.register({ name: 'timer_resume', namespace: 'cli.timer', description: 'Resume a timer.', inputSchema: { type: 'object', required: ['timer_id'] } }, (args) => timerService.resume(timerIdInput.parse(args).timer_id));
  registry.register({ name: 'timer_list', namespace: 'cli.timer', description: 'List timers.', inputSchema: { type: 'object' } }, () => timerService.listMcp());
  registry.register(
    {
      name: 'whoami',
      namespace: 'cli.meta',
      description: 'Return caller identity, role, parent, and project metadata.',
      inputSchema: { type: 'object' },
      usageNotes: ['Child agents are reported as sub-agent with their parent_process_id. They can spawn their own children for parts of their delegated task.']
    },
    (_args, context) => whoami(services.database, context.identity ?? null, Boolean(asRecord(_args).include_tools), registry)
  );

  registry.register(
    {
      name: 'help',
      namespace: 'meta',
      description: 'Return the schema and usage notes for one tool.',
      inputSchema: { type: 'object', required: ['tool'] },
      usageNotes: ['Use when a tool needs detailed guidance, such as revision guards or lease renewal.']
    },
    (args) => registry.helpPublic(helpInput.parse(args).tool)
  );

  const searchConversationHistory = (args: unknown, context: McpCallContext) => {
    const current = caller(context);
    if (!current) throw new Error('conversation history search requires an active MCP caller identity');
    const input = conversationHistoryToolInput.parse(args);
    const search = { ...input, project_id: current.project_id };
    return services.historySearch ? services.historySearch.search(search) : requireHistoryRead(services).search(search);
  };

  registry.register(
    {
      name: 'search_conversation_history',
      namespace: 'cli.history',
      description: 'Search prior imported conversations in the current project. Pass a returned conversation_id to spawn_agent to continue that exact conversation.',
      inputSchema: { type: 'object', required: ['query'] },
      usageNotes: [
        'Results are restricted to the active caller project and exclude unlinked conversations.',
        'For a message result, call history_get with conversation_id and anchor_message_id. For a conversation result, pass conversation_id only.',
        'Call spawn_agent with conversation_id to resume the provider conversation with its original context.',
        'When the owner has turned on semantic search on this host, results also include messages related in meaning, marked match: "semantic". A plain-language description of what you are looking for works as well as exact words.'
      ]
    },
    searchConversationHistory
  );

  registry.register(
    {
      name: 'search',
      namespace: 'search',
      description: 'Search session, timeline, and agent-history records. Raw PTY logs are not indexed.',
      inputSchema: { type: 'object', required: ['query'] }
    },
    (args, context) => {
      const input = searchArtifactsInput.parse(args);
      const current = caller(context);
      const projectId = current ? projectFor(context, input.project_id) : input.project_id;
      return services.actions.searchArtifacts.execute({ ...input, ...(projectId ? { project_id: projectId } : {}) });
    }
  );

  registry.register(
    {
      name: 'history_sources',
      namespace: 'history',
      hidden: true,
      description: 'List configured and default Claude, Codex, and OpenCode conversation-history sources.',
      inputSchema: { type: 'object' }
    },
    () => requireHistorySource(services).sources()
  );

  registry.register(
    {
      name: 'history_configure',
      namespace: 'history',
      hidden: true,
      description: 'Enable or disable a local provider conversation-history source and watcher.',
      inputSchema: { type: 'object', required: ['provider', 'path'] },
      changes: []
    },
    (args) => {
      const result = requireHistorySource(services).configure(historyConfigureInput.parse(args));
      services.historyWatcher?.restart();
      return result;
    }
  );

  registry.register(
    {
      name: 'history_import',
      namespace: 'history',
      hidden: true,
      description: 'Import structured Claude, Codex, or OpenCode conversation history from enabled sources or a manual path.',
      inputSchema: { type: 'object' },
      changes: []
    },
    (args, context) => {
      const input = historyImportInput.parse(args);
      const current = caller(context);
      const projectId = current ? projectFor(context, input.project_id ?? undefined) : input.project_id;
      return requireHistoryImportQueue(services).import({ ...input, ...(projectId ? { project_id: projectId } : {}) });
    }
  );

  registry.register(
    {
      name: 'history_import_status',
      namespace: 'history',
      hidden: true,
      description: 'Return recent conversation-history import batches and skipped/error files.',
      inputSchema: { type: 'object' }
    },
    (args) => {
      const queue = requireHistoryImportQueue(services).status();
      const activeBatchIds = [queue.running?.progress?.batchId].filter((id): id is string => Boolean(id));
      const includeWatcher = Boolean(args && typeof args === 'object' && !Array.isArray(args) && (args as { include_watcher?: unknown }).include_watcher === true);
      return { ...requireHistoryRead(services).importStatus(20, activeBatchIds), queue, ...(includeWatcher ? { watcher: services.historyWatcher?.status() ?? null } : {}) };
    }
  );

  registry.register(
    {
      name: 'history_list',
      namespace: 'history',
      description: 'List imported conversations, optionally scoped by project, provider, or session.',
      inputSchema: { type: 'object' }
    },
    (args, context) => {
      const input = historyListInput.parse(args);
      const current = caller(context);
      const projectId = current ? projectFor(context, input.project_id) : input.project_id;
      const sessions = input.resumable ? conversationSessionStates(services.database, projectId) : [];
      return requireHistoryRead(services).list({ ...input, ...(projectId ? { project_id: projectId } : {}) }, sessions);
    }
  );

  registry.register(
    {
      name: 'history_search',
      namespace: 'history',
      hidden: true,
      description: 'Search imported conversations in a project, one ranked result per conversation.',
      inputSchema: { type: 'object', required: ['query'] },
      changes: []
    },
    (args, context) => {
      const input = conversationSearchInput.omit({ project_id: true }).extend({ project_id: z.string().min(1).optional() }).parse(args);
      const projectId = projectFor(context, input.project_id);
      if (!projectId) throw new Error('no project is available');
      const sessions = input.resumable ? conversationSessionStates(services.database, projectId) : [];
      const search = { ...input, project_id: projectId };
      return services.historySearch ? services.historySearch.searchConversations(search, sessions) : requireHistoryRead(services).searchConversations(search, sessions);
    }
  );

  registry.register(
    {
      name: 'history_get',
      namespace: 'history',
      description: 'Get one imported conversation with a paginated message window.',
      inputSchema: { type: 'object', required: ['conversation_id'] },
      usageNotes: ['Pages from the oldest message. To read an agent\'s latest messages, or page back from them, use get_conversation_output.']
    },
    (args, context) => {
      const input = historyGetInput.parse(args);
      assertConversationAccess(services, context, input.conversation_id);
      return requireHistoryRead(services).get(input);
    }
  );

  registry.register(
    { name: 'media_list', namespace: 'media', hidden: true, changes: [], description: 'List images pasted into or viewed in a project\'s imported conversations, optionally for one session.', inputSchema: { type: 'object', required: ['project_id'] } },
    (args, context) => {
      const input = mediaListInput.parse(args);
      const projectId = projectFor(context, input.project_id);
      if (!projectId || !services.historyMedia) return { items: [], total: 0 };
      const session = input.session_id
        ? services.database.connection.prepare(`select harness as provider, resume_id as resumeId from sessions where id = ? and project_id = ?`).get(input.session_id, projectId) as { provider: string | null; resumeId: string | null } | undefined
        : undefined;
      return services.historyMedia.list({ ...input, project_id: projectId }, session);
    }
  );

  registry.register(
    { name: 'media_get', namespace: 'media', hidden: true, changes: [], description: 'Read one indexed conversation image by its hash.', inputSchema: { type: 'object', required: ['project_id', 'sha256'] } },
    (args, context) => {
      const input = mediaGetInput.parse(args);
      const projectId = projectFor(context, input.project_id);
      if (!projectId || !services.historyMedia) throw new Error('This image is no longer stored');
      return services.historyMedia.read({ ...input, project_id: projectId });
    }
  );

  registry.register(
    {
      name: 'history_resume',
      namespace: 'history',
      hidden: true,
      description: 'Resume an imported conversation as a new top-level agent session, replacing an empty Integrated session when given.',
      inputSchema: { type: 'object', required: ['conversation_id'] }
    },
    (args, context) => {
      if (caller(context)) throw new Error('history_resume is for the user; agents resume with spawn_agent and conversation_id');
      if (!resumeConversationAgent) throw new Error('conversation history is not available');
      const input = historyResumeInput.parse(args);
      const projectId = projectFor(context, input.project_id);
      if (!projectId) throw new Error('no project is available');
      return resumeConversationAgent.execute({
        conversation_id: input.conversation_id,
        project_id: projectId,
        interface_mode: input.interface_mode,
        ...(input.replace_process_id ? { replace_process_id: processFor(context, input.replace_process_id) } : {})
      });
    }
  );

  registry.register(
    {
      name: 'integrated_new',
      namespace: 'integrated',
      hidden: true,
      description: 'Start a new top-level conversation with the same harness, model, and working directory as an Integrated agent, replacing it when it is idle.',
      inputSchema: { type: 'object', required: ['process_id'] }
    },
    (args, context) => {
      if (caller(context)) throw new Error('integrated_new is for the user; agents start sessions with spawn_agent');
      const input = newAgentSessionInput.parse(args);
      const projectId = projectFor(context, input.project_id);
      if (!projectId) throw new Error('no project is available');
      return newAgentSession.execute({ process_id: processFor(context, input.process_id), project_id: projectId });
    }
  );

  registry.register(
    {
      name: 'integrated_restart',
      namespace: 'integrated',
      hidden: true,
      description: 'Stop a top-level Integrated agent and resume its conversation in a new process, keeping its session context, subagents, and timers.',
      inputSchema: { type: 'object', required: ['process_id'] }
    },
    (args, context) => {
      if (caller(context)) throw new Error('integrated_restart is for the user');
      const input = restartAgentSessionInput.parse(args);
      const projectId = projectFor(context, input.project_id);
      if (!projectId) throw new Error('no project is available');
      return restartAgentSession.execute({ process_id: processFor(context, input.process_id), project_id: projectId, force: input.force === true });
    }
  );
  registry.register(
    {
      name: 'integrated_restart_all',
      namespace: 'integrated',
      hidden: true,
      description: 'Restart every idle top-level Integrated agent across all projects, resuming each conversation in a new process.',
      inputSchema: { type: 'object' }
    },
    (_args, context) => {
      if (caller(context) || context.remote) throw new Error('integrated_restart_all is for the user');
      return restartAgentSession.executeAll();
    }
  );

  registry.register(
    {
      name: 'history_delete',
      namespace: 'history',
      hidden: true,
      description: 'Delete local Patterm conversation-history records without touching provider files.',
      inputSchema: { type: 'object', required: ['conversation_id'] }
    },
    (args, context) => {
      const conversationId = conversationDeleteInput.parse(args).conversation_id;
      assertConversationAccess(services, context, conversationId);
      return requireHistoryImportQueue(services).deleteConversation(conversationId);
    }
  );

  registry.register(
    {
      name: 'history_reset_imports',
      namespace: 'history',
      hidden: true,
      description: 'Clear local imported conversation-history records and optionally reimport enabled sources. Provider source files are not touched.',
      inputSchema: { type: 'object' },
      changes: []
    },
    (args) => {
      const input = historyResetInput.parse(args);
      return requireHistoryImportQueue(services).resetImports({ trigger: 'manual' }, input.reimport);
    }
  );

  registry.register(
    {
      name: 'project_list',
      namespace: 'project',
      hidden: true,
      description: 'List known projects.',
      inputSchema: { type: 'object' }
    },
    (_args, context) => {
      const current = caller(context);
      return { projects: current ? services.workbench.listProjects().filter((project) => project.id === current.project_id) : services.workbench.listProjects() };
    }
  );

  registry.register(
    {
      name: 'project_create',
      namespace: 'project',
      hidden: true,
      description: 'Register a local project rooted at a filesystem path (idempotent by path).',
      inputSchema: { type: 'object', required: ['path'] }
    },
    (args) => services.actions.createProject.execute(createProjectInput.parse(args))
  );

  registry.register(
    {
      name: 'fs_directories',
      namespace: 'project',
      hidden: true,
      changes: [],
      description: 'List the subdirectories of a server directory for the project path picker.',
      inputSchema: { type: 'object' }
    },
    (args) => services.actions.listDirectories.execute(listDirectoriesInput.parse(args))
  );

  registry.register(
    {
      name: 'project_logo_candidates',
      namespace: 'project',
      hidden: true,
      changes: [],
      description: 'List image files in a project that look like its logo.',
      inputSchema: { type: 'object', required: ['project_id'] }
    },
    (args, context) => services.actions.projectLogo.candidates(projectFor(context, projectLogoCandidatesInput.parse(args).project_id) ?? '')
  );

  registry.register(
    {
      name: 'project_set_logo',
      namespace: 'project',
      hidden: true,
      changes: ['workbench'],
      description: 'Set or clear a project logo (a small PNG, JPEG, or WebP data URL).',
      inputSchema: { type: 'object', required: ['project_id', 'logo'] }
    },
    (args, context) => {
      const input = setProjectLogoInput.parse(args);
      return services.actions.projectLogo.set({ ...input, project_id: projectFor(context, input.project_id) ?? '' });
    }
  );

  // Snoozing a project is the user's choice about their own attention.
  const projectSnoozesFor = (tool: string) => {
    if (!services.projectSnoozes) throw new Error(`${tool}: project snoozing is unavailable`);
    return services.projectSnoozes;
  };
  registry.register(
    { name: 'project_snooze', namespace: 'project', hidden: true, changes: ['workbench'], description: 'Snooze a project until a time, holding its notifications.', inputSchema: { type: 'object', required: ['project_id', 'until'] } },
    (args, context) => {
      const input = projectSnoozeInput.parse(args);
      return projectSnoozesFor('project_snooze').snooze({ ...input, project_id: projectFor(context, input.project_id) ?? '' });
    }
  );
  registry.register(
    { name: 'project_wake', namespace: 'project', hidden: true, changes: ['workbench'], description: 'Wake a snoozed project and summarise its held notifications.', inputSchema: { type: 'object', required: ['project_id'] } },
    (args, context) => projectSnoozesFor('project_wake').wake({ project_id: projectFor(context, projectWakeInput.parse(args).project_id) ?? '' })
  );

  registry.register(
    {
      name: 'project_get',
      namespace: 'project',
      hidden: true,
      description: 'Get a single project by id.',
      inputSchema: { type: 'object', required: ['project_id'] }
    },
    (args, context) => ({ project: services.workbench.getProject(projectFor(context, projectIdInput.parse(args).project_id) ?? '') })
  );


















  registry.register(
    {
      name: 'terminal_process_spawn',
      namespace: 'terminal.process',
      description: 'Spawn a PTY-backed agent, command, or terminal process.',
      hidden: true,
      inputSchema: { type: 'object' }
    },
    (args) => {
      const input = terminalProcessSpawn.parse(args);
      const [command, ...rest] = input.argv;
      // The sidecar reads command/args/env; translate argv into that contract.
      return services.terminal.request('terminal.process.spawn', {
        name: input.name,
        env: input.env,
        ...(command ? { command, args: rest } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {})
      });
    }
  );

  registry.register(
    {
      name: 'terminal_process_input',
      namespace: 'terminal.process',
      description: 'Send text, paste, or a named key to a PTY-backed process.',
      hidden: true,
      inputSchema: { type: 'object', required: ['process_id', 'kind'] }
    },
    (args, context) => {
      const input = terminalProcessInput.parse(args);
      const processId = processFor(context, input.process_id);
      if (input.kind === 'key') {
        return services.terminal.request('terminal.process.input', withResolvedPtyProcessId(services.database, { ...input, process_id: processId }));
      }
      return sendAgentInput(services.database, services.terminal, {
        process_id: processId,
        kind: input.kind === 'paste' ? 'paste' : 'text',
        text: input.text ?? '',
        submit: input.submit
      }, services.integrated);
    }
  );

  registry.register(
    {
      name: 'terminal_process_output',
      namespace: 'terminal.process',
      description: 'Read rendered grid or stream output from a PTY-backed process.',
      hidden: true,
      inputSchema: { type: 'object', required: ['process_id'] }
    },
    (args, context) => {
      const input = terminalProcessOutput.parse(args);
      return services.terminal.request('terminal.process.output', withResolvedPtyProcessId(services.database, { ...input, process_id: processFor(context, input.process_id) }));
    }
  );

  registry.register(
    {
      name: 'terminal_process_search',
      namespace: 'terminal.process',
      description: 'Search the rendered terminal grid for text.',
      hidden: true,
      inputSchema: { type: 'object', required: ['process_id', 'query'] }
    },
    (args, context) => {
      const input = terminalProcessSearch.parse(args);
      return services.terminal.request('terminal.process.search', withResolvedPtyProcessId(services.database, { ...input, process_id: processFor(context, input.process_id) }));
    }
  );

  registry.register(
    {
      name: 'terminal_process_select',
      namespace: 'terminal.process',
      hidden: true,
      description: 'Set or clear a terminal cell selection.',
      inputSchema: { type: 'object', required: ['process_id'] }
    },
    (args, context) => {
      const input = terminalProcessSelect.parse(args);
      return services.terminal.request('terminal.process.select', withResolvedPtyProcessId(services.database, { ...input, process_id: processFor(context, input.process_id) }));
    }
  );

  registry.register(
    {
      name: 'terminal_process_selection_text',
      namespace: 'terminal.process',
      hidden: true,
      description: 'Return text from the current terminal selection.',
      inputSchema: { type: 'object', required: ['process_id'] }
    },
    (args, context) => {
      const input = terminalProcessOutput.pick({ process_id: true }).parse(args);
      return services.terminal.request('terminal.process.selection_text', withResolvedPtyProcessId(services.database, { ...input, process_id: processFor(context, input.process_id) }));
    }
  );

  registry.register(
    {
      name: 'terminal_process_scroll',
      namespace: 'terminal.process',
      hidden: true,
      description: 'Scroll the active terminal process by line count.',
      inputSchema: { type: 'object', required: ['process_id', 'lines'] }
    },
    (args, context) => {
      const input = terminalProcessScroll.parse(args);
      return services.terminal.request('terminal.process.scroll', withResolvedPtyProcessId(services.database, { ...input, process_id: processFor(context, input.process_id) }));
    }
  );

  registry.register(
    {
      name: 'harness_list',
      namespace: 'harness',
      description: 'List discovered agent-harness installations (claude, codex, opencode, rawpty) with status and version.',
      inputSchema: { type: 'object' }
    },
    () => ({ harnesses: services.workbench.listHarnesses() })
  );

  registry.register(
    {
      name: 'harness_discover',
      namespace: 'harness',
      hidden: true,
      description: 'Re-scan PATH for installed harness CLIs and refresh the harness_installations table.',
      inputSchema: { type: 'object' }
    },
    () => services.actions.discoverHarnesses.execute()
  );

  registry.register(
    {
      name: 'opencode_service_restart',
      namespace: 'harness',
      hidden: true,
      description: 'Restart OpenCode\'s shared background server with the installed CLI. Interrupts every running OpenCode turn, including sessions outside Patterm.',
      inputSchema: { type: 'object' }
    },
    () => services.actions.restartOpenCodeService.execute()
  );

  registry.register(
    {
      name: 'harness_launch',
      namespace: 'harness',
      description: 'Launch an installed harness with the Patterm MCP server injected and register the session. Pass preset (by name or id) or model/reasoning to choose the model; without them the harness default preset applies.',
      hidden: true,
      inputSchema: { type: 'object', required: ['project_id'] }
    },
    (args, context) => {
      const input = launchHarnessInput.parse(args);
      const current = caller(context);
      return services.harnessLauncher.launch({
        ...input,
        project_id: projectFor(context, input.project_id) ?? input.project_id,
        worktree_id: scopedNullableWorktreeId(services.database, current, input.worktree_id)
      });
    }
  );

  const requireHarnessPresets = (): HarnessPresetService => {
    if (!services.harnessPresets) throw new Error('harness presets are unavailable');
    return services.harnessPresets;
  };
  const requireModelCatalog = (): HarnessModelCatalogService => {
    if (!services.modelCatalog) throw new Error('harness model discovery is unavailable');
    return services.modelCatalog;
  };

  registry.register(
    {
      name: 'harness_presets',
      namespace: 'harness',
      description: 'List configured model presets per harness (name, model, reasoning, Codex service tier, which one is the default). Use a preset name with spawn_agent.',
      inputSchema: { type: 'object' }
    },
    () => requireHarnessPresets().describe()
  );

  registry.register(
    {
      name: 'harness_preset_create',
      namespace: 'harness',
      hidden: true,
      changes: ['settings'],
      description: 'Create a model preset for a harness. Names are unique per harness and case-insensitive. Omit model (or pass null) to keep the harness\'s own configured model.',
      inputSchema: { type: 'object', required: ['harness', 'name'] }
    },
    (args) => {
      requireHarnessPresets().create(args);
      return requireHarnessPresets().describe();
    }
  );

  registry.register(
    {
      name: 'harness_preset_update',
      namespace: 'harness',
      hidden: true,
      changes: ['settings'],
      description: 'Update a preset by name or id. Set default=true to make it the harness default, false to clear that default.',
      inputSchema: { type: 'object', required: ['ref'] }
    },
    (args) => {
      requireHarnessPresets().update(args);
      return requireHarnessPresets().describe();
    }
  );

  registry.register(
    {
      name: 'harness_preset_delete',
      namespace: 'harness',
      hidden: true,
      changes: ['settings'],
      description: 'Delete a preset by name or id. If it was the harness default, the next preset becomes the default.',
      inputSchema: { type: 'object', required: ['ref'] }
    },
    (args) => {
      requireHarnessPresets().remove(args);
      return requireHarnessPresets().describe();
    }
  );

  registry.register(
    {
      name: 'harness_models',
      namespace: 'harness',
      description: 'List the cached model catalog per harness, including reasoning levels, Codex service tiers, and the last refresh error.',
      inputSchema: { type: 'object' }
    },
    () => requireModelCatalog().read()
  );

  registry.register(
    {
      name: 'harness_models_refresh',
      namespace: 'harness',
      hidden: true,
      description: 'Re-discover models from the installed harness CLIs and update the cache.',
      inputSchema: { type: 'object' }
    },
    () => requireModelCatalog().refresh()
  );

  registry.register(
    {
      name: 'process_create',
      namespace: 'process',
      description: 'Spawn a long-running process: a shell, or a freeform command (shell-wrapped), optionally relaunch-on-exit.',
      hidden: true,
      inputSchema: { type: 'object', required: ['project_id'] }
    },
    (args, context) => {
      const input = processCreateInput.parse(args);
      const current = caller(context);
      return services.processLauncher.create({
        ...input,
        project_id: projectFor(context, input.project_id) ?? input.project_id,
        worktree_id: scopedNullableWorktreeId(services.database, current, input.worktree_id)
      });
    }
  );

  registry.register(
    {
      name: 'process_restart',
      namespace: 'process',
      description: 'Re-attach a fresh PTY to an exited process, reusing its command.',
      hidden: true,
      inputSchema: { type: 'object', required: ['process_id'] }
    },
    (args, context) => services.processLauncher.relaunch(processFor(context, processRestartInput.parse(args).process_id))
  );

  registry.register(
    {
      name: 'process_update',
      namespace: 'process',
      description: 'Update a persistent process launch configuration.',
      hidden: true,
      inputSchema: { type: 'object', required: ['process_id', 'name'] }
    },
    (args, context) => {
      const input = processUpdateInput.parse(args);
      return services.processLauncher.update({ ...input, process_id: processFor(context, input.process_id) });
    }
  );

  registry.register(
    {
      name: 'worktree_create',
      namespace: 'worktree',
      description: 'Create a project-owned git worktree with a branch derived from its name. When an agent calls it, the worktree is also linked to the agent\'s session.',
      inputSchema: { type: 'object', required: ['project_id', 'name'] },
      usageNotes: [AGENT_WORKTREE_LINK_NOTE]
    },
    (args, context) => {
      const input = createWorktreeInput.parse(args);
      return services.actions.createWorktree.execute({ ...input, project_id: projectFor(context, input.project_id) ?? input.project_id }, agentFor(context));
    }
  );

  registry.register(
    {
      name: 'worktree_link',
      namespace: 'worktree',
      description: 'Register an existing git worktree directory with a project. A directory the project already registers returns that registration. When an agent calls it, the worktree is also linked to the agent\'s session.',
      inputSchema: { type: 'object', required: ['project_id', 'worktree_path'] },
      usageNotes: [AGENT_WORKTREE_LINK_NOTE]
    },
    (args, context) => {
      const input = linkWorktreeInput.parse(args);
      return services.actions.linkWorktree.execute({ ...input, project_id: projectFor(context, input.project_id) ?? input.project_id }, agentFor(context));
    }
  );

  registry.register(
    {
      name: 'worktree_list',
      namespace: 'worktree',
      description: 'List worktrees linked to a project.',
      inputSchema: { type: 'object' }
    },
    (args, context) => {
      const input = listWorktreesInput.parse(args);
      const current = caller(context);
      const projectId = current ? projectFor(context, input.project_id) : input.project_id;
      return services.actions.listWorktrees.execute({
        ...input,
        ...(projectId ? { project_id: projectId } : {})
      });
    }
  );

  registry.register(
    {
      name: 'worktree_abandon',
      namespace: 'worktree',
      description: 'Remove a worktree registration from the project and from every session it is linked to, while preserving its directory and branch.',
      inputSchema: { type: 'object', required: ['worktree_id'] }
    },
    (args, context) => {
      const input = abandonWorktreeInput.parse(args);
      return services.actions.abandonWorktree.execute({ ...input, worktree_id: worktreeFor(context, input.worktree_id) });
    }
  );

  registry.register(
    {
      name: 'diff_current',
      namespace: 'diff',
      description: 'Summarise the changes in a worktree without patch text. By default this is everything on its branch since it split from the default branch: committed, staged, unstaged, and untracked files. scope "uncommitted" compares with HEAD instead.',
      inputSchema: { type: 'object' },
      usageNotes: [
        'Agents may omit worktree_id to use their session\'s own worktree, else the first worktree linked to it. Owner requests require worktree_id.',
        'The split point is the merge base with the default branch (origin/HEAD\'s branch, else main, else master), using whichever of the local or origin branch is nearer HEAD. base.ref is "HEAD" when no default branch exists, and null before the first commit.',
        'Each file has status, additions, deletions, and binary, untracked, docs, and tests flags; files are sorted by path. Up to 500 untracked files are listed, and truncated is true when there are more.',
        'Read one file\'s old and new contents with diff_file.'
      ]
    },
    (args, context) => {
      const input = getCurrentDiffInput.parse(args);
      return services.actions.getCurrentDiff.execute(
        { ...input, ...(input.worktree_id ? { worktree_id: worktreeFor(context, input.worktree_id) } : {}) },
        caller(context)?.session_id ?? null
      );
    }
  );

  registry.register(
    {
      name: 'diff_file',
      namespace: 'diff',
      description: 'Return the old and new contents of one file from diff_current, compared with the same base.',
      inputSchema: { type: 'object', required: ['path'] },
      usageNotes: [
        'path is the repository-relative path that diff_current reports. Absolute paths, ".." segments, and files without changes are rejected.',
        'oldContents is null for added files and newContents is null for deleted files. A symlink\'s contents are its target.',
        'Binary files and files over 1 MiB return binary or tooLarge with null contents.',
        'Agents may omit worktree_id, as with diff_current.'
      ]
    },
    (args, context) => {
      const input = getDiffFileInput.parse(args);
      return services.actions.getDiffFile.execute(
        { ...input, ...(input.worktree_id ? { worktree_id: worktreeFor(context, input.worktree_id) } : {}) },
        caller(context)?.session_id ?? null
      );
    }
  );

  const publicInputs: Record<string, z.ZodTypeAny> = {
    spawn_agent: spawnAgentInput,
    spawn_process: spawnProcessInput,
    list_processes: listProcessesInput,
    get_process_status: processIdInput,
    get_process_output: cliProcessOutputInput,
    get_conversation_output: conversationOutputInput,
    search_output: searchOutputInput,
    wait_for_pattern: waitForPatternInput,
    send_input: sendInputInput,
    restart_process: processRestartInput,
    stop_process: processIdInput,
    close_process: processIdInput,
    'session_rename': renameSessionInput,
    rename_process: renameProcessInput,
    get_process_ports: processIdInput,
    send_message: messageInput,
    report_to_parent: reportToParentInput,
    notify_user: notifyUserInput,
    request_close: requestCloseInput,
    'notification_list': notificationListInput,
    timer_set: timerSetInput,
    timer_fire_when_idle_any: timerIdleInput,
    timer_fire_when_idle_all: timerIdleInput,
    timer_fire_when_reported_any: timerReportInput,
    timer_fire_when_reported_all: timerReportInput,
    timer_cancel: timerIdInput,
    timer_pause: timerIdInput,
    timer_resume: timerIdInput,
    whoami: z.object({ include_tools: z.boolean().optional() }),
    'help': helpInput,
    search_conversation_history: conversationHistoryToolInput,
    'search': searchArtifactsInput,
    'history_list': historyListInput,
    'history_get': historyGetInput,
    'worktree_create': createWorktreeInput,
    'worktree_link': linkWorktreeInput,
    'worktree_list': listWorktreesInput,
    'worktree_abandon': abandonWorktreeInput,
    'diff_current': getCurrentDiffInput,
    'diff_file': getDiffFileInput
  };
  for (const [name, schema] of Object.entries(publicInputs)) {
    const inputSchema = jsonSchema(schema, { $refStrategy: 'none' });
    if (name === 'spawn_agent') {
      inputSchema.anyOf = [{ required: ['agent'] }, { required: ['preset'] }, { required: ['conversation_id'] }];
    }
    if (name.startsWith('timer_fire_when_')) inputSchema.required = ['watched', 'body'];
    registry.setInputSchema(name, inputSchema);
  }
  for (const tool of registry.publicTools()) {
    const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
    const required = tool.inputSchema.required as string[] | undefined;
    if (required?.some((field) => !properties || !(field in properties))) {
      throw new Error(`MCP tool ${tool.name} declares a required field without a schema`);
    }
  }

  if (services.sandboxes) {
    registerSandboxTools(registry, services.sandboxes, {
      cwdFor: (context) => { try { return caller(context)?.cwd ?? null; } catch { return null; } },
      launchingSandbox: (identity) => services.launchingIdentities?.sandbox?.(identity) ?? null
    });
  }
  return registry;
}

function asRecord(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }

  return {};
}

// Roles and close times of a project's sessions, for the /resume picker.
function conversationSessionStates(database: DatabaseService, projectId: string | null | undefined): ConversationSessionState[] {
  if (!projectId) return [];
  return database.connection
    .prepare(`select id, session_role as role, exited_at as exitedAt from sessions where project_id = ?`)
    .all(projectId) as unknown as ConversationSessionState[];
}

interface CallerRow {
  session_id: string;
  project_id: string;
  process_id: string | null;
  session_role: string;
  cwd: string | null;
  worktree_id: string | null;
  parent_process_id: string | null;
  project_path: string | null;
  title: string | null;
}

// No identity means Patterm's own UI, which acts as the owner. An identity
// that is unknown, or whose agent has exited, never falls back to that.
function resolveCaller(database: DatabaseService, identity: string | null): CallerRow | null {
  if (!identity) {
    return null;
  }
  const caller = (
    database.connection
      .prepare(
        `select sessions.id as session_id, sessions.project_id, sessions.process_id,
                sessions.session_role, sessions.cwd, sessions.worktree_id, sessions.title,
                processes.parent_process_id, projects.path as project_path
         from sessions
         left join processes on processes.id = sessions.process_id
         left join projects on projects.id = sessions.project_id
         where sessions.mcp_identity = ? and sessions.exited_at is null`
      )
      .get(identity) as CallerRow | undefined
  );
  if (!caller) throw new Error('Unknown or inactive agent identity');
  return caller;
}

// A read made for an agent on a paired host acts as a caller in the local
// project linked with that agent's project, with no session or process.
function remoteCaller(database: DatabaseService, remote: NonNullable<McpCallContext['remote']>): CallerRow {
  const project = database.connection.prepare('select path from projects where id = ?').get(remote.project_id) as { path: string } | undefined;
  return {
    session_id: `remote:${remote.host_id}`, project_id: remote.project_id, process_id: null, session_role: 'remote',
    cwd: null, worktree_id: null, parent_process_id: null, project_path: project?.path ?? null, title: remote.host_name
  };
}

// The global assistant manages every workspace project, so it is scoped like the owner.
function isAssistant(caller: CallerRow | null): boolean {
  return caller?.session_role === 'assistant';
}

// Workspace routine runs read across projects like the assistant, without its
// assistant-only tools such as Focus mode.
function hasWorkspaceScope(caller: CallerRow | null): boolean {
  return caller?.session_role === 'assistant' || caller?.session_role === 'routine';
}

function workspaceProjectId(database: DatabaseService, projectId: string): string {
  const row = database.connection.prepare(`select kind from projects where id = ?`).get(projectId) as { kind: string } | undefined;
  if (!row) throw new Error(`unknown project: ${projectId}`);
  if (!isUserProjectKind(row.kind)) throw new Error('project is not a workspace project');
  return projectId;
}

function assistantOverview(services: RegistryServices, current: CallerRow) {
  const projects = services.workbench.listProjects().map((project) => ({
    project_id: project.id,
    name: project.name,
    path: project.path,
    processes: listActiveProcesses(services.database, project.id)
  }));
  const open = services.notifications?.list({ include_resolved: false, limit: 50 });
  return { current_process_id: current.process_id ?? '', projects, open_notifications: open?.items ?? [] };
}

// Running agents and processes only; the assistant asks for history explicitly.
function listActiveProcesses(database: DatabaseService, projectId: string) {
  const agents = database.connection.prepare(
    `select sessions.process_id, coalesce(sessions.title, sessions.harness) as name, sessions.harness,
            sessions.session_role, processes.parent_process_id, processes.activity
     from sessions join processes on processes.id = sessions.process_id
     where sessions.project_id = ? and sessions.exited_at is null and processes.status = 'running' and processes.kind = 'agent'
     order by sessions.started_at asc`
  ).all(projectId) as Array<{ process_id: string; name: string; harness: string; session_role: string; parent_process_id: string | null; activity: string }>;
  const processes = database.connection.prepare(
    `select id as process_id, name, kind, parent_process_id from processes where project_id = ? and kind != 'agent' and status = 'running' order by created_at asc`
  ).all(projectId) as Array<{ process_id: string; name: string; kind: string; parent_process_id: string | null }>;
  return [
    ...agents.map((row) => ({ process_id: row.process_id, name: row.name, kind: 'agent', harness: row.harness, activity: row.activity, ...(row.parent_process_id ? { parent_process_id: row.parent_process_id } : {}) })),
    ...processes.map((row) => ({ process_id: row.process_id, name: row.name, kind: row.kind, ...(row.parent_process_id ? { parent_process_id: row.parent_process_id } : {}) }))
  ];
}

function scopedProjectId(_database: DatabaseService, caller: CallerRow | null, projectId: string | null): string | null {
  if (!caller) {
    return projectId;
  }
  if (projectId && projectId !== caller.project_id) {
    throw new Error('project is outside the current caller scope');
  }
  return caller.project_id;
}

function scopedProcessId(database: DatabaseService, caller: CallerRow | null, processId: string): string {
  if (!caller) {
    return processId;
  }
  if (hasWorkspaceScope(caller)) {
    if (!database.connection.prepare(`select 1 from processes where id = ?`).get(processId)) throw new Error(`unknown process: ${processId}`);
    return processId;
  }
  const row = database.connection.prepare(`select project_id from processes where id = ?`).get(processId) as { project_id: string } | undefined;
  if (!row || row.project_id !== caller.project_id) {
    throw new Error('process is outside the current caller scope');
  }
  return processId;
}

function scopedWorktreeId(database: DatabaseService, caller: CallerRow | null, worktreeId: string): string {
  if (!caller || hasWorkspaceScope(caller)) {
    return worktreeId;
  }
  const row = database.connection.prepare(`select project_id from worktrees where id = ?`).get(worktreeId) as { project_id: string } | undefined;
  if (!row || row.project_id !== caller.project_id) {
    throw new Error('worktree is outside the current caller scope');
  }
  return worktreeId;
}

function scopedNullableWorktreeId(database: DatabaseService, caller: CallerRow | null, worktreeId: string | null | undefined): string | null {
  return worktreeId ? scopedWorktreeId(database, caller, worktreeId) : null;
}

function listCliProcesses(database: DatabaseService, kind?: string, projectId?: string | null, currentProcessId?: string | null) {
  const projectFilter = projectId ? ' and sessions.project_id = @project_id' : '';
  const sessions = database.connection
    .prepare(
      `select sessions.process_id, sessions.title, sessions.harness, sessions.session_role, sessions.exited_at, sessions.exit_code,
              processes.parent_process_id, processes.status as process_status
       from sessions left join processes on processes.id = sessions.process_id
       where sessions.process_id is not null${projectFilter}
       order by sessions.started_at desc`
    )
    .all(projectId ? { project_id: projectId } : {}) as Array<{
      process_id: string;
      title: string | null;
      harness: string | null;
      session_role: string;
      exited_at: string | null;
      exit_code: number | null;
      parent_process_id: string | null;
      process_status: string | null;
    }>;
  const processFilter = projectId ? ' and project_id = @project_id' : '';
  const processes = database.connection
    .prepare(`select id, parent_process_id, kind, name, status from processes where kind != 'agent'${processFilter} order by created_at desc`)
    .all(projectId ? { project_id: projectId } : {}) as Array<{ id: string; parent_process_id: string | null; kind: string; name: string; status: string }>;
  const rows = [
    ...sessions.map((row) => ({
      process_id: row.process_id,
      name: row.title ?? row.harness ?? 'agent',
      kind: 'agent',
      status: row.process_status && row.process_status !== 'running' ? row.process_status : row.exited_at ? 'exited' : 'running',
      ...(row.process_id === currentProcessId ? { is_current: true } : {}),
      ...(row.parent_process_id ? { parent_process_id: row.parent_process_id } : {}),
      ...(row.exit_code === null ? {} : { exit_code: row.exit_code })
    })),
    ...processes.map((row) => ({
      process_id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      ...(row.id === currentProcessId ? { is_current: true } : {}),
      ...(row.parent_process_id ? { parent_process_id: row.parent_process_id } : {})
    }))
  ];
  return kind ? rows.filter((row) => row.kind === kind) : rows;
}

function findCliProcess(database: DatabaseService, processId: string) {
  return listCliProcesses(database).find((row) => row.process_id === processId) ?? { process_id: processId, name: processId, kind: 'unknown', status: 'unknown' };
}

async function readProcessOutput(services: RegistryServices, processId: string, mode: string, sinceOffset: number) {
  if (isIntegratedProcess(services.database, processId)) {
    const row = services.database.connection.prepare(`select status, activity from processes where id = ?`).get(processId) as { status: string; activity: string | null } | undefined;
    const content = snapshotText(await requireIntegrated(services).conversation(processId));
    return { ...normalizeOutput({ content, status: row?.status ?? 'unknown' }, 'conversation'), activity: row?.activity ?? 'unknown', hint: CONVERSATION_OUTPUT_HINT };
  }
  const output = await services.terminal.request('terminal.process.output', { process_id: resolvePtyProcessId(services.database, processId), mode, since_offset: sinceOffset });
  return normalizeOutput(output, mode);
}

function normalizeOutput(output: unknown, mode: string) {
  const record = asRecord(output);
  const content = typeof record.content === 'string' ? record.content : typeof record.text === 'string' ? record.text : gridContent(record);
  const contentBytes = Buffer.byteLength(content, 'utf8');
  return {
    content,
    mode,
    new_offset: typeof record.new_offset === 'number' ? record.new_offset : 0,
    active_screen: typeof record.active_screen === 'string' ? record.active_screen : undefined,
    status: typeof record.status === 'string' ? record.status : undefined,
    rows: typeof record.rows === 'number' ? record.rows : undefined,
    cols: typeof record.cols === 'number' ? record.cols : undefined,
    cursor: record.cursor,
    screen_version: typeof record.screen_version === 'number' ? record.screen_version : undefined,
    display_offset: typeof record.display_offset === 'number' ? record.display_offset : undefined,
    content_bytes: contentBytes,
    truncated: false,
    canonicalized: mode === 'stream'
  };
}

function limitOutput<T extends ReturnType<typeof normalizeOutput>>(output: T, maxBytes?: number, maxLines?: number): T {
  let content = output.content;
  let truncated = false;
  if (maxLines && maxLines > 0) {
    const lines = content.split('\n');
    if (lines.length > maxLines) {
      content = lines.slice(-maxLines).join('\n');
      truncated = true;
    }
  }
  if (maxBytes) {
    const tail = tailUtf8(content, maxBytes);
    content = tail.text;
    truncated ||= tail.truncated;
  }
  return { ...output, content, content_bytes: Buffer.byteLength(content, 'utf8'), truncated };
}

function gridContent(record: Record<string, unknown>): string {
  const lines = record.lines;
  if (Array.isArray(lines)) {
    return lines.map((line) => (typeof line === 'string' ? line : String(line))).join('\n');
  }
  const grid = record.grid;
  if (Array.isArray(grid)) {
    return grid.map((line) => (Array.isArray(line) ? line.join('') : String(line))).join('\n');
  }
  return JSON.stringify(record);
}

function keyText(key: string | undefined): string {
  switch ((key ?? '').toLowerCase()) {
    case 'enter':
      return '\r';
    case 'escape':
      return '\u001b';
    case 'tab':
      return '\t';
    case 'backspace':
      return '\u007f';
    case 'delete':
      return '\u001b[3~';
    case 'arrowup':
    case 'up':
      return '\u001b[A';
    case 'arrowdown':
    case 'down':
      return '\u001b[B';
    case 'arrowright':
    case 'right':
      return '\u001b[C';
    case 'arrowleft':
    case 'left':
      return '\u001b[D';
    case 'ctrl-c':
    case 'ctrl+c':
    case 'control-c':
    case 'control+c':
      return '\u0003';
    case 'ctrl-d':
    case 'ctrl+d':
    case 'control-d':
    case 'control+d':
      return '\u0004';
    case 'ctrl-u':
    case 'ctrl+u':
    case 'control-u':
    case 'control+u':
      return '\u0015';
    default:
      return key ?? '';
  }
}

function extractPorts(content: string) {
  const seen = new Set<number>();
  const ports: Array<{ port: number; url?: string; first_seen_at: string }> = [];
  const now = new Date().toISOString();
  const regex = /https?:\/\/[^\s:/]+:(\d{2,5})(?:\/[^\s]*)?/g;
  for (const match of content.matchAll(regex)) {
    const port = Number(match[1]);
    if (port > 0 && port <= 65535 && !seen.has(port)) {
      seen.add(port);
      ports.push({ port, url: match[0], first_seen_at: now });
    }
  }
  return ports;
}

function commandFromArgv(argv: string[], shell: boolean): string | undefined {
  if (argv.length === 0) {
    return undefined;
  }
  if (shell) {
    return argv.join(' ');
  }
  return argv.map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

function whoami(database: DatabaseService, identity: string | null, includeTools: boolean, registry: McpToolRegistry) {
  const caller = resolveCaller(database, identity);
  return {
    process_id: caller?.process_id ?? '',
    name: caller?.title ?? caller?.session_id ?? 'external',
    role: caller?.session_role === 'child' ? 'sub-agent' : caller?.session_role === 'assistant' ? 'assistant' : 'orchestrator',
    ...(caller?.parent_process_id ? { parent_process_id: caller.parent_process_id } : {}),
    project: caller ? { key: caller.project_id, path: caller.project_path ?? '' } : null,
    ...(includeTools ? { available_tools: registry.publicTools({ identity }).map(({ name }) => name) } : {})
  };
}

function projectMeta(project: { id: string; path?: string | null } | null) {
  return project ? { key: project.id, path: project.path ?? '' } : null;
}

function requireHistoryImport(services: RegistryServices): AgentHistoryImportService {
  if (!services.historyImportService) throw new Error('conversation history import is not available');
  return services.historyImportService;
}

function requireHistorySource(services: RegistryServices): AgentHistorySourceService {
  if (!services.historySourceService) throw new Error('conversation history sources are not available');
  return services.historySourceService;
}

function requireHistoryImportQueue(services: RegistryServices): AgentHistoryImportQueueService {
  if (!services.historyImportQueue) throw new Error('conversation history import queue is not available');
  return services.historyImportQueue;
}

function requireHistoryRead(services: RegistryServices): AgentHistoryReadService {
  if (!services.historyReadService) throw new Error('conversation history read service is not available');
  return services.historyReadService;
}

function requireHistoryDelete(services: RegistryServices): AgentHistoryDeleteService {
  if (!services.historyDeleteService) throw new Error('conversation history delete service is not available');
  return services.historyDeleteService;
}

function requireIntegrated(services: RegistryServices): NonNullable<RegistryServices['integrated']> {
  if (!services.integrated) throw new Error('Integrated conversations are not available');
  return services.integrated;
}

function requireSettings(services: RegistryServices): NonNullable<RegistryServices['settings']> {
  if (!services.settings) throw new Error('Settings are not available');
  return services.settings;
}

function isIntegratedProcess(database: DatabaseService, processId: string): boolean {
  return Boolean(database.connection.prepare(`select 1 from sessions where process_id = ? and interface_mode = 'integrated' and exited_at is null`).get(processId));
}

function assertConversationAccess(services: RegistryServices, context: McpCallContext, conversationId: string): void {
  const current = resolveCaller(services.database, context.identity ?? null);
  if (!current) return;
  const conversation = requireHistoryRead(services).get({ conversation_id: conversationId }).conversation;
  if (!conversation) throw new Error(`unknown conversation: ${conversationId}`);
  if (conversation.projectId && conversation.projectId !== current.project_id) {
    throw new Error('conversation is outside the caller project scope');
  }
}

function childAgentInstructions(agentInstructions: string, prompt: string | undefined, detached: boolean, resuming: boolean): string {
  const body = [agentInstructions, prompt]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n\n');
  // A resumed former child keeps its old report_to_parent instructions, so it needs the correction even without new text.
  if (!body) return detached && resuming ? DETACHED_AGENT_INSTRUCTION : '';
  return `${body}\n\n${detached ? DETACHED_AGENT_INSTRUCTION : CHILD_AGENT_COMPLETION_INSTRUCTION}`;
}

const AGENT_WORKTREE_LINK_NOTE = 'An agent\'s result includes attached: true once the worktree is linked to its session, or attached: false with a warning, for example when the session already links 10 worktrees. The worktree is kept either way.';

const DETACHED_AGENT_INSTRUCTION = `You were started as a detached agent with no parent, so do not call report_to_parent. Report results to the user in this conversation, and call notify_user only if you are blocked on a human decision.`;

const CHILD_AGENT_COMPLETION_INSTRUCTION = `When this delegated work is done, blocked, failed, or has no findings, call report_to_parent with your result. Do not rely on terminal idle or get_process_output as the completion signal. Stay available after reporting: your parent may send follow-ups, such as re-reviewing fixes, and you should report again after each one.`;
