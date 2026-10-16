import type { PattermApplication } from '../App';
import { FinishedSubagentsAction, type FinishedSubagent } from '../Actions/FinishedSubagentsAction';
import type { RestartAllResult } from '../Actions/RestartAgentSessionAction';
import type { HarnessInstallationDto, ProcessDto, ProjectWorkbenchDto, SessionDto, WorktreeDto } from '../Repositories/WorkbenchRepository';

export type CommandGroup = 'current' | 'agent' | 'process' | 'create' | 'navigation' | 'worktree' | 'project' | 'app';
// Page rows open their actions instead of running.
export type CommandKind = 'backend' | 'navigate' | 'renderer' | 'page';

export interface CommandPaletteContext {
  active_project_id: string | null;
  active_terminal_id: string | null;
  active_tab: string | null;
  // The routed agent session or process. Integrated agents have no terminal,
  // so these, not the terminal handle, identify the current item.
  active_session_id?: string | null | undefined;
  active_process_id?: string | null | undefined;
}

export interface CommandInputDescriptor {
  type: 'text' | 'process-form' | 'project-form' | 'timer-form';
  title: string;
  placeholder?: string;
  value?: string;
}

export interface CommandTarget {
  kind: 'agent' | 'process' | 'worktree' | 'project';
  projectId: string;
  sessionId?: string;
  processId?: string;
}

export interface SessionWorktreeRef {
  id: string;
  branch: string | null;
  worktree_path: string;
  repo_path: string;
  linked_at: string | null;
  own: boolean;
}

export interface CommandDescriptor {
  id: string;
  label: string;
  hint?: string;
  confirmation?: string;
  // Completes "Press Enter again to …" while the confirmation is armed.
  confirmVerb?: string;
  group: CommandGroup;
  kind: CommandKind;
  input?: CommandInputDescriptor;
  disabled?: boolean;
  // The agent, process, worktree, or project that a row stands for.
  target?: CommandTarget;
  // What Enter does on a row named after its target, such as Restart.
  primary?: string;
  // Further actions for the row, opened with Tab.
  actions?: CommandDescriptor[];
  // Pages where the command is most useful. It ranks first there.
  pages?: string[];
  // Shown in the current item's section. The rest, such as Copy process ID,
  // sit under More actions.
  inline?: boolean;
  // Run by the renderer without a round trip.
  result?: CommandRunResult;
}

export interface CommandRunPayload {
  id: string;
  context: CommandPaletteContext;
  input?: Record<string, unknown> | undefined;
}

export interface CommandRunResult {
  navigate?: {
    projectId?: string | undefined;
    tab?: string | undefined;
    terminalProcessId?: string | undefined;
    sessionId?: string | undefined;
    processId?: string | undefined;
  };
  rendererAction?: 'settings' | 'workspaceSearch' | 'terminalSearch' | 'pickProjectDirectory' | 'quit'
    | 'copy' | 'integrated' | 'sessionContext' | 'reviewChanges' | 'restartAssistant';
  // Parameters for renderer actions.
  integrated?: 'interrupt' | 'new' | 'restart';
  processId?: string;
  sessionId?: string;
  name?: string;
  text?: string;
  worktree?: SessionWorktreeRef;
  refresh?: boolean;
  // Shown once the command has run.
  message?: string;
}

const HARNESS_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  rawpty: 'Raw terminal'
};

const PROCESS_STATUS_LABELS: Record<string, string> = {
  stopped: 'Stopped',
  exited: 'Exited',
  failed: 'Failed'
};

// Activities during which an Integrated agent has a response to stop.
const RESPONDING = new Set(['working', 'thinking', 'permission', 'question']);

