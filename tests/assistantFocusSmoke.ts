import assert from 'node:assert/strict';

import { findProcess } from '../resources/js/lib/agentMentions';
import { bareToolName, deriveAssistantFocus, isBackgroundMessage, latestTurnId, toolProcessCall, turnOrigin } from '../resources/js/lib/assistantFocus';
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
function user(text: string): TranscriptMessage {
  return { id: `row_${next += 1}`, role: 'user', kind: 'text', text };
}
function reply(text: string): TranscriptMessage {
  return { id: `row_${next += 1}`, role: 'assistant', kind: 'text', text };
}
// A Codex MCP call as the transcript projection shows it.
function call(tool: string, args: Record<string, unknown> | string, output = '', status: 'running' | 'completed' | 'failed' = 'completed'): TranscriptMessage {
  return {
    id: `row_${next += 1}`, role: 'assistant', kind: 'tool', text: output, title: 'MCP',
    tool: { name: 'mcpToolCall', family: 'mcp', status, title: 'MCP', input: { server: 'patterm', tool, arguments: args }, output }
  };
}

// A single read in a user turn focuses its agent.
let focus = deriveAssistantFocus([user("what's the login agent doing?"), call('get_process_output', { process_id: 'process_1' }), reply('It is testing.')], projects);
assert.deepEqual(focus?.target, { key: 'session:session_login', projectId: 'project_a', sessionId: 'session_login', label: 'Fix login' });
assert.equal(focus?.source, 'read');

// Only the latest turn counts, and a topic change moves the focus.
const history = [user('login?'), call('get_process_output', { process_id: 'process_1' }), user('and the docs one?'), call('get_process_status', '{"process_id":"process_2"}')];
assert.equal(deriveAssistantFocus(history, projects)?.target.key, 'session:session_docs');

// Reads of several agents are a survey, not a topic, whichever read tool they use.
assert.equal(deriveAssistantFocus([user('how is everything?'), call('get_process_output', { process_id: 'process_1' }), call('get_process_output', { process_id: 'process_2' })], projects), null);
assert.equal(deriveAssistantFocus([user('how is everything?'), call('get_conversation_output', { process_id: 'process_2' }), call('get_process_output', { process_id: 'process_1' })], projects), null);

// An action outranks reads.
focus = deriveAssistantFocus([user('tell docs to hurry'), call('get_process_output', { process_id: 'process_1' }), call('get_process_output', { process_id: 'process_3' }), call('send_message', { target_process_id: 'process_2', message: 'x' })], projects);
assert.equal(focus?.target.key, 'session:session_docs');
assert.equal(focus?.source, 'action');

// The user naming an agent outranks everything.
focus = deriveAssistantFocus([user('check process_3 please'), call('send_message', { target_process_id: 'process_2', message: 'x' })], projects);
assert.deepEqual(focus?.target, { key: 'process:process_3', projectId: 'project_a', processId: 'process_3', label: 'pnpm dev' });
assert.equal(focus?.source, 'mention');

// A spawned agent is focused once it appears in the workbench.
const spawned = [user('spawn a reviewer in beta'), call('spawn_agent', { project_id: 'project_b' }, '{"process_id":"process_2","name":"reviewer","kind":"agent","status":"running"}')];
assert.equal(deriveAssistantFocus(spawned, projects)?.target.key, 'session:session_docs');
assert.equal(deriveAssistantFocus(spawned, [projects[0]!]), null);

// A project-only turn focuses the project.
focus = deriveAssistantFocus([user('status of beta?'), call('get_project_status', { project_id: 'project_b' })], projects);
assert.deepEqual(focus?.target, { key: 'project:project_b', projectId: 'project_b', label: 'Beta' });

