import { harnessProviders } from '../Harness/providers';
import { commandFromShellArgv } from '../Platform/Shell';
import type { DatabaseService } from '../Services/DatabaseService';
import { USER_PROJECT_KINDS_SQL } from '../Services/PersonalProject';
import { SettingsService, type SidebarState } from '../Services/SettingsService';
import type { TimerRecord, TimerService } from '../Services/TimerService';
import type { StatusLabel } from '../Services/StatusLabels';
import type { StatusLabelColor } from '../Services/StatusLabelCommon';

// Renderer-facing (camelCase) shapes. These intentionally mirror the interfaces
// in resources/js/types.ts so the IPC payload drops straight into the UI.

export interface AutoSummaryDto { coverage?: string | null; text: string; status?: string | null; generatedAt: string; provider: string; model: string; }

export interface ProjectSummaryDto {
  id: string;
  name: string;
  path: string;
  logo: string | null;
  // 'personal' marks the Personal project, which is not a repository. Absent
  // on records from older paired hosts.
  kind?: ProjectKind;
  // Snoozed until this time: its notifications are held and All agents
  // tucks it away. Null when awake; absent on older paired hosts.
  snoozedUntil?: string | null;
  // The paired host that owns this record; absent for this host's own.
  host?: string;
  // Connected paired hosts this project is linked with, and the qualified ID
  // of the linked project there, for launching on that host.
  remotes?: Array<{ host: string; projectId: string; contextRevision?: number; sharesHistory?: boolean }>;
  // Counts writes to the project's todos, scratchpads, links and worktrees.
  // Clients key cached context reads by it. Only workbench snapshots carry
  // it, and older paired hosts omit it.
  contextRevision?: number;
  // Set on a paired host's records when that host announces its history
  // changes here, so its history reads can be cached.
  sharesHistory?: boolean;
}

export interface CloseRequestDto { summary: string; requestedAt: string; }

// A status label pinned on a running agent, resolved from this host's
// settings, so a paired host's records carry their own name and colour.
export interface StatusLabelDto { id: string; name: string; color: StatusLabelColor; setBy: 'agent' | 'user'; setAt: string; }

// `snoozedAt` is set while the agent sleeps until its next message; a
// reminder left for that message stays after it wakes, until dismissed.
export interface SnoozeDto { snoozedAt: string | null; reminder: string | null; }

export interface SessionDto {
  summary?: AutoSummaryDto | null;
  host?: string;
  // The agent asked to be closed and is waiting for the user's answer.
  closeRequest?: CloseRequestDto | null;
  // Older paired hosts omit it.
  snooze?: SnoozeDto | null;
  id: string;
  parentId: string | null;
  // The parent agent's process, which may sit in another project, such as a
  // bot's. Older paired hosts omit it.
  parentProcessId?: string | null;
  processId: string | null;
  // Lifecycle of the backing process; older hosts omit it.
  processStatus?: string | null;
  ptyProcessId: string | null;
  worktreeId: string | null;
  harness: string | null;
  interfaceMode: 'tui' | 'integrated';
  sessionRole: string;
  // The bot this session runs. Older paired hosts omit it.
  botId?: string | null;
  // The bot whose session started this one, such as a detached agent a bot
  // opened. Older paired hosts omit it.
  ownerBotId?: string | null;
  resumeStatus: string;
  activity: string;
  // Background tasks still running, such as a shell the agent waits on. Older
  // paired hosts omit it.
  backgroundTasks?: number;
  // When the backing process last changed activity, status or name, for
  // sorting by recent activity. Older paired hosts omit it.
  activityAt?: string | null;
  // What an Integrated agent waiting on you asks, in one line. Null while
  // nothing is pending; older paired hosts omit it.
  asking?: string | null;
  // Null when none is pinned; older paired hosts omit it.
  statusLabel?: StatusLabelDto | null;
  lastTitle: string | null;
  displayName: string | null;
  // The name to show: chosen, then generated, then native. Older paired hosts omit it.
  title?: string | null;
  model: string | null;
  reasoning: string | null;
  startedAt: string;
  exitedAt: string | null;
}

