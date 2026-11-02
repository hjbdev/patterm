// Reads Patterm tool calls in a transcript: which process a call acts on or
// reads, for links, and which user-role rows are Patterm's notes from someone
// else rather than the user. Messages from agents, timers, and notifications
// arrive as user-role rows with a bracketed heading.

import type { TranscriptTool } from './integratedConversation';

// Headings Patterm puts on messages it sends a bot for someone else.
const BACKGROUND_MESSAGE = /^\[(?:Patterm |System notification|system\]|message from |report from |agent message from |Attention requested by |Attention needed by |Failure reported by )/;
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

export function isBackgroundMessage(text: string): boolean {
  return BACKGROUND_MESSAGE.test(text.trimStart());
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
