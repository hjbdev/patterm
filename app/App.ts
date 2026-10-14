import { EventEmitter } from 'node:events';
import { AssistantService, type AssistantEvent } from './Services/AssistantService';
import { AssistantMemoryService } from './Services/AssistantMemoryService';
import { registerAssistantTools } from './MCP/registerAssistantTools';
import { registerIdleCompactionTools } from './MCP/registerIdleCompactionTools';
import { registerHostTools } from './MCP/registerHostTools';
import { registerProjectTools } from './MCP/registerProjectTools';
import { RemoveProjectAction } from './Actions/RemoveProjectAction';
import { RenameProjectAction } from './Actions/RenameProjectAction';
import { ProjectLaunchFence } from './Services/ProjectLaunchFence';
import { HostActions } from './Actions/HostActions';
import { HostService } from './Services/HostService';
import { PeerLinkService } from './Services/PeerLinkService';
import { TerminalSubscriptions } from './Services/TerminalSubscriptions';
import { UploadService } from './Http/UploadService';
import { RemoteClientService } from './Services/RemoteClientService';
import { ServerAccess } from './Http/ServerAccess';
import { BROWSER_TOOLS } from './Http/BrowserTools';
import { MCP_SERVER_TOOLS } from './MCP/registerMcpServerTools';
import { resolvePtyProcessId } from './Services/ProcessIdentity';
import { ProjectLinkService } from './Services/ProjectLinkService';
import { ProjectLinkActions } from './Actions/ProjectLinkActions';
import { CrossHostService, REMOTE_CONTEXT_READ_TOOLS } from './Services/CrossHostService';
import { AutoSummaryService } from './Services/AutoSummaryService';
import { AutoSummaryRunner } from './Services/AutoSummaryRunner';
import { AutoSummaryActions, registerAutoSummaryControl } from './Actions/AutoSummaryActions';
import { acquireApplicationLock } from './Runtime/ApplicationLock';
import { launchNodeHistoryWorker } from './Runtime/NodeHistoryWorker';
import path from 'node:path';
import { DiscoverHarnessesAction } from './Actions/DiscoverHarnessesAction';
import { ReconcileRuntimeAction } from './Actions/ReconcileRuntimeAction';
import { QuitApplicationAction } from './Actions/QuitApplicationAction';
import { terminalInventory, type TerminalHostOptions } from './Services/TerminalHostService';
import { createRegistryActions } from './Actions/RegistryActions';
import { CloseRequestActions } from './Actions/CloseRequestActions';
import { GetUsageSummaryAction } from './Actions/UsageActions';
import { UsageService } from './Services/UsageService';
import { harnessProviders } from './Harness/providers';
import { AgentHistoryImportService } from './Services/AgentHistory/AgentHistoryImportService';
import { AgentHistoryImportQueueService } from './Services/AgentHistory/AgentHistoryImportQueueService';
import { AgentHistoryReadService } from './Services/AgentHistory/AgentHistoryReadService';
import { ConversationMediaService } from './Services/AgentHistory/ConversationMediaService';
import { AgentHistorySourceService } from './Services/AgentHistory/AgentHistorySourceService';
import { ResumeIdCaptureService } from './Services/AgentHistory/ResumeIdCaptureService';
import { AgentHistoryWatcherService } from './Services/AgentHistory/AgentHistoryWatcherService';
import { ProviderHistoryDiscoveryService } from './Services/AgentHistory/ProviderHistoryDiscoveryService';
import { DatabaseService } from './Services/DatabaseService';
import { backupBeforeMigrations } from './Services/DatabaseBackupService';
import { DebugLogService } from './Services/DebugLogService';
import { DiffService } from './Services/DiffService';
import { GitService } from './Services/GitService';
import { HarnessDiscoveryService } from './Services/HarnessDiscoveryService';
import { HarnessLauncher } from './Services/HarnessLauncher';
import { HarnessModelCatalogService } from './Services/HarnessModelCatalogService';
import { HarnessPresetService } from './Services/HarnessPresetService';
import { OpenCodeServerService } from './Services/OpenCodeServerService';
import { CodexAppServerService } from './Services/CodexAppServerService';
import { ClaudeStreamService } from './Services/ClaudeStreamService';
import { detachedHostLauncher, systemdHostLauncher } from './Services/IntegratedHostLauncher';
import { IdleCompactionService } from './Services/IdleCompactionService';
import type { IdleCompactionSettings } from './Services/SettingsService';
import { IntegratedAgentService } from './Services/IntegratedAgentService';
import type { IntegratedConversationEvent } from './Services/IntegratedConversation';
import { TranscriptImageStore } from './Services/TranscriptImageStore';
import { WorktreeFileService } from './Services/WorktreeFileService';
import { HistoryDatabaseService } from './Services/HistoryDatabaseService';
import { ProcessLauncher } from './Services/ProcessLauncher';
import { RuntimeReconciler } from './Services/RuntimeReconciler';
import { SearchService } from './Services/SearchService';
import { SettingsService } from './Services/SettingsService';
import { ShellEnvironmentService } from './Services/ShellEnvironmentService';
import { SummaryService } from './Services/SummaryService';
import { TerminalService, type TerminalLifecycleFrame } from './Services/TerminalService';
import { TimerService } from './Services/TimerService';
import { RoutineService } from './Services/RoutineService';
import { TimelineService } from './Services/TimelineService';
import { WorktreeService } from './Services/WorktreeService';
import { WorkbenchRepository, type WorkbenchSnapshotDto } from './Repositories/WorkbenchRepository';
import { WorkbenchSyncService, type WorkbenchRead, type WorkbenchSince } from './Services/WorkbenchSyncService';
import type { WorkbenchPatch } from './Services/WorkbenchPatch';
import type { ChangeTopic } from './Services/ChangeTopics';
import { createMcpRegistry, type McpToolRegistry } from './MCP/createMcpRegistry';
import { McpSocketServer } from './MCP/McpSocketServer';
import { LaunchingMcpIdentities, McpHelperAccess } from './MCP/McpHelperAccess';
import { OpenExternalUrlAction } from './Actions/OpenExternalUrlAction';
import { TerminalClientRequestService, type TerminalClientRequest } from './Services/TerminalClientRequestService';
import { NotificationService, type NotificationChange, type NotificationRecord } from './Services/NotificationService';
import { NotificationDelivery } from './Services/NotificationDelivery';
import { NotificationTriage, TurnDigests } from './Services/NotificationTriage';
import { PresenceService } from './Services/PresenceService';
import { PushService, pushSubject } from './Services/PushService';
import { NotificationActions } from './Actions/NotificationActions';
import { sendAgentInput } from './Services/AgentInputService';
import { AssistantInbox } from './Services/AssistantInbox';
import { ensurePersonalProject } from './Services/PersonalProject';
import { McpServerRegistry } from './Services/McpServerRegistry';
import { codexMcpStartupNotice } from './Harness/McpDelivery';
import { McpOAuthService } from './Services/McpOAuthService';
import { McpServerImportService } from './Services/McpServerImportService';
import { NativeOAuthCallbackService } from './Services/NativeOAuthCallbackService';
import { McpServerActions } from './Actions/McpServerActions';
import { registerMcpServerTools } from './MCP/registerMcpServerTools';