export interface ProcessDto {
  summary?: AutoSummaryDto | null;
  host?: string;
  id: string;
  parentProcessId: string | null;
  kind: string;
  name: string;
  command: string;
  cwd: string | null;
  argv: string[];
  status: string;
  activity: string;
  // Background tasks still running. Older paired hosts omit it.
  backgroundTasks?: number;
  ptyProcessId: string | null;
  worktreeId: string | null;
  autoRestart: boolean;
  exitedAt: string | null;
  exitCode: number | null;
}

export interface WorktreeDto {
  host?: string;
  id: string;
  repoPath: string;
  worktreePath: string;
  branch: string | null;
}

export interface HarnessInstallationDto {
  id: string;
  harness: string;
  executablePath: string;
  version: string | null;
  status: string;
  discoveredAt: string;
  lastCheckedAt: string;
}

export interface ProjectWorkbenchDto {
  project: ProjectSummaryDto;
  projectSessions: SessionDto[];
  processes: ProcessDto[];
  worktrees: WorktreeDto[];
  // Pending and paused timers that call back into this project's processes.
  timers: TimerRecord[];
}

export interface WorkbenchSnapshotDto {
  projects: ProjectWorkbenchDto[];
  harnesses: HarnessInstallationDto[];
  sidebarState: SidebarState;
  terminalAvailable: boolean;
}

export type ProjectKind = 'workspace' | 'personal' | 'assistant' | 'bots';

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  logo: string | null;
  kind: ProjectKind;
  snoozed_until: string | null;
  context_revision: number;
}

interface SessionRow {
  id: string;
  process_id: string | null;
  pty_process_id?: string | null;
  worktree_id: string | null;
  harness: string | null;
  interface_mode: 'tui' | 'integrated';
  session_role: string;
  bot_id?: string | null;
  owner_bot_id?: string | null;
  resume_status: string;
  last_title: string | null;
  display_name: string | null;
  title: string | null;
  model: string | null;
  reasoning: string | null;
  started_at: string;
  exited_at: string | null;
}

interface ProcessRow {
  auto_summary: string | null;
  auto_summary_coverage: string | null;
  auto_status: string | null;
  auto_summary_at: string | null;
  auto_summary_provider: string | null;
  auto_summary_model: string | null;
  close_requested_at: string | null;
  close_request_summary: string | null;
  snoozed_at: string | null;
  snooze_reminder: string | null;
  id: string;
  parent_process_id: string | null;
  kind: string;
  name: string;
  cwd: string | null;
  argv: string | null;
  status: string;
  activity: string;
  background_tasks: number;
  asking: string | null;
  status_label_id: string | null;
  status_label_set_at: string | null;
  status_label_set_by: string | null;
  pty_process_id: string | null;
  worktree_id: string | null;
  auto_restart: number;
  exited_at: string | null;
  exit_code: number | null;
  updated_at: string;
}

interface WorktreeRow {
  id: string;
  repo_path: string;
  worktree_path: string;
  branch: string | null;
}

interface HarnessInstallationRow {
  id: string;
  harness: string;
  executable_path: string;
  version: string | null;
  status: string;
  discovered_at: string;
  last_checked_at: string;
}

// Sessions and processes that ended longer ago than this are left out of the
// snapshot that clients load and patch. Views read them on demand.
export const WORKBENCH_HISTORY_MS = 24 * 60 * 60 * 1000;

