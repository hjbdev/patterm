import assert from 'node:assert/strict';

import { findProcess } from '../resources/js/lib/agentMentions';
import { bareToolName, isBackgroundMessage, toolProcessCall } from '../resources/js/lib/assistantFocus';
import { buildTranscriptTool, type TranscriptMessage } from '../resources/js/lib/integratedConversation';
import type { ProcessRecord, ProjectWorkbench, SessionRecord } from '../resources/js/types';

function session(id: string, processId: string, title: string, exitedAt: string | null = null): SessionRecord {
  return {
    id, parentId: null, ptyProcessId: `pty-${id}`, processId, worktreeId: null, harness: 'codex', interfaceMode: 'integrated',
    sessionRole: 'orchestrator', resumeStatus: 'unknown', activity: 'idle', lastTitle: title, displayName: null,
    model: null, reasoning: null, startedAt: '2026-10-03T10:00:00Z', exitedAt
  };
}

function process(id: string, name: string, status = 'running'): ProcessRecord {
  return {
    id, parentProcessId: null, kind: 'process', name, command: name, cwd: null, argv: [], status, activity: 'idle',
    ptyProcessId: `pty-${id}`, worktreeId: null, autoRestart: false, exitedAt: null, exitCode: null
  };
}

const projects: ProjectWorkbench[] = [
  {
    project: { id: 'project_a', name: 'Alpha', path: '/a' },
    projectSessions: [session('session_login', 'process_1', 'Fix login'), session('session_old', 'process_9', 'Old work', '2026-10-03T09:00:00Z')],
    processes: [process('process_3', 'pnpm dev')], worktrees: [], timers: []
  },
  {
    project: { id: 'project_b', name: 'Beta', path: '/b' },
    projectSessions: [session('session_docs', 'process_2', 'Write docs')],
    processes: [], worktrees: [], timers: []
  }
];

let next = 0;
// A Codex MCP call as the transcript projection shows it.
function call(tool: string, args: Record<string, unknown> | string, output = '', status: 'running' | 'completed' | 'failed' = 'completed'): TranscriptMessage {
  return {
    id: `row_${next += 1}`, role: 'assistant', kind: 'tool', text: output, title: 'MCP',
    tool: { name: 'mcpToolCall', family: 'mcp', status, title: 'MCP', input: { server: 'patterm', tool, arguments: args }, output }
  };
}

// Patterm's notes from someone else are told apart from the user's own messages.
for (const text of ['[Patterm notifications]\n- [failure] Alpha (process process_1)', '[agent message from process_1 (Alpha / Fix login), not the user]\nDone', '[report from process_2: completed]', '[Patterm timer t: condition met]', '[message from process_1]\nhi', '[system] timer fired', '[Failure reported by process_1 (x)]']) {
  assert.ok(isBackgroundMessage(text), text);
}
assert.equal(isBackgroundMessage('[draft] please look at the login agent'), false);

// Tool names arrive bare, prefixed, or namespaced.
assert.equal(bareToolName('get_process_output'), 'get_process_output');
assert.equal(bareToolName('mcp__patterm__send_message'), 'send_message');
assert.equal(bareToolName('worktree_list'), 'worktree_list');
assert.equal(bareToolName('patterm_f37653dcf531_send_message'), 'send_message');

// Tool rows name the process they act on or read, for links.
const toolOf = (row: TranscriptMessage) => row.tool!;
assert.deepEqual(toolProcessCall(toolOf(call('get_process_output', { process_id: 'process_2' }))), { tool: 'get_process_output', processId: 'process_2' });
assert.deepEqual(toolProcessCall(toolOf(call('send_message', '{"target_process_id":"process_1"}'))), { tool: 'send_message', processId: 'process_1' });
assert.deepEqual(toolProcessCall(toolOf(call('spawn_agent', {}, '{"process_id": "process_7"}'))), { tool: 'spawn_agent', processId: 'process_7' });
// Claude passes the arguments as the input itself.
assert.deepEqual(toolProcessCall(buildTranscriptTool('mcp__patterm__send_message', { input: { name: 'x', target_process_id: 'process_4' }, state: 'completed' }, 'x')), { tool: 'send_message', processId: 'process_4' });
assert.deepEqual(toolProcessCall(buildTranscriptTool('mcp__patterm__get_process_output', { input: { process_id: 'process_3' }, state: 'completed' }, 'x')), { tool: 'get_process_output', processId: 'process_3' });
assert.equal(toolProcessCall(toolOf(call('get_process_output', { process_id: 'process_1' }, '', 'failed'))), null);
assert.equal(toolProcessCall(toolOf(call('list_processes', { project_id: 'project_a' }))), null);
assert.equal(toolProcessCall(toolOf(call('send_message', { target_process_id: 'assistant' }))), null);

// Process IDs resolve in any project, the preferred one first.
assert.equal(findProcess(projects, 'process_2')?.projectId, 'project_b');
assert.equal(findProcess(projects, 'process_2', 'project_a')?.session?.id, 'session_docs');
assert.equal(findProcess(projects, 'process_3')?.process?.name, 'pnpm dev');
assert.equal(findProcess(projects, 'process_404'), null);

console.log('assistant focus smoke passed');