export async function listCommandPaletteCommands(application: PattermApplication, context: CommandPaletteContext): Promise<{ commands: CommandDescriptor[] }> {
  const snapshot = application.currentWorkbench();
  const activeProject = projectForContext(snapshot.projects, context);
  const current = currentTarget(activeProject, context);
  // Rows from the open project come first.
  const projects = activeProject ? [activeProject, ...snapshot.projects.filter((project) => project !== activeProject)] : snapshot.projects;
  const commands: CommandDescriptor[] = [];

  if (activeProject && current) commands.push(...await currentCommands(application, activeProject, current));
  for (const project of projects) commands.push(...agentRows(project, activeProject, current));
  for (const project of projects) commands.push(...processRows(project, activeProject, current));
  if (activeProject) {
    commands.push(...createCommands(snapshot.harnesses, activeProject));
    commands.push(...worktreeRows(activeProject));
  }
  commands.push(projectCreateCommand(), ...projectRows(snapshot.projects, activeProject));

  const assistantRestart = await assistantRestartCommand(application);
  if (assistantRestart) commands.push(assistantRestart);
  const restartAll = restartAgentsCommand(snapshot.projects);
  if (restartAll) commands.push(restartAll);

  const confirmation = quitConfirmation(application, snapshot.projects);
  commands.push(
    { id: 'renderer:workspace-search', label: 'Search workspace content…', hint: 'Agents, conversations, and history', group: 'navigation', kind: 'renderer' },
    { id: 'renderer:settings', label: 'Settings', group: 'navigation', kind: 'renderer' },
    { id: 'renderer:quit', label: 'Quit Patterm', hint: 'Stop agents, commands, and timers on this machine', ...(confirmation ? { confirmation } : {}), confirmVerb: 'quit and stop all', group: 'app', kind: 'renderer' }
  );

  return { commands };
}

export async function runCommandPaletteCommand(application: PattermApplication, payload: CommandRunPayload): Promise<CommandRunResult> {
  if (application.isShuttingDown?.() && payload.id !== 'renderer:quit') throw new Error('Patterm is shutting down');
  const snapshot = application.currentWorkbench();
  const activeProject = projectForContext(snapshot.projects, payload.context);
  const id = payload.id;
  const input = payload.input ?? {};

  if (id.startsWith('navigate:')) {
    return navigateResult(id);
  }
  if (id === 'renderer:settings') return { rendererAction: 'settings' };
  if (id === 'renderer:workspace-search') return { rendererAction: 'workspaceSearch' };
  if (id === 'renderer:terminal-search') return { rendererAction: 'terminalSearch' };
  if (id === 'renderer:project-create') return { rendererAction: 'pickProjectDirectory' };
  if (id === 'renderer:quit') {
    if (input.confirmed !== true && quitConfirmation(application, snapshot.projects)) throw new Error('Confirm Quit and stop all before shutting down');
    await application.shutdown();
    return { rendererAction: 'quit' };
  }

  if (id === 'app:restart-agents') {
    if (input.confirmed !== true) throw new Error('Confirm restarting the agents first');
    const result = await application.mcp.call('integrated_restart_all', {}) as RestartAllResult;
    return { refresh: true, message: restartAllMessage(result) };
  }

  const projectId = activeProject?.project.id;
  if (id.startsWith('spawn:agent:')) {
    if (!projectId) throw new Error('No active project');
    const harness = id.slice('spawn:agent:'.length);
    const result = (await callTool(application, 'harness_launch', { harness, project_id: projectId, ...launchOptions(input) })) as { session_id?: string; pty_process_id?: string | null };
    return { navigate: { projectId, ...(result.pty_process_id ? { terminalProcessId: result.pty_process_id } : { sessionId: result.session_id }) }, refresh: true };
  }
  if (id.startsWith('history:resume:')) {
    if (!projectId) throw new Error('No active project');
    const interfaceMode = input.interface_mode === 'tui' || input.interface_mode === 'integrated' ? input.interface_mode : undefined;
    // An empty Integrated agent can be replaced by the resumed conversation.
    const replace = stringInput(input.replace_process_id);
    const result = (await callTool(application, 'history_resume', {
      conversation_id: id.slice('history:resume:'.length),
      project_id: projectId,
      ...(interfaceMode ? { interface_mode: interfaceMode } : {}),
      ...(replace ? { replace_process_id: replace } : {})
    })) as { session_id?: string };
    return { navigate: { projectId, sessionId: result.session_id }, refresh: true };
  }
  if (id.startsWith('timer:')) {
    const [, action, ...rest] = id.split(':');
    const timerId = rest.join(':');
    const tool = action === 'cancel' ? 'timer_cancel' : action === 'pause' ? 'timer_pause' : action === 'resume' ? 'timer_resume' : null;
    if (!tool || !timerId) throw new Error(`unknown timer command ${id}`);
    await callTool(application, tool, { timer_id: timerId });
    return { refresh: true };
  }
  if (id === 'spawn:terminal') {
    if (!projectId) throw new Error('No active project');
    const result = (await callTool(application, 'process_create', { project_id: projectId })) as { pty_process_id?: string };
    return { navigate: { projectId, terminalProcessId: result.pty_process_id }, refresh: true };
  }
  if (id === 'spawn:process') {
    if (!projectId) throw new Error('No active project');
    const command = stringInput(input.command);
    if (!command) throw new Error('Command is required');
    const result = (await callTool(application, 'process_create', {
      project_id: projectId,
      name: stringInput(input.name),
      command,
      auto_restart: Boolean(input.auto_restart)
    })) as { pty_process_id?: string };
    return { navigate: { projectId, terminalProcessId: result.pty_process_id }, refresh: true };
  }
  if (id === 'project:create') {
    const path = stringInput(input.path);
    if (!path) throw new Error('Project path is required');
    const result = (await callTool(application, 'project_create', { path })) as { project_id?: string };
    return { navigate: { projectId: result.project_id }, refresh: true };
  }
  if (id.startsWith('process:')) {
    return runProcessCommand(application, id, input);
  }
  if (id === 'worktree:create') {
    if (!projectId) throw new Error('No active project');
    await callTool(application, 'worktree_create', { project_id: projectId, name: stringInput(input.name) || stringInput(input.value) });
    return { navigate: { projectId, tab: 'worktrees' }, refresh: true };
  }
  if (id === 'worktree:link') {
    if (!projectId) throw new Error('No active project');
    const worktreePath = stringInput(input.worktree_path) || stringInput(input.value);
    if (!worktreePath) throw new Error('Worktree path is required');
    await callTool(application, 'worktree_link', { project_id: projectId, worktree_path: worktreePath });
    return { navigate: { projectId, tab: 'worktrees' }, refresh: true };
  }
  if (id.startsWith('worktree:shell:')) {
    if (!projectId) throw new Error('No active project');
    const worktreeId = id.slice('worktree:shell:'.length);
    const result = (await callTool(application, 'process_create', { project_id: projectId, worktree_id: worktreeId })) as { pty_process_id?: string };
    return { navigate: { projectId, terminalProcessId: result.pty_process_id }, refresh: true };
  }
  if (id.startsWith('worktree:abandon:')) {
    await callTool(application, 'worktree_abandon', { worktree_id: id.slice('worktree:abandon:'.length) });
    return { refresh: true };
  }

  throw new Error(`unknown command ${id}`);
}

