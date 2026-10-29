import assert from 'node:assert/strict';
import { actionCluster, createPaletteDocument, recordsRecent, rendererCommands, rankedCommands, withIntegratedSelectors, type CommandDescriptor } from '../resources/js/lib/commandPalette';
import { baseName } from '../resources/js/lib/serverPath';
import { worktreeName } from '../resources/js/lib/worktreeDiff';
import { describeDuration } from '../resources/js/lib/timers';
import { listCommandPaletteCommands, runCommandPaletteCommand, quitConfirmation } from '../app/Commands/CommandPalette';

const command = (id: string, label: string, extra: Partial<CommandDescriptor> = {}): CommandDescriptor => ({ id, label, group: 'open', kind: 'navigate', ...extra });
const search = command('renderer:workspace-search', 'Search workspace content…', { kind: 'renderer' });
const commands = [command('notes', 'Scratchpads'), command('todos', 'Todos'), command('disabled', 'Scratchpads unavailable', { disabled: true }), search];
assert.deepEqual(rankedCommands(commands, 'scratch').map(row => row.command.id), ['notes', search.id]);
assert.deepEqual(rankedCommands(commands, 'unmatched words').map(row => row.command.id), [search.id]);
assert.equal(rankedCommands([command('spawn:agent:claude', 'Spawn agent: Claude Code', { hint: '1.2.3' })], 'Spawn Claude')[0]?.command.label, 'Spawn Claude');
assert.equal(rankedCommands(commands, '', ['todos'])[0]?.command.id, 'todos');
assert.equal(rankedCommands(commands, 'scratch', ['todos'])[0]?.command.id, 'notes');
assert.equal(rankedCommands(commands, 'sp scratch')[0]?.command.id, search.id, 'Removed macros must not change query semantics');
const crowded = rankedCommands([...Array.from({ length: 500 }, (_, i) => command(String(i), `Agent ${i}`)), search], '');
assert.equal(crowded.filter(row => row.section === 'agent').length, 25, 'The opening list shows a bounded number of agents');
assert.equal(crowded.at(-1)?.command.id, search.id);
assert.deepEqual(rankedCommands([command('x', 'Switch to PAT-95')], 'stop'), [], 'Letters spread across words do not match');
assert.equal(rankedCommands([command('x', 'Switch to PAT-95')], 'pat95').length, 1, 'Abbreviations inside one word still match');

// Worktree labels come from server paths: a Windows one splits at backslashes, a POSIX one only at slashes.
// (paletteSources.worktreeLabel and TranscriptImage use the same baseName.)
assert.equal(baseName('/repo/.worktrees/feature/'), 'feature');
assert.equal(baseName('C:\\repo\\.worktrees\\feature'), 'feature');
assert.equal(baseName('C:\\repo\\.worktrees\\feature\\'), 'feature');
assert.equal(baseName('C:/repo/.worktrees/feature'), 'feature');
assert.equal(baseName('C:\\'), 'C:');
assert.equal(baseName('/'), undefined);
assert.equal(baseName('/srv/my repo'), 'my repo');
assert.equal(baseName('shot.png'), 'shot.png');
assert.equal(worktreeName({ branch: null, path: 'C:\\repo\\.worktrees\\detached\\' }), 'detached');
assert.equal(worktreeName({ branch: null, path: '/repo/.worktrees/detached' }), 'detached');

const project = { project: { id: 'p', name: 'Project', path: '/tmp/project' }, projectSessions: [], processes: [], worktrees: [], timers: [] };
const application = { currentWorkbench: () => ({ projects: [project], harnesses: [] }), timers: { list: () => [] }, database: { connection: { prepare: () => ({ all: () => [] }) } } } as unknown as Parameters<typeof listCommandPaletteCommands>[0];
const context = { active_project_id: 'p', active_terminal_id: null, active_tab: 'todos' };
const available = rendererCommands(context.active_project_id);

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  id, parentId: null, processId: `${id}_process`, ptyProcessId: null, worktreeId: null, harness: 'claude', interfaceMode: 'integrated',
  sessionRole: 'orchestrator', resumeStatus: 'found', activity: 'idle', lastTitle: null, displayName: id, model: null, reasoning: null,
  startedAt: '2026-10-01T00:00:00.000Z', exitedAt: null, ...extra
});
const integratedProject = {
  ...project,
  projectSessions: [
    session('root', { activity: 'working' }),
    session('child', { parentId: 'root', harness: 'codex' }),
    session('terminal', { interfaceMode: 'tui', ptyProcessId: 'pty_terminal' })
  ],
  processes: [
    { id: 'server', name: 'dev server', kind: 'command', parentProcessId: 'child_process', ptyProcessId: 'pty_server', status: 'running', activity: 'idle' },
    { id: 'crashed', name: 'crashed job', kind: 'command', parentProcessId: null, ptyProcessId: null, status: 'failed', activity: 'idle' },
    { id: 'gone', name: 'closed job', kind: 'command', parentProcessId: null, ptyProcessId: null, status: 'closed', activity: 'idle' }
  ]
};
const otherProject = { project: { id: 'q', name: 'Other', path: '/tmp/other' }, projectSessions: [session('elsewhere')], processes: [], worktrees: [], timers: [] };
const integratedApplication = { ...application, currentWorkbench: () => ({ projects: [integratedProject, otherProject], harnesses: [] }) } as unknown as typeof application;
const integratedContext = { active_project_id: 'p', active_terminal_id: null, active_tab: 'agents', active_session_id: 'root' };