export interface AppOptions {
  appDataPath: string;
  sidecarPath: string;
  // Path to the bundled MCP stdio shim (dist/mcp/patterm-mcp.js) that launched
  // harnesses run to reach the socket host.
  mcpShimPath: string;
  runtime?: 'node' | 'electron';
  launchDiagnostics?: unknown;
  launchIdentity?: unknown;
  terminalHosts?: TerminalHostOptions;
  // HTTPS origin of the browser server, used as the Web Push contact.
  publicOrigin?: string;
  // The only Tailscale login the browser server accepts through its public
  // origin. A server reachable over the tailnet needs one before it pairs.
  ownerLogin?: string;
  // The server's password and Remote access setting; read before startup.
  serverAccess?: ServerAccess;
  // The runtime lock, when the caller already holds it; released on dispose.
  runtimeLock?: () => void;
  onQuitRequested?: () => void;
}

export interface BootstrapPayload {
  appName: string;
  sidecarAvailable: boolean;
}

export interface PattermApplication {
  database: DatabaseService;
  serverAccess: ServerAccess;
  debugLog: DebugLogService;
  terminal: TerminalService;
  timers: TimerService;
  settings: SettingsService;
  harnessPresets: HarnessPresetService;
  modelCatalog: HarnessModelCatalogService;
  autoSummaries: AutoSummaryService;
  autoSummaryActions: AutoSummaryActions;
  timeline: TimelineService;
  mcp: McpToolRegistry;
  workbench: WorkbenchRepository;
  notifications: NotificationActions;
  hosts: HostActions;
  peers: PeerLinkService;
  terminalSubscriptions: TerminalSubscriptions;
  remote: RemoteClientService;
  bootstrap(): BootstrapPayload;
  // Notification records changed. Clients update badges and show toasts.
  onNotificationsChanged(handler: (change: NotificationChange) => void): () => void;
  // The user is away and a notification should reach the desktop.
  onDesktopNotification(handler: (notification: NotificationRecord) => void): () => void;
  // Global assistant state and voice session events, for every client.
  onAssistantEvent(handler: (event: AssistantEvent) => void): () => void;
  // Marks client-visible data as changed. Workbench changes are published as
  // patches; other topics reach clients as coalesced refetch signals.
  notifyChanged(topics: readonly ChangeTopic[]): void;
  // A versioned workbench snapshot, or only what a client holding `since`
  // lacks. Pending changes are published first.
  readWorkbench(since?: WorkbenchSince | null): WorkbenchRead;
  // The workbench as last published, for server-side readers.
  currentWorkbench(): WorkbenchSnapshotDto;
  onWorkbenchPatch(handler: (patch: WorkbenchPatch) => void): () => void;
  // Topics other than the workbench changed.
  onDataChanged(handler: (topics: ChangeTopic[]) => void): () => void;
  // Clipboard copies and link opens requested by a terminal program. Deliver
  // them to the client that controls the process.
  onTerminalClientRequest(handler: (request: TerminalClientRequest) => void): () => void;
  // Provider conversation deltas for one process. Release with the returned
  // function; losing a subscriber never stops native execution.
  subscribeConversation(processId: string, listener: (event: IntegratedConversationEvent) => void): Promise<() => void>;
  // Finishes an MCP server sign-in redirected to the browser server's
  // callback route and returns the page to show.
  mcpSignInCallback(url: string): Promise<{ status: number; body: string }>;
  dispose(): Promise<void>;
  shutdown(): Promise<void>;
  requestQuit(): void;
  isShuttingDown(): boolean;
}

export async function createApplication(options: AppOptions): Promise<PattermApplication> {
  const cleanup: Array<() => void | Promise<void>> = [options.runtimeLock ?? acquireApplicationLock(options.appDataPath)];
  const abort = new AbortController();
  let disposing: Promise<void> | undefined;
  const dispose = () => disposing ??= (async () => {
    abort.abort();
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Application shutdown failed');
  })();
  try {
    return await createApplicationResources(options, (close) => cleanup.push(close), abort.signal, dispose);
  } catch (error) {
    await dispose().catch((cleanupError) => console.error(cleanupError));
    throw error;
  }
}