// Offered while the assistant runs. A restart interrupts a response, so one
// in progress needs confirming. The renderer restarts it, because only the
// browser controlling the assistant may.
async function assistantRestartCommand(application: PattermApplication): Promise<CommandDescriptor | null> {
  let processId: string | null;
  let row: { activity: string | null } | undefined;
  try {
    ({ process_id: processId } = await callTool(application, 'assistant_get', {}) as { process_id: string | null });
    if (!processId) return null;
    row = application.database.connection.prepare('select activity from processes where id = ?').get(processId) as { activity: string | null } | undefined;
  } catch {
    // The palette still opens when the assistant's state can't be read.
    return null;
  }
  return {
    id: 'assistant:restart',
    label: 'Restart assistant',
    hint: 'Resume its conversation in a new Codex process',
    group: 'app',
    kind: 'renderer',
    result: { rendererAction: 'restartAssistant', processId },
    ...(row?.activity && RESPONDING.has(row.activity) ? { confirmation: 'The assistant is responding, and restarting stops it.', confirmVerb: 'restart it' } : {})
  };
}

// Restarts idle top-level Integrated agents everywhere, so they pick up MCP
// and settings changes. Working agents are left to finish.
function restartAgentsCommand(projects: ProjectWorkbenchDto[]): CommandDescriptor | null {
  const agents = projects.flatMap((project) => project.projectSessions)
    .filter((session) => !session.exitedAt && session.processId && !session.host && session.sessionRole === 'orchestrator' && session.interfaceMode === 'integrated');
  if (!agents.length) return null;
  // As the restart decides: only a finished turn is safe to stop.
  const working = agents.filter((session) => session.activity !== 'idle' && session.activity !== 'error').length;
  const idle = agents.length - working;
  return {
    id: 'app:restart-agents',
    label: 'Restart all agents',
    hint: 'Resume each Integrated conversation in a new process',
    group: 'app',
    kind: 'backend',
    confirmation: `This restarts ${countLabel(idle, 'idle agent')} across all projects and resumes their conversations.${working ? ` ${countLabel(working, 'working agent')} keep${working === 1 ? 's' : ''} running.` : ''}`,
    confirmVerb: 'restart them'
  };
}

