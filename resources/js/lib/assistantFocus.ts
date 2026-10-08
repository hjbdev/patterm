// What the assistant is discussing, inferred from its transcript so Follow can
// show it without a navigation tool or extra instructions. Messages from
// agents, timers, and notifications arrive as user-role rows with a bracketed
// heading. Such a background turn only has a focus when the assistant acts on
// one agent, or reads one agent's output, to deal with it. Spoken requests
// arrive wrapped in <realtime_delegation> with the user's own words as the
// input.

import { agentLabel } from './agentTabs';
import type { TranscriptMessage, TranscriptTool } from './integratedConversation';
import type { ProjectWorkbench } from '../types';

export interface FocusTarget {
  // Stable identity of the place shown, for comparing focuses.
  key: string;
  projectId: string;
  sessionId?: string;
  processId?: string;
  label: string;
}

export interface AssistantFocus {
  // The user row that started the turn.
  turnId: string;
  target: FocusTarget;
  // What named the target. A mention is known when the turn starts; the rest
  // come from tool calls and are only settled once the turn ends.
  source: 'mention' | 'action' | 'read' | 'project';
  // Started by a notification, agent message, report, or timer, not the user.
  background: boolean;
}

// Headings Patterm puts on messages it sends the assistant for someone else.
const BACKGROUND_MESSAGE = /^\[(?:Patterm |System notification|system\]|message from |report from |agent message from |Attention requested by |Attention needed by |Failure reported by )/;
const PROCESS_MENTION = /\bprocess_\d+\b/g;
const SPAWNED_PROCESS = /"process_id"\s*:\s*"(process_\d+)"/;
// Tools that act on one process, and the argument naming it.
const ACTION_TOOLS: Record<string, string> = {
  send_message: 'target_process_id',
  send_input: 'process_id',
  restart_process: 'process_id'
};
const READ_TOOLS: Record<string, string> = {
  get_process_output: 'process_id',
  get_conversation_output: 'process_id',
  get_process_status: 'process_id',
  search_output: 'process_id',
  wait_for_pattern: 'process_id',
  get_process_ports: 'process_id'
};
// Reads of what an agent said. Status checks and waits are how the assistant
// polls after a timer, so in a background turn they show nothing.
const CONTENT_READS = new Set(['get_process_output', 'get_conversation_output', 'search_output']);
const PROJECT_TOOLS = new Set(['get_project_status', 'list_processes', 'spawn_process']);

const DELEGATION = /^<realtime_delegation>/;

export function isBackgroundMessage(text: string): boolean {
  return BACKGROUND_MESSAGE.test(text.trimStart());
}