async function createApplicationResources(
  options: AppOptions,
  defer: (close: () => void | Promise<void>) => void,
  signal: AbortSignal,
  dispose: () => Promise<void>
): Promise<PattermApplication> {
  const startupStartedAt = Date.now();
  const debugLog = new DebugLogService(options.appDataPath);
  defer(() => debugLog.dispose());
  debugLog.initialize();
  defer(startEventLoopMonitor(debugLog));
  debugLog.write('startup', 'launch.identity', options.launchIdentity ?? { appDataPath: options.appDataPath });
  debugLog.write('startup', 'launch.windowing', options.launchDiagnostics ?? null);

  const backupStartedAt = Date.now();
  const backup = backupBeforeMigrations(options.appDataPath);
  if (backup) debugLog.write('startup', 'database.backup', { elapsed_ms: Date.now() - backupStartedAt, ...backup });

  const database = new DatabaseService(options.appDataPath, { busyTimeoutMs: 5000 });
  defer(() => database.dispose());
  const databaseStartedAt = Date.now();
  database.initialize();
  ensurePersonalProject(database, options.appDataPath);
  debugLog.write('startup', 'database.ready', { elapsed_ms: Date.now() - databaseStartedAt });

  const shellEnvStartedAt = Date.now();
  const resolvedEnv = await new ShellEnvironmentService().resolve();
  debugLog.write('startup', 'shell-env.ready', {
    elapsed_ms: Date.now() - shellEnvStartedAt,
    shell: resolvedEnv.SHELL ?? null,
    path: resolvedEnv.PATH ?? null
  });

  const terminal = new TerminalService(options.sidecarPath, debugLog, resolvedEnv, options.terminalHosts);
  defer(() => terminal.dispose());
  // Hosts keep running during startup. Retain lifecycle changes until the
  // reconciler is listening so an exit racing with inventory is not lost.
  const startupFrames = new Map<string, TerminalLifecycleFrame>();
  const stopBuffering = terminal.onFrame((frame) => {
    if (frame.type === 'terminal-lifecycle') startupFrames.set(`${frame.processId}:${frame.event}`, frame);
  });
  defer(stopBuffering);
  const terminalStartedAt = Date.now();
  await terminal.start();
  debugLog.write('startup', 'terminal.ready', { elapsed_ms: Date.now() - terminalStartedAt, available: terminal.isAvailable() });

  const settings = new SettingsService(database);
  const assistantMemory = new AssistantMemoryService(database, settings);
  const harnessPresets = new HarnessPresetService(settings);
  // Terminal hosts outlive the app on installed Linux services and on Windows
  // desktop. Only the Linux service also keeps Integrated hosts and the
  // OpenCode bridge across restarts; Windows desktop ties them to the app.
  const persistentTerminals = Boolean(options.terminalHosts);
  const persistent = persistentTerminals && process.platform !== 'win32';
  const events = new EventEmitter();
  // Created once the workbench repository exists. Earlier changes need no
  // patch: the first read builds the whole snapshot.
  let workbenchSync: WorkbenchSyncService | null = null;
  // Paired hosts' records, merged into every snapshot once the link exists.
  let remoteClient: RemoteClientService | null = null;
  const changedTopics = new Set<ChangeTopic>();
  let topicsScheduled = false;
  // `fromPeer` marks changes a paired host announced, which are not
  // announced back to it.
  const notifyChanged = (topics: readonly ChangeTopic[], fromPeer = false) => {
    if (!fromPeer) remoteClient?.localTopicsChanged(topics);
    for (const topic of topics) {
      if (topic === 'workbench') {
        workbenchSync?.invalidate();
        remoteClient?.localChanged();
      }
      else changedTopics.add(topic);
    }
    if (!changedTopics.size || topicsScheduled) return;
    // One signal per turn of the event loop, however many writes announce it.
    topicsScheduled = true;
    setImmediate(() => {
      topicsScheduled = false;
      const changed = [...changedTopics];
      changedTopics.clear();
      events.emit('data:changed', changed);
    });
  };
  const notifyWorkbenchChanged = () => notifyChanged(['workbench']);
  const transcriptImages = new TranscriptImageStore(path.join(options.appDataPath, 'transcript-images'));
  const openCodeServer = new OpenCodeServerService(database, resolvedEnv, { persistent, images: transcriptImages });
  const harnessRuntimeDir = path.join(options.appDataPath, 'harness');
  // Installed services run Integrated hosts in their own systemd units so a
  // service restart reconnects to them instead of killing them.
  const hostLauncher = persistent ? systemdHostLauncher(options.appDataPath, resolvedEnv) : detachedHostLauncher;
  // A release install names its bundled Node through the `current` symlink, so
  // agents and hosts that outlive an update don't keep a replaced version's path.
  const nodePath = process.env.PATTERM_NODE || process.execPath;
  const codexAppServer = new CodexAppServerService(database, harnessRuntimeDir, resolvedEnv, nodePath, undefined, { launcher: hostLauncher, images: transcriptImages });
  const claudeStream = new ClaudeStreamService(database, harnessRuntimeDir, nodePath, resolvedEnv, undefined, hostLauncher, transcriptImages);
  const integratedInputs = new WorktreeFileService(database, new UploadService(path.join(options.appDataPath, 'uploads')));
  const integrated = new IntegratedAgentService(database, { opencode: openCodeServer, codex: codexAppServer, claude: claudeStream }, () => notifyWorkbenchChanged(), integratedInputs, hostLauncher);
  integrated.setDebugLog(debugLog);
  // Holds unprompted input for the assistant while its Focus mode is on.
  const assistantInbox = new AssistantInbox(database);
  const timers = new TimerService(database, terminal, { persistent: persistentTerminals, integrated, assistantInbox, onChanged: notifyWorkbenchChanged });
  defer(() => timers.dispose());
  const historyDatabase = new HistoryDatabaseService(options.appDataPath, { mode: 'read', busyTimeoutMs: 250 });
  defer(() => historyDatabase.dispose());
  historyDatabase.initialize({ migrate: false });
  const searchService = new SearchService(database, historyDatabase);
  const searchIndexStartedAt = Date.now();
  const searchIndexRebuilt = searchService.ensureIndex();
  debugLog.write('startup', 'search-index.ready', { elapsed_ms: Date.now() - searchIndexStartedAt, rebuilt: searchIndexRebuilt });
  const timeline = new TimelineService(database, (eventId) => searchService.indexTimelineEvent(eventId));
  const presence = new PresenceService();
  const push = new PushService(database, options.appDataPath, pushSubject(options.publicOrigin));
  // Delivers a notice from one process to another, held while a parent
  // assistant is in Focus mode.
  const messageProcess = async (processId: string, text: string, fromProcessId: string) => {
    if (assistantInbox.holdNotice(processId, text, fromProcessId)) return;
    await sendAgentInput(database, terminal, { process_id: processId, kind: 'text', text, submit: true }, integrated);
  };
  const notificationService = new NotificationService(database, settings, timeline, messageProcess,
    (change) => events.emit('notifications:changed', change));
  const notifications = new NotificationActions(notificationService, settings, presence, push);
  const delivery = new NotificationDelivery(presence, {
    current: (id) => notificationService.get(id),
    push: (notification) => push.deliver(notification),
    desktop: (notification) => events.emit('notifications:desktop', notification),
    log: (event, data) => debugLog.write('notifications', event, data)
  });
  events.on('notifications:changed', (change: NotificationChange) => delivery.handle(change));
  defer(() => delivery.dispose());
  notificationService.prune();
  const raiseNotification = (input: Parameters<NotificationService['raise']>[0]) => {
    void notificationService.raise(input).catch((error: unknown) => {
      debugLog.write('notifications', 'raise.failed', { source: input.source, kind: input.kind, message: error instanceof Error ? error.message : String(error) });
    });
  };
  const turnDigests = new TurnDigests();
  defer(integrated.onConversationEvent((processId, event) => turnDigests.observe(processId, event)));
  const triage = new NotificationTriage(turnDigests,
    (processId) => timers.list().some((timer) => timer.ownerProcessId === processId && timer.status === 'pending' && timer.kind !== 'delay'),
    () => settings.notificationSettings().quietRoutineTurns);
  // Created once the launcher exists; earlier activity predates any assistant.
  let assistant: AssistantService | null = null;
  // Started after the listener below, which must see a compaction's turn end
  // before the service clears its state.
  const idleCompaction = new IdleCompactionService(database, integrated,
    (harness) => settings.idleCompactionSettings()[harness as keyof IdleCompactionSettings] === true,
    (event, data) => debugLog.write('idle-compaction', event, data), Date.now,
    (processId) => !assistant || assistant.voiceActive(processId));
  let closeRequests: CloseRequestActions | null = null;
  defer(integrated.onActivityChange(({ processId, previous, activity, snapshot }) => {
    const reportedThisTurn = notificationService.turnActivity(processId, previous, activity, snapshot);
    if (activity === 'permission') raiseNotification({ processId, source: 'integrated', kind: 'permission', body: 'Waiting for your permission', dedupeKey: 'integrated:permission' });
    else if (activity === 'working') {
      notificationService.resolveHandled(processId);
      // New work makes an earlier close request stale.
      if (!snapshot && (previous === 'idle' || previous === 'error')) closeRequests?.clear(processId);
    }
    else if (activity === 'error') raiseNotification({ processId, source: 'integrated', kind: 'failure', body: 'The agent reported an error' });
    else if (activity === 'idle') {
      notificationService.resolve({ process_id: processId, kinds: ['permission'] });
      // Reconnect snapshots are not turns the user has not seen.
      // The assistant's own turns are read in its panel, not announced, and
      // neither is a compaction or a turn that reported.
      const turnEnded = !snapshot && (previous === 'working' || previous === 'thinking' || previous === 'permission');
      // A turn that asked to be closed announces that instead of finishing.
      if (turnEnded && closeRequests?.pending(processId)) void closeRequests.announce(processId).catch(() => undefined);
      else if (turnEnded && !assistant?.isAssistantProcess(processId) && !idleCompaction.compacting(processId) && !reportedThisTurn) {
        const decision = triage.decide(processId);
        if (decision.reason !== 'disabled') debugLog.write('notifications', 'triage', { processId, ...decision });
        raiseNotification({ processId, source: 'integrated', kind: 'turn_finished', body: 'Finished its turn', dedupeKey: 'integrated:turn_finished', quiet: decision.quiet });
      }
    }
  }));

  // Started after the listener above, and before reconciliation so its
  // snapshots find every agent already disarmed.
  idleCompaction.start();
  defer(() => idleCompaction.dispose());

  const inventory = persistentTerminals ? terminalInventory.parse(await terminal.request('terminal.process.list')).processes : undefined;
  const reconciled = new ReconcileRuntimeAction(database).execute(inventory);
  debugLog.write('runtime', 'reconciled', reconciled);
  const integratedReconciled = await integrated.reconcile();
  notificationService.resumeTurns();
  debugLog.write('runtime', 'integrated.reconciled', integratedReconciled);

  const workbench = new WorkbenchRepository(database, undefined, timers);
  const sync = new WorkbenchSyncService(() => remoteClient ? remoteClient.merge(workbench.snapshot()) : workbench.snapshot(), {
    onError: (error) => debugLog.write('workbench', 'sync.failed', { message: error instanceof Error ? error.message : String(error) })
  });
  workbenchSync = sync;
  defer(() => sync.dispose());
  const harnessDiscovery = new HarnessDiscoveryService(harnessProviders, {
    env: resolvedEnv,
    // Windows ignores a $SHELL inherited from Git Bash or MSYS; raw terminals use PowerShell.
    ...(resolvedEnv.SHELL && process.platform !== 'win32' ? { shell: resolvedEnv.SHELL } : {})
  });
  const git = new GitService();
  const worktreeService = new WorktreeService({ database, timeline, workbench, git });
  const diffService = new DiffService({ worktrees: worktreeService, git });
  const summaryService = new SummaryService(database, timeline, searchService);
  const historyDiscovery = new ProviderHistoryDiscoveryService();
  const historySourceService = new AgentHistorySourceService(database, historyDiscovery);
  const historyImportService = new AgentHistoryImportService(database, historyDiscovery, timeline, undefined, database, historySourceService);
  const historyReadService = new AgentHistoryReadService(historyDatabase);
  integrated.setHistoryReadService(historyReadService);
  const socketPath = path.join(options.appDataPath, 'mcp.sock');
  const autoSummaries = new AutoSummaryService(database, settings, terminal, new AutoSummaryRunner(database, resolvedEnv), notifyWorkbenchChanged, Date.now, historyDatabase);
  const autoSummaryActions = new AutoSummaryActions(autoSummaries);
  autoSummaries.start();
  defer(() => autoSummaries.dispose());
  const resumeCapture = new ResumeIdCaptureService(database, searchService);
  const historyImportQueue = new AgentHistoryImportQueueService(options.appDataPath, undefined, options.runtime === 'node' ? launchNodeHistoryWorker : undefined, debugLog, {
    onResult: (result) => {
      if (applyHistoryImportEffects(result, timeline, resumeCapture)) notifyWorkbenchChanged();
      if (importedConversations(result)) { autoSummaries.historyChanged(); notifyChanged(['history']); }
    }
  });
  defer(() => historyImportQueue.dispose());
  const historyWatcher = new AgentHistoryWatcherService({
    enabledWatchSources: () => historySourceService.enabledWatchSources(),
    import: (input) => historyImportQueue.import(input)
  });

  defer(() => historyWatcher.stop());

  const modelCatalog = new HarnessModelCatalogService({ database, settings, env: resolvedEnv, openCodeServer, debugLog });
  defer(() => modelCatalog.dispose());
  const mcpServerRegistry = new McpServerRegistry(database);
  const mcpOAuth = new McpOAuthService(database, mcpServerRegistry, {
    publicOrigin: options.publicOrigin ?? null,
    onChanged: () => notifyChanged(['mcp-servers']),
    log: (event, data) => debugLog.write('mcp-servers', event, data)
  });
  defer(() => mcpOAuth.dispose());
  // Only Patterm's own servers: the user manages native Codex servers in Codex.
  defer(codexAppServer.onMcpStartupFailure((processId, failure) => {
    const server = mcpServerRegistry.forHarness('codex').find((entry) => entry.name === failure.server);
    if (server) raiseNotification({ processId, source: 'runtime', kind: 'failure', ...codexMcpStartupNotice(server, failure.error), dedupeKey: `mcp-startup:${server.name}` });
  }));
  const nativeOAuthCallbacks = new NativeOAuthCallbackService();
  const mcpServers = new McpServerActions(mcpServerRegistry, mcpOAuth, new McpServerImportService(mcpServerRegistry, { env: resolvedEnv }), nativeOAuthCallbacks, {
    redirectsToOrigin: Boolean(options.publicOrigin),
    env: resolvedEnv,
    onChanged: () => notifyChanged(['mcp-servers'])
  });
  const launchingIdentities = new LaunchingMcpIdentities();
  // Removing a project keeps launches out of it while it stops what runs there.
  const launchFence = new ProjectLaunchFence();
  const harnessLauncher = new HarnessLauncher({
    fence: launchFence,
    mcpServers: mcpServerRegistry,
    launchingIdentities,
    assistantMemory,
    openCodeServer,
    integrated,
    settings,
    database,
    timeline,
    terminal,
    workbench,
    providers: harnessProviders,
    nodePath,
    shimPath: options.mcpShimPath,
    socketPath,
    runtimeDir: harnessRuntimeDir,
    inheritedPath: resolvedEnv.PATH,
    search: searchService,
    debugLog,
    presetSettings: settings
  });
  // Restarts stop the assistant like any other agent; actions are created below.
  assistant = new AssistantService(database, options.appDataPath, harnessLauncher, codexAppServer, integrated, settings, assistantInbox,
    { stop: (processId) => actions.stopProcess.execute(processId), transferTimers: (from, to) => timers.transferOwner(from, to) },
    { log: (event, data) => debugLog.write('assistant', event, data), compacting: (processId) => idleCompaction.compacting(processId) });
  const assistantService = assistant;
  defer(() => assistantService.dispose());
  assistantService.start();
  events.on('notifications:changed', (change: NotificationChange) => assistantService.handleNotification(change));
  const processLauncher = new ProcessLauncher({
    fence: launchFence,
    database,
    timeline,
    terminal,
    workbench,
    notifyChanged: notifyWorkbenchChanged
  });
  const actions = createRegistryActions({
    integrated,
    openCodeServer,
    notifications: notificationService,
    database,
    timeline,
    terminal,
    harnessDiscovery,
    worktreeService,
    diffService,
    searchService
  });
  closeRequests = new CloseRequestActions(database, timeline, actions.closeProcess, messageProcess, notifyWorkbenchChanged, notificationService);
  const answeredCloseRequests = closeRequests;
  notifications.onUserInput((processId) => answeredCloseRequests.clear(processId));

  // Paired hosts. Only the server can be reached by other hosts, so only it
  // shows pairing codes; any host can pair to a server.
  const terminalSubscriptions = new TerminalSubscriptions(terminal);
  // The server's optional password, set from Settings › Remote access.
  const serverAccess = options.serverAccess ?? ServerAccess.forDataDirectory(options.appDataPath);
  // Pairing extends this host's owner access to another machine, so a server
  // other tailnet users could reach must know its owner or have a password.
  const tailnetOrigin = options.publicOrigin ? !['localhost', '127.0.0.1', '[::1]'].includes(new URL(options.publicOrigin).hostname) : false;
  const pairingBlocked = () => options.runtime === 'node' && tailnetOrigin && !options.ownerLogin && !serverAccess.passwordSet()
    ? 'Pairing is off because this server accepts any tailnet user. Set a password in Settings › Remote access, or install the service with --owner-login (sets PATTERM_OWNER_LOGIN) and restart it.'
    : null;
  const uploads = new UploadService(path.join(options.appDataPath, 'uploads'));
  const hostService = new HostService(database);
  hostService.identity();
  const peers = new PeerLinkService(hostService, {
    blocked: pairingBlocked,
    onChange: () => { notifyChanged(['settings']); workbenchSync?.invalidate(); },
    onRefused: (hostId, reason) => { void notifications.hostRefused(hostService.peer(hostId)?.name ?? 'a paired host', reason); }
  });
  defer(() => peers.dispose());
  const projectLinks = new ProjectLinkService(database, git);
  const crossHost = new CrossHostService(database, hostService, peers, projectLinks, timeline, {
    deliver: async (processId, text) => {
      const result = await sendAgentInput(database, terminal, { process_id: processId, kind: 'text', text, submit: true }, integrated);
      return (result as { delivery?: unknown } | null | undefined)?.delivery === 'uncertain' ? 'uncertain' : 'delivered';
    },
    read: (tool, args, scope) => REMOTE_CONTEXT_READ_TOOLS.has(tool)
      ? mcp.call(tool, { ...args, project_id: scope.project_id }, {})
      : mcp.call(tool, args, { remote: { host_id: scope.host.host_id, host_name: scope.host.name, project_id: scope.project_id } }),
    routine: (tool, args, scope) => mcp.call(tool, args, { remote: { host_id: scope.host.host_id, host_name: scope.host.name, project_id: scope.project_id, agent: scope.agent } }),
    bounced: (processId, title, body) => { notifications.deliveryFailed(processId, title, body); }
  });
  remoteClient = new RemoteClientService(hostService, peers, projectLinks, {
    localWorkbench: () => workbench.snapshot(),
    invalidate: () => workbenchSync?.invalidate(),
    terminal,
    terminalSubscriptions,
    resolvePty: (processId) => resolvePtyProcessId(database, processId),
    saveUpload: (name, bytes) => uploads.save(name, bytes),
    notifyRemoteTopics: (topics) => notifyChanged(topics, true),
    isIntegrated: (processId) => Boolean(database.connection.prepare(`select 1 from sessions where process_id = ? and interface_mode = 'integrated' limit 1`).get(processId)),
    subscribeConversation: (processId, listener) => integrated.subscribeConversation(processId, listener),
    // A paired host's UI runs the same tools as a browser, except ones that
    // change this host's settings or pairing.
    allowedTools: new Set([
      ...[...BROWSER_TOOLS].filter((tool) => !tool.startsWith('hosts_') && !tool.startsWith('settings_') && !(MCP_SERVER_TOOLS as readonly string[]).includes(tool)),
      // The command palette pauses, resumes, and cancels timers.
      'timer_cancel', 'timer_pause', 'timer_resume',
      // Socket-only for browsers; the peer route checks control itself.
      'integrated_restart'
    ])
  });
  const remote = remoteClient;
  defer(() => remote.dispose());
  const hosts = new HostActions(hostService, peers, {
    acceptsPairing: options.runtime === 'node' && Boolean(options.publicOrigin),
    pairingBlocked,
    passwordSet: () => serverAccess.passwordSet(),
    // Pairing, linking, and hiding change which records the workbench shows.
    onChange: () => notifyChanged(['settings', 'workbench']),
    projectLinks: (hostId) => projectLinks.links(hostId),
    onUnpaired: (peer) => { void crossHost.bounceQueued(peer.host_id, peer.name); }
  });
  const projectLinkActions = new ProjectLinkActions(projectLinks, hostService, peers, () => notifyChanged(['settings', 'workbench']));

  const routines = new RoutineService({
    database,
    timeline,
    launch: (input) => harnessLauncher.launch(input),
    stopProcess: (processId) => actions.stopProcess.execute(processId),
    presets: () => settings.harnessPresets(),
    notify: raiseNotification,
    onChanged: (workbench) => notifyChanged(workbench ? ['routines', 'workbench'] : ['routines']),
    appDataPath: options.appDataPath,
    log: (event, data) => debugLog.write('routines', event, data)
  });
  defer(() => routines.dispose());

  const usage = new UsageService(database, historyDatabase);
  integrated.setUsage(usage);
  const mcp = createMcpRegistry({
    actions,
    usage: new GetUsageSummaryAction(usage),
    database,
    terminal,
    timeline,
    workbench,
    harnessDiscovery,
    harnessLauncher,
    integrated,
    transcriptImages,
    settings,
    harnessPresets,
    modelCatalog,
    autoSummaries,
    processLauncher,
    searchService,
    historyImportService,
    historySourceService,
    historyImportQueue,
    historyReadService,
    historyMedia: new ConversationMediaService(historyDatabase),
    historyWatcher,
    timers,
    notifications,
    closeRequests,
    assistant: assistantService,
    assistantInbox,
    routines,
    assistantMemory,
    launchingIdentities,
    crossHost
  });
  registerAutoSummaryControl(mcp, autoSummaryActions);
  registerMcpServerTools(mcp, mcpServers);
  registerAssistantTools(mcp, assistantService, settings);
  registerIdleCompactionTools(mcp, settings);
  registerHostTools(mcp, hosts, projectLinkActions);
  registerProjectTools(mcp, {
    rename: new RenameProjectAction(database, timeline),
    remove: new RemoveProjectAction({
      database, timeline, closeProcess: actions.closeProcess, fence: launchFence, integrated,
      timers, links: projectLinks, unlink: projectLinkActions, history: historyImportQueue
    })
  });
  // Remote watches are stored as host ID and process ID.
  timers.setRemoteResolver((address) => {
    const separator = address.indexOf(':');
    const host = separator > 0 ? hostService.peer(address.slice(0, separator)) : null;
    return host ? { host_id: host.host_id, process_id: address.slice(separator + 1), name: host.name } : null;
  });
  peers.start();

  // Live PTY-exit handling (mark sessions/processes exited, auto-restart)
  // publishes a workbench patch to clients.
  const reconciler = new RuntimeReconciler(
    database,
    timeline,
    processLauncher,
    summaryService,
    terminal,
    notifyChanged,
    historyImportQueue,
    searchService,
    startupFrames.values(),
    (processId, exitCode) => raiseNotification({ processId, source: 'runtime', kind: 'failure', body: `Exited with code ${exitCode}` })
  );
  stopBuffering();
  startupFrames.clear();

  defer(() => reconciler.dispose());
  const clientRequests = new TerminalClientRequestService();
  remote.forwardClientRequests(clientRequests);
  defer(terminal.onFrame((frame) => {
    if (frame.type === 'terminal-clipboard') clientRequests.emit({ kind: 'clipboard', processId: frame.processId, text: frame.text });
    else if (frame.type === 'terminal-notification') {
      raiseNotification({ processId: frame.processId, source: 'terminal', kind: frame.source === 'bell' ? 'bell' : 'attention', title: frame.title, body: frame.body });
    }
  }));
  const openExternalUrl = new OpenExternalUrlAction(database, clientRequests);
  const mcpSocket = new McpSocketServer(socketPath, mcp, notifyChanged,
    (token, sessionId) => openCodeServer.resolveIdentity(token, sessionId),
    (input) => {
      const opened = openExternalUrl.execute(input);
      if (typeof input.url === 'string') nativeOAuthCallbacks.observe(input.url);
      return opened;
    },
    mcpServers.socketHandlers(new McpHelperAccess(database, (token) => openCodeServer.isBridgeToken(token), launchingIdentities)));
  defer(() => mcpSocket.stop());
  // Release activity observation before the database closes; persistent
  // hosts keep running and are observed again after reconnect.
  defer(() => integrated.dispose());
  if (!persistent) defer(() => integrated.stopAll());
  const mcpStartedAt = Date.now();
  await mcpSocket.start();
  timers.activate();
  routines.activate();
  debugLog.write('mcp', 'socket.listening', { address: mcpSocket.address, elapsed_ms: Date.now() - mcpStartedAt });
  debugLog.write('startup', 'critical.ready', { elapsed_ms: Date.now() - startupStartedAt });

  let backgroundStartup: Promise<void> | undefined;
  const startupTimer = setTimeout(() => {
    backgroundStartup = runBackgroundStartup({
      signal,
      database,
      debugLog,
      harnessDiscovery,
      modelCatalog,
      historyImportQueue,
      historyWatcher,
      timeline,
      notifyChanged: notifyWorkbenchChanged
    });
  }, 1_000);
  defer(async () => {
    clearTimeout(startupTimer);
    await backgroundStartup;
  });

  let shuttingDown = false;
  const quit = new QuitApplicationAction(database, terminal, timers, integrated, async () => {
    reconciler.dispose();
    await mcpSocket.stop();
  });

  return {
    database,
    serverAccess,
    autoSummaries,
    autoSummaryActions,
    debugLog,
    terminal,
    timers,
    settings,
    harnessPresets,
    modelCatalog,
    timeline,
    mcp,
    workbench,
    notifications,
    hosts,
    peers,
    terminalSubscriptions,
    remote,
    bootstrap: () => ({
      appName: 'patterm-desktop',
      sidecarAvailable: terminal.isAvailable()
    }),
    notifyChanged,
    readWorkbench: (since) => sync.read(since),
    currentWorkbench: () => sync.snapshot(),
    onWorkbenchPatch: (handler) => sync.onPatch(handler),
    onDataChanged: (handler) => {
      events.on('data:changed', handler);
      return () => { events.off('data:changed', handler); };
    },
    onTerminalClientRequest: (handler) => clientRequests.on(handler),
    onNotificationsChanged: (handler) => {
      events.on('notifications:changed', handler);
      return () => { events.off('notifications:changed', handler); };
    },
    onDesktopNotification: (handler) => {
      events.on('notifications:desktop', handler);
      return () => { events.off('notifications:desktop', handler); };
    },
    onAssistantEvent: (handler) => assistantService.onEvent(handler),
    subscribeConversation: (processId: string, listener: (event: IntegratedConversationEvent) => void) => remote.subscribeConversation(processId, listener),
    mcpSignInCallback: (url: string) => mcpOAuth.callbackPage(url),
    dispose,
    shutdown: () => { shuttingDown = true; return quit.execute(); },
    requestQuit: () => options.onQuitRequested?.(),
    isShuttingDown: () => shuttingDown
  } satisfies PattermApplication;
}

