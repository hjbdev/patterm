import { agentLabel } from './agentTabs';
import { relativeTime } from './format';
import { harnessLabel } from './harnesses';
import { timerLabel, timerRemaining } from './timers';
import type { CommandDescriptor } from './commandPalette';
import type { AgentInterface, ConversationRecord, ProjectWorkbench, TimerRecord, WorktreeRecord } from '../types';

// Rows the palette builds from conversations, timers, workspace search, and the
// launch choices, so every layout shares the same commands.

export const HISTORY_PROVIDERS = ['claude', 'codex', 'opencode'] as const;

export interface HarnessPreset {
  id: string;
  harness: string;
  name: string;
  model: string | null;
  reasoning: string | null;
}

export interface LaunchChoice {
  harness: string;
  presetId: string | null;
  worktreeId: string | null;
  interfaceMode: AgentInterface;
  prompt: string;
}

export interface WorkspaceSearchResult {
  kind: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  preview: string;
  target: { project_id: string | null; tab: string | null; terminal_process_id: string | null; conversation_id?: string | null; conversation_message_id?: string | null };
}

export interface PaletteTimer {
  timer: TimerRecord;
  project: ProjectWorkbench;
  owner: string;
  ownerSessionId: string | null;
}

// Resuming needs a native conversation ID in this project from a known agent;
// the server checks again.
export function resumableConversations(conversations: readonly ConversationRecord[], projectId: string | null): ConversationRecord[] {
  return conversations.filter((conversation) => Boolean(conversation.providerConversationId && projectId && conversation.projectId === projectId
    && (HISTORY_PROVIDERS as readonly string[]).includes(conversation.provider)));
}

// Each conversation resumes in the saved interface; its page offers the other.
export function conversationRows(conversations: readonly ConversationRecord[], now = Date.now(), defaultInterface: AgentInterface = 'integrated'): CommandDescriptor[] {
  const interfaces: AgentInterface[] = defaultInterface === 'tui' ? ['tui', 'integrated'] : ['integrated', 'tui'];
  return conversations.map((conversation) => {
    const title = conversation.title?.trim() || 'Untitled conversation';
    const id = `history:resume:${conversation.id}`;
    return {
      id,
      label: title,
      hint: conversationHint(conversation, now),
      aliases: [harnessLabel(conversation.provider)],
      harness: conversation.provider,
      group: 'conversation',
      kind: 'backend',
      primary: 'Resume',
      actions: [
        ...interfaces.map((mode) => ({ id, label: `Resume as ${interfaceLabel(mode)}`, group: 'conversation', kind: 'backend', params: { interface_mode: mode } } satisfies CommandDescriptor)),
        {
          id: `history:open:${conversation.id}`,
          label: 'Open in conversation history',
          group: 'conversation',
          kind: 'renderer',
          result: { rendererAction: 'openTarget', target: { project_id: conversation.projectId, tab: 'history', terminal_process_id: null, conversation_id: conversation.id } }
        }
      ]
    } satisfies CommandDescriptor;
  });
}

// From an agent, resuming replaces it while its conversation is still empty;
// otherwise the conversation opens beside it.
export function resumeInPlace(rows: readonly CommandDescriptor[], processId: string): CommandDescriptor[] {
  const replace = (command: CommandDescriptor): CommandDescriptor => command.id.startsWith('history:resume:')
    ? { ...command, params: { ...command.params, replace_process_id: processId } }
    : command;
  return rows.map((row) => ({ ...replace(row), ...(row.actions ? { actions: row.actions.map(replace) } : {}) }));
}

// The row's icon names the agent.
export function conversationHint(conversation: ConversationRecord, now = Date.now()): string {
  const messages = `${conversation.messageCount} ${conversation.messageCount === 1 ? 'message' : 'messages'}`;
  return [relativeTime(conversation.updatedAt ?? conversation.importedAt, now), messages].filter(Boolean).join(' · ');
}