export function quitConfirmation(application: PattermApplication, projects = application.currentWorkbench().projects): string | undefined {
  // The workbench includes paired hosts, even inside linked local projects.
  const localProjects = projects.filter((project) => !project.project.host);
  const agents = new Set(localProjects.flatMap((project) => project.projectSessions.filter((session) => !session.host && !session.exitedAt && session.processId).map((session) => session.processId)));
  // The global Assistant and its commands can live outside the workbench.
  const running = application.database.connection.prepare("select id, kind from processes where status = 'running'").all() as Array<{ id: string; kind: string }>;
  for (const row of running) if (row.kind === 'agent') agents.add(row.id);
  const commands = new Set(localProjects.flatMap((project) => project.processes.filter((process) => !process.host && process.status === 'running' && !agents.has(process.id)).map((process) => process.id)));
  for (const row of running) if (row.kind !== 'agent') commands.add(row.id);
  if (agents.size === 0 && commands.size === 0 && application.timers.list().length === 0) return undefined;
  return `This stops ${agents.size} agent${agents.size === 1 ? '' : 's'} and ${commands.size} command${commands.size === 1 ? '' : 's'} across all projects on this machine, including running sleeps and all Patterm timers. Saved conversations remain available to resume.`;
}

type CurrentTarget =
  | { kind: 'agent'; session: SessionDto; processId: string }
  | { kind: 'process'; process: ProcessDto };

async function currentCommands(application: PattermApplication, project: ProjectWorkbenchDto, target: CurrentTarget): Promise<CommandDescriptor[]> {
  if (target.kind === 'process') return processActions(project.project.id, target.process, true);
  const live = !target.session.exitedAt;
  const [worktrees, finished] = await Promise.all([
    sessionWorktrees(application, project.project.id, target.session.id),
    live && application.database ? new FinishedSubagentsAction(application.database).execute(target.processId) : []
  ]);
  return agentActions(project, target.session, target.processId, { current: true, worktrees, finished });
}

function agentActions(
  project: ProjectWorkbenchDto,
  session: SessionDto,
  processId: string,
  extra: { current?: boolean; worktrees?: SessionWorktreeRef[]; finished?: FinishedSubagent[] } = {}
): CommandDescriptor[] {
  const projectId = project.project.id;
  const name = agentLabel(session);
  const group: CommandGroup = extra.current ? 'current' : 'agent';
  const live = !session.exitedAt;
  const integrated = live && session.interfaceMode === 'integrated';
  const commands: CommandDescriptor[] = [];

  if (!extra.current) {
    commands.push({ id: `navigate:agent:${enc(projectId)}:${enc(session.id)}`, label: 'Switch to agent', hint: name, group, kind: 'navigate' });
  }
  // Integrated actions run in the open conversation, which owns its controls.
  if (extra.current && integrated && RESPONDING.has(session.activity)) {
    commands.push({ id: `integrated:interrupt:${processId}`, label: 'Stop response', hint: name, group, kind: 'renderer', inline: true, result: { rendererAction: 'integrated', integrated: 'interrupt', processId } });
  }
  for (const [index, worktree] of (extra.worktrees ?? []).entries()) {
    commands.push({ id: `renderer:review:${session.id}:${worktree.id}`, label: 'Review changes', hint: worktreeName(worktree.branch, worktree.worktree_path), group, kind: 'renderer', inline: index === 0, result: { rendererAction: 'reviewChanges', sessionId: session.id, worktree } });
  }
  if (extra.current && integrated) {
    commands.push({ id: `integrated:new:${processId}`, label: 'New conversation', hint: name, group, kind: 'renderer', inline: true, result: { rendererAction: 'integrated', integrated: 'new', processId } });
    // Top-level agents only: a subagent's parent watches it by process ID.
    if (session.sessionRole === 'orchestrator' && !session.host) {
      commands.push({
        id: `integrated:restart:${processId}`, label: 'Restart agent', hint: 'Resume this conversation in a new process', group, kind: 'renderer', inline: true,
        result: { rendererAction: 'integrated', integrated: 'restart', processId },
        ...(RESPONDING.has(session.activity) ? { confirmation: 'This agent is responding, and restarting stops it.', confirmVerb: 'restart it' } : {})
      });
    }
  }
  if (extra.current && !live && session.interfaceMode === 'integrated' && session.processStatus !== 'closed'
    && session.sessionRole === 'orchestrator' && !session.host) {
    commands.push({ id: `integrated:restart:${processId}`, label: 'Restart agent', hint: 'Resume this conversation in a new process', group, kind: 'renderer', inline: true,
      result: { rendererAction: 'integrated', integrated: 'restart', processId } });
  }
  if (extra.current) {
    commands.push({ id: `renderer:session-context:${session.id}`, label: 'Open session context', hint: 'Worktrees, todos, scratchpads, and links', group, kind: 'renderer', inline: true, result: { rendererAction: 'sessionContext', sessionId: session.id } });
  }
  // The open conversation's settings, such as the model, join here.
  commands.push({ id: `process:rename:${processId}`, label: 'Rename agent…', hint: name, group, kind: 'backend', inline: true, input: { type: 'text', title: 'Rename agent', placeholder: 'Agent name', value: name } });
  if (live) {
    commands.push({ id: `timer:set:${processId}`, label: 'Set timer…', hint: name, group, kind: 'backend', input: { type: 'timer-form', title: 'Set timer' } });
  }
  if (extra.current) {
    const family = liveAgents(project);
    const parent = session.parentId ? family.find((candidate) => candidate.id === session.parentId) : undefined;
    if (parent) commands.push({ ...gotoCommand(projectId, parent), label: 'Go to parent agent', hint: agentLabel(parent) });
    // Subagents are also listed under Agents, so they share one row here.
    const children = family.filter((candidate) => candidate.parentId === session.id);
    if (children.length === 1) commands.push({ ...gotoCommand(projectId, children[0]!), label: 'Go to subagent', hint: agentLabel(children[0]!) });
    else if (children.length) {
      commands.push({ id: `page:subagents:${session.id}`, label: 'Go to subagent…', hint: countLabel(children.length, 'subagent'), group, kind: 'page', actions: children.map((child) => gotoCommand(projectId, child)) });
    }
  }
  commands.push({ id: `renderer:copy:${processId}`, label: 'Copy process ID', hint: processId, group, kind: 'renderer', result: { rendererAction: 'copy', text: processId } });
  commands.push({ id: `process:close:${processId}`, label: 'Close agent', hint: name, group, kind: 'backend', inline: true, ...closeConfirmation(project, processId) });
  if (extra.finished?.length) {
    const one = extra.finished.length === 1;
    commands.push({
      id: `process:close-finished:${processId}`,
      label: 'Close finished subagents',
      hint: `${countLabel(extra.finished.length, 'subagent')} reported and idle`,
      confirmation: `This closes ${listNames(extra.finished.map((child) => child.name))}, which ${one ? 'has' : 'have'} reported and ${one ? 'is' : 'are'} idle.`,
      confirmVerb: one ? 'close it' : 'close them',
      group,
      kind: 'backend'
    });
  }
  return commands;
}