function importedConversations(result: unknown): boolean {
  const row = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const importResult = row.import && typeof row.import === 'object' ? row.import as Record<string, unknown> : row;
  return typeof importResult.conversationsImported === 'number' && importResult.conversationsImported > 0;
}

function applyHistoryImportEffects(result: unknown, timeline: TimelineService, resumeCapture: ResumeIdCaptureService): boolean {
  if (!result || typeof result !== 'object') return false;
  const row = result as Record<string, unknown>;
  const importResult = row.import && typeof row.import === 'object' ? row.import as Record<string, unknown> : row;
  let changed = false;
  const event = importResult.timelineEvent;
  if (event && typeof event === 'object' && shouldRecordHistoryImport(event as Record<string, unknown>)) {
    const input = event as Parameters<TimelineService['append']>[0];
    timeline.append(input);
    changed = true;
  }
  const marks = importResult.resumeMarks;
  if (Array.isArray(marks)) {
    for (const mark of marks) {
      if (!mark || typeof mark !== 'object') continue;
      const typed = mark as { session_id?: unknown; resume_id?: unknown };
      if (typeof typed.session_id === 'string' && typeof typed.resume_id === 'string') {
        changed = resumeCapture.markImported(typed.session_id, typed.resume_id) || changed;
      }
    }
  }
  return changed;
}