export class WorkbenchRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings = new SettingsService(database),
    private readonly timers?: Pick<TimerService, 'list'>,
    private readonly now: () => number = Date.now,
    private readonly terminalAvailable: () => boolean = () => false
  ) {}

  private get db() {
    return this.database.connection;
  }

  // The user's projects, with the Personal project first. Hidden in Settings,
  // Personal still lists while anything runs there, so no agent goes missing.
  private projectRows(): ProjectRow[] {
    const showPersonal = this.settings.appearanceSettings().personalProject;
    return this.db.prepare(`select id, name, path, logo, kind, snoozed_until, context_revision from projects where kind in ${USER_PROJECT_KINDS_SQL}
      and (kind <> 'personal' or ? or exists (select 1 from processes where processes.project_id = projects.id and processes.status = 'running'))
      order by kind = 'personal' desc, created_at asc`).all(showPersonal ? 1 : 0) as ProjectRow[];
  }

  listProjects(): ProjectSummaryDto[] {
    return this.projectRows().map(projectSummary);
  }

  getProject(id: string): ProjectSummaryDto | null {
    const row = this.db.prepare(`select id, name, path, logo, kind, snoozed_until, context_revision from projects where id = ?`).get(id) as ProjectRow | undefined;
    return row ? projectSummary(row) : null;
  }

  listHarnesses(): HarnessInstallationDto[] {
    const rows = this.db
      .prepare(`select * from harness_installations order by harness asc`)
      .all() as HarnessInstallationRow[];
    return rows.filter((row) => harnessProviders.some((provider) => provider.id === row.harness)).map(mapHarness);
  }

  snapshot(): WorkbenchSnapshotDto {
    const harnesses = this.listHarnesses();
    // The bots' and the assistant's hidden projects ride along so the
    // sidebar can list them with their status and open their conversations.
    // They never join the user's project lists.
    const hidden = this.db.prepare(`select id, name, path, logo, kind, snoozed_until, context_revision from projects where kind in ('bots', 'assistant')`).all() as ProjectRow[];
    const projectRows = [...this.projectRows(), ...hidden];
    const timers = this.timers?.list() ?? [];
    const labels = this.settings.statusLabels().labels;

    return { projects: projectRows.map((project) => this.projectWorkbench(project, timers, labels)), harnesses, sidebarState: this.settings.sidebarState(), terminalAvailable: this.terminalAvailable() };
  }

  updateSidebarState(input: SidebarState): SidebarState {
    return this.settings.updateSidebarState(input);
  }

  // One session or process, whether or not the snapshot still lists it. An
  // agent's process ID alone reads its latest session.
  record(input: { project_id: string; session_id?: string | undefined; process_id?: string | undefined }): { session: SessionDto | null; process: ProcessDto | null } {
    const processRows = this.db
      .prepare(`select * from processes where project_id = ? order by created_at asc`)
      .all(input.project_id) as ProcessRow[];
    const sessionRow = input.session_id
      ? this.db.prepare(`select ${SESSION_COLUMNS} from sessions left join processes on processes.id = sessions.process_id ${SESSION_OWNER_JOIN} where sessions.project_id = ? and sessions.id = ?`)
        .get(input.project_id, input.session_id) as SessionRow | undefined
      : input.process_id
        ? this.db.prepare(`select ${SESSION_COLUMNS} from sessions join processes on processes.id = sessions.process_id ${SESSION_OWNER_JOIN}
            where sessions.project_id = ? and sessions.process_id = ? and processes.kind = 'agent' order by sessions.started_at desc limit 1`)
          .get(input.project_id, input.process_id) as SessionRow | undefined
        : undefined;
    const processRow = input.process_id ? processRows.find((row) => row.id === input.process_id && row.kind !== 'agent') : undefined;
    return {
      session: sessionRow ? mapSessions([sessionRow], processRows, this.settings.statusLabels().labels)[0] ?? null : null,
      process: processRow ? mapProcess(processRow) : null
    };
  }

  private projectWorkbench(project: ProjectRow, timers: TimerRecord[], labels: StatusLabel[]): ProjectWorkbenchDto {
    // Keep recent history, assigned sessions, and ancestors of live processes.
    // An old failed parent must not disappear from its surviving family.
    const since = this.now() - WORKBENCH_HISTORY_MS;
    const sessionRows = this.db
      .prepare(`with recursive ancestors(id) as (
          select parent_process_id from processes where project_id = ? and status = 'running' and parent_process_id is not null
          union
          select p.parent_process_id from processes p join ancestors a on a.id = p.id
            where p.project_id = ? and p.parent_process_id is not null
        )
        select ${SESSION_COLUMNS} from sessions left join processes on processes.id = sessions.process_id ${SESSION_OWNER_JOIN}
        where sessions.project_id = ? and (sessions.exited_at is null or julianday(sessions.exited_at) >= julianday(?)
          or sessions.process_id in (select id from ancestors)
          or exists (select 1 from todo_assignments where todo_assignments.session_id = sessions.id))
        order by sessions.started_at asc`)
      .all(project.id, project.id, project.id, new Date(since).toISOString()) as SessionRow[];
    // Every process is read: parents and timers may belong to ended ones.
    const processRows = this.db
      .prepare(`select * from processes where project_id = ? order by created_at asc`)
      .all(project.id) as ProcessRow[];
    const sessions = mapSessions(sessionRows, processRows, labels);
    const processIds = new Set(processRows.map((row) => row.id));
    const recent = (row: ProcessRow) => row.status === 'running' || !row.exited_at || Date.parse(row.exited_at) >= since;

    return {
      project: { ...projectSummary(project), contextRevision: project.context_revision },
      projectSessions: sessions,
      processes: processRows.filter((row) => row.kind !== 'agent' && recent(row)).map(mapProcess),
      worktrees: (this.db.prepare('select * from worktrees where project_id = ? order by created_at').all(project.id) as WorktreeRow[]).map(mapWorktree),
      timers: timers.filter((timer) => timer.ownerProcessId !== null && processIds.has(timer.ownerProcessId))
    };
  }

}

