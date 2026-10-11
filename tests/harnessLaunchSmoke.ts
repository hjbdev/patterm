import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { CLAUDE_MCP_CONFIG, harnessProviders } from '../app/Harness/providers';
import { LaunchingMcpIdentities, McpHelperAccess } from '../app/MCP/McpHelperAccess';
import type { McpServerSpec } from '../app/Harness/HarnessProvider';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HarnessDiscoveryService } from '../app/Services/HarnessDiscoveryService';
import type { AgentHistoryReadService } from '../app/Services/AgentHistory/AgentHistoryReadService';
import { NewAgentSessionAction } from '../app/Actions/NewAgentSessionAction';
import { RestartAgentSessionAction } from '../app/Actions/RestartAgentSessionAction';
import { ResumeConversationAgentAction } from '../app/Actions/ResumeConversationAgentAction';
import { HarnessLauncher, type SpawnSink } from '../app/Services/HarnessLauncher';
import { AmpThreadService } from '../app/Services/AmpThreadService';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { prepareOpenCodeTheme } from '../app/Services/OpenCodeThemeService';
import { openCodeTheme } from '../app/Harness/OpenCodeTheme';
import { parse } from 'jsonc-parser';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';
import { OpenExternalUrlAction } from '../app/Actions/OpenExternalUrlAction';
import { TerminalClientRequestService, type TerminalClientRequest } from '../app/Services/TerminalClientRequestService';

interface SessionRow {
  harness: string;
  session_role: string;
  process_id: string | null;
  mcp_identity: string | null;
  resume_status: string;
  cwd: string | null;
  last_title: string | null;
}

const MCP: McpServerSpec = {
  command: '/opt/electron',
  args: ['/app/dist/mcp/patterm-mcp.js'],
  env: { ELECTRON_RUN_AS_NODE: '1', PATTERM_MCP_SOCKET: '/run/mcp.sock' }
};

function providerById(id: string) {
  const provider = harnessProviders.find((candidate) => candidate.id === id);
  assert.ok(provider, `provider ${id} exists`);
  return provider;
}

function assertOpenCodeTheme(tempDir: string): void {
  const source = path.join(tempDir, 'theme-source');
  const runtime = path.join(tempDir, 'theme-runtime');
  fs.mkdirSync(path.join(source, 'themes'), { recursive: true });
  fs.mkdirSync(path.join(source, 'plugins'));
  const original = '{\n// Preferences\n"tabs":{"enabled":true},"theme":{"mode":"dark"},\n}';
  fs.writeFileSync(path.join(source, 'cli.json'), original);
  fs.writeFileSync(path.join(source, 'service.json'), '{}');
  fs.writeFileSync(path.join(source, 'themes', 'custom.json'), '{}');
  const target = prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source });
  const cliPath = path.join(target, 'cli.json');
  const initial = fs.readFileSync(cliPath, 'utf8');
  assert.match(initial, /Preferences/);
  assert.deepEqual(parse(initial), { tabs: { enabled: true }, theme: { mode: 'dark', name: 'patterm-opencode' } });
  assert.equal(fs.readFileSync(path.join(source, 'cli.json'), 'utf8'), original);
  assert.equal(fs.realpathSync(path.join(target, 'service.json')), path.join(source, 'service.json'));
  assert.equal(fs.realpathSync(path.join(target, 'plugins')), path.join(source, 'plugins'));
  assert.equal(fs.realpathSync(path.join(target, 'themes', 'custom.json')), path.join(source, 'themes', 'custom.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'themes', 'patterm-opencode.json'), 'utf8')), openCodeTheme);

  // Bundled palette changes refresh the generated theme; matching content is left alone.
  const themePath = path.join(target, 'themes', 'patterm-opencode.json');
  fs.writeFileSync(themePath, JSON.stringify({ defs: { darkStep2: '#101010' } }));
  prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source });
  assert.deepEqual(JSON.parse(fs.readFileSync(themePath, 'utf8')), openCodeTheme, 'stale generated themes are refreshed');
  const formattedTheme = `${JSON.stringify(openCodeTheme, null, 2)}\n`;
  fs.writeFileSync(themePath, formattedTheme);
  prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source });
  assert.equal(fs.readFileSync(themePath, 'utf8'), formattedTheme, 'matching generated themes are not rewritten');

  // Native settings writes replace the file atomically. Keep that file on relaunch.
  const saved = '{"tabs":{"enabled":false},"animations":false,"theme":{"name":"custom","mode":"light"}}';
  fs.writeFileSync(`${cliPath}.tmp`, saved);
  fs.renameSync(`${cliPath}.tmp`, cliPath);
  const updatedSource = { tabs: { enabled: true, indicators: 'numbers' }, theme: { mode: 'dark' }, scroll: { speed: 3 }, plugins: ['new-plugin'] };
  fs.writeFileSync(path.join(source, 'cli.json'), JSON.stringify(updatedSource));
  prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source });
  assert.deepEqual(parse(fs.readFileSync(cliPath, 'utf8')), {
    ...parse(saved), tabs: { enabled: false, indicators: 'numbers' }, scroll: { speed: 3 }, plugins: ['new-plugin']
  }, 'new source settings merge with native saved settings, including sibling fields');
  prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source });
  assert.equal(parse(fs.readFileSync(cliPath, 'utf8')).tabs.enabled, false, 'local settings survive repeated launches');
  fs.writeFileSync(path.join(source, 'cli.json'), JSON.stringify({ ...updatedSource, scroll: { speed: 5 }, plugins: ['replacement-plugin'] }));
  prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source });
  const synced = parse(fs.readFileSync(cliPath, 'utf8'));
  assert.equal(synced.scroll.speed, 5, 'source edits propagate when the setting was not changed locally');
  assert.deepEqual(synced.plugins, ['replacement-plugin'], 'unchanged arrays accept source updates');
  fs.writeFileSync(path.join(source, 'cli.json'), '{"tabs":{"enabled":true},"theme":{"mode":"dark"}}');
  prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source });
  const removed = parse(fs.readFileSync(cliPath, 'utf8'));
  assert.equal(removed.scroll, undefined, 'source deletions remove unmodified settings');
  assert.equal(removed.plugins, undefined);
  assert.deepEqual(removed.tabs, { enabled: false }, 'source deletion of a sibling keeps the local preference');


  // Local removals and array edits also survive source updates, without losing comments.
  fs.writeFileSync(path.join(source, 'cli.json'), '{"tabs":{"enabled":true},"scroll":{"speed":2},"plugins":["source-plugin"]}');
  prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source });
  const localText = '{"tabs": {\n// Keep this comment\n"enabled": false}, "plugins":["local-plugin"],"theme":{"name":"patterm-opencode"}}';
  fs.writeFileSync(cliPath, localText);
  fs.writeFileSync(path.join(source, 'cli.json'), '{"tabs":{"enabled":true,"indicators":"numbers"},"scroll":{"speed":7},"plugins":["updated-source-plugin"],"theme":{"name":"tokyonight"}}');
  prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source });
  const localMerged = fs.readFileSync(cliPath, 'utf8');
  assert.match(localMerged, /Keep this comment/, 'nested JSONC comments survive sibling updates');
  assert.equal(parse(localMerged).scroll, undefined, 'locally deleted settings stay deleted');
  assert.deepEqual(parse(localMerged).plugins, ['local-plugin'], 'local array edits win conflicts');
  assert.equal(parse(localMerged).theme.name, 'tokyonight', 'new source themes propagate without a local theme override');
  const beforeInvalidSource = fs.readFileSync(cliPath, 'utf8');
  fs.writeFileSync(path.join(source, 'cli.json'), '{broken');
  assert.throws(() => prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source }), /valid JSONC/);
  assert.equal(fs.readFileSync(cliPath, 'utf8'), beforeInvalidSource, 'invalid source config cannot overwrite saved preferences');
  fs.writeFileSync(path.join(source, 'cli.json'), '{}');

  // Migrate the old forced system theme without resetting tabs or other settings.
  const oldRuntime = path.join(tempDir, 'old-theme-runtime');
  const oldTarget = path.join(oldRuntime, 'opencode-config');
  fs.mkdirSync(oldTarget, { recursive: true });
  fs.writeFileSync(path.join(oldTarget, 'cli.json'), '{"tabs":{"enabled":false},"theme":{"name":"system","mode":"dark"}}');
  fs.symlinkSync(path.join(source, 'themes'), path.join(oldTarget, 'themes'));
  prepareOpenCodeTheme(oldRuntime, { OPENCODE_CONFIG_DIR: source });
  assert.deepEqual(parse(fs.readFileSync(path.join(oldTarget, 'cli.json'), 'utf8')), { tabs: { enabled: false }, theme: { name: 'patterm-opencode', mode: 'dark' } });
  assert.equal(fs.existsSync(path.join(source, 'themes', 'patterm-opencode.json')), false, 'migration must not write through the old directory symlink');
  fs.unlinkSync(path.join(source, 'themes', 'custom.json'));
  prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source });
  assert.equal(fs.lstatSync(path.join(target, 'themes', 'custom.json'), { throwIfNoEntry: false }), undefined, 'removed source themes leave no broken discovery links');
  fs.writeFileSync(cliPath, '{broken');
  assert.throws(() => prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source }), /valid JSONC/);
  assert.equal(fs.readFileSync(cliPath, 'utf8'), '{broken', 'invalid saved preferences are never overwritten');
}

