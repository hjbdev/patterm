import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mentionLaunchers, mentionableAgents, mentionableProcesses, sessionForProcess, splitProcessMentions } = require('../dist/tests/resources/js/lib/agentMentions.js');

function session(id, processId, fields = {}) {
  return {
    id, processId, parentId: null, ptyProcessId: null, worktreeId: null, harness: 'claude', interfaceMode: 'integrated',
    sessionRole: 'orchestrator', resumeStatus: 'found', activity: 'idle', lastTitle: null, displayName: null,
    model: null, reasoning: null, startedAt: '2026-10-01T10:00:00.000Z', exitedAt: null, ...fields
  };
}

test('mentionable agents are the other live agents, subagents after their roots', () => {
  const sessions = [
    session('s_root', 'process_1', { displayName: 'Orchestrator' }),
    session('s_self', 'process_2', { displayName: 'Me' }),
    session('s_child', 'process_3', { parentId: 's_root', lastTitle: 'Review: PR #16' }),
    session('s_exited', 'process_4', { displayName: 'Done', exitedAt: '2026-10-01T11:00:00.000Z' }),
    session('s_unbacked', null, { displayName: 'No process' }),
    session('s_tui', 'process_5', { interfaceMode: 'tui', ptyProcessId: 'pty_5', displayName: 'Terminal agent' }),
    session('s_my_child', 'process_6', { parentId: 's_self', displayName: 'My reviewer' })
  ];
  const agents = mentionableAgents(sessions, 'process_2');
  assert.deepEqual(agents.map((agent) => agent.processId), ['process_1', 'process_3', 'process_6', 'process_5'], 'the agent being messaged, ended agents, and agents without a process are left out; its subagents keep their place');
  assert.deepEqual(agents.map((agent) => agent.name), ['Orchestrator', 'Review: PR #16', 'My reviewer', 'Terminal agent']);
  assert.deepEqual(agents.map((agent) => agent.parent), [null, 'Orchestrator', 'Me', null], 'subagents name their parent');
  assert.deepEqual(mentionableAgents([session('s_a', 'process_7'), session('s_b', 'process_8', { harness: 'codex' })], 'process_99').map((agent) => agent.name), ['claude', 'codex'], 'untitled agents fall back to their harness');
});

test('mentionable processes are the live ones, naming the agent that started them', () => {
  const process = (id, fields = {}) => ({ id, parentProcessId: null, kind: 'shell', name: id, command: 'bash', cwd: null, argv: [], status: 'running', activity: 'idle', ptyProcessId: `pty_${id}`, worktreeId: null, autoRestart: false, exitedAt: null, exitCode: null, ...fields });
  const processes = [
    process('process_10', { name: 'dev server', parentProcessId: 'process_1' }),
    process('process_11', { name: 'shell' }),
    process('process_12', { status: 'exited', ptyProcessId: null }),
    process('process_13', { name: 'orphan', parentProcessId: 'process_99' })
  ];
  const mentions = mentionableProcesses(processes, [session('s_root', 'process_1', { displayName: 'Orchestrator' })]);
  assert.deepEqual(mentions.map((item) => [item.processId, item.name, item.owner]), [
    ['process_10', 'dev server', 'Orchestrator'],
    ['process_11', 'shell', null],
    ['process_13', 'orphan', null]
  ], 'ended processes are left out');
});