// A session started by a bot's own session, such as a detached agent it
// opened, names that bot. The owner may sit in the bot's hidden project.
const SESSION_COLUMNS = 'sessions.*, processes.pty_process_id, owner.bot_id as owner_bot_id';
const SESSION_OWNER_JOIN = 'left join sessions owner on owner.id = sessions.created_by_actor';

// The snapshot also carries the bots' and the assistant's hidden projects;
// lists of the user's projects, agents and processes leave them out.
export function listedProject(project: ProjectWorkbenchDto): boolean {
  return project.project.kind !== 'bots' && project.project.kind !== 'assistant';
}

function projectSummary(row: ProjectRow): ProjectSummaryDto {
  return { id: row.id, name: row.name, path: row.path, logo: row.logo, kind: row.kind, snoozedUntil: row.snoozed_until };
}

// Derive each session's parent session via the backing process tree:
// session → process → parent_process → the session owning that process.
function mapSessions(sessions: SessionRow[], processes: ProcessRow[], labels: StatusLabel[]): SessionDto[] {
  const statuses = new Map(processes.map((process) => [process.id, process.status]));
  const summaries = new Map(processes.map((process) => [process.id, mapAutoSummary(process)]));
  const closeRequests = new Map(processes.map((process) => [process.id, mapCloseRequest(process)]));
  const snoozes = new Map(processes.map((process) => [process.id, mapSnooze(process)]));
  const backgroundTasks = new Map(processes.map((process) => [process.id, process.background_tasks]));
  const asking = new Map(processes.map((process) => [process.id, process.asking]));
  const labelsById = new Map(labels.map((label) => [label.id, label]));
  const statusLabels = new Map(processes.map((process) => [process.id, mapStatusLabel(process, labelsById)]));
  const parentProcessByProcessId = new Map<string, string | null>();
  const activityByProcessId = new Map<string, string>();
  const activityAtByProcessId = new Map<string, string>();
  for (const process of processes) {
    parentProcessByProcessId.set(process.id, process.parent_process_id);
    activityByProcessId.set(process.id, process.activity);
    activityAtByProcessId.set(process.id, process.updated_at);
  }
  const sessionByProcessId = new Map<string, string>();
  for (const session of sessions) {
    if (session.process_id) {
      sessionByProcessId.set(session.process_id, session.id);
    }
  }

  return sessions.map((session) => {
    const parentProcessId = session.process_id ? parentProcessByProcessId.get(session.process_id) ?? null : null;
    const parentId = parentProcessId ? sessionByProcessId.get(parentProcessId) ?? null : null;
    return {
      id: session.id,
      parentId,
      parentProcessId,
      processId: session.process_id,
      processStatus: session.process_id ? statuses.get(session.process_id) ?? null : null,
      summary: session.process_id ? summaries.get(session.process_id) ?? null : null,
      closeRequest: session.process_id ? closeRequests.get(session.process_id) ?? null : null,
      snooze: session.process_id ? snoozes.get(session.process_id) ?? null : null,
      ptyProcessId: session.pty_process_id ?? null,
      worktreeId: session.worktree_id,
      harness: session.harness,
      interfaceMode: session.interface_mode,
      sessionRole: session.session_role,
      botId: session.bot_id ?? null,
      ownerBotId: session.owner_bot_id ?? null,
      resumeStatus: session.resume_status,
      activity: session.process_id ? activityByProcessId.get(session.process_id) ?? 'idle' : 'idle',
      backgroundTasks: session.process_id ? backgroundTasks.get(session.process_id) ?? 0 : 0,
      activityAt: session.process_id ? activityAtByProcessId.get(session.process_id) ?? null : null,
      asking: session.process_id ? asking.get(session.process_id) ?? null : null,
      statusLabel: session.process_id ? statusLabels.get(session.process_id) ?? null : null,
      lastTitle: session.last_title,
      displayName: session.display_name,
      title: session.title,
      model: session.model,
      reasoning: session.reasoning,
      startedAt: session.started_at,
      exitedAt: session.exited_at
    };
  });
}