// Background messages set a focus when the assistant acts on one agent or
// reads one agent's output for them. Mentions in the heading, status checks,
// waits, and project checks do not count.
const spawnedDocs = '{"process_id":"process_2","name":"reviewer","kind":"agent","status":"running"}';
for (const text of ['[Patterm notifications]\n- [failure] Alpha (process process_1)', '[agent message from process_1 (Alpha / Fix login), not the user]\nDone', '[report from process_2: completed]', '[Patterm timer t: condition met]', '[message from process_1]\nhi', '[system] timer fired', '[Failure reported by process_1 (x)]']) {
  assert.ok(isBackgroundMessage(text), text);
  const before = [user('docs?'), call('get_process_output', { process_id: 'process_2' }), user(text)];
  assert.equal(deriveAssistantFocus(before, projects), null, text);
  for (const tool of ['get_process_status', 'wait_for_pattern', 'get_process_ports']) {
    assert.equal(deriveAssistantFocus([...before, call(tool, { process_id: 'process_1', pattern: 'x' })], projects), null, `${text} ${tool}`);
  }
  assert.equal(deriveAssistantFocus([...before, call('get_project_status', { project_id: 'project_a' })], projects), null, text);
  assert.equal(deriveAssistantFocus([...before, call('spawn_process', { project_id: 'project_a', command: 'pnpm dev' })], projects), null, text);

  for (const tool of ['get_conversation_output', 'get_process_output', 'search_output']) {
    focus = deriveAssistantFocus([...before, call(tool, { process_id: 'process_1', pattern: 'x' })], projects);
    assert.equal(focus?.target.key, 'session:session_login', `${text} ${tool}`);
    assert.equal(focus?.source, 'read', `${text} ${tool}`);
    assert.equal(focus?.background, true, `${text} ${tool}`);
  }
  // A status check alongside one output read does not add a second place.
  assert.equal(deriveAssistantFocus([...before, call('get_process_status', { process_id: 'process_2' }), call('get_conversation_output', { process_id: 'process_1' })], projects)?.target.key, 'session:session_login', text);

  for (const action of [
    call('send_message', { target_process_id: 'process_1', message: 'ok' }),
    call('send_input', { process_id: 'process_1', kind: 'text', text: 'y' }),
    call('restart_process', { process_id: 'process_1' })
  ]) {
    focus = deriveAssistantFocus([...before, action], projects);
    assert.equal(focus?.target.key, 'session:session_login', text);
    assert.equal(focus?.source, 'action', text);
    assert.equal(focus?.background, true, text);
  }
  focus = deriveAssistantFocus([...before, call('spawn_agent', { agent: 'codex' }, spawnedDocs)], projects);
  assert.equal(focus?.target.key, 'session:session_docs', text);
  assert.equal(focus?.source, 'action', text);

  // Acting on one agent after reading another shows the one acted on.
  assert.equal(deriveAssistantFocus([...before, call('get_conversation_output', { process_id: 'process_1' }), call('send_message', { target_process_id: 'process_2', message: 'go' })], projects)?.target.key, 'session:session_docs', text);
  // A digest about several agents names none, whether it reads or acts on them.
  assert.equal(deriveAssistantFocus([...before, call('get_conversation_output', { process_id: 'process_1' }), call('get_process_output', { process_id: 'process_2' })], projects), null, text);
  assert.equal(deriveAssistantFocus([...before, call('send_message', { target_process_id: 'process_1', message: 'a' }), call('send_message', { target_process_id: 'process_2', message: 'b' })], projects), null, text);
  assert.equal(deriveAssistantFocus([...before, call('send_message', { target_process_id: 'process_1', message: 'a' }), call('send_message', { target_process_id: 'process_2', message: 'b' }), call('get_conversation_output', { process_id: 'process_1' })], projects), null, text);
  // Failed actions are ignored.
  assert.equal(deriveAssistantFocus([...before, call('send_message', { target_process_id: 'process_1', message: 'a' }, '', 'failed')], projects), null, text);
}
assert.equal(isBackgroundMessage('[draft] please look at the login agent'), false);
assert.equal(deriveAssistantFocus([user('login?'), call('get_process_output', { process_id: 'process_1' })], projects)?.background, false);

// Spoken requests arrive as voice delegations. One whose input the user said
// is the user's own turn, like a typed message; one the voice model started
// by itself is background.
function delegation(input: string, delta: string[]): string {
  return `<realtime_delegation>\n  <input>${input}</input>\n  <transcript_delta>${delta.join('\n')}</transcript_delta>\n</realtime_delegation>`;
}
const spoken = delegation('What is the login agent doing', ['assistant:  One sec.', 'user:  What is the login agent  doing']);
assert.equal(turnOrigin(spoken), 'user');
assert.equal(turnOrigin(delegation('Okay, um... and the docs one?', ['user:  login?', 'assistant:  It is testing.', 'user: Okay, um... and the docs one?'])), 'user');
const relayed = delegation('Read the release notes agent conversation and summarise its questions', ['assistant:  The release notes agent has two questions for you.']);
assert.equal(turnOrigin(relayed), 'background');
assert.equal(turnOrigin(delegation('', ['user:  hello'])), 'background');
assert.equal(turnOrigin('[Patterm notifications]\n- x'), 'background');
assert.equal(turnOrigin('plain typed message'), 'user');

// A spoken request follows exactly like a typed one, terminal reads included.
focus = deriveAssistantFocus([user(spoken), call('get_process_output', { process_id: 'process_1' })], projects);
assert.equal(focus?.target.key, 'session:session_login');
assert.equal(focus?.background, false);
assert.equal(deriveAssistantFocus([user(delegation('status of beta', ['user: status of beta'])), call('get_project_status', { project_id: 'project_b' })], projects)?.target.key, 'project:project_b');
// A delegation the voice model started follows like other background turns:
// actions and output reads, but not status checks or project checks.
assert.equal(deriveAssistantFocus([user(relayed), call('get_process_status', { process_id: 'process_2' })], projects), null);
assert.equal(deriveAssistantFocus([user(relayed), call('get_project_status', { project_id: 'project_b' })], projects), null);
assert.equal(deriveAssistantFocus([user(relayed), call('send_message', { target_process_id: 'process_2', message: 'x' })], projects)?.background, true);
assert.equal(deriveAssistantFocus([user(relayed), call('get_process_output', { process_id: 'process_2' })], projects)?.target.key, 'session:session_docs');
assert.equal(deriveAssistantFocus([user(relayed), call('get_conversation_output', { process_id: 'process_2' })], projects)?.target.key, 'session:session_docs');

// The latest turn is found whoever started it.
assert.equal(latestTurnId([user('a'), reply('b')]), `row_${next - 1}`);
assert.equal(latestTurnId([reply('only the assistant')]), null);

// Failed calls, exited agents, unknown IDs, and subagent rows are ignored.
assert.equal(deriveAssistantFocus([user('x'), call('get_process_output', { process_id: 'process_1' }, '', 'failed')], projects), null);
assert.equal(deriveAssistantFocus([user('x'), call('get_process_output', { process_id: 'process_9' })], projects), null);
assert.equal(deriveAssistantFocus([user('x'), call('get_process_output', { process_id: 'process_404' })], projects), null);
assert.equal(deriveAssistantFocus([user('x'), { ...call('get_process_output', { process_id: 'process_1' }), parentId: 'row_task' }], projects), null);
assert.equal(deriveAssistantFocus([], projects), null);

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