// Timers from every project, soonest first. Agents own most of them.
export function paletteTimers(projects: readonly ProjectWorkbench[]): PaletteTimer[] {
  return projects.flatMap((project) => project.timers.map((timer) => {
    const session = project.projectSessions.find((candidate) => candidate.processId === timer.ownerProcessId);
    const process = session ? null : project.processes.find((candidate) => candidate.id === timer.ownerProcessId);
    return { timer, project, owner: session ? agentLabel(session) : process?.name ?? 'Patterm', ownerSessionId: session && !session.exitedAt ? session.id : null };
  })).sort((a, b) => (a.timer.firesAtUnixMs ?? Infinity) - (b.timer.firesAtUnixMs ?? Infinity) || a.timer.createdAtUnixMs - b.timer.createdAtUnixMs);
}

export function timerRows(timers: readonly PaletteTimer[], now: number, activeProjectId: string | null): CommandDescriptor[] {
  return timers.map(({ timer, project, owner, ownerSessionId }) => {
    const label = timerLabel(timer);
    const paused = timer.status === 'paused';
    return {
      id: `timer:${timer.id}`,
      label,
      hint: [timerRemaining(timer, now), owner, project.project.id === activeProjectId ? '' : project.project.name].filter(Boolean).join(' · '),
      group: 'timer',
      kind: 'page',
      actions: [
        { id: `timer:${paused ? 'resume' : 'pause'}:${timer.id}`, label: paused ? 'Resume timer' : 'Pause timer', hint: label, group: 'timer', kind: 'backend' },
        ...(ownerSessionId ? [{ id: `goto:${ownerSessionId}`, label: 'Go to agent', hint: owner, group: 'timer', kind: 'navigate', result: { navigate: { projectId: project.project.id, sessionId: ownerSessionId } } } satisfies CommandDescriptor] : []),
        { id: `timer:cancel:${timer.id}`, label: 'Cancel timer', hint: label, group: 'timer', kind: 'backend' }
      ]
    } satisfies CommandDescriptor;
  });
}

const SEARCH_KIND_LABELS: Record<string, string> = {
  session: 'Agent',
  conversation: 'Conversation',
  conversation_message: 'Message',
  summary: 'Summary',
  timeline: 'Activity'
};

export function searchRows(results: readonly WorkspaceSearchResult[]): CommandDescriptor[] {
  return results.map((result) => ({
    id: `search:${result.kind}:${result.owner_id}`,
    label: result.title || SEARCH_KIND_LABELS[result.kind] || result.kind,
    hint: [SEARCH_KIND_LABELS[result.kind] ?? result.kind, cleanPreview(result.preview)].filter(Boolean).join(' · '),
    group: 'search',
    kind: 'renderer',
    result: { rendererAction: 'openTarget', target: result.target }
  } satisfies CommandDescriptor));
}

function cleanPreview(preview: string): string {
  return preview.replaceAll('[', '').replaceAll(']', '').replace(/\s+/g, ' ').trim();
}

export function presetLabel(preset: HarnessPreset | null | undefined): string {
  if (!preset) return 'Agent default';
  return preset.name;
}

export function worktreeLabel(worktree: WorktreeRecord | null | undefined): string {
  if (!worktree) return 'Project directory';
  return worktree.branch ?? worktree.worktreePath.split('/').filter(Boolean).at(-1) ?? worktree.id;
}

// Named as in the launch menu's toggle.
export function interfaceLabel(mode: AgentInterface): string {
  return mode === 'integrated' ? 'Integrated' : 'TUI';
}

// The input sent to spawn:agent for a launch.
export function launchParams(choice: LaunchChoice): Record<string, unknown> {
  const prompt = choice.prompt.trim();
  return {
    ...(choice.presetId ? { preset: choice.presetId } : {}),
    ...(choice.worktreeId ? { worktree_id: choice.worktreeId } : {}),
    interface_mode: choice.interfaceMode,
    ...(prompt ? { initial_prompt: prompt } : {})
  };
}

// The project directory is the usual place to run, so only a worktree is named.
export function launchSummary(choice: LaunchChoice, presets: readonly HarnessPreset[], worktrees: readonly WorktreeRecord[]): string {
  const preset = presets.find((candidate) => candidate.id === choice.presetId);
  const worktree = worktrees.find((candidate) => candidate.id === choice.worktreeId);
  return [harnessLabel(choice.harness), presetLabel(preset), worktree ? worktreeLabel(worktree) : '', interfaceLabel(choice.interfaceMode)].filter(Boolean).join(' · ');
}