function mapProcess(row: ProcessRow): ProcessDto {
  const argv = parseArgv(row.argv);
  return {
    id: row.id,
    summary: mapAutoSummary(row),
    parentProcessId: row.parent_process_id,
    kind: row.kind,
    name: row.name,
    command: commandFromShellArgv(argv),
    cwd: row.cwd,
    argv,
    status: row.status,
    activity: row.activity,
    backgroundTasks: row.background_tasks,
    ptyProcessId: row.pty_process_id,
    worktreeId: row.worktree_id,
    autoRestart: row.auto_restart === 1,
    exitedAt: row.exited_at,
    exitCode: row.exit_code
  };
}

function mapAutoSummary(row: ProcessRow): AutoSummaryDto | null {
  return row.auto_summary && row.auto_summary_at && row.auto_summary_provider && row.auto_summary_model
    ? { text: row.auto_summary, coverage: row.auto_summary_coverage, status: row.auto_status, generatedAt: row.auto_summary_at, provider: row.auto_summary_provider, model: row.auto_summary_model } : null;
}

// Shown once the turn that asked has finished.
function mapCloseRequest(row: ProcessRow): CloseRequestDto | null {
  if (!row.close_requested_at || row.status !== 'running' || row.activity === 'working' || row.activity === 'thinking') return null;
  return { summary: row.close_request_summary ?? '', requestedAt: row.close_requested_at };
}

// Only a running agent shows its label, and a deleted label reads as none.
function mapStatusLabel(row: ProcessRow, labels: Map<string, StatusLabel>): StatusLabelDto | null {
  const label = row.status === 'running' && row.status_label_id ? labels.get(row.status_label_id) : undefined;
  return label && row.status_label_set_at ? { id: label.id, name: label.name, color: label.color, setBy: row.status_label_set_by === 'user' ? 'user' : 'agent', setAt: row.status_label_set_at } : null;
}

function mapSnooze(row: ProcessRow): SnoozeDto | null {
  const snoozedAt = row.status === 'running' ? row.snoozed_at : null;
  return snoozedAt || row.snooze_reminder ? { snoozedAt, reminder: row.snooze_reminder } : null;
}

function parseArgv(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}



function mapWorktree(row: WorktreeRow): WorktreeDto {
  return {
    id: row.id,
    repoPath: row.repo_path,
    worktreePath: row.worktree_path,
    branch: row.branch
  };
}

function mapHarness(row: HarnessInstallationRow): HarnessInstallationDto {
  return {
    id: row.id,
    harness: row.harness,
    executablePath: row.executable_path,
    version: row.version,
    status: row.status,
    discoveredAt: row.discovered_at,
    lastCheckedAt: row.last_checked_at
  };
}