function assertProviderPlans(runtimeDir: string): void {
  // Claude: MCP config file behind --mcp-config, socket lives in the file.
  const claude = providerById('claude').buildLaunch({ executablePath: '/usr/bin/claude', mcp: MCP, runtimeDir });
  assert.equal(claude.command, '/usr/bin/claude');
  assert.deepEqual(claude.env, {});
  assert.deepEqual(claude.args.slice(0, 3), ['--permission-mode', 'auto', '--mcp-config']);
  assert.equal(claude.args[3], path.join(runtimeDir, 'claude-mcp-patterm.json'));
  const identified = providerById('claude').buildLaunch({ executablePath: '/usr/bin/claude', mcp: { ...MCP, env: { ...MCP.env, PATTERM_MCP_IDENTITY: 'mcp_1' } }, runtimeDir });
  assert.equal(identified.args[3], path.join(runtimeDir, 'claude-mcp-mcp_1.json'), 'each Claude launch gets its own MCP config');
  assert.equal(claude.files.length, 1);
  const claudeConfig = JSON.parse(claude.files[0]!.contents) as {
    mcpServers: { patterm: { command: string; args: string[]; env: Record<string, string> } };
  };
  assert.equal(claudeConfig.mcpServers.patterm.command, '/opt/electron');
  assert.deepEqual(claudeConfig.mcpServers.patterm.args, ['/app/dist/mcp/patterm-mcp.js']);
  assert.equal(claudeConfig.mcpServers.patterm.env.PATTERM_MCP_SOCKET, '/run/mcp.sock');
  const claudeWithContext = providerById('claude').buildLaunch({ executablePath: '/usr/bin/claude', mcp: MCP, runtimeDir, agentContext: 'Agent startup context' });
  assert.ok(claudeWithContext.agentContextInjected, 'claude reports agent context injection');
  assert.deepEqual(
    claudeWithContext.args.slice(-2),
    ['--append-system-prompt', 'Agent startup context'],
    'claude appends agent context to the system prompt'
  );
  const resumedClaude = providerById('claude').buildLaunch({ executablePath: '/usr/bin/claude', mcp: MCP, runtimeDir, resumeId: 'claude_resume_test' });
  assert.deepEqual(resumedClaude.args.slice(-2), ['--resume', 'claude_resume_test'], 'claude resumes the exact provider conversation');

  // Codex: repeated -c TOML overrides, no files, no env.
  const codex = providerById('codex').buildLaunch({ executablePath: '/usr/bin/codex', mcp: MCP, runtimeDir, agentContext: 'Agent startup context\nwith "quotes"' });
  assert.deepEqual(codex.env, {});
  assert.equal(codex.files.length, 0);
  assert.ok(codex.args.includes('mcp_servers.patterm.command="/opt/electron"'), 'codex sets mcp command via -c');
  assert.ok(
    codex.args.includes('mcp_servers.patterm.env.PATTERM_MCP_SOCKET="/run/mcp.sock"'),
    'codex passes socket via -c env override'
  );
  assert.ok(codex.args.includes('developer_instructions="Agent startup context\\nwith \\"quotes\\""'), 'codex injects multiline agent context as developer instructions');
  assert.ok(codex.agentContextInjected, 'codex reports agent context injection');
  const resumedCodex = providerById('codex').buildLaunch({ executablePath: '/usr/bin/codex', mcp: MCP, runtimeDir, resumeId: 'codex_resume_test' });
  assert.equal(resumedCodex.args[0], 'resume', 'codex uses the resume subcommand');
  assert.equal(resumedCodex.args.at(-1), 'codex_resume_test', 'codex passes the exact session id');
  assert.ok(resumedCodex.args.includes('mcp_servers.patterm.command="/opt/electron"'), 'codex resume keeps MCP injection');

  // OpenCode attaches to a session prepared through the shared-server API.
  const opencode = providerById('opencode').buildLaunch({ executablePath: '/usr/bin/opencode', mcp: MCP, runtimeDir, agentContext: 'Agent startup context' });
  assert.deepEqual(opencode.args, []);
  assert.deepEqual(opencode.env, {}, 'shared-server config is not injected into the TUI environment');
  assert.deepEqual(opencode.files, []);
  assert.deepEqual(providerById('opencode').executableCandidates, ['opencode']);
  const resumedOpenCode = providerById('opencode').buildLaunch({ executablePath: '/usr/bin/opencode', mcp: MCP, runtimeDir, resumeId: 'opencode_resume_test' });
  assert.deepEqual(resumedOpenCode.args, ['--session', 'opencode_resume_test'], 'opencode resumes the exact session');

  const amp = providerById('amp').buildLaunch({ executablePath: '/usr/bin/amp', mcp: MCP, runtimeDir, resumeId: 'T-1234', model: 'high' });
  assert.deepEqual(amp.args.slice(0, 3), ['threads', 'continue', 'T-1234']);
  assert.deepEqual(JSON.parse(amp.files[0]!.contents), { patterm: MCP });
  assert.equal(amp.args[4], amp.files[0]!.path);
  assert.deepEqual(amp.args.slice(-2), ['--mode', 'high']);
  assert.throws(() => providerById('amp').buildLaunch({ executablePath: '/usr/bin/amp', mcp: MCP, runtimeDir }), /thread ID/);

  // RawPty: bare shell, no injection.
  const raw = providerById('rawpty').buildLaunch({ executablePath: '/bin/zsh', mcp: MCP, runtimeDir });
  assert.deepEqual(raw, { command: '/bin/zsh', args: [], env: {}, files: [] });
  assert.throws(
    () => providerById('rawpty').buildLaunch({ executablePath: '/bin/zsh', mcp: MCP, runtimeDir, resumeId: 'raw_resume_test' }),
    /cannot be resumed/
  );
}

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-launch-'));
  const runtimeDir = path.join(tempDir, 'harness');
  const shimPath = path.join(tempDir, 'patterm-mcp.js');

  try {
    assertProviderPlans(runtimeDir);
    const ampExecutable = path.join(tempDir, 'amp-fixture');
    fs.writeFileSync(ampExecutable, `#!${process.execPath}\nconsole.log('https://ampcode.com/threads/T-1234');\n`, { mode: 0o700 });
    const ampThreads = new AmpThreadService();
    assert.equal(await ampThreads.prepare(ampExecutable, tempDir, null), 'T-1234');
    assert.equal(await ampThreads.prepare(ampExecutable, tempDir, 'T-5678'), 'T-5678');
    await assert.rejects(ampThreads.prepare(ampExecutable, tempDir, 'not-a-thread'), /Invalid Amp thread ID/);
    assertOpenCodeTheme(tempDir);
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

    // Pretend discovery already found Claude, OpenCode, and Amp (Codex stays absent).
    for (const [harness, exe] of [['claude', '/usr/bin/claude'], ['opencode', '/usr/bin/opencode'], ['amp', ampExecutable]] as const) {
      database.connection
        .prepare(
          `insert into harness_installations (id, harness, executable_path, version, status, discovered_at, last_checked_at)
           values (?, ?, ?, ?, 'available', ?, ?)`
        )
        .run(`harness_${harness}`, harness, exe, '1.0.0', now, now);
    }

    const repo = new WorkbenchRepository(database);

    const terminalRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let nextProcessNumber = 1;
    const terminal: SpawnSink = {
      request: async (method, params) => {
        terminalRequests.push({ method, params: params as Record<string, unknown> });
        if (method === 'terminal.process.spawn') {
          return { process_id: `proc_${nextProcessNumber++}` };
        }
        if (method === 'terminal.process.output') {
          return { process_id: (params as { process_id?: string }).process_id, status: 'running', lines: ['codex ready'] };
        }
        return { ok: true };
      }
    };

    let openInstruction = '';
    const integratedPrompts: Array<{ processId: string; text: string; context?: string }> = [];
    const stoppedIntegrated: string[] = [];
    const observedIntegrated: string[] = [];
    let failIntegratedPrompt = false;
    // Integrated harnesses start MCP helpers while preparing, before the
    // session is registered; their identity must already be accepted.
    const launchingIdentities = new LaunchingMcpIdentities();
    const helperAccess = new McpHelperAccess(database, () => false, launchingIdentities);
    const helperHarnesses: string[] = [];
    const integratedService = {
      prepare: async (_harness: 'claude' | 'codex' | 'opencode' | 'amp', input: { context: string; mcp: { env: Record<string, string> } }) => {
        helperHarnesses.push(helperAccess.harness({ identity: input.mcp.env.PATTERM_MCP_IDENTITY!, opencodeBridge: undefined })!);
        openInstruction = input.context; return { resumeId: _harness === 'amp' ? 'T-prepared' : 'ses_prepared', argv: ['/usr/bin/opencode'] }; },
      prompt: async (processId: string, text: string, context?: string) => {
        assert.ok(observedIntegrated.includes(processId), 'an Integrated agent is observed before its first prompt');
        integratedPrompts.push({ processId, text, ...(context ? { context } : {}) });
        if (failIntegratedPrompt) throw new Error('Initial prompt failed');
        return { id: 'msg_test', admittedSeq: 1 };
      },
      stop: async (processId: string) => { stoppedIntegrated.push(processId); },
      observe: (processId: string) => { observedIntegrated.push(processId); },
      cleanupLaunch: async () => undefined
    };
    const launcher = new HarnessLauncher({
      settings: { agentInterface: () => 'tui' },
      openCodeServer: {
        prepare: async (input) => { openInstruction = input.context; return { resumeId: 'ses_prepared', argv: ['/usr/bin/opencode'] }; }
      },
      integrated: integratedService,
      launchingIdentities,
      ampThreads,
      database,
      timeline,
      terminal,
      workbench: repo,
      providers: harnessProviders,
      nodePath: MCP.command,
      shimPath,
      socketPath: MCP.env.PATTERM_MCP_SOCKET!,
      runtimeDir,
      inheritedPath: '/usr/bin'
    });

    // Old configs of exited Claude agents are removed; recent ones may belong
    // to a launch that hasn't registered yet.
    fs.mkdirSync(runtimeDir, { recursive: true });
    const staleConfig = path.join(runtimeDir, 'claude-mcp-mcp_00000000-0000-4000-8000-000000000001.json');
    const recentConfig = path.join(runtimeDir, 'claude-mcp-mcp_00000000-0000-4000-8000-000000000002.json');
    fs.writeFileSync(staleConfig, '{}');
    fs.writeFileSync(recentConfig, '{}');
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(staleConfig, hourAgo, hourAgo);

    // Launch Claude: spawn carries the resolved plan; a session row is written.
    const launched = await launcher.launch({ harness: 'claude', project_id: projectId, actor_id: null });
    assert.equal(fs.existsSync(staleConfig), false, 'stale Claude MCP configs are removed');
    assert.equal(fs.existsSync(recentConfig), true, 'recent Claude MCP configs are kept');
    assert.equal(launched.process_id, 'process_1');
    assert.equal(launched.pty_process_id, 'proc_1');
    const spawn = lastRequest(terminalRequests, 'terminal.process.spawn');
    assert.equal(spawn.command, '/usr/bin/claude');
    assert.equal(spawn.kind, 'agent');
    assert.equal(spawn.cwd, projectPath, 'cwd defaults to the project path');
    assert.ok(Array.isArray(spawn.args) && (spawn.args as string[]).includes('--mcp-config'));
    const projectContext = claudeAppendSystemPrompt(spawn.args as string[]);
    assert.match(projectContext, new RegExp(`Project: ${projectId}`), 'project-level claude receives project identity');
    assert.match(projectContext, /Orient with get_project_status/, 'project-level claude receives an orientation pointer');
    assert.match(projectContext, /Agent-facing tools are available directly; use help/, 'project-level claude receives direct tool guidance');
    assert.match(projectContext, /never to satisfy host-internal planning\/review requirements/, 'project-level claude is told not to use Patterm delegation for host workflows');
    assert.match(projectContext, /report_to_parent/, 'project-level claude receives child completion report guidance');
    assert.match(projectContext, /send_message the child that already reported instead of spawning a replacement/, 'project-level claude reuses reported children for follow-ups');
    assert.match(projectContext, /reference_attach its URL to your session/, 'project-level claude links PRs and issues to its session');
    assert.match(projectContext, /Link every git worktree you work in to your session \(at most 10\): worktree_create and worktree_link do this automatically; otherwise call worktree_attach/, 'project-level claude links its worktrees to its session');
    assert.match(projectContext, /Do not send a running child status checks, hurry-up messages, or requests to wrap up/, 'project-level claude is told not to nudge running children');
    assert.match(projectContext, /genuinely new task information or to cancel at the user's request/, 'project-level claude receives the allowed messaging exceptions');
    assert.doesNotMatch(projectContext, /Context Task/, 'project-level claude does not receive task records');
    assert.match(projectContext, /never invent labels from IDs/, 'project-level claude keeps exact process names');
    assert.match(projectContext, /call request_close with a short summary/, 'project-level claude learns when to ask to be closed');
    assert.ok(projectContext.length < 2000, 'project-level context stays compact');
    const claudeConfigPath = (spawn.args as string[])[3]!;
    assert.match(path.basename(claudeConfigPath), CLAUDE_MCP_CONFIG, 'claude mcp config is named for its launch');
    assert.equal(path.dirname(claudeConfigPath), runtimeDir, 'claude mcp config written to runtime dir');
    const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8')) as {
      mcpServers: { patterm: { env: Record<string, string> } };
    };
    assert.ok(claudeConfig.mcpServers.patterm.env.PATTERM_MCP_IDENTITY, 'claude mcp config carries a per-session identity');
    assert.equal(path.basename(claudeConfigPath), `claude-mcp-${claudeConfig.mcpServers.patterm.env.PATTERM_MCP_IDENTITY}.json`);
    const opener = path.join(runtimeDir, 'bin', 'xdg-open');
    const spawnEnv = spawn.env as Record<string, string>;
    assert.equal(spawnEnv.PATH, `${path.dirname(opener)}:/usr/bin`, 'the xdg-open shim precedes the inherited PATH');
    assert.equal(spawnEnv.BROWSER, opener);
    assert.equal(spawnEnv.PATTERM_TERMINAL_IDENTITY, claudeConfig.mcpServers.patterm.env.PATTERM_MCP_IDENTITY, 'the opener reports as the agent session');
    assert.equal(spawnEnv.PATTERM_MCP_IDENTITY, undefined, 'nested MCP shims do not inherit the agent identity');
    assert.ok(fs.statSync(opener).mode & 0o100, 'the xdg-open shim is executable');
    // Stand-ins for the shim and the system opener show which path each target takes.
    const fakeBin = path.join(tempDir, 'system-bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'xdg-open'), '#!/bin/sh\necho "system $*"\n', { mode: 0o700 });
    const fakeShim = path.join(tempDir, 'fake-shim.sh');
    fs.writeFileSync(fakeShim, 'echo "patterm $PATTERM_MCP_SOCKET $PATTERM_MCP_IDENTITY $*"\n');
    const fakeOpener = fs.readFileSync(opener, 'utf8')
      .replace(`'${MCP.command}' '${shimPath}'`, `/bin/sh '${fakeShim}'`)
      .replace(`PATH='/usr/bin'`, `PATH='${fakeBin}'`);
    const fakeOpenerPath = path.join(tempDir, 'xdg-open-test');
    fs.writeFileSync(fakeOpenerPath, fakeOpener, { mode: 0o700 });
    const runOpener = (target: string) => execFileSync(fakeOpenerPath, [target], { env: { PATTERM_TERMINAL_IDENTITY: 'mcp_x' }, encoding: 'utf8' }).trim();
    assert.equal(runOpener('https://example.com/pulls/87'), `patterm ${MCP.env.PATTERM_MCP_SOCKET} mcp_x --open https://example.com/pulls/87`);
    assert.equal(runOpener('/tmp/report.pdf'), 'system /tmp/report.pdf', 'files still go to the system opener');
    const clientRequests = new TerminalClientRequestService();
    const delivered: TerminalClientRequest[] = [];
    clientRequests.on((request) => delivered.push(request));
    const openUrl = new OpenExternalUrlAction(database, clientRequests);
    openUrl.execute({ identity: spawnEnv.PATTERM_TERMINAL_IDENTITY, url: 'https://example.com/pulls/87' });
    assert.deepEqual(delivered, [{ kind: 'open-url', processId: 'proc_1', url: 'https://example.com/pulls/87' }], 'links open on the client controlling the agent PTY');
    assert.throws(() => openUrl.execute({ identity: spawnEnv.PATTERM_TERMINAL_IDENTITY, url: 'file:///etc/passwd' }), /does not open file: links/);
    assert.throws(() => openUrl.execute({ identity: 'mcp_unknown', url: 'https://example.com' }), /not a running Patterm terminal/);
    assert.equal(delivered.length, 1);

    const sessionRow = database.connection
      .prepare(`select harness, session_role, process_id, resume_status, cwd, mcp_identity, last_title from sessions where id = ?`)
      .get(launched.session_id) as SessionRow | undefined;
    assert.equal(sessionRow?.harness, 'claude');
    assert.equal(sessionRow?.session_role, 'orchestrator');
    assert.equal(sessionRow?.process_id, 'process_1');
    assert.equal(sessionRow?.resume_status, 'unknown');
    assert.equal(sessionRow?.cwd, projectPath);
    assert.equal(sessionRow?.last_title, 'Claude Code');
    assert.ok(sessionRow?.mcp_identity, 'session stores MCP identity');
    const processRow = database.connection
      .prepare(`select pty_process_id from processes where id = ?`)
      .get(launched.process_id) as { pty_process_id: string | null } | undefined;
    assert.equal(processRow?.pty_process_id, 'proc_1', 'agent stores the reused sidecar id only as the live PTY handle');
    const launchedSession = repo.snapshot().projects[0]?.projectSessions.find((session) => session.id === launched.session_id);
    assert.equal(launchedSession?.processId, 'process_1', 'workbench exposes stable session process row id');
    assert.equal(launchedSession?.ptyProcessId, 'proc_1', 'workbench exposes live PTY id for terminal focus');

    const namedLaunch = await launcher.launch({ harness: 'claude', project_id: projectId, name: 'API Reviewer' });
    const namedSessionRow = database.connection
      .prepare(`select last_title from sessions where id = ?`)
      .get(namedLaunch.session_id) as { last_title: string | null } | undefined;
    const namedProcessRow = database.connection
      .prepare(`select name from processes where id = ?`)
      .get(namedLaunch.process_id) as { name: string } | undefined;
    assert.equal(lastRequest(terminalRequests, 'terminal.process.spawn').name, 'API Reviewer');
    assert.equal(namedSessionRow?.last_title, 'API Reviewer');
    assert.equal(namedProcessRow?.name, 'API Reviewer');

    const promptLaunch = await launcher.launch({ harness: 'claude', project_id: projectId, initial_prompt: 'Do the next step.' });
    const promptSpawn = lastRequest(terminalRequests, 'terminal.process.spawn');
    const promptSpawnArgs = promptSpawn.args as string[];
    const appendSystemPromptAt = promptSpawnArgs.indexOf('--append-system-prompt');
    assert.notEqual(appendSystemPromptAt, -1, 'project-scoped claude launch appends task context to the system prompt');
    const promptContext = promptSpawnArgs[appendSystemPromptAt + 1] ?? '';
    assert.match(promptContext, new RegExp(`Project: ${projectId}`), 'project-scoped claude receives project identity');
    for (const sentinel of [
      'Use the task description.',
      'Implement the task context feature.',
      'plan-sentinel-should-not-load',
      'issue-sentinel-should-not-load',
      'decision-sentinel-should-not-load',
      'check-in-sentinel-should-not-load',
      'handoff-sentinel-should-not-load',
      'worktree-sentinel-should-not-load',
      'diff-sentinel-should-not-load',
      'timeline-sentinel-should-not-load',
      'patterm.task.check_in.create',
      'patterm.worktree.link'
    ]) {
      assert.doesNotMatch(promptContext, new RegExp(sentinel.replaceAll('.', '\\.')), `${sentinel} is not loaded into launch context`);
    }
    assert.ok(promptContext.length < 2000, 'project-scoped context stays compact');
    await waitFor(
      async () => terminalRequests.filter((request) => request.method === 'terminal.process.input' && (request.params as { process_id?: string }).process_id === promptLaunch.pty_process_id).length >= 1,
      'project-scoped launch receives explicit initial prompt'
    );
    const promptInputRequests = terminalRequests.filter(
      (request) => request.method === 'terminal.process.input' && (request.params as { process_id?: string }).process_id === promptLaunch.pty_process_id
    );
    assert.deepEqual(promptInputRequests[0]?.params, {
      process_id: promptLaunch.pty_process_id,
      kind: 'paste',
      text: 'Do the next step.',
      submit: true
    });
    assert.doesNotMatch(String(promptInputRequests[0]?.params.text ?? ''), /Context Task/, 'task context is not sent as user text');

    const startedEvents = database.connection
      .prepare(`select count(*) as n from timeline_events where event_type = 'session.started'`)
      .get() as { n: number };
    assert.equal(startedEvents.n, 3, 'session.started recorded on timeline');

    // Launch OpenCode: attach to the session prepared by the shared-server service.
    const inputCountBeforeOpenCode = terminalRequests.filter((request) => request.method === 'terminal.process.input').length;
    const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    const configDir = path.join(tempDir, 'launch-config');
    fs.mkdirSync(configDir);
    const preferences = JSON.stringify({ tabs: { enabled: false }, theme: { name: 'tokyonight', mode: 'dark' } });
    fs.writeFileSync(path.join(configDir, 'cli.json'), preferences);
    process.env.OPENCODE_CONFIG_DIR = configDir;
    try { await launcher.launch({ harness: 'opencode', project_id: projectId }); }
    finally {
      if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }
    const openSpawn = lastRequest(terminalRequests, 'terminal.process.spawn');
    assert.equal((openSpawn.env as Record<string, string>).OPENCODE_CONFIG_DIR, path.join(runtimeDir, 'opencode-config'));
    assert.equal(fs.readFileSync(path.join(configDir, 'cli.json'), 'utf8'), preferences, 'launch preserves saved tabs and theme preferences');
    assert.equal(parse(fs.readFileSync(path.join(runtimeDir, 'opencode-config', 'cli.json'), 'utf8')).theme.name, 'tokyonight', 'a chosen native theme remains selected');
    assert.deepEqual(openSpawn.args, ['--session', 'ses_prepared']);
    assert.equal(openSpawn.command, '/usr/bin/opencode');
    const storedOpenCode = database.connection.prepare(`select resume_id from sessions where harness = 'opencode'`).get() as { resume_id: string };
    assert.equal(storedOpenCode.resume_id, 'ses_prepared', 'session identity is stored before model work begins');
    assert.match(openInstruction, new RegExp(`Project: ${projectId}`), 'opencode instruction file includes project identity');
    assert.match(openInstruction, /replace unavailable host-native subagents/, 'opencode instruction file blocks Patterm as a host-subagent fallback');
    assert.doesNotMatch(openInstruction, /Implement the task context feature/, 'opencode instruction file excludes task records');
    assert.doesNotMatch(openInstruction, /worktree-sentinel-should-not-load/, 'opencode instruction file excludes worktrees');
    assert.equal(
      terminalRequests.filter((request) => request.method === 'terminal.process.input').length,
      inputCountBeforeOpenCode,
      'opencode project context without explicit prompt is not sent through terminal input'
    );

    const ampLaunched = await launcher.launch({ harness: 'amp', project_id: projectId, interface_mode: 'tui' });
    const ampSpawn = lastRequest(terminalRequests, 'terminal.process.spawn');
    assert.equal(ampSpawn.command, ampExecutable);
    assert.deepEqual((ampSpawn.args as string[]).slice(0, 3), ['threads', 'continue', 'T-1234']);
    assert.equal((ampSpawn.env as Record<string, string>).AMP_WEB_TERMINAL, '1', 'amp copies through OSC 52');
    assert.ok(JSON.parse(fs.readFileSync((ampSpawn.args as string[])[4]!, 'utf8')).patterm.env.PATTERM_MCP_IDENTITY);
    assert.equal((database.connection.prepare('select resume_id from sessions where id = ?').get(ampLaunched.session_id) as { resume_id: string }).resume_id, 'T-1234');
    const ampIntegrated = await launcher.launch({ harness: 'amp', project_id: projectId, interface_mode: 'integrated' });
    assert.equal(ampIntegrated.pty_process_id, null);
    assert.equal((database.connection.prepare('select resume_id from sessions where id = ?').get(ampIntegrated.session_id) as { resume_id: string }).resume_id, 'T-prepared');
    assert.deepEqual(helperHarnesses, ['amp'], 'helpers started while preparing are recognised before the session is registered');

    const spawnCountBeforeIntegrated = terminalRequests.filter((request) => request.method === 'terminal.process.spawn').length;
    const integrated = await launcher.launch({ harness: 'opencode', project_id: projectId, interface_mode: 'integrated', initial_prompt: 'Use Integrated mode.' });
    assert.equal(integrated.pty_process_id, null);
    assert.equal(integrated.interface_mode, 'integrated');
    assert.equal(terminalRequests.filter((request) => request.method === 'terminal.process.spawn').length, spawnCountBeforeIntegrated, 'Integrated launch does not create a PTY');
    const integratedRow = database.connection.prepare(`select interface_mode from sessions where id = ?`).get(integrated.session_id) as { interface_mode: string };
    assert.equal(integratedRow.interface_mode, 'integrated');
    assert.equal(repo.snapshot().projects[0]?.projectSessions.find((session) => session.id === integrated.session_id)?.ptyProcessId, null);
    assert.deepEqual(integratedPrompts.map(({ processId, text }) => ({ processId, text })), [{ processId: integrated.process_id, text: 'Use Integrated mode.' }]);

    failIntegratedPrompt = true;
    await assert.rejects(launcher.launch({ harness: 'opencode', project_id: projectId, interface_mode: 'integrated', initial_prompt: 'Fail this prompt.' }), /Initial prompt failed/);
    assert.equal(stoppedIntegrated.length, 1, 'failed initial submission stops its native Integrated runtime');

    // A harness that was never discovered cannot be launched.
    await assert.rejects(launcher.launch({ harness: 'codex', project_id: projectId }), /not available/);

    const missingShimLauncher = new HarnessLauncher({
      database,
      timeline,
      terminal,
      workbench: repo,
      providers: harnessProviders,
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
      harnessLauncher: launcher
    });
    const viaRegistry = (await registry.call('harness_launch', {
      harness: 'claude',
      project_id: projectId
    })) as { session_id: string; pty_process_id: string };
    assert.ok(viaRegistry.session_id, 'registry launch returns a session id');
    assert.ok(viaRegistry.pty_process_id.startsWith('proc_'), 'registry launch returns the live PTY id for focus');

    const inputCountBeforeSpawnAgent = terminalRequests.filter((request) => request.method === 'terminal.process.input').length;
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
    assert.equal(spawnedAgentSession?.display_name, 'Docs Agent', 'CLI spawn_agent keeps the requested name separate from terminal titles');
    database.connection.prepare(`update sessions set last_title = 'claude' where process_id = ?`).run(spawnedAgent.process_id);
    const spawnedAgentSnapshot = repo.snapshot().projects
      .flatMap((project) => [...project.projectSessions])
      .find((session) => session.processId === spawnedAgent.process_id);
    assert.equal(spawnedAgentSnapshot?.displayName ?? spawnedAgentSnapshot?.lastTitle, 'Docs Agent', 'CLI spawn_agent name remains the UI label after a terminal title update');
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
    assert.doesNotMatch(claudeAppendSystemPrompt(lastRequest(terminalRequests, 'terminal.process.spawn').args as string[]), /Task: task_context/, 'default CLI child does not inherit task identity');

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
          return conversationRecord({ id: conversationId, projectId, worktreeId: 'worktree_context', cwd: projectPath });
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
      historyReadService
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
    const resumeSpawn = lastRequest(terminalRequests, 'terminal.process.spawn');
    assert.equal(resumeSpawn.cwd, projectPath, 'resume uses the recorded conversation cwd');
    assert.deepEqual((resumeSpawn.args as string[]).slice(-2), ['--resume', 'claude_resume_existing'], 'resume launches the exact provider conversation');
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
    const concurrentSpawnCount = terminalRequests.filter((request) => request.method === 'terminal.process.spawn').length;
    const concurrent = await Promise.allSettled([
      resumeRegistry.call('spawn_agent', { conversation_id: 'conversation_concurrent' }, { identity: parentIdentity.mcp_identity }),
      resumeRegistry.call('spawn_agent', { conversation_id: 'conversation_concurrent' }, { identity: parentIdentity.mcp_identity })
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1, 'one concurrent resume succeeds');
    assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1, 'one concurrent resume is rejected');
    assert.equal(
      terminalRequests.filter((request) => request.method === 'terminal.process.spawn').length,
      concurrentSpawnCount + 1,
      'concurrent resume requests create one PTY'
    );
    await assert.rejects(
      resumeRegistry.call('history_resume', { conversation_id: 'conversation_user' }, { identity: parentIdentity.mcp_identity }),
      /agents resume with spawn_agent/,
      'agents cannot start top-level resumes'
    );
    const userResume = (await resumeRegistry.call('history_resume', { conversation_id: 'conversation_user', project_id: projectId, interface_mode: 'tui' }, {})) as { process_id: string; replaced_process_id: string | null };
    assert.equal(userResume.replaced_process_id, null);
    assert.deepEqual(database.connection.prepare(`
      select sessions.session_role, sessions.interface_mode, processes.parent_process_id
      from sessions join processes on processes.id = sessions.process_id where sessions.process_id = ?
    `).get(userResume.process_id), { session_role: 'orchestrator', interface_mode: 'tui', parent_process_id: null }, 'a user resume is a top-level session in the chosen mode');

    // Replacement closes only an empty, running Integrated tab in the project.
    const emptyTab = await launcher.launch({ harness: 'claude', project_id: projectId, interface_mode: 'integrated' });
    const busyTab = await launcher.launch({ harness: 'claude', project_id: projectId, interface_mode: 'integrated' });
    const closed: string[] = [];
    const replacingResume = new ResumeConversationAgentAction(database, historyReadService, launcher, {
      integrated: { isEmpty: async (processId: string) => processId === emptyTab.process_id },
      closeProcess: { execute: async (processId: string) => { closed.push(processId); return { closed: [processId] }; } }
    });
    const kept = await replacingResume.execute({ conversation_id: 'conversation_keep', project_id: projectId, interface_mode: 'integrated', replace_process_id: busyTab.process_id });
    assert.equal(kept.replaced_process_id, null, 'a tab with a conversation stays open');
    const replaced = await replacingResume.execute({ conversation_id: 'conversation_replace', project_id: projectId, interface_mode: 'integrated', replace_process_id: emptyTab.process_id });
    assert.equal(replaced.replaced_process_id, emptyTab.process_id, 'an empty tab is replaced');
    assert.deepEqual(closed, [emptyTab.process_id]);

    // `/new` relaunches the same harness and model, replacing only an idle tab.
    const newClosed: string[] = [];
    const newSession = new NewAgentSessionAction(database, launcher, {
      execute: async (processId: string) => { newClosed.push(processId); return { closed: [processId] }; }
    });
    const sourceTab = await launcher.launch({ harness: 'claude', model: 'claude-opus-5-5', project_id: projectId, interface_mode: 'integrated' });
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
      transferTimers: (from, to) => { timerTransfers.push([from, to]); }
    });
    const restartTab = await launcher.launch({ harness: 'claude', model: 'claude-opus-5-5', project_id: projectId, interface_mode: 'integrated' });
    const restartChild = await launcher.launch({ harness: 'claude', project_id: projectId, interface_mode: 'integrated', parent_process_id: restartTab.process_id, session_role: 'child' });
    // The fake Integrated host reports this native conversation for every launch.
    database.connection.prepare(`update sessions set title_set_by_user = 1 where process_id = ?`).run(restartTab.process_id);
    database.connection.prepare(`update processes set activity = 'working' where id = ?`).run(restartTab.process_id);
    await assert.rejects(restart.execute({ process_id: restartTab.process_id, project_id: projectId }), /working/, 'a turn in progress is not cut short');
    await assert.rejects(restart.execute({ process_id: restartChild.process_id, project_id: projectId }), /Only top-level agents/);
    database.connection.prepare(`update processes set activity = 'idle' where id = ?`).run(restartTab.process_id);
    const restarted = await restart.execute({ process_id: restartTab.process_id, project_id: projectId });
    assert.equal(restarted.replaced_process_id, restartTab.process_id);
    assert.deepEqual(restartSteps, [`stop:${restartTab.process_id}`, `close:${restartTab.process_id}`], 'the old process stops before the resume and closes after it');
    assert.deepEqual(timerTransfers, [[[restartTab.process_id], restarted.process_id]]);
    assert.deepEqual(database.connection.prepare(`select harness, model, interface_mode, session_role, resume_id, resumed_from_session_id, title_set_by_user from sessions where id = ?`).get(restarted.session_id), {
      harness: 'claude', model: 'claude-opus-5-5', interface_mode: 'integrated', session_role: 'orchestrator', resume_id: 'ses_prepared', resumed_from_session_id: restartTab.session_id, title_set_by_user: 1
    }, 'the new session resumes the same conversation and keeps a user-chosen name');
    assert.equal((database.connection.prepare('select parent_process_id from processes where id = ?').get(restartChild.process_id) as { parent_process_id: string }).parent_process_id,
      restarted.process_id, 'subagents report to the new process');

    // Restart all leaves working agents running.
    const idleTab = await launcher.launch({ harness: 'claude', project_id: projectId, interface_mode: 'integrated' });
    database.connection.prepare(`update processes set activity = 'idle' where id = ?`).run(idleTab.process_id);
    database.connection.prepare(`update processes set activity = 'working' where id = ?`).run(restarted.process_id);
    const all = await restart.executeAll();
    assert.ok(all.restarted.some((item) => item.from === idleTab.process_id), 'an idle agent restarts');
    assert.ok(all.skipped.some((item) => item.process_id === restarted.process_id && item.reason === 'working'), 'a working agent is skipped');
    assert.ok(!all.skipped.some((item) => item.process_id === restartChild.process_id) && !all.restarted.some((item) => item.from === restartChild.process_id), 'subagents are not considered');

    await waitFor(async () => terminalRequests.filter((request) => request.method === 'terminal.process.input').length >= inputCountBeforeSpawnAgent + 1, 'initial prompt injection sends pasted prompt and submit request');
    const inputRequests = terminalRequests.filter((request) => request.method === 'terminal.process.input').slice(inputCountBeforeSpawnAgent, inputCountBeforeSpawnAgent + 1);
    assert.deepEqual(inputRequests[0]?.params, {
      process_id: inputRequests[0]?.params.process_id,
      kind: 'paste',
      text: 'Review the docs\n\nThen report risks\nCheck examples\n\nWhen this delegated work is done, blocked, failed, or has no findings, call report_to_parent with your result. Do not rely on terminal idle or get_process_output as the completion signal. Stay available after reporting: your parent may send follow-ups, such as re-reviewing fixes, and you should report again after each one.',
      submit: true
    });
    const inputCountBeforeMcpPaste = terminalRequests.filter((request) => request.method === 'terminal.process.input').length;
    await registry.call('send_input', { process_id: spawnedAgent.process_id, kind: 'paste', text: 'follow-up\nmessage', submit: true });
    const mcpPasteInput = terminalRequests.filter((request) => request.method === 'terminal.process.input').slice(inputCountBeforeMcpPaste).at(0);
    assert.deepEqual(mcpPasteInput?.params, {
      process_id: inputRequests[0]?.params.process_id,
      kind: 'paste',
      text: 'follow-up\nmessage',
      submit: true
    });

    // Resume also injects a prompt asynchronously. Wait for that launch before
    // disposing the database used to resolve its process and harness identity.
    const resumedPtyId = (database.connection.prepare('select pty_process_id from processes where id = ?').get(resumedAgent.process_id) as { pty_process_id: string }).pty_process_id;
    await waitFor(
      () => terminalRequests.some((request) => request.method === 'terminal.process.input' && request.params.process_id === resumedPtyId),
      'resumed agent receives its initial prompt before database teardown'
    );
    const resumedInput = terminalRequests.find((request) => request.method === 'terminal.process.input' && request.params.process_id === resumedPtyId);
    assert.match(String(resumedInput?.params.text), /^Continue the prior work/);
    assert.equal(resumedInput?.params.submit, true);

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

function lastRequest(requests: Array<{ method: string; params: Record<string, unknown> }>, method: string): Record<string, unknown> {
  const request = requests.filter((candidate) => candidate.method === method).at(-1);
  assert.ok(request, `${method} was requested`);
  return request.params;
}

function claudeAppendSystemPrompt(args: string[]): string {
  const index = args.indexOf('--append-system-prompt');
  assert.notEqual(index, -1, 'claude args include appended system prompt');
  return args[index + 1] ?? '';
}

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

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(label);
}