function processActions(projectId: string, process: ProcessDto, current: boolean): CommandDescriptor[] {
  const group: CommandGroup = current ? 'current' : 'process';
  const running = process.status === 'running';
  return [
    ...(!current && running ? [{ id: `navigate:process:${enc(projectId)}:${enc(process.id)}`, label: 'Switch to process', hint: process.name, group, kind: 'navigate' } satisfies CommandDescriptor] : []),
    { id: `process:restart:${process.id}`, label: 'Restart process', hint: process.name, group, kind: 'backend', inline: true },
    ...(running ? [{ id: `process:stop:${process.id}`, label: 'Stop process', hint: process.name, group, kind: 'backend', inline: true } satisfies CommandDescriptor] : []),
    { id: `process:rename:${process.id}`, label: 'Rename process…', hint: process.name, group, kind: 'backend', inline: true, input: { type: 'text', title: 'Rename process', placeholder: 'Process name', value: process.name } },
    { id: `renderer:copy:${process.id}`, label: 'Copy process ID', hint: process.id, group, kind: 'renderer', inline: true, result: { rendererAction: 'copy', text: process.id } },
    { id: `process:close:${process.id}`, label: 'Close process', hint: process.name, confirmation: 'This stops the process.', confirmVerb: 'close it', group, kind: 'backend', inline: true }
  ];
}

function gotoCommand(projectId: string, session: SessionDto): CommandDescriptor {
  return { id: `goto:${session.id}`, label: agentLabel(session), group: 'current', kind: 'navigate', result: { navigate: { projectId, sessionId: session.id } } };
}

// Closing an agent stops it, and everything it started, so it always asks.
function closeConfirmation(project: ProjectWorkbenchDto, processId: string): Pick<CommandDescriptor, 'confirmation' | 'confirmVerb'> {
  const { agents, processes } = runningDescendants(project, processId);
  if (!agents.length && !processes.length) return { confirmation: 'This stops the agent.', confirmVerb: 'close it' };
  const parts = [agents.length ? countLabel(agents.length, 'subagent') : '', processes.length ? countLabel(processes.length, 'process', 'processes') : ''].filter(Boolean).join(' and ');
  const names = [...agents.map(agentLabel), ...processes.map((process) => process.name)];
  return { confirmation: `Also closes ${parts}: ${listNames(names)}.`, confirmVerb: 'close all of them' };
}