test('process IDs split out of message text as whole words', () => {
  assert.deepEqual(splitProcessMentions('ask process_12, then process_3.'), [
    { text: 'ask ' },
    { text: 'process_12', processId: 'process_12' },
    { text: ', then ' },
    { text: 'process_3', processId: 'process_3' },
    { text: '.' }
  ]);
  assert.deepEqual(splitProcessMentions('process_1'), [{ text: 'process_1', processId: 'process_1' }]);
  assert.deepEqual(splitProcessMentions('subprocess_1, process_2x and process_'), [{ text: 'subprocess_1, process_2x and process_' }], 'IDs inside other words are text');
  assert.deepEqual(splitProcessMentions(''), [{ text: '' }]);
  // Agents on a paired host are addressed with the host's name.
  assert.deepEqual(splitProcessMentions('asked beta:process_1 and dev-box2:process_7.'), [
    { text: 'asked ' },
    { text: 'beta:process_1', processId: 'beta:process_1' },
    { text: ' and ' },
    { text: 'dev-box2:process_7', processId: 'dev-box2:process_7' },
    { text: '.' }
  ]);
  assert.deepEqual(splitProcessMentions('Beta:process_1'), [{ text: 'Beta:' }, { text: 'process_1', processId: 'process_1' }], 'host names are lowercase');
  assert.deepEqual(splitProcessMentions('target_process_id x_beta:process_1'), [{ text: 'target_process_id x_beta:' }, { text: 'process_1', processId: 'process_1' }]);
});

test('launchers offer presets, then harnesses, for installed harnesses', () => {
  const installed = (harness, status = 'available') => ({ id: harness, harness, executablePath: '', version: null, status, discoveredAt: '', lastCheckedAt: '' });
  const preset = (id, harness, name) => ({ id, harness, name, model: null, reasoning: null });
  const launchers = mentionLaunchers(
    [installed('claude'), installed('codex'), installed('opencode', 'missing'), installed('rawpty')],
    [preset('p1', 'claude', 'Smartypants'), preset('p2', 'claude', 'Fast'), preset('p3', 'codex', 'fast'), preset('p4', 'opencode', 'Deep')]
  );
  assert.deepEqual(launchers.map((launcher) => [launcher.kind, launcher.name, launcher.token]), [
    ['preset', 'Smartypants', '[patterm_preset:Smartypants]'],
    ['preset', 'Fast', '[patterm_preset:claude/Fast]'],
    ['preset', 'fast', '[patterm_preset:codex/fast]'],
    ['harness', 'Claude Code', '[patterm_harness:claude]'],
    ['harness', 'Codex', '[patterm_harness:codex]']
  ], 'shared preset names carry their harness; missing harnesses and raw terminals are left out');
});

test('launch tokens split out of message text', () => {
  assert.deepEqual(splitProcessMentions('use [patterm_preset:Smartypants] and [patterm_harness:codex] with process_2'), [
    { text: 'use ' },
    { text: '[patterm_preset:Smartypants]', launch: { kind: 'preset', name: 'Smartypants', harness: null } },
    { text: ' and ' },
    { text: '[patterm_harness:codex]', launch: { kind: 'harness', name: 'Codex', harness: 'codex' } },
    { text: ' with ' },
    { text: 'process_2', processId: 'process_2' }
  ]);
  assert.deepEqual(splitProcessMentions('[patterm_preset:claude/Fast]')[0]?.launch, { kind: 'preset', name: 'Fast', harness: 'claude' });
  assert.deepEqual(splitProcessMentions('[patterm_preset:a/b]')[0]?.launch, { kind: 'preset', name: 'a/b', harness: null }, 'an unknown prefix is part of the name');
  assert.deepEqual(splitProcessMentions('[patterm_preset:]'), [{ text: '[patterm_preset:]' }]);
});

test('a process resolves to its live session, otherwise its latest', () => {
  const older = session('s_old', 'process_1', { startedAt: '2026-10-01T09:00:00.000Z', exitedAt: '2026-10-01T09:30:00.000Z' });
  const newer = session('s_new', 'process_1', { startedAt: '2026-10-01T10:00:00.000Z', exitedAt: '2026-10-01T10:30:00.000Z' });
  const live = session('s_live', 'process_1', { startedAt: '2026-10-01T08:00:00.000Z' });
  assert.equal(sessionForProcess([newer, older], 'process_1')?.id, 's_new');
  assert.equal(sessionForProcess([older, live, newer], 'process_1')?.id, 's_live');
  assert.equal(sessionForProcess(new Map([['s_old', older]]).values(), 'process_1')?.id, 's_old', 'any iterable of sessions works');
  assert.equal(sessionForProcess([older], 'process_2'), null);
});