function shouldRecordHistoryImport(event: Record<string, unknown>): boolean {
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const values = metadata as Record<string, unknown>;
  return values.trigger === 'manual' && (positiveResultCount(values.conversationsImported) || positiveResultCount(values.errorCount));
}

function positiveResultCount(value: unknown): boolean {
  return typeof value === 'number' && value > 0;
}

async function runBackgroundStartup(input: {
  signal: AbortSignal;
  database: DatabaseService;
  debugLog: DebugLogService;
  harnessDiscovery: HarnessDiscoveryService;
  modelCatalog: HarnessModelCatalogService;
  historyImportQueue: AgentHistoryImportQueueService;
  historyWatcher: AgentHistoryWatcherService;
  timeline: TimelineService;
  notifyChanged: () => void;
}): Promise<void> {
  queueHistoryStartupImport(input);

  const discoveryStartedAt = Date.now();
  try {
    const discovered = await new DiscoverHarnessesAction(input.database, input.timeline, input.harnessDiscovery).execute();
    input.debugLog.write('harness', 'discovered', {
      elapsed_ms: Date.now() - discoveryStartedAt,
      available: discovered.harnesses.filter((row) => row.status === 'available').map((row) => row.harness)
    });
    input.notifyChanged();
  } catch (error) {
    input.debugLog.write('harness', 'discover.failed', {
      elapsed_ms: Date.now() - discoveryStartedAt,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  // Model discovery needs the executable paths from the harness scan. Failures
  // are per provider and never block startup.
  input.modelCatalog.start();
  void input.modelCatalog.refresh().catch((error) => {
    input.debugLog.write('harness-models', 'startup.failed', {
      message: error instanceof Error ? error.message : String(error)
    });
  });
}

function queueHistoryStartupImport(input: { signal: AbortSignal; debugLog: DebugLogService; historyImportQueue: AgentHistoryImportQueueService; historyWatcher: AgentHistoryWatcherService }): void {
  const historyStartedAt = Date.now();
  input.historyWatcher.start();
  const timer = setTimeout(() => {
    if (input.signal.aborted) return;
    try {
      input.historyImportQueue.import({ trigger: 'startup' });
      input.debugLog.write('history', 'startup-import.ready', { elapsed_ms: Date.now() - historyStartedAt });
    } catch (error) {
      input.debugLog.write('history', 'startup-import.failed', { elapsed_ms: Date.now() - historyStartedAt, message: error instanceof Error ? error.message : String(error) });
    }
  }, 10_000);
  input.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
}

function startEventLoopMonitor(debugLog: DebugLogService): () => void {
  if (process.env.PATTERM_DEBUG_EVENT_LOOP !== '1') {
    return () => {};
  }
  const thresholdMs = positiveNumber(process.env.PATTERM_DEBUG_EVENT_LOOP_THRESHOLD_MS) ?? 500;
  const intervalMs = 250;
  let expectedAt = Date.now() + intervalMs;
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expectedAt;
    if (lag >= thresholdMs) {
      debugLog.write('event-loop', 'stall', { lag_ms: lag, threshold_ms: thresholdMs });
    }
    expectedAt = now + intervalMs;
  }, intervalMs);
  return () => clearInterval(timer);
}

function positiveNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