function runningDescendants(project: ProjectWorkbenchDto, processId: string): { agents: SessionDto[]; processes: ProcessDto[] } {
  const owners = new Set([processId]);
  const agents: SessionDto[] = [];
  const sessionsByProcess = new Map(project.projectSessions.flatMap((session) => session.processId ? [[session.processId, session] as const] : []));
  // Sessions name their parent session, so walk the agent tree first.
  const pending = [processId];
  while (pending.length) {
    const ownerId = pending.shift()!;
    const owner = sessionsByProcess.get(ownerId);
    if (!owner) continue;
    for (const child of project.projectSessions) {
      if (child.parentId !== owner.id || !child.processId || owners.has(child.processId)) continue;
      owners.add(child.processId);
      pending.push(child.processId);
      if (!child.exitedAt) agents.push(child);
    }
  }
  const processes = project.processes.filter((process) => process.status === 'running' && process.parentProcessId !== null && owners.has(process.parentProcessId));
  return { agents, processes };
}

function agentRows(project: ProjectWorkbenchDto, activeProject: ProjectWorkbenchDto | null, current: CurrentTarget | null): CommandDescriptor[] {
  const projectId = project.project.id;
  const sessions = liveAgents(project);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return sessions
    .filter((session) => !(current?.kind === 'agent' && current.session.id === session.id))
    .map((session) => {
      const parent = session.parentId ? byId.get(session.parentId) : undefined;
      const hint = [parent ? `Subagent of ${agentLabel(parent)}` : '', project === activeProject ? '' : project.project.name].filter(Boolean).join(' · ');
      return {
        id: `navigate:agent:${enc(projectId)}:${enc(session.id)}`,
        label: agentLabel(session),
        ...(hint ? { hint } : {}),
        group: 'agent',
        kind: 'navigate',
        primary: 'Switch',
        target: { kind: 'agent', projectId, sessionId: session.id, processId: session.processId! },
        actions: agentActions(project, session, session.processId!)
      } satisfies CommandDescriptor;
    });
}

// Running processes switch to their terminal. Ended ones restart, since their
// tabs are gone and nothing else in the UI can bring them back.
function processRows(project: ProjectWorkbenchDto, activeProject: ProjectWorkbenchDto | null, current: CurrentTarget | null): CommandDescriptor[] {
  const projectId = project.project.id;
  const owners = new Map(project.projectSessions.flatMap((session) => session.processId ? [[session.processId, session] as const] : []));
  return project.processes.flatMap((process) => {
    if (process.status === 'closed' || (current?.kind === 'process' && current.process.id === process.id)) return [];
    const running = process.status === 'running';
    if (running && !process.ptyProcessId) return [];
    const owner = process.parentProcessId ? owners.get(process.parentProcessId) : undefined;
    const hint = [
      running ? '' : PROCESS_STATUS_LABELS[process.status] ?? 'Ended',
      owner ? `Started by ${agentLabel(owner)}` : '',
      project === activeProject ? '' : project.project.name
    ].filter(Boolean).join(' · ');
    return [{
      id: running ? `navigate:process:${enc(projectId)}:${enc(process.id)}` : `process:restart:${process.id}`,
      label: process.name,
      ...(hint ? { hint } : {}),
      group: 'process',
      kind: running ? 'navigate' : 'backend',
      primary: running ? 'Switch' : 'Restart',
      target: { kind: 'process', projectId, processId: process.id },
      actions: processActions(projectId, process, false)
    } satisfies CommandDescriptor];
  });
}

function createCommands(harnesses: HarnessInstallationDto[], project: ProjectWorkbenchDto): CommandDescriptor[] {
  return [
    ...harnesses
      .filter((harness) => harness.status === 'available' && harness.harness !== 'rawpty')
      .map((harness) => ({ id: `spawn:agent:${harness.harness}`, label: `Spawn ${HARNESS_LABELS[harness.harness] ?? harness.harness}`, group: 'create' as const, kind: 'backend' as const })),
    { id: 'spawn:terminal', label: 'New terminal', group: 'create', kind: 'backend' },
    { id: 'spawn:process', label: 'New process…', hint: 'Run a command in this project', group: 'create', kind: 'backend', input: { type: 'process-form', title: 'New process' } },
    { id: 'worktree:create', label: 'Create worktree', hint: project.project.name, group: 'create', kind: 'backend', pages: ['worktrees'], input: { type: 'text', title: 'Create worktree', placeholder: 'Worktree name' } },
    { id: 'worktree:link', label: 'Link worktree…', hint: 'Choose an existing worktree directory', group: 'create', kind: 'backend', pages: ['worktrees'], input: { type: 'text', title: 'Link worktree', placeholder: '/path/to/worktree' } }
  ];
}

