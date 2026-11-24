import type { HarnessId } from '../Harness/HarnessProvider';
import type { IntegratedConversationEvent, IntegratedConversationListener, IntegratedConversationMessage, IntegratedTask, IntegratedTaskOutput, IntegratedUsage } from '../Services/IntegratedConversation';
import type { IntegratedDeliveryState } from '../Services/IntegratedDelivery';
import type { IntegratedGoal, IntegratedGoalAction, IntegratedGoalMarker } from '../Services/IntegratedGoal';
import type { ResolvedIntegratedPrompt } from '../Services/IntegratedInput';
import type { McpLaunchServer } from '../Services/McpServerRegistry';
import type { MemoryUpdate } from '../Services/MemoryPushService';
import type { IntegratedFormRequest, IntegratedPermission, IntegratedQuestionRequest, IntegratedQueuedMessage } from '../Services/TranscriptProjection';

export type AgentAdapterId = HarnessId;

export type AgentArchiveFallback = 'always' | 'when-unavailable' | 'never';

export type AgentHostKind = 'supervised-socket' | 'external-daemon';

export type SupervisedHostKind = 'claude-host' | 'app-server' | 'acp-host';

export interface AgentCapabilities {
  hostKind: AgentHostKind;
  hibernation: {
    supported: boolean;
    canResume?: (cwd: string, resumeId: string) => boolean;
  };
  archiveFallback: AgentArchiveFallback;
  input: {
    steering: boolean;
    nativeQueue: boolean;
    configureWhileBusy: boolean;
    routineDigest: boolean;
  };
  interactions: {
    permissions: boolean;
    questions: boolean;
    forms: boolean;
    parentReadAutoApprove: boolean;
  };
  features: {
    goals: boolean;
    compact: boolean;
    slashCommands: boolean;
    memoryPush: boolean;
    quietReplies: boolean;
    voice: boolean;
    statelessGenerate: boolean;
    serviceTier: boolean;
    liveModels: boolean;
    sessionDirectory: boolean;
    olderMessages: boolean;
  };
  selectors: {
    reasoning?: string;
    speed?: string;
  };
  compaction: {
    defaultCacheTtlMs: number | null;
    modelCacheTtlMs?: (model: string | null) => number | null;
  };
}

export function defaultAgentCapabilities(overrides: Partial<AgentCapabilities> = {}): AgentCapabilities {
  return {
    hostKind: overrides.hostKind ?? 'supervised-socket',
    hibernation: {
      supported: false,
      ...overrides.hibernation
    },
    archiveFallback: overrides.archiveFallback ?? 'never',
    input: {
      steering: false,
      nativeQueue: false,
      configureWhileBusy: true,
      routineDigest: false,
      ...overrides.input
    },
    interactions: {
      permissions: true,
      questions: false,
      forms: false,
      parentReadAutoApprove: false,
      ...overrides.interactions
    },
    features: {
      goals: false,
      compact: false,
      slashCommands: false,
      memoryPush: false,
      quietReplies: false,
      voice: false,
      statelessGenerate: false,
      serviceTier: false,
      liveModels: false,
      sessionDirectory: false,
      olderMessages: false,
      ...overrides.features
    },
    selectors: {
      ...overrides.selectors
    },
    compaction: {
      defaultCacheTtlMs: null,
      ...overrides.compaction
    }
  };
}

// Structured runtime state persisted in sessions.runtime_state so host socket,
// PID, config path, hibernation state, and adapter metadata are never packed
// into positional indices of processes.argv.
export interface SessionRuntimeState {
  hostKind?: SupervisedHostKind;
  executable?: string;
  socketPath?: string;
  pid?: number | null;
  configPath?: string;
  hibernatedAt?: string | null;
  adapterData?: Record<string, unknown>;
}

export interface AgentLaunchInput {
  executable: string;
  cwd: string;
  // The user's chosen name, or null to let the native agent title the session.
  name: string | null;
  context: string;
  mcp: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  // The user's global MCP servers for this harness.
  mcpServers?: McpLaunchServer[];
  resumeId: string | null;
  model?: string | null;
  reasoning?: string | null;
  serviceTier?: string | null;
  // A restart reconnects MCP servers a shared daemon keeps across sessions,
  // so their tool lists are fetched again.
  reconnectMcp?: boolean;
  // Recovery fallbacks are not explicit model/effort overrides. A provider's
  // saved controls can be newer than the stopped session's launch columns.
  restoreSavedSettings?: boolean;
  // The assistant and bots: Patterm keeps their saved memory current.
  memoryPush?: boolean;
  // Set when transparently waking a hibernated session in place so duplicate-attach
  // checks ignore the session's own live row.
  wakingSessionId?: string;
  quietNotificationReplies?: boolean;
}

export interface AgentLaunchResult {
  resumeId: string;
  argv: string[];
  runtimeState?: SessionRuntimeState;
}

export interface AgentLiveSettings {
  model?: string | null;
  reasoning?: string | null;
  service_tier?: string | null;
}

export type AgentFormAction = 'accept' | 'decline' | 'cancel';