async function main() {
  // Paired-host records are visible in both standalone and linked projects,
  // but quitting this app only stops work owned by this machine.
  const remoteSession = session('host:remote', { host: 'host' });
  const remoteProcess = { id: 'host:command', host: 'host', status: 'running' };
  const remoteOnly = { ...project, project: { ...project.project, host: 'host' }, projectSessions: [remoteSession], processes: [remoteProcess] };
  const linkedRemoteOnly = { ...project, projectSessions: [remoteSession], processes: [remoteProcess] };
  assert.equal(quitConfirmation(application, [remoteOnly, linkedRemoteOnly] as unknown as Parameters<typeof quitConfirmation>[1]), undefined, 'Remote work must not trigger a local Quit warning');
  const mixed = { ...integratedProject, projectSessions: [...integratedProject.projectSessions, remoteSession], processes: [...integratedProject.processes, remoteProcess] };
  assert.match(quitConfirmation(application, [mixed, remoteOnly] as unknown as Parameters<typeof quitConfirmation>[1]) ?? '', /3 agents and 1 command/, 'Linked projects count only their local records');
  const assistantApplication = { ...application, database: { connection: { prepare: () => ({ all: () => [{ id: 'assistant', kind: 'agent' }, { id: 'assistant-command', kind: 'command' }] }) } } } as unknown as typeof application;
  assert.match(quitConfirmation(assistantApplication, [remoteOnly] as unknown as Parameters<typeof quitConfirmation>[1]) ?? '', /1 agent and 1 command/, 'Local Assistant work outside the workbench still counts');
  const quitCommands = (await listCommandPaletteCommands(application, context)).commands;
  assert.equal(quitCommands.find(item => item.id === 'renderer:quit')?.confirmation, undefined, 'An empty app needs no Quit confirmation');
  let shutdowns = 0;
  const emptyApplication = { ...application, shutdown: async () => { shutdowns++; } } as typeof application;
  assert.equal((await runCommandPaletteCommand(emptyApplication, { id: 'renderer:quit', context })).rendererAction, 'quit');
  assert.equal(shutdowns, 1);
  // Unowned and paused timers also get cancelled by Quit, even without processes.
  for (const status of ['pending', 'paused']) {
    const timedApplication = { ...emptyApplication, timers: { list: () => [{ ownerProcessId: null, status }] } } as unknown as typeof application;
    assert.ok((await listCommandPaletteCommands(timedApplication, context)).commands.find(item => item.id === 'renderer:quit')?.confirmation);
    await assert.rejects(runCommandPaletteCommand(timedApplication, { id: 'renderer:quit', context }), /Confirm Quit/);
  }
  assert.equal(shutdowns, 1, 'Timers prevent an unconfirmed shutdown');
  for (const query of ['patterm', 'desktop', 'close']) {
    assert.ok(!rankedCommands(quitCommands, query).some(row => row.command.id === 'renderer:quit'), `${query} must not match Quit's description`);
  }
  assert.ok(rankedCommands(quitCommands, 'quit').some(row => row.command.id === 'renderer:quit'));

  const reusedHandleProject = {
    ...project,
    processes: [{ id: 'old_preview', name: 'Old preview', ptyProcessId: 'proc_1', status: 'exited' }],
    projectSessions: [{ id: 'live_session', processId: 'live_agent', ptyProcessId: 'proc_1', displayName: 'Live agent', exitedAt: null }]
  };
  const reusedHandleApplication = { ...application, currentWorkbench: () => ({ projects: [reusedHandleProject], harnesses: [] }) } as unknown as typeof application;
  const focusedCommands = (await listCommandPaletteCommands(reusedHandleApplication, { ...context, active_terminal_id: 'proc_1' })).commands;
  assert.ok(focusedCommands.some(command => command.id === 'process:close:live_agent'), 'Close targets the live agent rather than an old terminal with the same PTY handle');
  assert.ok(!focusedCommands.some(command => command.id === 'process:close:old_preview'));

  // Integrated agents have no terminal: the routed session identifies them.
  const listed = (await listCommandPaletteCommands(integratedApplication, integratedContext)).commands;
  assert.match(listed.find(item => item.id === 'renderer:quit')?.confirmation ?? '', /4 agents and 1 command/);
  await assert.rejects(runCommandPaletteCommand(integratedApplication, { id: 'renderer:quit', context: integratedContext }), /Confirm Quit/);
  const current = listed.filter(item => item.group === 'current');
  for (const id of ['integrated:interrupt:root_process', 'process:rename:root_process', 'timer:set:root_process', 'goto:child', 'renderer:copy:root_process', 'process:close:root_process']) {
    assert.ok(current.some(item => item.id === id), `${id} is offered for the current Integrated agent`);
  }
  assert.equal(current.find(item => item.id === 'timer:set:root_process')?.input?.type, 'timer-form', 'Timers are set in the palette, so Escape returns to it');
  const close = current.find(item => item.id === 'process:close:root_process');
  assert.equal(close?.label, 'Close agent');
  assert.match(close?.confirmation ?? '', /1 subagent and 1 process: child, dev server/, 'Closing names what else it closes');
  assert.ok(!listed.some(item => item.id === 'navigate:agent:p:root'), 'The current agent is not listed to switch to');
  for (const id of ['navigate:agent:p:child', 'navigate:agent:p:terminal', 'navigate:agent:q:elsewhere']) {
    assert.ok(listed.some(item => item.id === id), `${id} is listed while an Integrated agent is open`);
  }
  assert.equal(listed.find(item => item.id === 'navigate:agent:p:child')?.hint, 'Subagent of root');
  assert.equal(listed.find(item => item.id === 'navigate:agent:q:elsewhere')?.hint, 'Other');
  assert.ok(listed.find(item => item.id === 'navigate:agent:p:child')?.actions?.some(action => action.id === 'process:close:child_process'), 'Agent rows carry their own actions');
  const home = (await listCommandPaletteCommands(integratedApplication, { active_project_id: null, active_terminal_id: null, active_tab: null })).commands;
  for (const id of ['navigate:agent:p:root', 'navigate:agent:p:child', 'navigate:agent:q:elsewhere']) {
    assert.ok(home.some(item => item.id === id), `${id} is listed from the home page`);
  }

  // Ended processes restart from their row and from their own page.
  const crashedRow = listed.find(item => item.id === 'process:restart:crashed');
  assert.equal(crashedRow?.primary, 'Restart');
  assert.match(crashedRow?.hint ?? '', /^Failed/);
  assert.ok(!listed.some(item => item.target?.processId === 'gone'), 'Closed processes are not listed');
  assert.equal(listed.find(item => item.id === 'navigate:process:p:server')?.hint, 'Started by child');
  const processCurrent = (await listCommandPaletteCommands(integratedApplication, { ...integratedContext, active_session_id: null, active_process_id: 'crashed' })).commands.filter(item => item.group === 'current');
  assert.deepEqual(processCurrent.map(item => item.id), ['process:restart:crashed', 'process:rename:crashed', 'renderer:copy:crashed', 'process:close:crashed']);
  assert.equal(processCurrent.find(item => item.id === 'process:close:crashed')?.confirmation, 'This stops the process.', 'Closing a process asks first');

  const calls: Array<{ name: string; args: unknown }> = [];
  const recording = { ...integratedApplication, mcp: { call: async (name: string, args: unknown) => { calls.push({ name, args }); return {}; } } } as unknown as typeof application;
  await assert.rejects(runCommandPaletteCommand(recording, { id: 'process:close:root_process', context: integratedContext }), /confirm/i, 'Closing running subagents needs confirmation');
  assert.equal(calls.length, 0);
  await runCommandPaletteCommand(recording, { id: 'process:close:root_process', context: integratedContext, input: { confirmed: true } });
  assert.deepEqual(calls, [{ name: 'close_process', args: { process_id: 'root_process' } }]);
  calls.length = 0;
  await assert.rejects(runCommandPaletteCommand(recording, { id: 'process:close:crashed', context: integratedContext }), /confirm/i, 'Closing a process needs confirmation too');
  assert.equal(calls.length, 0);
  assert.deepEqual(await runCommandPaletteCommand(recording, { id: 'navigate:process:p:server', context: integratedContext }), { navigate: { projectId: 'p', processId: 'server' } });

  // Launch choices, resuming, and timers go through the same tools as the rest of the UI.
  calls.length = 0;
  await runCommandPaletteCommand(recording, { id: 'spawn:agent:codex', context: integratedContext, input: { preset: 'fast', worktree_id: 'w', interface_mode: 'tui', initial_prompt: ' Fix the tests ', name: 'ignored', model: 'ignored' } });
  assert.deepEqual(calls, [{ name: 'harness_launch', args: { harness: 'codex', project_id: 'p', preset: 'fast', worktree_id: 'w', initial_prompt: 'Fix the tests', interface_mode: 'tui' } }]);
  calls.length = 0;
  await runCommandPaletteCommand(recording, { id: 'history:resume:conversation_1', context: integratedContext, input: { interface_mode: 'integrated', replace_process_id: 'root_process' } });
  assert.deepEqual(calls, [{ name: 'history_resume', args: { conversation_id: 'conversation_1', project_id: 'p', interface_mode: 'integrated', replace_process_id: 'root_process' } }]);
  calls.length = 0;
  for (const action of ['cancel', 'pause', 'resume']) await runCommandPaletteCommand(recording, { id: `timer:${action}:timer_1`, context: integratedContext });
  assert.deepEqual(calls.map(call => call.name), ['timer_cancel', 'timer_pause', 'timer_resume']);
  assert.ok(calls.every(call => (call.args as { timer_id?: string }).timer_id === 'timer_1'));
  await assert.rejects(runCommandPaletteCommand(recording, { id: 'timer:delete:timer_1', context: integratedContext }), /unknown timer command/);

  // Restart assistant shows while it runs and asks first while it responds.
  // The renderer runs it, because only the browser in control may.
  assert.ok(!listed.some(item => item.id === 'assistant:restart'), 'no assistant, no restart');
  let assistantActivity = 'idle';
  const withAssistant = {
    ...integratedApplication,
    database: { connection: { prepare: () => ({ get: () => ({ activity: assistantActivity }), all: () => [] }) } },
    mcp: { call: async (name: string) => name === 'assistant_get' ? { process_id: 'assistant_1' } : {} }
  } as unknown as typeof application;
  const restartRow = () => listCommandPaletteCommands(withAssistant, integratedContext).then(result => result.commands.find(item => item.id === 'assistant:restart'));
  assert.deepEqual(await restartRow(), { id: 'assistant:restart', label: 'Restart assistant', hint: 'Resume its conversation in a new Codex process', group: 'app', kind: 'renderer', result: { rendererAction: 'restartAssistant', processId: 'assistant_1' } });
  assistantActivity = 'working';
  assert.match((await restartRow())?.confirmation ?? '', /restarting stops it/);

  // The current item's actions come first and survive any number of rows.
  const legacyCommands = Array.from({ length: 500 }, (_, i) => command(`agent-${i}`, `Agent ${i}`));
  const opening = rankedCommands([...legacyCommands, ...listed], '', [], { page: 'agents' });
  const openingIds = ['integrated:interrupt:root_process', 'integrated:new:root_process', 'integrated:restart:root_process', 'renderer:session-context:root', 'process:rename:root_process', 'process:close:root_process', 'page:current-actions'];
  assert.deepEqual(opening.slice(0, openingIds.length).map(row => row.command.id), openingIds, 'Everyday actions open without More actions');
  assert.ok(opening.slice(0, openingIds.length).every(row => row.section === 'current'));
  assert.equal(opening[openingIds.length]?.section, 'agent');
  const more = opening.find(row => row.command.id === 'page:current-actions')?.command;
  assert.equal(more?.kind, 'page');
  assert.equal(more?.actions?.length, current.length, 'More actions lists every action for the current agent');
  assert.deepEqual([...new Set(opening.map(row => row.section))], ['current', 'agent', 'process', 'create', 'navigation', 'project', 'app']);
  assert.equal(rankedCommands(listed, 'close')[0]?.command.id, 'process:close:root_process');
  assert.equal(rankedCommands(listed, 'stop')[0]?.command.id, 'integrated:interrupt:root_process');

  // Selectors published by the open conversation join the current actions as settings.
  const withModel = withIntegratedSelectors(current, 'root_process', {
    selectors: [
      { id: 'model', label: 'Model', value: 'opus', options: [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }] },
      { id: 'mode', label: 'Mode', value: 'plan', options: [{ value: 'plan', label: 'Plan' }, { value: 'default', label: 'Default' }] }
    ],
    commands: []
  });
  const model = withModel.find(item => item.id === 'integrated:selector:root_process:model');
  assert.equal(withModel.findIndex(item => item.id === 'process:rename:root_process'), withModel.indexOf(model!) + 2, 'Settings sit together before Rename');
  assert.equal(model?.label, 'Model');
  assert.equal(model?.hint, 'Opus');
  assert.equal(model?.inline, true);
  assert.deepEqual(model?.actions?.filter(action => action.current).map(action => action.label), ['Opus'], 'Only the current model is checked');
  assert.deepEqual(model?.actions?.[1]?.result, { rendererAction: 'integrated', integrated: 'configure', processId: 'root_process', selector: 'model', value: 'sonnet' });
  assert.ok(withModel.some(item => item.label === 'Mode' && item.inline), 'Every setting opens without More actions');
  assert.equal(rankedCommands(withModel, 'change model')[0]?.command.id, model?.id, 'Settings are still found by the verb');
  assert.equal(rankedCommands(withModel, 'opus')[0]?.command.id, model?.id, 'and by their value');
  const thinking = withIntegratedSelectors(current, 'root_process', {
    selectors: [{ id: 'effort', label: 'Thinking', value: 'low', options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }],
    commands: []
  });
  for (const word of ['effort', 'reasoning', 'thinking', 'change reasoning']) {
    assert.equal(rankedCommands(thinking, word)[0]?.command.id, 'integrated:selector:root_process:effort', `"${word}" finds the effort setting`);
  }

  // Pages set settings and destructive actions apart.
  assert.deepEqual(withModel.map(actionCluster).filter((cluster, index, all) => cluster !== all[index - 1]), ['main', 'settings', 'main', 'danger']);
  assert.equal(describeDuration(600), '10 minutes');
  assert.equal(describeDuration(5400), '1 hour 30 minutes');
  assert.equal(describeDuration(1), '1 second');

  for (const tab of ['agents', 'todos', 'scratchpads', 'worktrees', 'history']) {
    const id = `navigate:project-tab:p:${tab}`;
    assert.ok(available.some(item => item.id === id), `${tab} is reachable from the single launcher`);
    assert.deepEqual(available.find(item => item.id === id)?.result, { navigate: { projectId: 'p', tab } });
    assert.deepEqual(await runCommandPaletteCommand(application, { id, context }), { navigate: { projectId: 'p', tab } });
  }
  const worktreeProject = { ...project, worktrees: [{ id: 'w', repoPath: '/tmp/project', worktreePath: '/tmp/project/.worktrees/w', branch: 'patterm/w' }] };
  const worktreeCommands = (await listCommandPaletteCommands({ ...application, currentWorkbench: () => ({ projects: [worktreeProject], harnesses: [] }) } as unknown as typeof application, context)).commands;
  const worktreeRow = worktreeCommands.find(item => item.id === 'worktree:shell:w');
  assert.equal(worktreeRow?.label, 'patterm/w');
  assert.ok(worktreeRow?.actions?.some(item => item.id === 'worktree:abandon:w'), 'Each worktree is one row with its actions');
  assert.ok(![...available, ...worktreeCommands].some(item => item.id.startsWith('diff:') || item.id.endsWith(':diffs')), 'diff snapshots and the Diffs page have no commands');
  const catalogue = [...available, ...legacyCommands];
  const openingRows = rankedCommands(catalogue, '', legacyCommands.slice(0, 20).map(item => item.id));
  for (const item of available.filter(item => item.group === 'navigation')) {
    assert.ok(openingRows.some(row => row.command.id === item.id), `${item.label} survives the result limit with a legacy backend`);
    assert.ok(rankedCommands(catalogue, item.label).some(row => row.command.id === item.id), `${item.label} is searchable`);
  }
  assert.ok(rendererCommands(null).some(item => item.id === 'renderer:settings'));
  assert.ok(rendererCommands('p').some(item => item.label === 'Worktrees'), 'a repository project has a Worktrees page');
  assert.ok(!rendererCommands('project_personal', false).some(item => item.label === 'Worktrees'), 'the Personal project has no Worktrees page');
  assert.ok(!rendererCommands(null).some(item => item.kind === 'navigate'), 'Project navigation needs a selected project');
  const creationCommands = [...available, ...(await listCommandPaletteCommands(application, context)).commands];
  for (const [noun, id] of [['worktree', 'worktree:create'], ['todo', 'renderer:todo-create'], ['scratchpad', 'renderer:scratchpad-create'], ['note', 'renderer:scratchpad-create'], ['project', 'renderer:project-create'], ['terminal', 'spawn:terminal'], ['process', 'spawn:process']]) {
    for (const verb of ['new', 'create', 'spawn']) {
      assert.equal(rankedCommands(creationCommands, `${verb} ${noun}`)[0]?.command.id, id, `${verb} ${noun} finds the creation action`);
    }
  }
  assert.equal(rankedCommands(creationCommands, 'todos')[0]?.command.id, 'navigate:project-tab:p:todos', 'Unqualified page searches still prefer navigation');
  assert.equal(rankedCommands(creationCommands, 'create scratchpads')[0]?.command.id, 'renderer:scratchpad-create');

  // The current page lifts the commands made for it.
  const onTodos = rankedCommands(creationCommands, '', [], { page: 'todos' });
  assert.deepEqual(onTodos.filter(row => row.section === 'suggested').map(row => row.command.id), ['renderer:todo-create']);
  assert.equal(rankedCommands(creationCommands, 'new', [], { page: 'todos' })[0]?.command.id, 'renderer:todo-create');
  assert.equal(rankedCommands(creationCommands, 'new', [], { page: 'scratchpads' })[0]?.command.id, 'renderer:scratchpad-create');

  for (const id of ['navigate:agent:p:child', 'spawn:agent:claude', 'renderer:todo-create', 'worktree:shell:w']) assert.ok(recordsRecent(command(id, id, { group: 'agent' })), `${id} is remembered`);
  for (const id of ['process:close:a', 'integrated:interrupt:a', 'renderer:copy:a', 'renderer:quit', 'worktree:abandon:w', 'goto:child']) assert.ok(!recordsRecent(command(id, id, { group: 'agent' })), `${id} is not remembered`);

  for (const kind of ['todo', 'scratchpad'] as const) {
    const calls: unknown[] = [];
    const target = await createPaletteDocument(kind, 'p', async (name, args) => { calls.push({ name, args }); return { id: 'created' }; });
    assert.deepEqual(calls, [{ name: `${kind}_create`, args: { project_id: 'p', title: `Untitled ${kind}` } }]);
    assert.deepEqual(target, { projectId: 'p', tab: `${kind}s`, recordId: 'created' });
  }
  await assert.rejects(createPaletteDocument('todo', null, async () => { throw new Error('Must not call'); }), /Select a project/);
  await assert.rejects(createPaletteDocument('scratchpad', 'p', async () => { throw new Error('Save failed'); }), /Save failed/);

  // The bots' and the assistant's hidden projects ride along in the
  // workbench, but the palette lists neither them nor their sessions.
  const hiddenProjects = [
    { project: { id: 'project_bot_fable', name: 'Fable', path: '/tmp/fable', kind: 'bots' }, projectSessions: [session('fable', { sessionRole: 'bot' })], processes: [], worktrees: [], timers: [] },
    { project: { id: 'project_assistant', name: 'Assistant', path: '/tmp/assistant', kind: 'assistant' }, projectSessions: [session('assistant', { sessionRole: 'assistant' })], processes: [], worktrees: [], timers: [] }
  ];
  const withHidden = { ...application, currentWorkbench: () => ({ projects: [project, ...hiddenProjects], harnesses: [] }) } as unknown as typeof application;
  const hiddenIds = (await listCommandPaletteCommands(withHidden, context)).commands.map((entry) => entry.id).filter((id) => /project_bot_fable|project_assistant/.test(id));
  assert.deepEqual(hiddenIds, []);
  assert.equal((await listCommandPaletteCommands(withHidden, { ...context, active_project_id: 'project_bot_fable' })).commands.some((entry) => entry.id.startsWith('spawn:')), false, 'a bot project is never the active project');
  console.log('Command palette smoke checks passed');
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