function worktreeRows(project: ProjectWorkbenchDto): CommandDescriptor[] {
  const projectId = project.project.id;
  return project.worktrees.map((worktree) => ({
    id: `worktree:shell:${worktree.id}`,
    label: worktreeLabel(worktree),
    hint: worktree.worktreePath,
    group: 'worktree',
    kind: 'backend',
    primary: 'Open terminal',
    pages: ['worktrees'],
    target: { kind: 'worktree', projectId },
    actions: [
      { id: `worktree:shell:${worktree.id}`, label: 'Open terminal', group: 'worktree', kind: 'backend' },
      { id: `worktree:abandon:${worktree.id}`, label: 'Unlink worktree', hint: 'Keeps files and branch', group: 'worktree', kind: 'backend' }
    ]
  } satisfies CommandDescriptor));
}

function projectRows(projects: ProjectWorkbenchDto[], activeProject: ProjectWorkbenchDto | null): CommandDescriptor[] {
  return projects
    .filter((project) => project !== activeProject)
    .map((project) => ({ id: `navigate:project:${enc(project.project.id)}`, label: project.project.name, hint: project.project.path, group: 'project', kind: 'navigate', primary: 'Open', target: { kind: 'project', projectId: project.project.id } } satisfies CommandDescriptor));
}

function projectCreateCommand(): CommandDescriptor {
  return { id: 'renderer:project-create', label: 'New project', hint: 'Register a local project directory', group: 'create', kind: 'renderer' };
}

async function runProcessCommand(application: PattermApplication, id: string, input: Record<string, unknown>): Promise<CommandRunResult> {
  // Process IDs from a paired host contain a colon, as in workstation:process_7.
  const [, action, ...rest] = id.split(':');
  const processId = rest.join(':');
  if (!processId) throw new Error('Process id is required');
  if (action === 'rename') {
    const name = stringInput(input.name) || stringInput(input.value);
    if (!name) throw new Error('Name is required');
    await callTool(application, 'rename_process', { process_id: processId, name });
    return { refresh: true };
  }
  if (action === 'close') {
    if (input.confirmed !== true) throw new Error('Confirm closing it first');
    await callTool(application, 'close_process', { process_id: processId });
    return { refresh: true };
  }
  if (action === 'close-finished') {
    if (input.confirmed !== true) throw new Error('Confirm closing the finished subagents first');
    if (application.remote.target({ process_id: processId })) throw new Error('Close finished subagents on the host that runs them.');
    for (const child of new FinishedSubagentsAction(application.database).execute(processId)) {
      await callTool(application, 'close_process', { process_id: child.process_id });
    }
    return { refresh: true };
  }
  if (action === 'stop') {
    await callTool(application, 'stop_process', { process_id: processId });
    return { refresh: true };
  }
  if (action === 'restart') {
    await callTool(application, 'process_restart', { process_id: processId });
    return { refresh: true };
  }
  throw new Error(`unknown process command ${id}`);
}

function restartAllMessage(result: RestartAllResult): string {
  const restarted = `Restarted ${countLabel(result.restarted.length, 'agent')}`;
  const working = result.skipped.filter((item) => item.reason === 'working').length;
  const failed = result.skipped.filter((item) => item.reason !== 'working');
  return [restarted, working ? `${working} still working` : '', failed.length ? `${failed.length} could not restart: ${failed.map((item) => `${item.name} (${item.reason})`).join('; ')}` : ''].filter(Boolean).join(' · ');
}

// Navigation IDs encode each ID, because a paired host's IDs contain a colon,
// as in workstation:process_7.
const enc = encodeURIComponent;

function navigateResult(id: string): CommandRunResult {
  const [, kind, project, tail] = id.split(':').map((part) => decodeURIComponent(part));
  if (kind === 'project' && project) return { navigate: { projectId: project } };
  if (kind === 'project-tab' && project && tail) return { navigate: { projectId: project, tab: tail } };
  if (kind === 'terminal' && project && tail) return { navigate: { projectId: project, terminalProcessId: tail } };
  if (kind === 'agent' && project && tail) return { navigate: { projectId: project, sessionId: tail } };
  if (kind === 'process' && project && tail) return { navigate: { projectId: project, processId: tail } };
  throw new Error(`unknown navigation command ${id}`);
}