// Who started a turn. A voice delegation is the user's when its input is
// something the user said; one the voice model starts by itself, such as to
// follow up a notification it announced, is background.
export function turnOrigin(text: string): 'user' | 'background' {
  const trimmed = text.trimStart();
  if (isBackgroundMessage(trimmed)) return 'background';
  if (!DELEGATION.test(trimmed)) return 'user';
  const input = squash(/<input>([\s\S]*?)<\/input>/.exec(trimmed)?.[1] ?? '');
  const delta = /<transcript_delta>([\s\S]*?)<\/transcript_delta>/.exec(trimmed)?.[1] ?? '';
  const spoken = delta.split('\n').filter((line) => line.startsWith('user:')).map((line) => squash(line.slice(5)));
  return input && spoken.some((line) => line && (line.includes(input) || input.includes(line))) ? 'user' : 'background';
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// The latest turn's single focus, or null when it has none or names several
// places. A background turn counts only actions and reads of output: its
// heading names the sender, and project checks are routine.
export function deriveAssistantFocus(rows: readonly TranscriptMessage[], projects: readonly ProjectWorkbench[]): AssistantFocus | null {
  const start = latestTurnIndex(rows);
  if (start < 0) return null;
  const turn = rows[start]!;
  const background = turnOrigin(turn.text) === 'background';

  const resolve = (processId: string) => resolveProcess(projects, processId);
  const mentioned = distinct([...turn.text.matchAll(PROCESS_MENTION)].map((match) => resolve(match[0])));
  const acted: Array<FocusTarget | null> = [];
  const read: Array<FocusTarget | null> = [];
  const contentRead: Array<FocusTarget | null> = [];
  const projectIds: string[] = [];
  for (const row of rows.slice(start + 1)) {
    if (row.kind !== 'tool' || row.parentId || !row.tool || row.tool.status === 'failed') continue;
    const call = mcpCall(row.tool);
    if (!call) continue;
    if (call.tool === 'spawn_agent') {
      const spawned = SPAWNED_PROCESS.exec(row.tool.output ?? row.text)?.[1];
      if (spawned) acted.push(resolve(spawned));
    } else if (ACTION_TOOLS[call.tool]) {
      acted.push(resolve(String(call.args[ACTION_TOOLS[call.tool]!] ?? '')));
    } else if (READ_TOOLS[call.tool]) {
      const target = resolve(String(call.args[READ_TOOLS[call.tool]!] ?? ''));
      read.push(target);
      if (CONTENT_READS.has(call.tool)) contentRead.push(target);
    } else if (PROJECT_TOOLS.has(call.tool) && typeof call.args.project_id === 'string') {
      projectIds.push(call.args.project_id);
    }
  }

  const tiers = background
    ? [[distinct(acted), 'action'], [distinct(contentRead), 'read']] as const
    : [[mentioned, 'mention'], [distinct(acted), 'action'], [distinct(read), 'read']] as const;
  for (const [targets, source] of tiers) {
    if (targets.length === 1) return { turnId: turn.id, target: targets[0]!, source, background };
    if (targets.length > 1) return null;
  }
  const project = new Set(projectIds);
  if (project.size !== 1 || background) return null;
  const workbench = projects.find((item) => item.project.id === [...project][0]);
  return workbench ? { turnId: turn.id, target: { key: `project:${workbench.project.id}`, projectId: workbench.project.id, label: workbench.project.name }, source: 'project', background } : null;
}

// The user row that starts the latest turn, whoever sent it.
export function latestTurnId(rows: readonly TranscriptMessage[]): string | null {
  const index = latestTurnIndex(rows);
  return index < 0 ? null : rows[index]!.id;
}

function latestTurnIndex(rows: readonly TranscriptMessage[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.role === 'user' && row.kind === 'text' && !row.parentId) return index;
  }
  return -1;
}

// A running agent opens on its agent page, any other process on its own.
// Exited ones are left alone: Follow shows live work.
export function resolveProcess(projects: readonly ProjectWorkbench[], processId: string): FocusTarget | null {
  if (!processId) return null;
  for (const { project, projectSessions, processes } of projects) {
    const session = projectSessions.find((item) => item.processId === processId && !item.exitedAt);
    if (session) return { key: `session:${session.id}`, projectId: project.id, sessionId: session.id, label: agentLabel(session) };
    const process = processes.find((item) => item.id === processId && item.status === 'running');
    if (process) return { key: `process:${process.id}`, projectId: project.id, processId: process.id, label: process.name };
  }
  return null;
}

// The process a Patterm tool call acts on or reads, if it names one, with
// the tool's bare name.
export function toolProcessCall(tool: TranscriptTool, text = ''): { tool: string; processId: string } | null {
  const call = mcpCall(tool);
  if (!call || tool.status === 'failed') return null;
  const key = ACTION_TOOLS[call.tool] ?? READ_TOOLS[call.tool];
  const value = call.tool === 'spawn_agent' ? SPAWNED_PROCESS.exec(tool.output ?? text)?.[1] : key ? call.args[key] : undefined;
  return typeof value === 'string' && /^process_\d+$/.test(value) ? { tool: call.tool, processId: value } : null;
}

// The MCP tool a row called, by its bare name, with parsed arguments.
function mcpCall(tool: TranscriptTool | undefined): { tool: string; args: Record<string, unknown> } | null {
  if (!tool || tool.family !== 'mcp') return null;
  const input = record(tool.input);
  // Claude (mcp__server__tool) and OpenCode's bridge (patterm_<hash>_tool)
  // name the tool and pass the arguments as the input itself.
  const prefixed = /^(?:mcp__|patterm_[0-9a-f]{12}_)/.test(tool.name);
  const name = typeof input.tool === 'string' ? input.tool : !prefixed && typeof input.name === 'string' ? input.name : tool.name;
  let args: unknown = input.arguments ?? input.args ?? input.input ?? (prefixed ? input : undefined);
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  return { tool: bareToolName(name), args: record(args) };
}

export function bareToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, '').replace(/^patterm_[0-9a-f]{12}_/, '').replace(/^patterm[._]/, '').replace(/\./g, '_');
}

function distinct(targets: ReadonlyArray<FocusTarget | null>): FocusTarget[] {
  const seen = new Map<string, FocusTarget>();
  for (const target of targets) if (target && !seen.has(target.key)) seen.set(target.key, target);
  return [...seen.values()];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
