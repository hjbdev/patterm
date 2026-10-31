// Renderer records mirror the workbench and conversation read APIs.
// Nullable DB columns are modelled as `T | null` (not `?: T`) to play nicely
// with `exactOptionalPropertyTypes`. Timestamps are ISO strings (stored as text).

export type ActorType = 'human' | 'agent' | 'system';
export interface AutoSummaryRecord { coverage?: string | null; text: string; status?: string | null; generatedAt: string; provider: string; model: string; }

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  logo?: string | null;
  // 'personal' marks the Personal project, which is not a repository.
  kind?: 'workspace' | 'personal' | 'assistant' | 'bots';
  // Snoozed until this time: notifications held, tucked away in All agents.
  snoozedUntil?: string | null;
  // The paired host that owns a record, which then has a host-qualified ID
  // such as `workstation:process_7`. Absent for this host's own records.
  host?: string;
  // Connected paired hosts this project is linked with, and the qualified ID
  // of the linked project there.
  remotes?: Array<{ host: string; projectId: string; contextRevision?: number; sharesHistory?: boolean }>;
  // Counts writes to the project's todos, scratchpads, links and worktrees.
  // Absent on older paired hosts.
  contextRevision?: number;
  // Set on a paired host's records when that host announces its history
  // changes here, so its history reads can be cached.
  sharesHistory?: boolean;
}

export interface ProjectWorkbench {
  project: ProjectSummary;
  projectSessions: SessionRecord[];
  processes: ProcessRecord[];
  worktrees: WorktreeRecord[];
  timers: TimerRecord[];
}

export interface SidebarState {
  projects: string[];
  sections: string[];
  knownProjects: string[];
  knownSections: string[];
}

export type SessionRole = 'orchestrator' | 'child' | 'process' | 'assistant' | 'routine' | 'bot';
export type ResumeStatus = 'unknown' | 'found' | 'missing' | 'imported';
export type AgentInterface = 'tui' | 'integrated';

// Live activity of an agent/process. Mirrors patterm-cli IdleState
// (internal/app idle detection). Runtime-derived, not a persisted column.
export type ActivityState = 'working' | 'thinking' | 'idle' | 'permission' | 'question' | 'error' | 'unknown';

// sessions → AGENTS
export interface CloseRequestRecord { summary: string; requestedAt: string; }
// `snoozedAt` is set while the agent sleeps until its next message; a
// reminder left for that message stays after it wakes, until dismissed.
export interface SnoozeRecord { snoozedAt: string | null; reminder: string | null; }

export interface SessionRecord {
  summary?: AutoSummaryRecord | null;
  host?: string;
  // The agent asked to be closed and is waiting for the user's answer.
  closeRequest?: CloseRequestRecord | null;
  snooze?: SnoozeRecord | null;
  id: string;
  // Parent agent that spawned this one (null for a root/orchestrator).
  parentId: string | null;
  // The parent agent's process, which may sit in another project, such as a
  // bot's.
  parentProcessId?: string | null;
  // Sidecar PTY id backing this session, used to attach the terminal view.
  ptyProcessId: string | null;
  // Stable processes.id row backing this session, used for lifecycle actions.
  processId: string | null;
  // Lifecycle of the backing process; older hosts omit it.
  processStatus?: string | null;
  worktreeId: string | null;
  harness: string | null;
  interfaceMode: AgentInterface;
  sessionRole: SessionRole;
  // The bot this session runs, for role 'bot'.
  botId?: string | null;
  resumeStatus: ResumeStatus;
  activity: ActivityState;
  // Background tasks still running, such as a shell the agent waits on. Older
  // paired hosts omit it.
  backgroundTasks?: number;
  // When the backing process last changed activity, status or name. Older
  // paired hosts omit it.
  activityAt?: string | null;
  // What an Integrated agent waiting on you asks, in one line. Older paired
  // hosts omit it.
  asking?: string | null;
  lastTitle: string | null;
  displayName: string | null;
  // Chosen, then generated, then native name. Older paired hosts omit it.
  title?: string | null;
  model: string | null;
  reasoning: string | null;
  startedAt: string;
  exitedAt: string | null;
}

export type ProcessStatus = 'running' | 'stopped' | 'exited' | 'failed';

export interface ProcessRecord {
  summary?: AutoSummaryRecord | null;
  host?: string;
  id: string;
  parentProcessId: string | null;
  kind: string;
  name: string;
  command: string;
  cwd: string | null;
  argv: string[];
  status: ProcessStatus | string;
  activity: ActivityState;
  // Background tasks still running. Older paired hosts omit it.
  backgroundTasks?: number;
  // Live sidecar PTY handle backing this process's terminal tab (null once exited).
  ptyProcessId: string | null;
  worktreeId: string | null;
  autoRestart: boolean;
  exitedAt: string | null;
  exitCode: number | null;
}

export type TimerKind = 'delay' | 'idle_any' | 'idle_all' | 'report_any' | 'report_all' | 'output';
export type TimerStatus = 'pending' | 'paused';

export interface TimerRecord {
  id: string;
  kind: TimerKind;
  status: TimerStatus;
  ownerProcessId: string | null;
  watched: string[];
  pattern?: string;
  label: string | null;
  body: string;
  firesAtUnixMs: number | null;
  pausedRemainingMs: number | null;
  createdAtUnixMs: number;
}

export interface WorktreeRecord {
  host?: string;
  id: string;
  repoPath: string;
  worktreePath: string;
  branch: string | null;
}

// Discovered agent-harness CLIs.
export type HarnessId = 'claude' | 'codex' | 'opencode' | 'rawpty';
export type HarnessStatus = 'available' | 'missing' | 'broken';

export interface HarnessInstallationRecord {
  id: string;
  harness: HarnessId | string;
  executablePath: string;
  version: string | null;
  status: HarnessStatus | string;
  discoveredAt: string;
  lastCheckedAt: string;
}

export interface ConversationRecord {
  id: string;
  provider: string;
  providerConversationId: string | null;
  projectId: string | null;
  sessionId: string | null;
  processId: string | null;
  worktreeId: string | null;
  sourceFileId: string | null;
  title: string | null;
  cwd: string | null;
  providerVersion: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  status: string;
  linkConfidence: number | null;
  linkReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  importedAt: string;
  messageCount: number;
}

export interface ConversationMessageRecord {
  id: string;
  conversationId: string;
  providerMessageId: string | null;
  parentProviderMessageId: string | null;
  turnId: string | null;
  seq: number;
  role: string;
  kind: string;
  text: string;
  toolName: string | null;
  toolStatus: string | null;
  toolInputSummary: string | null;
  toolOutputSummary: string | null;
  redactionCount: number;
  tokenCount: number | null;
  providerCreatedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