// Runs a tool here, or on the paired host whose records it names.
function callTool(application: PattermApplication, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const host = application.remote?.target(args);
  return host ? application.remote.relay(host, 'patterm:mcp:call', { tool, arguments: args }) : application.mcp.call(tool, args);
}

function currentTarget(project: ProjectWorkbenchDto | null, context: CommandPaletteContext): CurrentTarget | null {
  if (!project) return null;
  const session = context.active_session_id ? project.projectSessions.find((candidate) => candidate.id === context.active_session_id) : undefined;
  if (session?.processId) return { kind: 'agent', session, processId: session.processId };
  const process = context.active_process_id ? project.processes.find((candidate) => candidate.id === context.active_process_id && candidate.status !== 'closed') : undefined;
  if (process) return { kind: 'process', process };
  return terminalTarget(project, context.active_terminal_id);
}

// Older renderers identify the current item only by its terminal handle.
function terminalTarget(project: ProjectWorkbenchDto, terminalId: string | null): CurrentTarget | null {
  if (!terminalId) return null;
  // Prefer live matches across both kinds before falling back to an exited terminal.
  const procs = project.processes.filter((proc) => proc.ptyProcessId === terminalId || proc.id === terminalId);
  const sessions = project.projectSessions.filter((session) => session.ptyProcessId === terminalId && session.processId);
  const liveProc = procs.find((candidate) => candidate.status === 'running');
  const liveSession = sessions.find((candidate) => !candidate.exitedAt);
  const proc = liveProc ?? (liveSession ? undefined : procs[0]);
  if (proc) return { kind: 'process', process: proc };
  const session = liveSession ?? sessions[0];
  if (session?.processId) return { kind: 'agent', session, processId: session.processId };
  return null;
}

// Live agents in tab order: each root followed by its subagents.
function liveAgents(project: ProjectWorkbenchDto): SessionDto[] {
  const live = project.projectSessions.filter((session) => !session.exitedAt && session.processId && (session.interfaceMode === 'integrated' || session.ptyProcessId));
  const ids = new Set(live.map((session) => session.id));
  const children = new Map<string | null, SessionDto[]>();
  for (const session of live) {
    const parentId = session.parentId && ids.has(session.parentId) ? session.parentId : null;
    children.set(parentId, [...(children.get(parentId) ?? []), session]);
  }
  const ordered: SessionDto[] = [];
  const visit = (parentId: string | null): void => {
    for (const session of children.get(parentId) ?? []) {
      ordered.push(session);
      visit(session.id);
    }
  };
  visit(null);
  return ordered;
}

async function sessionWorktrees(application: PattermApplication, projectId: string, sessionId: string): Promise<SessionWorktreeRef[]> {
  if (!application.mcp) return [];
  try {
    const context = (await callTool(application, 'session_context', { project_id: projectId, session_id: sessionId, limit: 1 })) as { worktrees?: { items?: SessionWorktreeRef[] } };
    return context.worktrees?.items ?? [];
  } catch {
    // The rest of the palette is still useful without diff review.
    return [];
  }
}

function projectForContext(projects: ProjectWorkbenchDto[], context: CommandPaletteContext): ProjectWorkbenchDto | null {
  return projects.find((project) => project.project.id === context.active_project_id) ?? null;
}

function agentLabel(session: SessionDto): string {
  return session.title ?? session.displayName ?? session.lastTitle ?? session.harness ?? 'agent';
}

function worktreeLabel(worktree: WorktreeDto): string {
  return worktreeName(worktree.branch, worktree.worktreePath) || worktree.id;
}

function worktreeName(branch: string | null, path: string): string {
  return branch ?? path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

function countLabel(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

function listNames(names: string[]): string {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown}, and ${names.length - 3} more` : shown;
}

// Launch choices from the palette. The launch tool validates them.
function launchOptions(input: Record<string, unknown>): Record<string, string> {
  const options: Record<string, string> = {};
  for (const key of ['preset', 'worktree_id', 'initial_prompt'] as const) {
    const value = stringInput(input[key]);
    if (value) options[key] = value;
  }
  if (input.interface_mode === 'tui' || input.interface_mode === 'integrated') options.interface_mode = input.interface_mode;
  return options;
}

function stringInput(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
