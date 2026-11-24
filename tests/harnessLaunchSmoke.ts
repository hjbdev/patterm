import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { harnessProviders } from '../app/Harness/providers';
import { LaunchingMcpIdentities, McpHelperAccess } from '../app/MCP/McpHelperAccess';
import type { McpServerSpec } from '../app/Harness/HarnessProvider';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HarnessDiscoveryService } from '../app/Services/HarnessDiscoveryService';
import type { AgentHistoryReadService } from '../app/Services/AgentHistory/AgentHistoryReadService';
import { NewAgentSessionAction } from '../app/Actions/NewAgentSessionAction';
import { RestartAgentSessionAction } from '../app/Actions/RestartAgentSessionAction';
import { TimerService } from '../app/Services/TimerService';
import { ResumeConversationAgentAction } from '../app/Actions/ResumeConversationAgentAction';
import { HarnessLauncher } from '../app/Services/HarnessLauncher';
import type { SpawnSink } from '../app/Services/ProcessLauncher';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';

interface SessionRow {
  harness: string;
  session_role: string;
  process_id: string | null;
  mcp_identity: string | null;
  resume_status: string;
  cwd: string | null;
  last_title: string | null;
  interface_mode: string;
}

const MCP: McpServerSpec = {
  command: '/opt/electron',
  args: ['/app/dist/mcp/patterm-mcp.js'],
  env: { ELECTRON_RUN_AS_NODE: '1', PATTERM_MCP_SOCKET: '/run/mcp.sock' }
};

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-launch-'));
  const runtimeDir = path.join(tempDir, 'harness');
  const shimPath = path.join(tempDir, 'patterm-mcp.js');

  try {
    fs.writeFileSync(shimPath, '');

    const database = new DatabaseService(tempDir);
    database.initialize();
    const timeline = new TimelineService(database);
    const now = new Date().toISOString();

    const projectId = 'project_test';
    const projectPath = path.join(tempDir, 'repo');
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'worktree'), { recursive: true });
    database.connection
      .prepare(`insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)`)
      .run(projectId, 'Launch Test', projectPath, now, now);
    database.connection
      .prepare(
        `insert into processes (id, project_id, kind, name, status, cwd, argv, created_at, updated_at)
         values ('proc_1', ?, 'agent', 'Old Claude', 'exited', ?, '[]', ?, ?)`
      )
      .run(projectId, projectPath, now, now);

    database.connection
      .prepare(
        `insert into worktrees (id, project_id, repo_path, worktree_path, branch, created_by, created_at)
         values ('worktree_context', ?, ?, ?, 'worktree-sentinel-should-not-load', 'user', ?)`
      )
      .run(projectId, projectPath, path.join(tempDir, 'worktree'), now);
    fs.mkdirSync(path.join(tempDir, 'moved', 'nested'), { recursive: true });
    database.connection
      .prepare(
        `insert into worktrees (id, project_id, repo_path, worktree_path, branch, created_by, created_at)
         values ('worktree_moved', ?, ?, ?, 'patterm/moved', 'user', ?)`
      )
      .run(projectId, projectPath, path.join(tempDir, 'moved'), now);
    database.connection
      .prepare(
        `insert into diff_snapshots (id, project_id, patch, metadata, created_at) values ('diff_context', 'project_test', ?, '{}', ?)`
      )
      .run('diff-sentinel-should-not-load-into-agent-context\n'.repeat(10_000), now);
    database.connection
      .prepare(
        `insert into timeline_events (id, event_type, project_id, actor_type, metadata, created_at)
         values ('timeline_context', 'task.note', ?, 'system', ?, ?)`
      )
      .run(projectId, JSON.stringify({ body: 'timeline-sentinel-should-not-load-into-agent-context' }), now);

    // Pretend discovery already found Claude and OpenCode (Codex stays absent).
    for (const [harness, exe] of [['claude', '/usr/bin/claude'], ['opencode', '/usr/bin/opencode']] as const) {
      database.connection
        .prepare(
          `insert into harness_installations (id, harness, executable_path, version, status, discovered_at, last_checked_at)
           values (?, ?, ?, ?, 'available', ?, ?)`
        )
        .run(`harness_${harness}`, harness, exe, '1.0.0', now, now);
    }

    const repo = new WorkbenchRepository(database);

    const terminalRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const terminal: SpawnSink = {
      request: async (method, params) => {
        terminalRequests.push({ method, params: params as Record<string, unknown> });
        return { ok: true };
      }
    };

    const preparedCalls: Array<{
      harness: string;
      cwd: string;
      context: string;
      resumeId?: string;
      reconnectMcp?: boolean;
      restoreSavedSettings?: boolean;
    }> = [];
    const integratedPrompts: Array<{ processId: string; text: string; context?: string }> = [];
    const stoppedIntegrated: string[] = [];
    const observedIntegrated: string[] = [];
    let failIntegratedPrompt = false;
    // Integrated harnesses start MCP helpers while preparing, before the
    // session is registered; their identity must already be accepted.
    const launchingIdentities = new LaunchingMcpIdentities();
    const helperAccess = new McpHelperAccess(database, () => false, launchingIdentities);
    const helperHarnesses: string[] = [];
    const reconnectedMcp: boolean[] = [];
    const restoredControls: boolean[] = [];
    const integratedService = {
      prepare: async (
        harness: 'claude' | 'codex' | 'opencode' | 'agy',
        input: { cwd: string; context: string; resumeId?: string | null; mcp: { env: Record<string, string> }; reconnectMcp?: boolean; restoreSavedSettings?: boolean }
      ) => {
        reconnectedMcp.push(input.reconnectMcp === true);
        restoredControls.push(input.restoreSavedSettings === true);
        helperHarnesses.push(helperAccess.harness({ identity: input.mcp.env.PATTERM_MCP_IDENTITY!, opencodeBridge: undefined })!);
        preparedCalls.push({
          harness,
          cwd: input.cwd,
          context: input.context,
          ...(input.resumeId ? { resumeId: input.resumeId } : {}),
          ...(input.reconnectMcp !== undefined ? { reconnectMcp: input.reconnectMcp } : {}),
          ...(input.restoreSavedSettings !== undefined ? { restoreSavedSettings: input.restoreSavedSettings } : {})
        });
        return { resumeId: input.resumeId ?? 'ses_prepared', argv: [`/usr/bin/${harness}`] };
      },
      prompt: async (processId: string, text: string, context?: string) => {
        assert.ok(observedIntegrated.includes(processId), 'an Integrated agent is observed before its first prompt');
        integratedPrompts.push({ processId, text, ...(context ? { context } : {}) });
        if (failIntegratedPrompt) throw new Error('Initial prompt failed');
        return { delivery: 'accepted' as const, id: 'msg_test', admittedSeq: 1 };
      },
      stop: async (processId: string) => { stoppedIntegrated.push(processId); },
      observe: (processId: string) => { observedIntegrated.push(processId); },
      cleanupLaunch: async () => undefined
    };
    const launcher = new HarnessLauncher({
      settings: { figuresEnabled: () => true },
      integrated: integratedService,
      launchingIdentities,
      database,
      timeline,
      workbench: repo,
      providers: harnessProviders,
      nodePath: MCP.command,
      shimPath,
      socketPath: MCP.env.PATTERM_MCP_SOCKET!,
      runtimeDir
    });

    // Launch Claude: prepares through Integrated and records a session row.
    const launched = await launcher.launch({ harness: 'claude', project_id: projectId, actor_id: null });
    assert.deepEqual(helperHarnesses, ['claude'], 'helpers started while preparing are recognised before the session is registered');
    assert.equal(launched.process_id, 'process_1');
    assert.equal(terminalRequests.length, 0, 'agent launch does not create a PTY');
    const firstPrepare = preparedCalls.at(-1)!;
    assert.equal(firstPrepare.harness, 'claude');
    assert.equal(firstPrepare.cwd, projectPath, 'cwd defaults to the project path');
    const projectContext = firstPrepare.context;
    assert.match(projectContext, new RegExp(`Project: ${projectId}`), 'project-level claude receives project identity');
    assert.match(projectContext, /Orient with get_project_status/, 'project-level claude receives an orientation pointer');
    assert.match(projectContext, /Agent-facing tools are available directly; where only a core set is declared, list the rest with help/, 'project-level claude receives direct tool guidance');
    assert.match(projectContext, /never to satisfy host-internal planning\/review requirements/, 'project-level claude is told not to use Patterm delegation for host workflows');
    assert.match(projectContext, /report_to_parent/, 'project-level claude receives child completion report guidance');
    assert.match(projectContext, /send_message the child that already reported instead of spawning a replacement/, 'project-level claude reuses reported children for follow-ups');
    assert.match(projectContext, /reference_attach its URL to your session/, 'project-level claude links PRs and issues to its session');
    assert.match(projectContext, /Link every git worktree you work in to your session \(at most 10\): worktree_create and worktree_link do this automatically; otherwise call worktree_attach/, 'project-level claude links its worktrees to its session');
    assert.match(projectContext, /Do not send a running child status checks, hurry-up messages, or requests to wrap up/, 'project-level claude is told not to nudge running children');
    assert.match(projectContext, /genuinely new task information or to cancel at the user's request/, 'project-level claude receives the allowed messaging exceptions');
    assert.match(projectContext, /never invent labels from IDs/, 'project-level claude keeps exact process names');
    assert.match(projectContext, /call request_close with a short summary/, 'project-level claude learns when to ask to be closed');
    assert.match(projectContext, /status_set/, 'project-level claude learns to pin a status label while it waits');
    assert.match(projectContext, /call html_render \(load them through tool search/, 'Integrated agents learn to show pages with html_render');
    // Far under OpenCode's 8 KiB instruction cap, which also holds memory.
    assert.ok(projectContext.length < 2700, 'project-level context stays compact');

    const sessionRow = database.connection
      .prepare(`select harness, session_role, process_id, resume_status, cwd, mcp_identity, last_title, interface_mode from sessions where id = ?`)
      .get(launched.session_id) as SessionRow | undefined;
    assert.equal(sessionRow?.harness, 'claude');
    assert.equal(sessionRow?.session_role, 'orchestrator');
    assert.equal(sessionRow?.process_id, 'process_1');
    assert.equal(sessionRow?.resume_status, 'found');
    assert.equal(sessionRow?.cwd, projectPath);
    assert.equal(sessionRow?.last_title, 'Claude Code');
    assert.equal(sessionRow?.interface_mode, 'integrated');
    assert.ok(sessionRow?.mcp_identity, 'session stores MCP identity');
    const processRow = database.connection
      .prepare(`select pty_process_id from processes where id = ?`)
      .get(launched.process_id) as { pty_process_id: string | null } | undefined;
    assert.equal(processRow?.pty_process_id, null, 'Integrated agents have no PTY handle');
    const launchedSession = repo.snapshot().projects[0]?.projectSessions.find((session) => session.id === launched.session_id);
    assert.equal(launchedSession?.processId, 'process_1', 'workbench exposes stable session process row id');

    const namedLaunch = await launcher.launch({ harness: 'claude', project_id: projectId, name: 'API Reviewer' });
    const namedSessionRow = database.connection
      .prepare(`select last_title from sessions where id = ?`)
      .get(namedLaunch.session_id) as { last_title: string | null } | undefined;
    const namedProcessRow = database.connection
      .prepare(`select name from processes where id = ?`)
      .get(namedLaunch.process_id) as { name: string } | undefined;
    assert.equal(namedSessionRow?.last_title, 'API Reviewer');
    assert.equal(namedProcessRow?.name, 'API Reviewer');

    const promptLaunch = await launcher.launch({ harness: 'claude', project_id: projectId, initial_prompt: 'Do the next step.' });
    const promptContext = preparedCalls.at(-1)!.context;
    assert.match(promptContext, new RegExp(`Project: ${projectId}`), 'project-scoped claude receives project identity');
    for (const sentinel of [
      'worktree-sentinel-should-not-load',
      'diff-sentinel-should-not-load',
      'timeline-sentinel-should-not-load'
    ]) {
      assert.ok(!promptContext.includes(sentinel), `${sentinel} is not loaded into launch context`);
    }
    assert.ok(promptContext.length < 2700, 'project-scoped context stays compact');
    assert.deepEqual(
      { processId: integratedPrompts.at(-1)?.processId, text: integratedPrompts.at(-1)?.text },
      { processId: promptLaunch.process_id, text: 'Do the next step.' }
    );

    const startedEvents = database.connection
      .prepare(`select count(*) as n from timeline_events where event_type = 'session.started'`)
      .get() as { n: number };
    assert.equal(startedEvents.n, 3, 'session.started recorded on timeline');

    // Launch OpenCode through Integrated.
    const openCode = await launcher.launch({ harness: 'opencode', project_id: projectId, initial_prompt: 'Use Integrated mode.' });
    const openInstruction = preparedCalls.at(-1)!.context;
    assert.match(openInstruction, new RegExp(`Project: ${projectId}`), 'opencode instruction includes project identity');
    assert.match(openInstruction, /replace unavailable host-native subagents/, 'opencode instruction blocks Patterm as a host-subagent fallback');
    assert.doesNotMatch(openInstruction, /worktree-sentinel-should-not-load/, 'opencode instruction excludes worktrees');
    const storedOpenCode = database.connection.prepare(`select resume_id, interface_mode from sessions where id = ?`).get(openCode.session_id) as { resume_id: string; interface_mode: string };
    assert.equal(storedOpenCode.resume_id, 'ses_prepared', 'session identity is stored before model work begins');
    assert.equal(storedOpenCode.interface_mode, 'integrated');
    assert.deepEqual(
      { processId: integratedPrompts.at(-1)?.processId, text: integratedPrompts.at(-1)?.text },
      { processId: openCode.process_id, text: 'Use Integrated mode.' }
    );

    failIntegratedPrompt = true;
    await assert.rejects(launcher.launch({ harness: 'opencode', project_id: projectId, initial_prompt: 'Fail this prompt.' }), /Initial prompt failed/);
    assert.equal(stoppedIntegrated.length, 1, 'failed initial submission stops its native Integrated runtime');
    failIntegratedPrompt = false;

    // A harness that was never discovered cannot be launched.
    await assert.rejects(launcher.launch({ harness: 'codex', project_id: projectId }), /not available/);

    const missingShimLauncher = new HarnessLauncher({
      database,
      timeline,
      workbench: repo,
      providers: harnessProviders,
      integrated: integratedService,
      nodePath: MCP.command,
      shimPath: path.join(tempDir, 'missing-mcp-shim.js'),
      socketPath: MCP.env.PATTERM_MCP_SOCKET!,
      runtimeDir
    });
    await assert.rejects(
      missingShimLauncher.launch({ harness: 'claude', project_id: projectId }),
      /Patterm MCP shim is missing/
    );

    // The registry exposes launch through harness_launch.
    const harnessDiscovery = new HarnessDiscoveryService(harnessProviders);
    const registry = createTestMcpRegistry({
      tempDir,
      database,
      terminal: terminal as unknown as TerminalService,
      timeline,
      workbench: repo,
      harnessDiscovery,
      harnessLauncher: launcher,
      integrated: integratedService as never
    });
    const viaRegistry = (await registry.call('harness_launch', {
      harness: 'claude',
      project_id: projectId
    })) as { session_id: string; process_id: string };
    assert.ok(viaRegistry.session_id, 'registry launch returns a session id');
    assert.ok(viaRegistry.process_id.startsWith('process_'), 'registry launch returns the process id');

    const promptCountBeforeSpawnAgent = integratedPrompts.length;
    const spawnedAgent = (await registry.call('spawn_agent', {
      agent: 'claude',
      name: 'Docs Agent',
      agent_instructions: 'Review the docs',
      prompt: 'Then report risks\nCheck examples'
    })) as { name: string; process_id: string };
    assert.equal(spawnedAgent.name, 'Docs Agent', 'CLI spawn_agent returns the requested name');
    const spawnedAgentSession = database.connection
      .prepare(`select last_title, display_name from sessions where process_id = ?`)
      .get(spawnedAgent.process_id) as { last_title: string | null; display_name: string | null } | undefined;
    assert.equal(spawnedAgentSession?.last_title, 'Docs Agent', 'CLI spawn_agent persists the requested name');
    assert.equal(spawnedAgentSession?.display_name, 'Docs Agent', 'CLI spawn_agent keeps the requested name separate from titles');
    database.connection.prepare(`update sessions set last_title = 'claude' where process_id = ?`).run(spawnedAgent.process_id);
    const spawnedAgentSnapshot = repo.snapshot().projects
      .flatMap((project) => [...project.projectSessions])
      .find((session) => session.processId === spawnedAgent.process_id);
    assert.equal(spawnedAgentSnapshot?.displayName ?? spawnedAgentSnapshot?.lastTitle, 'Docs Agent', 'CLI spawn_agent name remains the UI label after a title update');
    assert.deepEqual(
      { processId: integratedPrompts[promptCountBeforeSpawnAgent]?.processId, text: integratedPrompts[promptCountBeforeSpawnAgent]?.text },
      {
        processId: spawnedAgent.process_id,
        text: 'Review the docs\n\nThen report risks\nCheck examples\n\nWhen this delegated work is done, blocked, failed, or has no findings, call report_to_parent with your result. Do not rely on terminal idle or get_process_output as the completion signal. Stay available after reporting: your parent may send follow-ups, such as re-reviewing fixes, and you should report again after each one.'
      }
    );

    await registry.call('send_input', { process_id: spawnedAgent.process_id, kind: 'paste', text: 'follow-up\nmessage', submit: true });
    assert.deepEqual(
      { processId: integratedPrompts.at(-1)?.processId, text: integratedPrompts.at(-1)?.text },
      {
        processId: spawnedAgent.process_id,
        text: 'follow-up\nmessage'
      }
    );

    const parentIdentity = database.connection
      .prepare(`select mcp_identity from sessions where id = ?`)
      .get(promptLaunch.session_id) as { mcp_identity: string | null } | undefined;
    assert.ok(parentIdentity?.mcp_identity, 'project-scoped launch has MCP identity for registry calls');
    const projectScopedChild = (await registry.call('spawn_agent', { agent: 'claude', name: 'Project Child' }, { identity: parentIdentity.mcp_identity })) as { process_id: string };
    const projectScopedChildSession = database.connection
      .prepare(
        `select sessions.project_id, processes.parent_process_id
         from sessions
         join processes on processes.id = sessions.process_id
         where sessions.process_id = ?`
      )
      .get(projectScopedChild.process_id) as { project_id: string; parent_process_id: string | null } | undefined;
    assert.equal(projectScopedChildSession?.project_id, projectId);
    assert.equal(projectScopedChildSession?.parent_process_id, promptLaunch.process_id, 'project-scoped child still records its parent process');

    const historyReadService = {
      findConversation: (conversationId: string) => {
        if (conversationId === 'conversation_foreign') {
          return conversationRecord({ id: conversationId, projectId: 'project_other' });
        }
        if (conversationId === 'conversation_unlinked') {
          return conversationRecord({ id: conversationId, projectId: null });
        }
        if (conversationId === 'conversation_missing_resume') {
          return conversationRecord({ id: conversationId, projectId, providerConversationId: null });
        }
        if (conversationId === 'conversation_missing_cwd') {
          return conversationRecord({ id: conversationId, projectId, providerConversationId: 'claude_resume_missing_cwd', cwd: path.join(tempDir, 'gone') });
        }
        if (conversationId === 'conversation_concurrent') {
          return conversationRecord({ id: conversationId, projectId, providerConversationId: 'claude_resume_concurrent', cwd: projectPath });
        }
        if (conversationId === 'conversation_resume') {
          return conversationRecord({ id: conversationId, projectId, worktreeId: 'worktree_context', cwd: path.join(tempDir, 'worktree') });
        }
        // The session moved out of its recorded worktree after it was linked.
        if (conversationId === 'conversation_moved_root' || conversationId === 'conversation_moved_worktree') {
          return conversationRecord({ id: conversationId, projectId, providerConversationId: `claude_${conversationId}`, worktreeId: 'worktree_context',
            cwd: conversationId === 'conversation_moved_root' ? projectPath : path.join(tempDir, 'moved', 'nested') });
        }
        if (conversationId === 'conversation_user' || conversationId === 'conversation_replace' || conversationId === 'conversation_keep') {
          return conversationRecord({ id: conversationId, projectId, providerConversationId: `claude_${conversationId}`, cwd: projectPath });
        }
        return null;
      }
    } as unknown as AgentHistoryReadService;
    const resumeRegistry = createTestMcpRegistry({
      tempDir,
      database,
      terminal: terminal as unknown as TerminalService,
      timeline,
      workbench: repo,
      harnessDiscovery,
      harnessLauncher: launcher,
      historyReadService,
      integrated: integratedService as never
    });
    await assert.rejects(
      resumeRegistry.call('spawn_agent', { conversation_id: 'conversation_resume', agent: 'claude' }, { identity: parentIdentity.mcp_identity }),
      /infers agent from conversation_id/,
      'resume input rejects an explicit provider'
    );
    await assert.rejects(
      resumeRegistry.call('spawn_agent', { conversation_id: 'conversation_foreign' }, { identity: parentIdentity.mcp_identity }),
      /outside the current caller project/,
      'resume rejects conversations outside the caller project'
    );
    await assert.rejects(
      resumeRegistry.call('spawn_agent', { conversation_id: 'conversation_unlinked' }, { identity: parentIdentity.mcp_identity }),
      /outside the current caller project/,
      'resume rejects unlinked conversations'
    );
    await assert.rejects(
      resumeRegistry.call('spawn_agent', { conversation_id: 'conversation_missing_resume' }, { identity: parentIdentity.mcp_identity }),
      /no provider resume ID/,
      'resume rejects history without a provider resume id'
    );
    await assert.rejects(
      resumeRegistry.call('spawn_agent', { conversation_id: 'conversation_missing_cwd' }, { identity: parentIdentity.mcp_identity }),
      /working directory is unavailable/,
      'resume does not silently replace a missing recorded cwd'
    );
    const resumedAgent = (await resumeRegistry.call('spawn_agent', {
      conversation_id: 'conversation_resume',
      prompt: 'Continue the prior work'
    }, { identity: parentIdentity.mcp_identity })) as { process_id: string; name: string };
    assert.equal(resumedAgent.name, 'Prior Claude conversation', 'resume uses the imported conversation title');
    const resumePrepare = preparedCalls.at(-1)!;
    assert.equal(resumePrepare.cwd, path.join(tempDir, 'worktree'), 'resume uses the recorded conversation cwd');
    assert.equal(resumePrepare.resumeId, 'claude_resume_existing', 'resume launches the exact provider conversation');
    assert.match(integratedPrompts.at(-1)!.text, /^Continue the prior work/);
    const resumedSession = database.connection.prepare(`
      select sessions.resume_id, sessions.resume_status, sessions.worktree_id, sessions.session_role,
        processes.parent_process_id
      from sessions
      join processes on processes.id = sessions.process_id
      where sessions.process_id = ?
    `).get(resumedAgent.process_id) as {
      resume_id: string;
      resume_status: string;
      worktree_id: string | null;
      session_role: string;
      parent_process_id: string | null;
    } | undefined;
    assert.deepEqual(resumedSession, {
      resume_id: 'claude_resume_existing',
      resume_status: 'imported',
      worktree_id: 'worktree_context',
      session_role: 'child',
      parent_process_id: promptLaunch.process_id
    });
    const resumeTimeline = database.connection.prepare(`select metadata from timeline_events where event_type = 'session.started' and metadata like '%conversation_resume%' order by created_at desc limit 1`).get() as { metadata: string } | undefined;
    assert.equal(JSON.parse(resumeTimeline?.metadata ?? '{}').resumed_conversation_id, 'conversation_resume', 'resume provenance is recorded on the session event');
    await assert.rejects(
      resumeRegistry.call('spawn_agent', { conversation_id: 'conversation_resume' }, { identity: parentIdentity.mcp_identity }),
      new RegExp(`already has a running Patterm agent: ${resumedAgent.process_id}`),
      'resume rejects a duplicate live Patterm process and identifies it'
    );
    const concurrentPrepareCount = preparedCalls.length;
    const concurrent = await Promise.allSettled([
      resumeRegistry.call('spawn_agent', { conversation_id: 'conversation_concurrent' }, { identity: parentIdentity.mcp_identity }),
      resumeRegistry.call('spawn_agent', { conversation_id: 'conversation_concurrent' }, { identity: parentIdentity.mcp_identity })
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1, 'one concurrent resume succeeds');
    assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1, 'one concurrent resume is rejected');
    assert.equal(preparedCalls.length, concurrentPrepareCount + 1, 'concurrent resume requests prepare one agent');
    await assert.rejects(
      resumeRegistry.call('history_resume', { conversation_id: 'conversation_user' }, { identity: parentIdentity.mcp_identity }),
      /agents resume with spawn_agent/,
      'agents cannot start top-level resumes'
    );
    const userResume = (await resumeRegistry.call('history_resume', { conversation_id: 'conversation_user', project_id: projectId }, {})) as { process_id: string; replaced_process_id: string | null };
    assert.equal(userResume.replaced_process_id, null);
    assert.deepEqual(database.connection.prepare(`
      select sessions.session_role, sessions.interface_mode, processes.parent_process_id
      from sessions join processes on processes.id = sessions.process_id where sessions.process_id = ?
    `).get(userResume.process_id), { session_role: 'orchestrator', interface_mode: 'integrated', parent_process_id: null }, 'a user resume is a top-level Integrated session');

    // Replacement closes only an empty, running Integrated tab in the project.
    const emptyTab = await launcher.launch({ harness: 'claude', project_id: projectId });
    const busyTab = await launcher.launch({ harness: 'claude', project_id: projectId });
    const closed: string[] = [];
    const replacingResume = new ResumeConversationAgentAction(database, historyReadService, launcher, {
      integrated: { isEmpty: async (processId: string) => processId === emptyTab.process_id },
      closeProcess: { execute: async (processId: string) => { closed.push(processId); return { closed: [processId] }; } }
    });
    const kept = await replacingResume.execute({ conversation_id: 'conversation_keep', project_id: projectId, replace_process_id: busyTab.process_id });
    assert.equal(kept.replaced_process_id, null, 'a tab with a conversation stays open');
    const replaced = await replacingResume.execute({ conversation_id: 'conversation_replace', project_id: projectId, replace_process_id: emptyTab.process_id });
    assert.equal(replaced.replaced_process_id, emptyTab.process_id, 'an empty tab is replaced');
    assert.deepEqual(closed, [emptyTab.process_id]);

    // A conversation resumes linked to the worktree it is in now, never to a
    // recorded one it has moved out of.
    const movedRoot = await replacingResume.execute({ conversation_id: 'conversation_moved_root', project_id: projectId });
    assert.equal((database.connection.prepare('select worktree_id from sessions where id = ?').get(movedRoot.session_id) as { worktree_id: string | null }).worktree_id, null,
      'a conversation that moved to an unregistered directory has no worktree');
    const movedWorktree = await replacingResume.execute({ conversation_id: 'conversation_moved_worktree', project_id: projectId });
    assert.equal((database.connection.prepare('select worktree_id from sessions where id = ?').get(movedWorktree.session_id) as { worktree_id: string | null }).worktree_id, 'worktree_moved',
      'a conversation that moved into a registered worktree is linked to it');

    // `/new` relaunches the same harness and model, replacing only an idle tab.
    const newClosed: string[] = [];
    const newSession = new NewAgentSessionAction(database, launcher, {
      execute: async (processId: string) => { newClosed.push(processId); return { closed: [processId] }; }
    });
    const sourceTab = await launcher.launch({ harness: 'claude', model: 'claude-opus-5-5', project_id: projectId });
    database.connection.prepare(`update processes set activity = 'working' where id = ?`).run(sourceTab.process_id);
    const beside = await newSession.execute({ process_id: sourceTab.process_id, project_id: projectId });
    assert.equal(beside.replaced_process_id, null, 'a working agent stays open beside the new session');
    assert.deepEqual(database.connection.prepare(`select harness, model, interface_mode from sessions where id = ?`).get(beside.session_id),
      { harness: 'claude', model: 'claude-opus-5-5', interface_mode: 'integrated' }, 'the new session keeps the harness and model');
    database.connection.prepare(`update processes set activity = 'idle' where id = ?`).run(sourceTab.process_id);
    const fresh = await newSession.execute({ process_id: sourceTab.process_id, project_id: projectId });
    assert.equal(fresh.replaced_process_id, sourceTab.process_id, 'an idle tab is replaced');
    assert.deepEqual(newClosed, [sourceTab.process_id]);
    await assert.rejects(newSession.execute({ process_id: sourceTab.process_id, project_id: 'project_other' }), /unknown Integrated agent/);

    // `/restart` resumes the same conversation in a new process, which takes
    // over the old one's context, subagents, and timers.
    const restartSteps: string[] = [];
    const timerTransfers: Array<[readonly string[], string]> = [];
    const restart = new RestartAgentSessionAction(database, launcher, {
      stop: async (processId: string) => {
        restartSteps.push(`stop:${processId}`);
        database.connection.prepare(`update processes set status = 'stopped' where id = ?`).run(processId);
        database.connection.prepare(`update sessions set exited_at = ? where process_id = ?`).run(new Date().toISOString(), processId);
      },
      close: async (processId: string) => { restartSteps.push(`close:${processId}`); },
      holdTimers: (processId: string) => { restartSteps.push(`hold:${processId}`); return [`timer_${processId}`]; },
      releaseTimers: (timerIds) => { restartSteps.push(`release:${timerIds.join(',')}`); },
      transferTimers: (from, to) => { timerTransfers.push([from, to]); restartSteps.push('transfer'); },
      // The user switched model and effort after launch.
      liveSettings: async () => ({ model: 'claude-fable-5-1', reasoning: 'high' })
    });
    const restartTab = await launcher.launch({ harness: 'claude', model: 'claude-opus-5-5', project_id: projectId });
    const restartChild = await launcher.launch({ harness: 'claude', project_id: projectId, parent_process_id: restartTab.process_id, session_role: 'child' });
    // The fake Integrated host reports this native conversation for every launch.
    database.connection.prepare(`update sessions set title_set_by_user = 1, last_title = 'Fix the restart titles' where process_id = ?`).run(restartTab.process_id);
    database.connection.prepare(`update processes set activity = 'working' where id = ?`).run(restartTab.process_id);
    await assert.rejects(restart.execute({ process_id: restartTab.process_id, project_id: projectId }), /working/, 'a turn in progress is not cut short');
    await assert.rejects(restart.execute({ process_id: restartChild.process_id, project_id: projectId }), /Only top-level agents/);
    database.connection.prepare(`update processes set activity = 'idle' where id = ?`).run(restartTab.process_id);
    reconnectedMcp.length = 0;
    restoredControls.length = 0;
    const restarted = await restart.execute({ process_id: restartTab.process_id, project_id: projectId });
    assert.equal(restarted.replaced_process_id, restartTab.process_id);
    assert.deepEqual(reconnectedMcp, [true], 'a restart reconnects shared MCP servers so their tool lists are fetched again');
    assert.deepEqual(restoredControls, [false], 'successfully read live controls outrank older saved preferences');
    assert.deepEqual(restartSteps, [`hold:${restartTab.process_id}`, `stop:${restartTab.process_id}`, 'transfer', `release:timer_${restartTab.process_id}`, `close:${restartTab.process_id}`],
      'timers wait through the gap, and the old process stops before the resume and closes after it');
    assert.deepEqual(timerTransfers, [[[restartTab.process_id], restarted.process_id]]);
    assert.deepEqual(database.connection.prepare(`select harness, model, reasoning, interface_mode, session_role, resume_id, resumed_from_session_id, title_set_by_user, display_name, last_title from sessions where id = ?`).get(restarted.session_id), {
      harness: 'claude', model: 'claude-fable-5-1', reasoning: 'high', interface_mode: 'integrated', session_role: 'orchestrator', resume_id: 'ses_prepared', resumed_from_session_id: restartTab.session_id, title_set_by_user: 1,
      display_name: null, last_title: 'Fix the restart titles'
    }, 'the new session resumes the same conversation on the live model, and keeps a user-chosen name');
    assert.equal((database.connection.prepare('select parent_process_id from processes where id = ?').get(restartChild.process_id) as { parent_process_id: string }).parent_process_id,
      restarted.process_id, 'subagents report to the new process');

    // A crashed parent can restart with stale working activity, retaining
    // its children, timers, and resume provenance just like a live restart.
    const deadTab = await launcher.launch({ harness: 'claude', project_id: projectId });
    const liveChild = await launcher.launch({ harness: 'claude', project_id: projectId, parent_process_id: deadTab.process_id, session_role: 'child' });
    database.connection.prepare("update processes set status = 'failed', activity = 'working' where id = ?").run(deadTab.process_id);
    database.connection.prepare('update sessions set exited_at = ? where id = ?').run(new Date().toISOString(), deadTab.session_id);
    const recovered = await restart.execute({ process_id: deadTab.process_id, project_id: projectId });
    assert.equal(restoredControls.at(-1), true, 'ended-host recovery marks launch columns as fallbacks for newer saved controls');
    assert.equal(recovered.replaced_process_id, deadTab.process_id);
    assert.equal((database.connection.prepare('select parent_process_id from processes where id = ?').get(liveChild.process_id) as { parent_process_id: string }).parent_process_id, recovered.process_id);
    assert.equal((database.connection.prepare('select resumed_from_session_id from sessions where id = ?').get(recovered.session_id) as { resumed_from_session_id: string }).resumed_from_session_id, deadTab.session_id);
    assert.deepEqual(timerTransfers.at(-1), [[deadTab.process_id], recovered.process_id]);
    database.connection.prepare("update processes set status = 'closed' where id = ?").run(deadTab.process_id);
    await assert.rejects(restart.execute({ process_id: deadTab.process_id, project_id: projectId }), /not a restartable Integrated agent/);
    await assert.rejects(restart.execute({ process_id: recovered.process_id, project_id: 'project_other' }), /not a restartable Integrated agent/);

    // A turn that starts while the settings are read is not cut short, and
    // timers are held before that read.
    const raceSteps: string[] = [];
    const raceTab = await launcher.launch({ harness: 'claude', project_id: projectId });
    const racing2 = new RestartAgentSessionAction(database, launcher, {
      stop: async (processId: string) => { raceSteps.push(`stop:${processId}`); },
      close: async () => {},
      holdTimers: () => { raceSteps.push('hold'); return ['timer_race']; },
      releaseTimers: (timerIds) => { raceSteps.push(`release:${timerIds.join(',')}`); },
      transferTimers: () => {},
      liveSettings: async (processId: string) => {
        raceSteps.push('read');
        database.connection.prepare(`update processes set activity = 'working' where id = ?`).run(processId);
        return {};
      }
    });
    await assert.rejects(racing2.execute({ process_id: raceTab.process_id, project_id: projectId }), /working/);
    assert.deepEqual(raceSteps, ['hold', 'read', 'release:timer_race']);
    // A live effort on the default model resumes as given, not through a preset.
    database.connection.prepare(`update processes set activity = 'idle' where id = ?`).run(raceTab.process_id);
    const defaultModel = await new RestartAgentSessionAction(database, launcher, {
      stop: async (processId: string) => {
        database.connection.prepare(`update processes set status = 'stopped' where id = ?`).run(processId);
        database.connection.prepare(`update sessions set exited_at = ? where process_id = ?`).run(new Date().toISOString(), processId);
      },
      close: async () => {}, holdTimers: () => [], releaseTimers: () => {}, transferTimers: () => {},
      liveSettings: async () => ({ model: null, reasoning: 'high' })
    }).execute({ process_id: raceTab.process_id, project_id: projectId });
    assert.deepEqual(database.connection.prepare('select model, reasoning from sessions where id = ?').get(defaultModel.session_id), { model: null, reasoning: 'high' });

    // A failed resume resumes the held timers on the stopped agent and leaves its tab.
    const failing = new RestartAgentSessionAction(database, { resume: async () => { throw new Error('resume refused'); } }, {
      stop: async () => undefined, close: async (processId: string) => { restartSteps.push(`close:${processId}`); },
      holdTimers: () => ['timer_failed'], releaseTimers: (timerIds) => { restartSteps.push(`release:${timerIds.join(',')}`); }, transferTimers: () => undefined
    });
    const failTab = await launcher.launch({ harness: 'claude', project_id: projectId });
    database.connection.prepare(`update processes set activity = 'idle' where id = ?`).run(failTab.process_id);
    restartSteps.length = 0;
    await assert.rejects(failing.execute({ process_id: failTab.process_id, project_id: projectId }), /did not restart: resume refused/);
    assert.deepEqual(restartSteps, ['release:timer_failed']);
    database.connection.prepare(`update processes set activity = 'working' where id = ?`).run(failTab.process_id);

    // An OpenCode session that moved (session_move) restarts where it is now,
    // if that is in the project. A known bad directory is refused before the
    // agent stops.
    const movedSteps: string[] = [];
    const movedResumes: Array<{ cwd: string | undefined; worktree_id: string | null | undefined }> = [];
    let located: () => Promise<string | null> = async () => null;
    const moving = new RestartAgentSessionAction(database, {
      resume: async (input) => { movedResumes.push({ cwd: input.cwd, worktree_id: input.worktree_id }); throw new Error('resume refused'); }
    }, {
      stop: async (processId: string) => { movedSteps.push(`stop:${processId}`); }, close: async () => undefined,
      holdTimers: () => ['timer_moved'], releaseTimers: (timerIds) => { movedSteps.push(`release:${timerIds.join(',')}`); }, transferTimers: () => undefined,
      sessionDirectory: () => located()
    });
    const movedTab = await launcher.launch({ harness: 'claude', project_id: projectId, worktree_id: 'worktree_context' });
    database.connection.prepare(`update sessions set harness = 'opencode' where id = ?`).run(movedTab.session_id);
    database.connection.prepare(`update processes set activity = 'idle' where id = ?`).run(movedTab.process_id);
    const restartMoved = () => moving.execute({ process_id: movedTab.process_id, project_id: projectId });
    fs.mkdirSync(path.join(tempDir, 'outside'), { recursive: true });
    for (const [directory, refusal] of [[path.join(tempDir, 'outside'), /moved to .*outside this project, so it was not restarted\. It is still running/], [path.join(tempDir, 'gone'), /which no longer exists/]] as const) {
      located = async () => directory;
      movedSteps.length = 0;
      await assert.rejects(restartMoved(), refusal);
      assert.deepEqual(movedSteps, ['release:timer_moved'], 'a restart that cannot work leaves the agent running');
    }
    fs.symlinkSync(path.join(tempDir, 'outside'), path.join(projectPath, 'outside-link'));
    located = async () => path.join(projectPath, 'outside-link');
    await assert.rejects(restartMoved(), /outside this project/, 'a symlink out of the project is outside it');
    fs.rmSync(path.join(projectPath, 'outside-link'));
    assert.equal(movedResumes.length, 0);
    located = async () => path.join(tempDir, 'moved', 'nested');
    await assert.rejects(restartMoved(), /did not restart/);
    assert.deepEqual(movedResumes.at(-1), { cwd: path.join(tempDir, 'moved', 'nested'), worktree_id: 'worktree_moved' }, 'a moved session resumes where it is, in the worktree there');
    // A symlink inside one worktree into another is in the one it leads to.
    fs.symlinkSync(path.join(tempDir, 'moved'), path.join(tempDir, 'worktree', 'moved-link'));
    located = async () => path.join(tempDir, 'worktree', 'moved-link');
    await assert.rejects(restartMoved(), /did not restart/);
    assert.deepEqual(movedResumes.at(-1), { cwd: path.join(tempDir, 'worktree', 'moved-link'), worktree_id: 'worktree_moved' }, 'the worktree is chosen by resolved path; the cwd stays as OpenCode wrote it');
    fs.rmSync(path.join(tempDir, 'worktree', 'moved-link'));
    located = async () => projectPath;
    await assert.rejects(restartMoved(), /did not restart/);
    assert.deepEqual(movedResumes.at(-1), { cwd: projectPath, worktree_id: null }, 'a move out of every registered worktree drops the worktree');
    located = async () => { throw new Error('daemon unavailable'); };
    await assert.rejects(restartMoved(), /did not restart/);
    assert.deepEqual(movedResumes.at(-1), { cwd: path.join(tempDir, 'worktree'), worktree_id: 'worktree_context' }, 'an unreadable location keeps the launch directory');
    // A session already in a directory outside its recorded worktree, as after
    // a resume from history before this fix, restarts linked to where it is.
    database.connection.prepare(`update sessions set worktree_id = 'worktree_moved' where id = ?`).run(movedTab.session_id);
    located = async () => path.join(tempDir, 'worktree');
    await assert.rejects(restartMoved(), /did not restart/);
    assert.deepEqual(movedResumes.at(-1), { cwd: path.join(tempDir, 'worktree'), worktree_id: 'worktree_context' }, 'a stale worktree link is not carried into the restart');
    database.connection.prepare(`update processes set activity = 'working' where id = ?`).run(movedTab.process_id);

    // The timer service pauses only an owner's pending timers.
    const holdingTimers = new TimerService(database, terminal as never);
    const ownTimer = holdingTimers.setDelay({ seconds: 600, ownerProcessId: failTab.process_id, body: 'wake' });
    const otherTimer = holdingTimers.setDelay({ seconds: 600, ownerProcessId: restartTab.process_id, body: 'other' });
    assert.deepEqual(holdingTimers.holdOwner(failTab.process_id), [ownTimer.id]);
    assert.deepEqual(holdingTimers.list().map((timer) => [timer.id, timer.status]).sort(), [[ownTimer.id, 'paused'], [otherTimer.id, 'pending']].sort());
    holdingTimers.dispose();

    // Restart all leaves working agents running.
    const idleTab = await launcher.launch({ harness: 'claude', project_id: projectId });
    database.connection.prepare(`update processes set activity = 'idle' where id = ?`).run(idleTab.process_id);
    database.connection.prepare(`update processes set activity = 'working' where id = ?`).run(restarted.process_id);
    // A turn that starts while another agent restarts is still seen.
    const lateTab = await launcher.launch({ harness: 'claude', project_id: projectId });
    database.connection.prepare(`update processes set activity = 'idle' where id = ?`).run(lateTab.process_id);
    const racing = new RestartAgentSessionAction(database, {
      resume: async (input, resume) => {
        if (resume.source_session_id === idleTab.session_id) database.connection.prepare(`update processes set activity = 'working' where id = ?`).run(lateTab.process_id);
        return launcher.resume(input, resume);
      }
    }, {
      stop: async (processId: string) => { database.connection.prepare(`update processes set status = 'stopped' where id = ?`).run(processId); database.connection.prepare(`update sessions set exited_at = ? where process_id = ?`).run(new Date().toISOString(), processId); },
      close: async () => undefined, holdTimers: () => [], releaseTimers: () => undefined, transferTimers: () => undefined
    });
    const all = await racing.executeAll();
    assert.ok(all.skipped.some((item) => item.process_id === lateTab.process_id && item.reason === 'working'), 'an agent that started working mid-run is skipped');
    assert.ok(all.restarted.some((item) => item.from === idleTab.process_id), 'an idle agent restarts');
    assert.ok(all.skipped.some((item) => item.process_id === restarted.process_id && item.reason === 'working'), 'a working agent is skipped');
    assert.ok(!all.skipped.some((item) => item.process_id === restartChild.process_id) && !all.restarted.some((item) => item.from === restartChild.process_id), 'subagents are not considered');

    database.dispose();
    // eslint-disable-next-line no-console
    console.log('harness launch smoke ok');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function conversationRecord(overrides: Partial<ReturnType<typeof conversationRecordBase>> = {}) {
  return { ...conversationRecordBase(), ...overrides };
}

function conversationRecordBase() {
  return {
    id: 'conversation_resume',
    provider: 'claude',
    providerConversationId: 'claude_resume_existing' as string | null,
    projectId: 'project_test' as string | null,
    sessionId: null,
    processId: null,
    worktreeId: null as string | null,
    sourceFileId: null,
    title: 'Prior Claude conversation',
    cwd: null as string | null,
    providerVersion: '2.1.0',
    startedAt: null,
    updatedAt: null,
    endedAt: null,
    status: 'imported',
    linkConfidence: 1,
    linkReason: 'test',
    metadata: {},
    createdAt: new Date(0).toISOString(),
    importedAt: new Date(0).toISOString(),
    messageCount: 1
  };
}