export interface AgentControlSelector {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string; description?: string }>;
}

export interface AgentCommand {
  name: string;
  description?: string;
  source?: 'patterm';
}

export interface AgentControls {
  selectors: AgentControlSelector[];
  commands: AgentCommand[];
  revision?: string;
  goals?: import('../Services/IntegratedGoal').IntegratedGoalSupport;
}

export interface AgentReviewPrompt {
  id: string;
  revoked: AbortSignal;
  current(): boolean;
}

export interface AdapterRecoveryAction {
  id: string;
  label: string;
  description: string;
  detail?: string;
}

export interface AgentPendingRequests {
  permissions: { data: IntegratedPermission[] };
  questions: { data: IntegratedQuestionRequest[] };
  forms: { data: IntegratedFormRequest[] };
}

export interface AgentConversationDiagnostics {
  unhandled?: unknown[];
  [key: string]: unknown;
}

export interface AgentConversationSnapshot {
  process_id?: string;
  session_id?: string;
  provider_session_id?: string | null;
  provider?: string;
  status?: string;
  status_detail?: string | null;
  revision?: number;
  controls_revision?: string;
  streaming?: boolean;
  hibernated?: boolean;
  history_truncated?: boolean;
  history_unavailable?: boolean;
  history_cursor?: { next?: string | null } | string | null;
  history_spliced_id?: string | null;
  last_turn_boundary_at?: string | null;
  messages?: { data: IntegratedConversationMessage[] } | IntegratedConversationMessage[];
  archived_messages?: unknown[];
  permissions?: { data: IntegratedPermission[] } | IntegratedPermission[];
  questions?: { data: IntegratedQuestionRequest[] } | IntegratedQuestionRequest[];
  forms?: { data: IntegratedFormRequest[] } | IntegratedFormRequest[];
  usage?: IntegratedUsage | null;
  tasks?: IntegratedTask[];
  queue?: IntegratedQueuedMessage[];
  goal?: IntegratedGoal | null;
  goal_markers?: IntegratedGoalMarker[];
  diagnostics?: AgentConversationDiagnostics;
  mode?: string | null;
  recovery?: AdapterRecoveryAction | null;
  [key: string]: unknown;
}

export interface AgentOlderMessagesPage {
  messages?: { data: IntegratedConversationMessage[] } | IntegratedConversationMessage[];
  archived_messages?: unknown[];
  cursor?: string | null;
  [key: string]: unknown;
}

export interface AgentPromptResult {
  id?: string;
  turnId?: string;
  queued?: boolean;
  [key: string]: unknown;
}

export type AgentTaskOutput = IntegratedTaskOutput;

export type AgentEvent = IntegratedConversationEvent;
export type AgentEventListener = IntegratedConversationListener;

export interface AgentAdapter {
  readonly id?: string;
  readonly capabilities?: AgentCapabilities;
  prepare(input: AgentLaunchInput): Promise<AgentLaunchResult>;
  conversation(processId: string): Promise<AgentConversationSnapshot>;
  olderMessages?(processId: string, cursor: string): Promise<AgentOlderMessagesPage>;
  prompt(processId: string, input: ResolvedIntegratedPrompt, review?: AgentReviewPrompt): Promise<AgentPromptResult | void>;
  interrupt(processId: string, options?: { resume?: boolean }): Promise<void>;
  stopTask?(processId: string, taskId: string): Promise<void>;
  taskOutput?(processId: string, taskId: string, since?: string | null, cursor?: string | null): Promise<AgentTaskOutput>;
  updateQueued?(processId: string, messageId: string, action: 'steer' | 'cancel'): Promise<void>;
  replyPermission(processId: string, requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<void>;
  replyQuestion(processId: string, requestId: string, answers: string[][]): Promise<void>;
  replyForm?(processId: string, formId: string, answer: Record<string, unknown>, action?: AgentFormAction): Promise<void>;
  controls?(processId: string): Promise<AgentControls>;
  configure?(processId: string, selector: string, value: string): Promise<void>;
  command?(processId: string, name: string, text: string): Promise<Record<string, unknown> | void>;
  goal?(processId: string, action: IntegratedGoalAction, objective?: string): Promise<Record<string, unknown> | void>;
  compact?(processId: string): Promise<Record<string, unknown> | void>;
  currentModel?(processId: string): Promise<string | null>;
  lastActivity?(processId: string): Promise<number | null>;
  nativeSettings?(processId: string): Promise<AgentLiveSettings>;
  sessionDirectory?(processId: string): Promise<string | null>;
  reconcile?(processId: string, messageId: string): Promise<IntegratedDeliveryState>;
  subscribe?(processId: string, listener: AgentEventListener): Promise<() => void>;
  title?(processId: string, prompt: string): Promise<string | null>;
  stop?(processId: string): Promise<void>;
  updateMemory?(processId: string, update: MemoryUpdate): Promise<void>;
  stopAll?(): Promise<void>;
  cleanupLaunch?(input: AgentLaunchInput, result: AgentLaunchResult): Promise<void>;
  liveModels?(): Promise<unknown>;
}
