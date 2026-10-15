import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { buildSync } from 'esbuild';

import { listCommandPaletteCommands, runCommandPaletteCommand } from '../app/Commands/CommandPalette';
import { McpSocketServer } from '../app/MCP/McpSocketServer';
import { DatabaseService } from '../app/Services/DatabaseService';
import type { HarnessLauncher } from '../app/Services/HarnessLauncher';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import type { AgentHistoryImportQueueService } from '../app/Services/AgentHistory/AgentHistoryImportQueueService';
import type { AgentHistoryReadService } from '../app/Services/AgentHistory/AgentHistoryReadService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';
import type { NotificationActions } from '../app/Actions/NotificationActions';
import { WorkbenchSeeder } from './fixtures/WorkbenchSeeder';
import { ipcPath } from '../app/Platform/Ipc';
import { removeTree } from './fixtures/TempTree';

const FIGURE_TOOLS = ['html_render'];

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-workbench-'));
  try {
    const database = new DatabaseService(tempDir);
    database.initialize();

    // The global Assistant is hidden from the workbench but Quit still stops it.
    database.connection.exec("insert into projects (id, name, path, kind, created_at, updated_at) values ('assistant_quit', 'Assistant', '/tmp', 'assistant', 'now', 'now'); insert into processes (id, project_id, kind, name, status, activity, created_at, updated_at) values ('assistant_quit', 'assistant_quit', 'agent', 'Assistant', 'running', 'working', 'now', 'now')");
    let shutdowns = 0;
    const assistantOnly = { database, currentWorkbench: () => new WorkbenchRepository(database).snapshot(), timers: { list: () => [] }, shutdown: async () => { shutdowns++; } } as unknown as Parameters<typeof runCommandPaletteCommand>[0];
    assert.deepEqual(assistantOnly.currentWorkbench().projects, []);
    await assert.rejects(runCommandPaletteCommand(assistantOnly, { id: 'renderer:quit', context: { active_project_id: null, active_terminal_id: null, active_tab: null } }), /Confirm Quit/);
    assert.equal(shutdowns, 0);
    database.connection.exec("delete from processes where id = 'assistant_quit'; delete from projects where id = 'assistant_quit'");

    const seeder = new WorkbenchSeeder(database, new TimelineService(database));
    seeder.seedIfEmpty();
    seeder.seedIfEmpty(); // idempotent

    const repo = new WorkbenchRepository(database);
    const snapshot = repo.snapshot();
    const projectSnapshot = snapshot.projects[0];
    assert.ok(projectSnapshot, 'seed project present');

    assert.equal(projectSnapshot.projectSessions.length, 4);
    assert.equal(projectSnapshot.worktrees.length, 1);
    assert.equal('diffs' in projectSnapshot, false, 'diff snapshots are no longer part of the workbench');
    assert.equal('tasks' in projectSnapshot, false);
    assert.equal('timeline' in projectSnapshot, false, 'routine snapshots omit the unbounded timeline');
    assert.ok(projectSnapshot.projectSessions.some((session) => session.parentId));
    assert.deepEqual(projectSnapshot.timers, [], 'snapshots without a timer service list no timers');

    const ownedProcessId = projectSnapshot.projectSessions.find((session) => session.processId)?.processId;
    assert.ok(ownedProcessId, 'seed session has a process');
    const timerFields = { kind: 'delay' as const, status: 'pending' as const, watched: [], body: 'wake', label: null, firesAtUnixMs: 1, pausedRemainingMs: null, createdAtUnixMs: 0 };
    const timedRepo = new WorkbenchRepository(database, undefined, {
      list: () => [{ ...timerFields, id: 'owned', ownerProcessId: ownedProcessId }, { ...timerFields, id: 'foreign', ownerProcessId: 'proc_elsewhere' }, { ...timerFields, id: 'unowned', ownerProcessId: null }]
    });
    assert.deepEqual(timedRepo.snapshot().projects[0]?.timers.map((item) => item.id), ['owned'], 'project snapshots list only timers owned by project processes');

    // Sessions and processes that ended over a day ago leave the snapshot,
    // unless a todo is assigned to them, and stay readable on demand.
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
    const db = database.connection;
    db.prepare(`insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)`).run('p_window', 'Window', '/srv/window', at(500), at(500));
    const addProcess = (id: string, kind: string, status: string, exitedAt: string | null) => db.prepare(
      `insert into processes (id, project_id, kind, name, status, created_at, updated_at, exited_at) values (?, 'p_window', ?, ?, ?, ?, ?, ?)`
    ).run(id, kind, id, status, at(400), at(400), exitedAt);
    const addSession = (id: string, processId: string, exitedAt: string | null) => db.prepare(
      `insert into sessions (id, project_id, process_id, harness, session_role, resume_status, started_at, exited_at, created_by_actor) values (?, 'p_window', ?, 'claude', 'orchestrator', 'found', ?, ?, 'user')`
    ).run(id, processId, at(400), exitedAt);
    addProcess('agent_live', 'agent', 'running', null);
    addProcess('agent_recent', 'agent', 'closed', at(3));
    addProcess('agent_old', 'agent', 'closed', at(48));
    addProcess('agent_assigned', 'agent', 'closed', at(72));
    addSession('s_live', 'agent_live', null);
    addSession('s_recent', 'agent_recent', at(3));
    addSession('s_old', 'agent_old', at(48));
    addSession('s_assigned', 'agent_assigned', at(72));
    addProcess('cmd_running', 'command', 'running', null);
    addProcess('cmd_recent', 'command', 'exited', at(2));
    addProcess('cmd_old', 'command', 'exited', at(30));
    db.prepare(`insert into todos (id, project_id, title, created_at, updated_at, created_by_actor) values ('t_window', 'p_window', 'Assigned', ?, ?, 'user')`).run(at(100), at(100));
    db.prepare(`insert into todo_assignments (todo_id, assignee_id, session_id) values ('t_window', 's_assigned', 's_assigned')`).run();
    const windowRepo = new WorkbenchRepository(database, undefined, undefined, () => now);
    const windowed = windowRepo.snapshot().projects.find((item) => item.project.id === 'p_window')!;
    assert.deepEqual(windowed.projectSessions.map((session) => session.id), ['s_live', 's_recent', 's_assigned'], 'sessions that ended over a day ago leave the snapshot unless assigned');
    assert.deepEqual(windowed.processes.map((process) => process.id), ['cmd_running', 'cmd_recent'], 'processes that ended over a day ago leave the snapshot');
    const windowSessions = () => windowRepo.snapshot().projects.find((item) => item.project.id === 'p_window')!.projectSessions.map((session) => session.id);
    db.prepare(`insert into todo_assignments (todo_id, assignee_id, session_id) values ('t_window', 's_old', 's_old')`).run();
    assert.ok(windowSessions().includes('s_old'), 'assigning a todo to an ended session brings it back into the snapshot');
    db.prepare(`delete from todo_assignments where todo_id = 't_window' and session_id = 's_old'`).run();
    assert.ok(!windowSessions().includes('s_old'), 'removing the assignment leaves it out again');
    const archived = windowRepo.record({ project_id: 'p_window', session_id: 's_old', process_id: 'cmd_old' });
    assert.equal(archived.session?.id, 's_old');
    assert.equal(archived.session?.exitedAt, at(48));
    assert.equal(archived.process?.id, 'cmd_old');
    assert.deepEqual(windowRepo.record({ project_id: 'p_window', session_id: 'missing', process_id: 'agent_old' }), { session: null, process: null }, 'missing sessions and agent processes read as null');
    assert.equal(windowRepo.record({ project_id: 'p_window', process_id: 'agent_old' }).session?.id, 's_old', 'an agent process ID alone reads its session');
    assert.equal(windowRepo.record({ project_id: 'p_window', process_id: 'cmd_old' }).session, null, 'a command process has no session');
    assert.equal(windowRepo.record({ project_id: 'other', process_id: 'agent_old' }).session, null, 'agent sessions are read within their project');
    assert.equal(windowRepo.record({ project_id: 'other', session_id: 's_old' }).session, null, 'records are read within their project');
    db.prepare(`delete from todo_assignments where todo_id = 't_window'`).run();
    db.prepare(`delete from todos where id = 't_window'`).run();
    db.prepare(`delete from sessions where project_id = 'p_window'`).run();
    db.prepare(`delete from processes where project_id = 'p_window'`).run();
    db.prepare(`delete from projects where id = 'p_window'`).run();

    // MCP registry: direct public tools and read tools route through the repository.
    const terminalRequests: Array<{ method: string; params: unknown }> = [];
    const fakeTerminal = {
      isAvailable: () => false,
      request: async (method: string, params: unknown) => {
        terminalRequests.push({ method, params });
        if (method === 'terminal.process.stop' && (params as { process_id: string }).process_id === 'old_child') {
          throw new Error('process not found: old_child');
        }
        if (method === 'terminal.process.output') {
          return { process_id: 'proc_identity', status: 'running', screen: 'server http://localhost:5173 ready', lines: ['server http://localhost:5173 ready'], rows: 1, cols: 80 };
        }
        if (method === 'terminal.process.search') {
          return { matches: [{ row: 0, col: 7, length: 21 }] };
        }
        if (method === 'terminal.process.status') {
          return { process_id: 'proc_identity', status: 'running', rows: 1, cols: 80 };
        }
        if (method === 'terminal.process.close') {
          const id = (params as { process_id: string }).process_id;
          const process = database.connection.prepare('select status from processes where id = ? or pty_process_id = ?').get(id, id) as { status: string };
          assert.equal(process.status, 'closed', 'persist closure before releasing terminal state');
        }
        return { ok: true };
      }
    } as unknown as TerminalService;
    const registryTimeline = new TimelineService(database);
    let importedHistoryProjectId: string | null | undefined;
    let listedHistoryProjectId: string | null | undefined;
    let searchedHistoryInput: { project_id: string } | undefined;
    const handledNotifications: string[] = [];
    const reportedNotifications: string[] = [];
    const registry = createTestMcpRegistry({
      tempDir,
      notifications: { userInput: (processId: string) => { handledNotifications.push(processId); }, reported: (processId: string) => { reportedNotifications.push(processId); } } as unknown as NotificationActions,
      database,
      terminal: fakeTerminal,
      timeline: registryTimeline,
      workbench: repo,
      historyImportQueue: {
        import(input: { project_id?: string | null }) {
          importedHistoryProjectId = input.project_id;
          return { queued: true };
        }
      } as unknown as AgentHistoryImportQueueService,
      historyReadService: {
        list(input: { project_id?: string | null }) {
          listedHistoryProjectId = input.project_id;
          return { conversations: [] };
        },
        search(input: { project_id: string }) {
          searchedHistoryInput = input;
          return { query: 'needle', results: [] };
        }
      } as unknown as AgentHistoryReadService
    });

    const paletteApplication = { database, workbench: repo, currentWorkbench: () => repo.snapshot(), mcp: registry } as Parameters<typeof listCommandPaletteCommands>[0];
    const paletteContext = { active_project_id: projectSnapshot.project.id, active_terminal_id: null, active_tab: null };
    const commands = (await listCommandPaletteCommands(paletteApplication, paletteContext)).commands;
    assert.equal(commands.find((command) => command.id === 'worktree:create')?.input?.type, 'text');
    assert.ok(!commands.some((command) => command.id.startsWith('task:') || command.id.startsWith('issue:')));
    assert.ok(!commands.some((command) => command.id.startsWith('diff:') || command.id.endsWith(':diffs')), 'diff snapshot and Diffs page commands are removed');
    assert.deepEqual(await runCommandPaletteCommand(paletteApplication, { id: `navigate:project-tab:${projectSnapshot.project.id}:worktrees`, context: paletteContext }), { navigate: { projectId: projectSnapshot.project.id, tab: 'worktrees' } });
    await assert.rejects(runCommandPaletteCommand(paletteApplication, { id: 'task:create', context: paletteContext }), /unknown command/);

    assert.deepEqual(registry.changedTopics('get_project_status'), [], 'project status reads do not force workbench refreshes');
    assert.deepEqual(registry.changedTopics('history_import_status'), [], 'history import status polling is read-only');
    assert.deepEqual(registry.changedTopics('search_conversation_history'), [], 'history search is read-only');
    assert.deepEqual(registry.changedTopics('integrated_get'), [], 'integrated transcript polling is read-only');
    assert.deepEqual(registry.changedTopics('integrated_history'), [], 'older transcript pages are read-only');
    assert.deepEqual(registry.changedTopics('integrated_controls'), [], 'integrated control reads are read-only');
    const publicTools = registry.publicTools();
    const publicNames = publicTools.map(({ name }) => name);
    assert.equal(publicNames.length, 80, 'the catalogue contains only agent-facing tools');
    assert.equal(new Set(publicNames).size, publicNames.length, 'each tool has a unique public name');
    assert.ok(publicNames.every((name) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name)), 'every tool name is snake_case');
    for (const name of ['spawn_agent', 'get_conversation_output', 'report_to_parent', 'notify_user', 'request_close', 'notification_list', 'timer_fire_when_reported_all', 'search_conversation_history', 'help', 'todo_create', 'reference_attach', 'session_context', 'history_get', 'assistant_overview', 'assistant_focus', 'assistant_focus_set', 'host_read']) {
      assert.ok(publicNames.includes(name), `${name} is advertised directly`);
    }
    // Hidden tools stay off the catalogue, and the old dotted spellings are gone.
    for (const name of ['patterm.call', 'patterm.discover', 'patterm.whoami', 'patterm.help', 'patterm.todo.create', 'todo.create', 'ui.save', 'session.context', 'start_process', 'get_process_raw_output', 'timer_wait', 'history_search', 'terminal_process_spawn', 'terminal_process_scroll', 'project_list', 'project_create', 'harness_discover', 'harness_models_refresh', 'harness_preset_update', 'history_reset_imports', 'history_delete', 'todo_lease_revoke', 'request_human_attention']) {
      assert.ok(!publicNames.includes(name), `${name} is not advertised`);
      await assert.rejects(registry.callPublic(name, {}), /unknown MCP tool/);
    }
    for (const tool of publicTools) {
      const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
      for (const field of tool.inputSchema.required as string[] | undefined ?? []) {
        assert.ok(properties && field in properties, `${tool.name} describes required field ${field}`);
      }
    }
    assert.ok((registry.helpPublic('help').inputSchema.properties as Record<string, unknown>).tool, 'help advertises its required argument');
    assert.ok((registry.helpPublic('spawn_agent').inputSchema.properties as Record<string, unknown>).preset, 'agent launch advertises preset selection');
    assert.ok((registry.helpPublic('reference_attach').inputSchema.properties as Record<string, unknown>).target_id, 'project context tools advertise their input');
    assert.deepEqual(registry.helpPublic('timer_set').inputSchema.required, ['seconds'], 'elapsed timers do not require a custom message');
    assert.throws(() => registry.helpPublic('integrated_send'), /unknown MCP tool/);
    assert.equal(registry.helpPublic('html_render').name, 'html_render', 'help takes the name every harness shows');
    assert.throws(() => registry.helpPublic('html.render'), /unknown MCP tool/);
    assert.throws(() => registry.helpPublic('ui_save'), /unknown MCP tool/, 'ui_save is retired');
    assert.throws(() => registry.register({ name: 'todo.archive', namespace: 'todo', description: 'x', inputSchema: { type: 'object' } }, () => null), /must be snake_case/);

    // Messages sent from the composer, even mid-turn, withdraw a close request.
    const clearedCloseRequests: string[] = [];
    const composerRegistry = createTestMcpRegistry({
      tempDir,
      database,
      terminal: fakeTerminal,
      timeline: registryTimeline,
      workbench: repo,
      integrated: { prompt: async () => ({}), updateQueued: async () => ({}) } as unknown as Parameters<typeof createTestMcpRegistry>[0]['integrated'],
      closeRequests: { request: async () => ({ status: 'requested' as const }), answer: async () => ({ kept_open: true as const }), clear: (processId: string) => { clearedCloseRequests.push(processId); return true; } }
    });
    await composerRegistry.call('integrated_send', { process_id: 'proc_composer', text: 'One more thing' });
    await composerRegistry.call('integrated_queue_update', { process_id: 'proc_composer', message_id: 'message_1', action: 'steer' });
    await composerRegistry.call('integrated_queue_update', { process_id: 'proc_composer', message_id: 'message_2', action: 'cancel' });
    assert.deepEqual(clearedCloseRequests, ['proc_composer', 'proc_composer'], 'sending and steering withdraw a close request; cancelling does not');

    const mcpNow = new Date().toISOString();
    database.connection
      .prepare(
        `insert into processes (id, project_id, kind, name, status, created_at, updated_at)
         values ('proc_identity', ?, 'agent', 'orchestrator', 'running', ?, ?)`
      )
      .run(projectSnapshot.project.id, mcpNow, mcpNow);
    database.connection
      .prepare(
        `insert into sessions (id, project_id, process_id, mcp_identity, harness, session_role, resume_status, started_at, last_title)
         values ('session_identity', ?, 'proc_identity', 'identity_test', 'claude', 'orchestrator', 'unknown', ?, 'orchestrator')`
      )
      .run(projectSnapshot.project.id, mcpNow);
    database.connection
      .prepare(`insert into projects (id, name, path, created_at, updated_at) values ('project_other', 'Other Project', '/tmp/other', ?, ?)`)
      .run(mcpNow, mcpNow);
    database.connection
      .prepare(
        `insert into worktrees (id, project_id, repo_path, worktree_path, branch, created_by, created_at)
         values ('worktree_other', 'project_other', '/tmp/other', '/tmp/other/.worktrees/task', 'patterm/other', 'test', ?)`
      )
      .run(mcpNow);
    database.connection
      .prepare(
        `insert into processes (id, project_id, kind, name, status, created_at, updated_at)
         values ('proc_other', 'project_other', 'agent', 'other agent', 'running', ?, ?)`
      )
      .run(mcpNow, mcpNow);
    database.connection
      .prepare(
        `insert into sessions (id, project_id, process_id, mcp_identity, harness, session_role, resume_status, started_at, last_title)
         values ('session_other', 'project_other', 'proc_other', 'identity_other', 'codex', 'orchestrator', 'unknown', ?, 'other')`
      )
      .run(mcpNow);

    const identityContext = { identity: 'identity_test' };
    await assert.rejects(
      registry.call('search_conversation_history', { query: 'needle' }),
      /active MCP caller identity/,
      'conversation history search fails closed without an active caller'
    );
    const who = (await registry.call('whoami', { include_tools: true }, identityContext)) as { process_id: string; available_tools: string[] };
    assert.equal(who.process_id, 'proc_identity', 'direct whoami resolves MCP identity');
    assert.ok(who.available_tools.includes('spawn_agent'), 'orchestrator can see spawn_agent');
    const scopedProcesses = (await registry.call('list_processes', {}, identityContext)) as {
      current_process_id: string;
      processes: Array<{ process_id: string; is_current?: boolean }>;
    };
    assert.equal(scopedProcesses.current_process_id, 'proc_identity', 'process list identifies the caller process');
    assert.ok(scopedProcesses.processes.some((process) => process.process_id === 'proc_identity'), 'caller project process is visible');
    assert.equal(scopedProcesses.processes.find((process) => process.process_id === 'proc_identity')?.is_current, true, 'caller process is marked current');
    assert.ok(scopedProcesses.processes.filter((process) => process.process_id !== 'proc_identity').every((process) => process.is_current !== true), 'only the caller process is marked current');
    assert.ok(!scopedProcesses.processes.some((process) => process.process_id === 'proc_other'), 'other project process is hidden');
    const scopedProcessesByNamespace = (await registry.callPublic('list_processes', {}, identityContext)) as {
      current_process_id: string;
      processes: Array<{ process_id: string; is_current?: boolean }>;
    };
    assert.equal(scopedProcessesByNamespace.current_process_id, 'proc_identity', 'direct MCP calls preserve caller identity');
    await assert.rejects(
      registry.call('process_create', { project_id: projectSnapshot.project.id, worktree_id: 'worktree_other' }, identityContext),
      /outside the current caller scope/,
      'process spawn rejects foreign worktree cwd'
    );
    await assert.rejects(registry.call('diff_current', { worktree_id: 'worktree_other' }, identityContext), /outside the current caller scope/, 'diffs reject foreign worktrees');
    await assert.rejects(registry.call('diff_file', { worktree_id: 'worktree_other', path: 'README.md' }, identityContext), /outside the current caller scope/, 'diff files reject foreign worktrees');
    await assert.rejects(registry.call('diff_current', {}), /worktree_id is required for owner requests/);
    assert.ok(publicNames.includes('session_rename'));
    await assert.rejects(registry.call('session_rename', { name: 'Unauthenticated' }), /authenticated/);
    await assert.rejects(registry.call('session_rename', { name: 'Unknown' }, { identity: 'invalid' }));
    await assert.rejects(registry.call('session_rename', { name: '   ' }, identityContext));
    await assert.rejects(registry.call('session_rename', { name: 'x'.repeat(501) }, identityContext));
    await assert.rejects(registry.call('session_rename', { name: 'Other', process_id: 'proc_other' }, identityContext));
    for (const name of ['Investigating titles', 'Implementing titles']) {
      assert.deepEqual(await registry.callPublic('session_rename', { name: ` ${name} ` }, identityContext), { renamed: true });
      assert.equal(repo.snapshot().projects[0]?.projectSessions.find((session) => session.processId === 'proc_identity')?.displayName, name);
      assert.equal((database.connection.prepare("select name from processes where id = 'proc_identity'").get() as { name: string }).name, name);
    }
    await registry.call('rename_process', { process_id: 'proc_identity', name: 'renamed orchestrator' });
    const discarded = { renamed: false, reason: 'user_override' };
    assert.deepEqual(await registry.call('session_rename', { name: 'Agent replacement' }, identityContext), discarded);
    assert.deepEqual(await registry.call('rename_process', { process_id: 'proc_identity', name: 'Legacy replacement' }, identityContext), discarded);
    assert.equal((database.connection.prepare("select title_set_by_user from sessions where id = 'session_identity'").get() as { title_set_by_user: number }).title_set_by_user, 1);
    assert.equal((database.connection.prepare("select name from processes where id = 'proc_identity'").get() as { name: string }).name, 'renamed orchestrator');

    database.connection.prepare(`update sessions set last_title = 'runtime title' where process_id = 'proc_identity'`).run();
    const renamed = repo.snapshot().projects[0]?.projectSessions.find((session) => session.processId === 'proc_identity');
    assert.equal(renamed?.displayName, 'renamed orchestrator', 'agent rename is stored separately from runtime title');
    assert.equal(renamed?.lastTitle, 'runtime title', 'runtime title remains independently updateable');
    const renamedList = (await registry.call('list_processes', { kind: 'agent' })) as { processes: Array<{ process_id: string; name: string }> };
    assert.equal(renamedList.processes.find((process) => process.process_id === 'proc_identity')?.name, 'renamed orchestrator', 'CLI process list prefers display name');
    const nestedWho = (await registry.callPublic('whoami', { include_tools: true }, identityContext)) as {
      process_id: string;
    };
    assert.equal(nestedWho.process_id, 'proc_identity', 'direct whoami preserves caller identity');
    const nestedStatus = (await registry.callPublic('get_project_status', {}, identityContext)) as {
      current_process_id: string;
      processes: Array<{ process_id: string; is_current?: boolean }>;
    };
    assert.equal(nestedStatus.current_process_id, 'proc_identity', 'direct project status identifies the caller process');
    assert.equal(nestedStatus.processes.find((process) => process.process_id === 'proc_identity')?.is_current, true, 'project status marks the caller process current');
    database.connection
      .prepare(
        `insert into processes (id, project_id, parent_process_id, kind, name, status, created_at, updated_at)
         values ('proc_child_identity', ?, 'proc_identity', 'agent', 'child', 'running', ?, ?)`
      )
      .run(projectSnapshot.project.id, mcpNow, mcpNow);
    database.connection
      .prepare(
        `insert into sessions (id, project_id, process_id, mcp_identity, harness, session_role, resume_status, started_at, last_title)
         values ('session_child_identity', ?, 'proc_child_identity', 'identity_child', 'codex', 'child', 'unknown', ?, 'child')`
      )
      .run(projectSnapshot.project.id, mcpNow);
    const messageTimelineBefore = database.connection.prepare(`select count(*) as n from timeline_events`).get() as { n: number };
    const codexMessage = 'x'.repeat(2_232);
    await registry.call('send_message', { target_process_id: 'proc_child_identity', message: codexMessage }, identityContext);
    const childMessage = terminalRequests.filter((request) => request.method === 'terminal.process.input').at(-1);
    assert.deepEqual(childMessage?.params, {
      process_id: 'proc_child_identity',
      kind: 'paste',
      text: `[message from proc_identity]\n${codexMessage}`,
      submit: true
    });
    await registry.call('send_message', { target_process_id: 'parent', message: 'child reporting in' }, { identity: 'identity_child' });
    const parentMessage = terminalRequests.filter((request) => request.method === 'terminal.process.input').at(-1);
    assert.deepEqual(parentMessage?.params, {
      process_id: 'proc_identity',
      kind: 'paste',
      text: '[message from proc_child_identity]\nchild reporting in',
      submit: true
    });
    // A parent's message ends its child's blocked episode; a child's message
    // to its parent leaves the parent's own requests open.
    assert.deepEqual(handledNotifications, ['proc_child_identity']);
    const messageTimelineAfter = database.connection.prepare(`select count(*) as n from timeline_events`).get() as { n: number };
    assert.equal(messageTimelineAfter.n, messageTimelineBefore.n, 'send_message remains ephemeral and does not write timeline events');
    const report = (await registry.call(
      'report_to_parent',
      { status: 'no_findings', title: 'Review complete', body: 'No findings.' },
      { identity: 'identity_child' }
    )) as { ok: boolean; event_id: string };
    assert.equal(report.ok, true, 'report_to_parent returns success');
    assert.deepEqual(reportedNotifications, ['proc_child_identity'], 'a report clears the reporter\'s turn-ended notice');
    const parentReport = terminalRequests.filter((request) => request.method === 'terminal.process.input').at(-1);
    assert.deepEqual(parentReport?.params, {
      process_id: 'proc_identity',
      kind: 'paste',
      text: '[report from proc_child_identity: no_findings]\nReview complete\nNo findings.',
      submit: true
    });
    const reportEvent = database.connection
      .prepare(`select event_type, process_id, session_id, metadata from timeline_events where id = ?`)
      .get(report.event_id) as { event_type: string; process_id: string | null; session_id: string | null; metadata: string } | undefined;
    assert.equal(reportEvent?.event_type, 'agent.reported', 'report_to_parent persists a report event');
    assert.equal(reportEvent?.process_id, 'proc_child_identity', 'report event is associated with the child process');
    assert.equal(reportEvent?.session_id, 'session_child_identity', 'report event is associated with the child session');
    assert.equal(JSON.parse(reportEvent?.metadata ?? '{}').parent_process_id, 'proc_identity', 'report event records the parent process');
    const spawnProcessHelp = registry.help('spawn_process');
    assert.ok((spawnProcessHelp.inputSchema.properties as Record<string, unknown>).detached, 'spawn_process advertises detached');
    assert.match(spawnProcessHelp.usageNotes?.join('\n') ?? '', /Only spawn detached processes when the user has specifically asked/, 'spawn_process help restricts detaching to user requests');
    const spawnAgentHelp = registry.help('spawn_agent');
    assert.ok((spawnAgentHelp.inputSchema.properties as Record<string, unknown>).detached, 'spawn_agent advertises detached');
    assert.match(spawnAgentHelp.usageNotes?.join('\n') ?? '', /Only spawn detached agents when the user has specifically asked/, 'spawn_agent help restricts detaching to user requests');
    const agentLaunches: Array<{ parent_process_id: string | null; session_role: string; actor_id: string | null; initial_prompt: string }> = [];
    const launchRegistry = createTestMcpRegistry({
      tempDir,
      database,
      terminal: fakeTerminal,
      timeline: registryTimeline,
      workbench: repo,
      harnessLauncher: {
        async launch(launch: (typeof agentLaunches)[number]) {
          agentLaunches.push(launch);
          return { process_id: `proc_launched_${agentLaunches.length}`, harness: 'claude' };
        },
        async resume(launch: (typeof agentLaunches)[number]) {
          agentLaunches.push(launch);
          return { process_id: `proc_launched_${agentLaunches.length}`, harness: 'claude' };
        }
      } as unknown as HarnessLauncher,
      historyReadService: {
        findConversation: (id: string) => ({ id, projectId: projectSnapshot.project.id, provider: 'claude', providerConversationId: `resume_${id}`, worktreeId: null, cwd: tempDir, sessionId: null, title: null })
      } as unknown as AgentHistoryReadService
    });
    const attached = (await launchRegistry.call('spawn_agent', { agent: 'claude', prompt: 'review' }, identityContext)) as { parent_process_id?: string };
    assert.equal(attached.parent_process_id, 'proc_identity', 'spawned agents are children by default');
    assert.equal(agentLaunches[0]?.session_role, 'child');
    assert.match(agentLaunches[0]?.initial_prompt ?? '', /call report_to_parent/, 'children are told to report to their parent');
    const detached = (await launchRegistry.call('spawn_agent', { agent: 'claude', prompt: 'review', detached: true }, identityContext)) as { parent_process_id?: string };
    assert.equal(detached.parent_process_id, undefined, 'detached agents have no parent');
    assert.equal(agentLaunches[1]?.parent_process_id, null, 'detached agents launch without a parent process');
    assert.equal(agentLaunches[1]?.session_role, 'orchestrator', 'detached agents launch as top-level agents');
    assert.equal(agentLaunches[1]?.actor_id, 'session_identity', 'detached agents still record who spawned them');
    assert.match(agentLaunches[1]?.initial_prompt ?? '', /do not call report_to_parent/, 'detached agents are told they have no parent');
    await launchRegistry.call('spawn_agent', { agent: 'claude', detached: true }, identityContext);
    assert.equal(agentLaunches[2]?.initial_prompt, '', 'a fresh detached agent without a prompt starts idle');
    await launchRegistry.call('spawn_agent', { conversation_id: 'conv_former_child', prompt: '  ', detached: true }, identityContext);
    assert.equal(agentLaunches[3]?.parent_process_id, null, 'detached resumes launch without a parent process');
    assert.match(agentLaunches[3]?.initial_prompt ?? '', /do not call report_to_parent/, 'a resumed detached agent is told it has no parent even without new text');
    await assert.rejects(
      registry.call('report_to_parent', { body: 'done' }, identityContext),
      /no parent agent .* notify_user/,
      'report_to_parent explains that parentless agents cannot report'
    );
    const sendMessageHelp = registry.help('send_message');
    assert.match(sendMessageHelp.usageNotes?.join('\n') ?? '', /parent/, 'send_message help documents the parent alias');
    assert.match(sendMessageHelp.usageNotes?.join('\n') ?? '', /Do not message a running child to check its status, hurry it, or ask it to wrap up/, 'send_message help forbids status nudges');
    assert.match(sendMessageHelp.usageNotes?.join('\n') ?? '', /genuinely new task information or to cancel at the user's request/, 'send_message help documents valid running-child messages');
    const timerHelp = registry.help('timer_set');
    assert.match(timerHelp.usageNotes?.join('\n') ?? '', /inspect next/, 'timer_set help tells agents to include next inspection guidance');
    assert.match(timerHelp.usageNotes?.join('\n') ?? '', /delegated-agent completion.*timer_fire_when_reported_any\/all/, 'timer_set help points delegated work to report timers');
    const idleAllHelp = registry.help('timer_fire_when_idle_all');
    assert.match(idleAllHelp.usageNotes?.join('\n') ?? '', /rescue timeout/, 'idle timer help documents rescue timeouts');
    assert.match(idleAllHelp.usageNotes?.join('\n') ?? '', /Do not use tiny 5-30 second fallbacks/, 'idle timer help discourages premature fallback waits');
    assert.match(idleAllHelp.usageNotes?.join('\n') ?? '', /20\+ minutes/, 'idle timer help warns that substantive LLM work can run quietly for a long time');
    assert.match(idleAllHelp.usageNotes?.join('\n') ?? '', /1200\+ seconds/, 'idle timer help suggests true long-running rescue timeouts');
    assert.match(idleAllHelp.usageNotes?.join('\n') ?? '', /timer_fire_when_reported_all/, 'idle timer help points delegated completion to report timers');
    assert.match(idleAllHelp.usageNotes?.join('\n') ?? '', /do not loop get_process_output/i, 'idle timer help tells agents not to poll output');
    const reportedAllHelp = registry.help('timer_fire_when_reported_all');
    assert.match(reportedAllHelp.usageNotes?.join('\n') ?? '', /report_to_parent/, 'reported timer help documents the child report completion signal');
    assert.match(reportedAllHelp.usageNotes?.join('\n') ?? '', /20\+ minutes/, 'reported timer help warns that reviews can be long-running');
    assert.match(reportedAllHelp.usageNotes?.join('\n') ?? '', /wait for its callback/i, 'reported timer help tells parents to wait for the callback');
    assert.match(reportedAllHelp.usageNotes?.join('\n') ?? '', /does not justify nudging the remaining children/, 'reported timer help prevents early reports from prompting sibling nudges');
    assert.equal(
      ((idleAllHelp.inputSchema.properties as Record<string, { type?: string }> | undefined)?.max_wait_seconds)?.type,
      'number',
      'idle timer schema advertises max_wait_seconds'
    );
    const outputHelp = registry.help('get_process_output');
    assert.match(outputHelp.usageNotes?.join('\n') ?? '', /not a durable transcript or final-answer transport/, 'output help documents rendered viewport semantics');
    const inputResult = (await registry.call('send_input', { process_id: 'proc_identity', kind: 'key', key: 'ctrl-c', tail_mode: 'grid' })) as {
      ok: boolean;
      tail: { content: string };
    };
    assert.equal(inputResult.ok, true);
    assert.match(inputResult.tail.content, /localhost:5173/);
    await registry.call('send_input', { process_id: 'proc_identity', kind: 'key', key: 'enter' });
    await registry.call('send_input', { process_id: 'proc_identity', kind: 'key', key: 'ctrl+u' });
    const inputRequests = terminalRequests.filter((request) => request.method === 'terminal.process.input');
    assert.equal((inputRequests.at(-2)?.params as { text?: string }).text, '\r', 'enter sends carriage return');
    assert.equal((inputRequests.at(-1)?.params as { text?: string }).text, '\u0015', 'ctrl+u clears agent composer');
    assert.equal(handledNotifications.at(-1), 'proc_identity', 'send_input answers the target\'s open requests');
    await registry.call('send_input', { process_id: 'proc_identity', kind: 'text', text: 'submitted claude text', submit: true });
    assert.deepEqual(terminalRequests.filter((request) => request.method === 'terminal.process.input').at(-1)?.params, {
      process_id: 'proc_identity',
      kind: 'paste',
      text: 'submitted claude text',
      submit: true
    });
    const ports = (await registry.call('get_process_ports', { process_id: 'proc_identity' })) as { ports: Array<{ port: number }> };
    assert.equal(ports.ports[0]?.port, 5173, 'get_process_ports extracts URL-form ports');
    const timerInputCount = terminalRequests.filter((request) => request.method === 'terminal.process.input').length;
    const timer = (await registry.call('timer_set', { seconds: 0, body: 'timer fired' }, identityContext)) as { timer_id: string };
    assert.ok(timer.timer_id, 'timer_set returns a timer id');
    await waitForTerminalInputCount(terminalRequests, timerInputCount + 1, 'timer_set sends its body to the owning process');
    assert.deepEqual(terminalRequests.filter((request) => request.method === 'terminal.process.input').at(-1)?.params, {
      process_id: 'proc_identity',
      kind: 'paste',
      text: 'timer fired',
      submit: true
    });
    await registry.callPublic('timer_set', { seconds: 0, label: 'reminder' }, identityContext);
    await waitForTerminalInputCount(terminalRequests, timerInputCount + 2, 'timer_set defaults to a useful callback message');
    assert.equal((terminalRequests.filter((request) => request.method === 'terminal.process.input').at(-1)?.params as { text: string }).text, '[system] timer reminder fired');

    database.connection
      .prepare(
        `insert into processes (id, project_id, kind, name, status, activity, created_at, updated_at)
         values ('proc_fresh_idle', ?, 'agent', 'fresh idle agent', 'running', 'idle', ?, ?)`
      )
      .run(projectSnapshot.project.id, mcpNow, mcpNow);
    const freshIdleInputCount = terminalRequests.filter((request) => request.method === 'terminal.process.input').length;
    const freshIdleTimer = (await registry.call(
      'timer_fire_when_idle_all',
      { watched: ['proc_fresh_idle'], body: 'fresh idle fired' },
      identityContext
    )) as { timer_id: string; status: string; waiting_on: string[] };
    assert.ok(freshIdleTimer.timer_id, 'fresh idle timer returns a timer id');
    assert.equal(freshIdleTimer.status, 'pending');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      terminalRequests.filter((request) => request.method === 'terminal.process.input').length,
      freshIdleInputCount,
      'idle_all does not fire immediately for a freshly spawned process that has not worked yet'
    );
    await registry.call('timer_cancel', { timer_id: freshIdleTimer.timer_id }, identityContext);

    database.connection
      .prepare(
        `insert into processes (id, project_id, kind, name, status, activity, created_at, updated_at)
         values ('proc_report_wait', ?, 'agent', 'report wait agent', 'running', 'idle', ?, ?)`
      )
      .run(projectSnapshot.project.id, mcpNow, mcpNow);
    const reportedInputCount = terminalRequests.filter((request) => request.method === 'terminal.process.input').length;
    const reportedTimer = (await registry.call(
      'timer_fire_when_reported_all',
      { watched: ['proc_report_wait'], body: 'reported all fired' },
      identityContext
    )) as { timer_id: string; status: string; waiting_on: string[] };
    assert.ok(reportedTimer.timer_id, 'reported_all returns a timer id');
    assert.equal(reportedTimer.status, 'pending');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      terminalRequests.filter((request) => request.method === 'terminal.process.input').length,
      reportedInputCount,
      'reported_all does not fire merely because a child is terminal-idle'
    );
    registryTimeline.append({
      event_type: 'agent.reported',
      project_id: projectSnapshot.project.id,
      process_id: 'proc_report_wait',
      actor_type: 'agent',
      metadata: { body: 'done' }
    });
    await waitForTerminalInputCount(terminalRequests, reportedInputCount + 1, 'reported_all fires after the child reports');
    {
      const callback = terminalRequests.filter((request) => request.method === 'terminal.process.input').at(-1)?.params as { process_id: string; text: string };
      assert.equal(callback.process_id, 'proc_identity');
      assert.match(callback.text, /^\[Patterm timer timer_\w+: condition met\]\n- proc_report_wait \"report wait agent\": reported completed at \S+: done\nRead full results with get_conversation_output\.\nreported all fired$/, 'timer callbacks say why they fired and what each watched process did');
    }

    database.connection
      .prepare(
        `insert into processes (id, project_id, kind, name, status, activity, created_at, updated_at)
         values ('proc_report_stopped', ?, 'agent', 'stopped report agent', 'running', 'working', ?, ?)`
      )
      .run(projectSnapshot.project.id, mcpNow, mcpNow);
    const stoppedReportInputCount = terminalRequests.filter((request) => request.method === 'terminal.process.input').length;
    const stoppedReportTimer = (await registry.call(
      'timer_fire_when_reported_all',
      { watched: ['proc_report_stopped'], body: 'reported stop fired' },
      identityContext
    )) as { timer_id: string; status: string; waiting_on: string[] };
    assert.ok(stoppedReportTimer.timer_id, 'reported_all returns a timer id for stopped fallback');
    database.connection.prepare(`update processes set status = 'stopped' where id = 'proc_report_stopped'`).run();
    await waitForTerminalInputCount(terminalRequests, stoppedReportInputCount + 1, 'reported_all fires if a watched child stops without reporting');
    {
      const callback = terminalRequests.filter((request) => request.method === 'terminal.process.input').at(-1)?.params as { process_id: string; text: string };
      assert.equal(callback.process_id, 'proc_identity');
      assert.match(callback.text, /^\[Patterm timer timer_\w+: condition met\]\n- proc_report_stopped \"stopped report agent\": stopped without reporting\nreported stop fired$/, 'timer callbacks say why they fired and what each watched process did');
    }

    database.connection.prepare(`update processes set activity = 'working' where id = 'proc_identity'`).run();
    const idleAnyInputCount = terminalRequests.filter((request) => request.method === 'terminal.process.input').length;
    const idleAnyTimer = (await registry.call(
      'timer_fire_when_idle_any',
      { watched: ['proc_identity'], body: 'idle any fired' },
      identityContext
    )) as { timer_id: string; status: string; waiting_on: string[] };
    assert.ok(idleAnyTimer.timer_id, 'idle_any returns a timer id');
    assert.equal(idleAnyTimer.status, 'pending');
    assert.deepEqual(idleAnyTimer.waiting_on, ['proc_identity']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      terminalRequests.filter((request) => request.method === 'terminal.process.input').length,
      idleAnyInputCount,
      'idle_any does not fire while a watched process is still working'
    );
    database.connection.prepare(`update processes set activity = 'idle' where id = 'proc_identity'`).run();
    await waitForTerminalInputCount(terminalRequests, idleAnyInputCount + 1, 'idle_any fires when watched process activity becomes idle');
    {
      const callback = terminalRequests.filter((request) => request.method === 'terminal.process.input').at(-1)?.params as { process_id: string; text: string };
      assert.equal(callback.process_id, 'proc_identity');
      assert.match(callback.text, /^\[Patterm timer timer_\w+: condition met\]\n- proc_identity \"[^\"]+\": idle \(its turn ended\)\nidle any fired$/, 'timer callbacks say why they fired and what each watched process did');
    }

    const idleObservedAt = new Date(Date.now() + 1000).toISOString();
    database.connection
      .prepare(
        `insert into processes (id, project_id, kind, name, status, activity, created_at, updated_at)
         values ('proc_idle_all_a', ?, 'agent', 'idle all a', 'running', 'idle', ?, ?),
                 ('proc_idle_all_b', ?, 'agent', 'idle all b', 'running', 'working', ?, ?)`
      )
      .run(projectSnapshot.project.id, mcpNow, idleObservedAt, projectSnapshot.project.id, mcpNow, mcpNow);
    const idleAllInputCount = terminalRequests.filter((request) => request.method === 'terminal.process.input').length;
    const idleAllTimer = (await registry.call(
      'timer_fire_when_idle_all',
      { watched: ['proc_idle_all_a', 'proc_idle_all_b'], body: 'idle all fired' },
      identityContext
    )) as { timer_id: string; status: string; waiting_on: string[] };
    assert.ok(idleAllTimer.timer_id, 'idle_all returns a timer id');
    assert.equal(idleAllTimer.status, 'pending');
    assert.deepEqual(idleAllTimer.waiting_on, ['proc_idle_all_a', 'proc_idle_all_b']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      terminalRequests.filter((request) => request.method === 'terminal.process.input').length,
      idleAllInputCount,
      'idle_all waits until every watched running process is idle'
    );
    database.connection.prepare(`update processes set activity = 'idle' where id = 'proc_idle_all_b'`).run();
    await waitForTerminalInputCount(terminalRequests, idleAllInputCount + 1, 'idle_all fires once every watched process is idle');
    {
      const callback = terminalRequests.filter((request) => request.method === 'terminal.process.input').at(-1)?.params as { process_id: string; text: string };
      assert.equal(callback.process_id, 'proc_identity');
      assert.match(callback.text, /^\[Patterm timer timer_\w+: condition met\]\n- proc_idle_all_a \"idle all a\": idle \(its turn ended\)\n- proc_idle_all_b \"idle all b\": idle \(its turn ended\)\nidle all fired$/, 'timer callbacks say why they fired and what each watched process did');
    }

    const closeNow = new Date().toISOString();
    database.connection
      .prepare(
        `insert into processes (id, project_id, parent_process_id, kind, name, status, created_at, updated_at)
         values ('close_parent', ?, null, 'agent', 'close parent', 'running', ?, ?),
                ('close_child', ?, 'close_parent', 'agent', 'close child', 'running', ?, ?),
                ('close_grandchild', ?, 'close_child', 'agent', 'close grandchild', 'running', ?, ?)`
      )
      .run(
        projectSnapshot.project.id,
        closeNow,
        closeNow,
        projectSnapshot.project.id,
        closeNow,
        closeNow,
        projectSnapshot.project.id,
        closeNow,
        closeNow
      );
    database.connection
      .prepare(
        `insert into sessions (id, project_id, process_id, mcp_identity, harness, session_role, resume_status, started_at, last_title)
         values ('session_close_parent', ?, 'close_parent', 'close_parent_identity', 'codex', 'orchestrator', 'unknown', ?, 'close parent'),
                ('session_close_child', ?, 'close_child', 'close_child_identity', 'codex', 'child', 'unknown', ?, 'close child'),
                ('session_close_grandchild', ?, 'close_grandchild', 'close_grandchild_identity', 'codex', 'child', 'unknown', ?, 'close grandchild')`
      )
      .run(projectSnapshot.project.id, closeNow, projectSnapshot.project.id, closeNow, projectSnapshot.project.id, closeNow);

    database.connection.prepare(`update sessions set resume_id = 'native-close-resume' where id = 'session_close_parent'`).run();
    database.connection.prepare(`insert into processes (id, project_id, parent_process_id, kind, name, status, created_at, updated_at)
      values ('old_child', ?, 'close_parent', 'agent', 'previous runtime', 'exited', ?, ?)`).run(projectSnapshot.project.id, closeNow, closeNow);
    const closeResult = (await registry.call('close_process', { process_id: 'close_parent' })) as { closed: string[] };
    assert.deepEqual(closeResult.closed, ['close_parent', 'close_child', 'old_child', 'close_grandchild'], 'close_process returns parent and descendants, including historical entries without a runtime');
    const closeStatuses = database.connection
      .prepare(`select id, status from processes where id in ('close_parent', 'close_child', 'close_grandchild') order by id`)
      .all() as Array<{ id: string; status: string }>;
    assert.deepEqual(
      closeStatuses.map((row) => [row.id, row.status]),
      [
        ['close_child', 'closed'],
        ['close_grandchild', 'closed'],
        ['close_parent', 'closed']
      ],
      'closing a parent closes descendants'
    );
    const exitedSessions = database.connection
      .prepare(`select count(*) as count from sessions where process_id in ('close_parent', 'close_child', 'close_grandchild') and exited_at is not null`)
      .get() as { count: number };
    assert.equal(exitedSessions.count, 3, 'closing parent exits descendant sessions');
    assert.equal(
      (database.connection.prepare(`select resume_id from sessions where id = 'session_close_parent'`).get() as { resume_id: string }).resume_id,
      'native-close-resume',
      'closing the runtime preserves native resume metadata'
    );
    const stoppedProcesses = terminalRequests
      .filter((request) => request.method === 'terminal.process.stop')
      .map((request) => (request.params as { process_id: string }).process_id);
    assert.deepEqual(stoppedProcesses.slice(-3), ['close_parent', 'close_child', 'close_grandchild'], 'terminal stop cascades to descendants');
    const closedProcesses = terminalRequests
      .filter((request) => request.method === 'terminal.process.close')
      .map((request) => (request.params as { process_id: string }).process_id);
    assert.deepEqual(closedProcesses.slice(-3), ['close_parent', 'close_child', 'close_grandchild'], 'terminal close releases descendant runtime state');
    const stopCount = terminalRequests.filter((request) => request.method === 'terminal.process.stop').length;
    const closeCount = terminalRequests.filter((request) => request.method === 'terminal.process.close').length;
    await registry.call('close_process', { process_id: 'close_parent' });
    assert.equal(terminalRequests.filter((request) => request.method === 'terminal.process.stop').length, stopCount, 'repeated close does not stop released runtimes');
    assert.equal(terminalRequests.filter((request) => request.method === 'terminal.process.close').length, closeCount, 'repeated close does not close released handles');

    // The Electron-hosted socket serves the registry to an external client (the shim).
    const socketPath = path.join(tempDir, 'mcp.sock');
    let socketNotifyCount = 0;
    const socketServer = new McpSocketServer(socketPath, registry, () => {
      socketNotifyCount += 1;
    });
    await socketServer.start();
    if (process.platform !== 'win32') assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600, 'MCP socket is owner-only');
    const catalog = (await callOverSocket(socketPath, { id: 0, version: 2, op: 'catalog' })) as { result: Array<{ name: string }> };
    // Project management is offered only to the assistant session.
    const agentNames = publicNames.filter((name) => !name.startsWith('assistant_project_'));
    assert.equal(agentNames.length, publicNames.length - 3);
    assert.deepEqual(catalog.result.map(({ name }) => name), agentNames, 'the shim receives the canonical public catalogue');
    const tuiCatalog = (await callOverSocket(socketPath, { id: 1, version: 2, op: 'catalog', identity: 'identity_test' })) as { result: Array<{ name: string }> };
    assert.deepEqual(tuiCatalog.result.map(({ name }) => name), agentNames.filter((name) => !FIGURE_TOOLS.includes(name)), 'TUI agents are not offered figures');
    const tuiFigure = (await callOverSocket(socketPath, { id: 2, version: 2, tool: 'html_render', args: {}, identity: 'identity_test' })) as { error: string };
    assert.match(tuiFigure.error, /only in Integrated mode/, 'TUI agents cannot save figures');
    database.connection.prepare(`update sessions set interface_mode = 'integrated' where mcp_identity = 'identity_test'`).run();
    const integratedCatalog = (await callOverSocket(socketPath, { id: 3, version: 2, op: 'catalog', identity: 'identity_test' })) as { result: Array<{ name: string }> };
    assert.ok(integratedCatalog.result.some(({ name }) => name === 'html_render'), 'Integrated agents are offered figures');
    assert.ok(!publicNames.includes('html_preview'), 'only the desktop app, which can draw pages off screen, offers previews');
    database.connection.prepare(`update sessions set interface_mode = 'tui' where mcp_identity = 'identity_test'`).run();
    const directContext = (await callOverSocket(socketPath, { id: 4, version: 2, tool: 'get_project_status', args: {}, identity: 'identity_test' })) as {
      result: { current_process_id: string };
    };
    assert.equal(directContext.result.current_process_id, 'proc_identity', 'direct socket calls preserve caller identity');
    const hiddenCall = (await callOverSocket(socketPath, { id: 5, version: 2, tool: 'project.create', args: { path: '/tmp/example' }, identity: 'identity_test' })) as { error: string };
    assert.match(hiddenCall.error, /unknown MCP tool/, 'hidden application commands cannot be invoked through MCP');
    const hiddenHelp = (await callOverSocket(socketPath, { id: 6, version: 2, tool: 'help', args: { tool: 'integrated.send' }, identity: 'identity_test' })) as { error: string };
    assert.match(hiddenHelp.error, /unknown MCP tool/, 'public help does not expose internal tools');
    const legacyCall = (await callOverSocket(socketPath, { id: 7, tool: 'get_project_status', args: {} })) as { error: string };
    assert.match(legacyCall.error, /unsupported MCP shim version/, 'the socket has no legacy shim dispatch path');
    const shimPath = path.join(tempDir, 'shim.cjs');
    buildSync({ entryPoints: ['mcp/shim.ts'], outfile: shimPath, bundle: true, platform: 'node', format: 'cjs' });
    const client = new Client({ name: 'full-catalogue-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [shimPath], env: { PATTERM_MCP_SOCKET: socketPath, PATTERM_MCP_IDENTITY: 'identity_test' }, stderr: 'pipe' }));
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map(({ name }) => name), agentNames.filter((name) => !FIGURE_TOOLS.includes(name)), 'the catalogue a TUI agent lists is valid over modern MCP tools/list');
      assert.match(JSON.stringify(await client.callTool({ name: 'list_processes', arguments: {} })), /proc_identity/, 'new clients call the backend directly with caller identity');
      assert.equal((await client.callTool({ name: 'spawn_agent', arguments: {} })).isError, true, 'agent launch validates its cross-field requirement before forwarding');
      assert.match(JSON.stringify(await client.callTool({ name: 'help', arguments: { tool: 'todo_create' } })), /title/, 'help reads the public catalogue');
    } finally {
      await client.close();
    }
    // Only Patterm's own UI acts as the owner; socket callers must name a live agent.
    const anonymous = (await callOverSocket(socketPath, { id: 8, version: 2, tool: 'get_project_status', args: {} })) as { error: string };
    assert.match(anonymous.error, /no Patterm agent identity/, 'socket calls without an identity are refused');
    const unknown = (await callOverSocket(socketPath, { id: 9, version: 2, tool: 'get_project_status', args: {}, identity: 'identity_unknown' })) as { error: string };
    assert.match(unknown.error, /Unknown or inactive agent identity/, 'an unknown identity never falls back to owner scope');
    const unscopedTool = (await callOverSocket(socketPath, { id: 11, version: 2, tool: 'timer_list', args: {}, identity: 'identity_unknown' })) as { error: string };
    assert.match(unscopedTool.error, /Unknown or inactive agent identity/, 'tools that ignore their caller still check it');
    const socketResponse = (await callOverSocket(socketPath, { id: 1, version: 2, tool: 'get_project_status', args: {}, identity: 'identity_test' })) as {
      result: { project: { key: string } | null };
    };
    assert.equal(socketResponse.result.project?.key, projectSnapshot.project.id, 'registry reachable over the socket');
    assert.equal(socketNotifyCount, 0, 'socket-hosted read-only MCP calls do not notify the renderer to refresh workbench state');
    const socketStopResponse = (await callOverSocket(socketPath, { id: 2, version: 2, tool: 'stop_process', args: { process_id: 'proc_identity' }, identity: 'identity_test' })) as {
      result: { ok: boolean; status: string };
    };
    assert.equal(socketStopResponse.result.status, 'stopped', 'socket stop_process persists stopped state');
    assert.equal(socketNotifyCount, 1, 'socket stop_process triggers a renderer refresh notification');
    const socketStoppedSession = database.connection.prepare(`select exited_at from sessions where process_id = 'proc_identity'`).get() as { exited_at: string | null };
    assert.ok(socketStoppedSession.exited_at, 'socket stop_process exits the stopped session so it drops from active tabs after refresh');
    const exited = (await callOverSocket(socketPath, { id: 10, version: 2, tool: 'get_project_status', args: {}, identity: 'identity_test' })) as { error: string };
    assert.match(exited.error, /Unknown or inactive agent identity/, 'an exited agent cannot call with its old identity');
    const connectedClient = net.createConnection(ipcPath(socketPath));
    await new Promise<void>((resolve, reject) => { connectedClient.once('connect', resolve); connectedClient.once('error', reject); });
    const disconnected = new Promise<void>((resolve) => connectedClient.once('close', () => resolve()));
    socketServer.stop();
    await disconnected;

    database.dispose();
    // eslint-disable-next-line no-console
    console.log('workbench read smoke ok');
  } finally {
    removeTree(tempDir);
  }
}

function callOverSocket(socketPath: string, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(ipcPath(socketPath), () => {
      client.write(`${JSON.stringify(request)}\n`);
    });
    client.setEncoding('utf8');
    let buffer = '';
    client.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        client.end();
        resolve(JSON.parse(buffer.slice(0, newline)));
      }
    });
    client.on('error', reject);
  });
}

async function waitForTerminalInputCount(terminalRequests: Array<{ method: string; params: unknown }>, expected: number, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (terminalRequests.filter((request) => request.method === 'terminal.process.input').length >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
