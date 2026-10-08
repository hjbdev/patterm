import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import { AutoSummaryService, conversationSummaryText, ownerMessages, summarySnapshot, type IntegratedSummarySource } from '../app/Services/AutoSummaryService';
import { AutoSummaryRunner, claudeSummaryArgs, codexSummaryArgs, runSummaryCommand, summaryEnvironment } from '../app/Services/AutoSummaryRunner';
import { autoSummarySettingsInput, summaryResult, SUMMARY_SYSTEM_PROMPT, SUMMARY_TEST_SYSTEM_PROMPT, type SummaryContext } from '../app/Services/AutoSummarySettings';
import type { TerminalService } from '../app/Services/TerminalService';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { HistoryDatabaseService } from '../app/Services/HistoryDatabaseService';
import { SecretRedactor } from '../app/Services/AgentHistory/SecretRedactor';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-summary-test-'));
  const database = new DatabaseService(directory);
  database.initialize();
  const settings = new SettingsService(database);
  let now = 0;
  let calls = 0;
  let lastMode: 'summary' | 'test' | undefined;
  let lastInput = '';
  let lastContext: SummaryContext | undefined;
  let snapshots = 0;
  let output = 'The build completed successfully. All forty regression tests passed.';
  let snapshotGate: Promise<void> | null = null;
  let run: (signal: AbortSignal) => Promise<string> = async () => 'Build and tests passed.';
  let frameListener: Parameters<TerminalService['onFrame']>[0] | undefined;
  const terminal = {
    onFrame(listener: Parameters<TerminalService['onFrame']>[0]) { frameListener = listener; return () => { frameListener = undefined; }; },
    async request(method: string, params: Record<string, unknown>) {
      assert.equal(method, 'terminal.process.output');
      assert.equal(params.max_lines, 100);
      snapshots++;
      await snapshotGate;
      return { screen: output };
    }
  } as Pick<TerminalService, 'request' | 'onFrame'>;
  const service = new AutoSummaryService(database, settings, terminal, {
    availability: () => ({ available: true, reason: null }),
    async run(_settings, text, signal, mode, context) {
      calls++;
      lastMode = mode;
      lastInput = text;
      lastContext = context;
      assert.ok(Buffer.byteLength(text) <= 12 * 1024);
      return run(signal);
    }
  }, () => {}, () => now);
  const db = database.connection;
  const add = (id: string, parent: string | null = null) => db.prepare(`insert into processes
    (id,project_id,parent_process_id,kind,name,status,activity,pty_process_id,created_at,updated_at)
    values (?, 'project', ?, 'agent', ?, 'running', 'idle', ?, 'now', 'now')`).run(id, parent, id, id);
  const recap = (id: string) => db.prepare('select auto_summary, auto_summary_provider, auto_summary_model from processes where id = ?').get(id) as Record<string, unknown>;
  try {
    db.exec("insert into projects(id,name,path,created_at,updated_at) values('project','Test','/tmp','now','now')");
    add('root'); add('child', 'root');
    assert.equal(settings.autoSummarySettings().enabled, false);
    assert.equal(settings.autoSummarySettings().models.claude, 'haiku');
    assert.equal(settings.autoSummarySettings().models.codex, 'gpt-5.6-luna');
    assert.throws(() => autoSummarySettingsInput.parse({ intervalSeconds: 1 }));
    assert.deepEqual(settings.autoSummarySettings().reasoning, { claude: null, codex: 'low' });
    assert.throws(() => autoSummarySettingsInput.parse({ reasoning: { claude: '--dangerously-skip-permissions' } }), 'reasoning levels cannot be flags');
    assert.throws(() => summaryResult.parse({ summary: 'x', command: 'run me' }));
    assert.throws(() => summaryResult.parse({ summary: 'x'.repeat(601) }));
    service.start();
    service.userInput('root'); now = 100_000; service.tick(); await flush();
    assert.equal(calls, 0, 'off by default');
    const enabled = { ...settings.autoSummarySettings(), enabled: true };
    service.update(enabled);
    service.tick(); await flush();
    assert.equal(calls, 0, 'requires human input');
    service.userInput('child'); now += 2000; service.tick(); await flush();
    assert.equal(calls, 0, 'child processes are excluded');
    service.userInput('root'); now += 1999; service.tick(); await flush();
    assert.equal(calls, 0, 'quiet window');
    now++; service.tick(); await flush();
    assert.equal(calls, 1);
    assert.deepEqual({ ...recap('root') }, { auto_summary: 'Build and tests passed.', auto_summary_provider: 'claude', auto_summary_model: 'haiku' });
    db.exec("insert into sessions(id,project_id,process_id,harness,session_role,started_at) values ('session','project','root','claude','orchestrator','now')");
    const workbench = new WorkbenchRepository(database);
    assert.equal(workbench.snapshot().projects[0]?.projectSessions[0]?.summary?.text, 'Build and tests passed.');
    add('shell');
    db.exec("update processes set kind = 'shell', auto_summary = 'Server ready.', auto_summary_at = 'now', auto_summary_provider = 'claude', auto_summary_model = 'haiku' where id = 'shell'");
    assert.equal(workbench.snapshot().projects[0]?.processes.find((item) => item.id === 'shell')?.summary?.text, 'Server ready.');
    now += 29_999; service.tick(); await flush(); assert.equal(snapshots, 1, 'minimum interval');
    now++; service.tick(); await flush(); assert.equal(calls, 1, 'unchanged snapshot');
    output = 'short'; now += 30_000; service.tick(); await flush(); assert.equal(calls, 1, 'trivial output');
    output = 'A different build is running and compiling a large number of modules.';
    db.exec("update processes set activity = 'permission' where id = 'root'");
    now += 30_000; service.tick(); await flush(); assert.equal(calls, 1, 'permission prompts are not summarised');
    db.exec(`insert into external_references(id,project_id,url,provider,resource_type,identifier,title,created_at,updated_at)
        values ('ref','project','https://linear.app/x/PAT-12','linear','issue','PAT-12','Release hygiene','now','now');
      insert into session_references values ('session','ref');
      insert into todos(id,project_id,title,status,created_at,updated_at,created_by_actor) values ('todo','project','Ship licence','in_progress','now','now','user');
      insert into todo_assignments(todo_id,assignee_id,session_id) values ('todo','session','session');
      update processes set activity = 'working' where id = 'root'`);
    service.tick(); await flush(); assert.equal(calls, 2, 'continuous output gets periodic summaries');
    assert.deepEqual(lastContext, { thread_name: 'root', references: ['PAT-12: Release hygiene'], todos: ['Ship licence (in progress)'],
      user_messages: [], previous_summary: 'Build and tests passed.' }, 'the recap builds on the last one and the thread\'s goal');

    // A terminal agent's own messages come from imported history.
    const history = new HistoryDatabaseService(directory);
    history.initialize();
    history.connection.prepare(`insert into conversations(id,provider,session_id,status,created_at,imported_at)
      values ('conversation','claude','session','imported','now','now')`).run();
    const message = history.connection.prepare(`insert into conversation_messages(id,conversation_id,seq,role,kind,text,created_at)
      values (?, 'conversation', ?, ?, ?, ?, 'now')`);
    message.run('m1', 1, 'user', 'message', 'Make recaps say what the thread is for');
    message.run('m2', 2, 'assistant', 'message', 'On it.');
    message.run('m3', 3, 'user', 'tool_result', 'tool output');
    // Agent reports share the owner's role; a long run of them must not hide a later change of direction.
    for (let seq = 4; seq < 200; seq++) message.run(`r${seq}`, seq, 'user', 'message', `[report from process_9: completed]\nStep ${seq}`);
    message.run('m200', 200, 'user', 'message', 'Now also cover the feed recap');
    message.run('m201', 201, 'user', 'message', 'ANTHROPIC_API_KEY=sk-ant-' + 'a'.repeat(60));
    db.prepare("update external_references set title = ? where id = 'ref'").run('Leaked sk-' + 'b'.repeat(40));
    const withHistory = new AutoSummaryService(database, settings, terminal, { availability: () => ({ available: true, reason: null }), run: async () => '' },
      () => {}, () => now, null, history);
    const context = (withHistory as unknown as { context(id: string, conversation: unknown): SummaryContext }).context('root', null);
    const messages = context.user_messages!;
    assert.equal(messages.length, 3);
    assert.equal(messages[0], 'Make recaps say what the thread is for');
    assert.equal(messages[1], 'Now also cover the feed recap', 'owner messages after many agent reports are found');
    assert.ok(!messages[2]!.includes('a'.repeat(60)), 'owner messages are redacted');
    assert.ok(!context.references![0]!.includes('b'.repeat(40)), 'metadata is redacted too');
    history.dispose();
    // A missing history database leaves the recap to the other context.
    const missing = new HistoryDatabaseService(path.join(directory, 'absent'), { mode: 'read' });
    missing.initialize({ migrate: false });
    const withoutHistory = new AutoSummaryService(database, settings, terminal, { availability: () => ({ available: true, reason: null }), run: async () => '' },
      () => {}, () => now, null, missing);
    assert.deepEqual((withoutHistory as unknown as { context(id: string, conversation: unknown): SummaryContext }).context('root', null).user_messages, []);

    // A rejected request backs off and never persists provider diagnostics.
    output += ' More output.';
    run = async () => { throw new Error('secret provider diagnostic'); };
    now += 30_000; service.tick(); await flush(); assert.equal(calls, 3);
    assert.ok(!JSON.stringify(service.status()).includes('secret provider'));
    now += 30_000; service.tick(); await flush(); assert.equal(calls, 3, 'failure backoff');
    now += 30_000; service.tick(); await flush(); assert.equal(calls, 4);

    // Eligibility can change while the sidecar is preparing the snapshot.
    service.update(enabled);
    service.userInput('root');
    db.exec("update processes set activity = 'idle' where id = 'root'");
    now += 2000;
    let releaseSnapshot!: () => void;
    snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    service.tick();
    const callsBeforePermission = calls;
    db.exec("update processes set activity = 'permission' where id = 'root'");
    releaseSnapshot(); await flush();
    assert.equal(calls, callsBeforePermission, 'recheck permission state after awaiting the snapshot');
    snapshotGate = null;
    db.exec("update processes set activity = 'working' where id = 'root'");

    run = async () => 'patterm okay';
    const snapshotsBeforeTest = snapshots;
    assert.deepEqual(await service.test(enabled), { ok: true });
    assert.equal(lastMode, 'test');
    assert.equal(lastInput, 'patterm okay', 'synthetic data contains no test instructions');
    assert.equal(snapshots, snapshotsBeforeTest, 'connection test never reads terminal output');
    run = async () => 'unexpected';
    await assert.rejects(service.test(enabled), /expected phrase/);

    // Two global jobs, one per process; cancellation discards even a late success.
    db.exec("update processes set activity = 'idle' where id = 'root'");
    service.update(enabled);
    const releases: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    run = (signal) => new Promise((resolve) => { signals.push(signal); releases.push(() => resolve('Late summary.')); });
    add('second'); add('third');
    for (const id of ['root', 'second', 'third']) service.userInput(id);
    now += 2000; service.tick(); await flush();
    assert.equal(service.status().inFlight, 2);
    service.tick(); await flush(); assert.equal(signals.length, 2);
    service.update({ ...enabled, enabled: false });
    assert.ok(signals.every((signal) => signal.aborted));
    releases.splice(0).forEach((release) => release()); await flush();
    assert.equal(recap('second').auto_summary, null);
    assert.equal(recap('root').auto_summary, 'Build and tests passed.');
    service.update(enabled); service.userInput('root'); now += 2000; service.tick(); await flush();
    assert.equal(signals.at(-1)?.aborted, false);
    frameListener?.({ type: 'terminal-lifecycle', processId: 'root', event: 'activity', activity: 'permission' } as Parameters<NonNullable<typeof frameListener>>[0]);
    assert.equal(signals.at(-1)?.aborted, true, 'permission transition cancels an in-flight runner');
    releases.splice(0).forEach((release) => release()); await flush();
    assert.equal(recap('root').auto_summary, 'Build and tests passed.');
    service.update(enabled); service.userInput('root'); now += 2000; service.tick(); await flush();
    assert.equal(signals.at(-1)?.aborted, false);
    frameListener?.({ type: 'terminal-lifecycle', processId: 'root', event: 'exit' } as Parameters<NonNullable<typeof frameListener>>[0]);
    assert.equal(signals.at(-1)?.aborted, true);
    releases.splice(0).forEach((release) => release()); await flush();
    service.userInput('root'); now += 2000; service.tick(); await flush();
    const disposed = service.dispose();
    assert.equal(signals.at(-1)?.aborted, true);
    releases.splice(0).forEach((release) => release()); await disposed;
    assert.equal(frameListener, undefined);

    // Integrated agents have no PTY: UI prompts make them eligible and the
    // visible transcript, without reasoning or subagent rows, is summarised.
    add('integrated');
    db.exec("update processes set pty_process_id = null where id = 'integrated'");
    db.exec(`insert into sessions(id,project_id,process_id,harness,session_role,interface_mode,started_at)
      values ('integrated-session','project','integrated','codex','orchestrator','integrated','now')`);
    // Providers wrap rows as { data: [...] }, as the renderer reads them.
    const conversation = { messages: { data: [
      { id: '1', role: 'user', kind: 'text', text: 'Fix the failing parser test.' },
      { id: '2', role: 'assistant', kind: 'reasoning', text: 'private reasoning' },
      { id: '3', role: 'assistant', kind: 'tool', text: '', title: 'Bash', tool: { name: 'Bash', input: { command: 'pnpm test', description: 'Run the tests' } } },
      { id: '4', role: 'assistant', kind: 'text', text: 'Subagent detail', parentId: '3' },
      { id: '5', role: 'assistant', kind: 'text', text: 'The parser test passes now.' }
    ] } };
    const expected = 'User: Fix the failing parser test.\nTool: Bash: Run the tests\nAssistant: The parser test passes now.';
    assert.equal(conversationSummaryText(conversation), expected);
    assert.equal(conversationSummaryText({ messages: conversation.messages.data }), expected, 'a bare row array is accepted too');
    assert.equal(conversationSummaryText(null), '');
    assert.deepEqual(ownerMessages(['Fix the login bug', '/compact', '<command-name>/clear</command-name>', '[report from process_2: completed]\nDone',
      '[message from process_3]\nHi', '[Patterm timer t: condition met]', '[Attention requested by process_4 (Child)]\nPick one',
      '[Failure reported by process_5 (Child)]', '[Attention needed by process_6 (Child)]', ' Fix the login bug ', 'Also the logout one']),
    ['Fix the login bug', 'Also the logout one'], 'only the owner\'s own messages, once each');
    const many = ownerMessages(Array.from({ length: 30 }, (_, i) => `message ${i} ${'x'.repeat(2000)}`));
    assert.deepEqual(many.map((text) => text.split(' ')[1]), ['0', '1', '22', '23', '24', '25', '26', '27', '28', '29'], 'the first two and last eight');
    assert.deepEqual(many.map((text) => text.length), [1500, ...Array(9).fill(500)]);
    const key = `Use this key\n-----BEGIN PRIVATE KEY-----\n${'k'.repeat(3000)}\n-----END PRIVATE KEY-----`;
    assert.ok(!ownerMessages([key], (text) => new SecretRedactor().redact(text).text)[0]!.includes('kkkk'), 'redaction runs before the cut');
    let conversationListener: Parameters<IntegratedSummarySource['onConversationEvent']>[0] | undefined;
    const source: IntegratedSummarySource = {
      async conversation(id) { assert.equal(id, 'integrated'); return conversation; },
      onConversationEvent(listener) { conversationListener = listener; return () => { conversationListener = undefined; }; }
    };
    const inputs: string[] = [];
    const integratedService = new AutoSummaryService(database, settings, terminal, {
      availability: () => ({ available: true, reason: null }),
      async run(_settings, text) { inputs.push(text); return 'Parser test fixed.'; }
    }, () => {}, () => now, source);
    integratedService.start();
    assert.ok(conversationListener);
    now += 2000; integratedService.tick(); await flush();
    assert.equal(inputs.length, 0, 'Integrated agents also require user input');
    integratedService.userInput('integrated'); now += 2000; integratedService.tick(); await flush();
    assert.deepEqual(inputs, [expected]);
    assert.equal(recap('integrated').auto_summary, 'Parser test fixed.');
    await integratedService.dispose();
    assert.equal(conversationListener, undefined);

    const runner = new AutoSummaryRunner(database, process.env);
    assert.equal(runner.availability('claude').available, false);
    assert.equal(runner.availability('codex').available, false);
    const gated = new AutoSummaryService(database, settings, terminal, runner, () => {});
    assert.throws(() => gated.update({ ...enabled, provider: 'codex' }), /not discovered/);
    await gated.dispose();
    await assert.rejects(runner.run({ ...enabled, provider: 'opencode' }, 'test', new AbortController().signal), /not discovered/);
    const fixture = path.join(directory, 'claude');
    fs.copyFileSync(path.resolve('tests/fixtures/summaryCli.cjs'), fixture);
    fs.chmodSync(fixture, 0o700);
    db.prepare("insert into harness_installations values ('fake', 'claude', ?, 'fixture', 'available', 'now', 'now')").run(fixture);
    assert.equal(await runner.run(enabled, 'synthetic terminal text', new AbortController().signal), 'patterm okay');
    const testSettings = { ...enabled, models: { ...enabled.models, claude: 'health-check' } };
    const health = new AutoSummaryService(database, settings, terminal, runner, () => {});
    assert.deepEqual(await health.test(testSettings), { ok: true });
    await health.dispose();
    const testArgs = claudeSummaryArgs('haiku', 'test');
    const normalArgs = claudeSummaryArgs('haiku');
    const promptIndex = normalArgs.indexOf('--system-prompt') + 1;
    assert.equal(testArgs[promptIndex], SUMMARY_TEST_SYSTEM_PROMPT);
    assert.equal(normalArgs[promptIndex], SUMMARY_SYSTEM_PROMPT);
    testArgs[promptIndex] = normalArgs[promptIndex]!;
    assert.deepEqual(testArgs, normalArgs, 'connection test keeps all summary isolation flags');
    for (const model of ['bad-json', 'bad-schema', 'error']) {
      await assert.rejects(runner.run({ ...enabled, models: { ...enabled.models, claude: model } }, 'synthetic', new AbortController().signal), /Summari[sz]|Summary/);
    }
    const providerFixture = path.join(directory, 'summary-providers');
    fs.copyFileSync(path.resolve('tests/fixtures/summaryProviders.cjs'), providerFixture);
    fs.chmodSync(providerFixture, 0o700);
    const codexHome = path.join(directory, 'native-codex');
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
    fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'Must not reach the summariser');
    const providers = new AutoSummaryRunner(database, { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: 'must-not-leak', PATTERM_PROCESS_ID: 'must-not-leak' });
    for (const provider of ['codex', 'opencode'] as const) {
      db.prepare("insert into harness_installations values (?, ?, ?, 'fixture', 'available', 'now', 'now')").run(provider, provider, providerFixture);
      assert.equal(providers.availability(provider).available, true);
      const providerSettings = { ...enabled, provider };
      const providerService = new AutoSummaryService(database, settings, terminal, providers, () => {});
      try {
        assert.equal(providerService.update(providerSettings).enabled, true);
        assert.deepEqual(await providerService.test(providerSettings), { ok: true });
        assert.equal(await providers.run(providerSettings, 'synthetic terminal output', new AbortController().signal), 'patterm okay');
        for (const model of ['bad-json', 'bad-schema', 'error']) {
          await assert.rejects(providers.run({ ...providerSettings, models: { ...providerSettings.models, [provider]: model } }, 'synthetic', new AbortController().signal), /Summari[sz]|Summary/);
        }
      } finally { await providerService.dispose(); }
    }
    const newer = { ...enabled, provider: 'codex' as const, models: { ...enabled.models, codex: 'newer-model' } };
    assert.equal(await providers.run(newer, 'synthetic', new AbortController().signal), 'patterm okay', 'models missing from the bundled catalogue use the refreshed one');
    await assert.rejects(providers.run({ ...newer, models: { ...newer.models, codex: 'unknown-model' } }, 'synthetic', new AbortController().signal), /not in this Codex build/);
    assert.equal(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'), '{}', 'native login survives temporary-home cleanup');
    const env = summaryEnvironment({ HOME: directory, PATH: process.env.PATH, ANTHROPIC_API_KEY: 'secret', PATTERM_PROCESS_ID: 'child', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', NODE_OPTIONS: '--require evil' });
    assert.equal(env.HOME, directory);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.PATTERM_PROCESS_ID, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    const args = claudeSummaryArgs('haiku');
    assert.equal(args.includes('--effort'), false, 'no reasoning keeps the model default');
    const effortArgs = claudeSummaryArgs('sonnet', 'summary', 'low');
    assert.equal(effortArgs[effortArgs.indexOf('--effort') + 1], 'low');
    assert.ok(codexSummaryArgs('gpt-5.6-luna', directory, 'low').includes('model_reasoning_effort="low"'));
    assert.equal(codexSummaryArgs('gpt-5.6-luna', directory).some((arg) => arg.startsWith('model_reasoning_effort')), false);
    assert.equal(args.includes('--bare'), false);
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]!).disableAllHooks, true);
    const command = (code: string, signal = new AbortController().signal) => runSummaryCommand(process.execPath, ['-e', code], 'synthetic input', directory, env, signal);
    assert.equal(await command("process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('okay'))"), 'okay');
    await assert.rejects(command("process.stdout.write('x'.repeat(17000))"), /exceeded/);
    await assert.rejects(command("process.stderr.write('secret'); process.exit(1)"), /unsuccessfully/);
    const cancelled = new AbortController();
    const hung = command('setInterval(() => {}, 1000)', cancelled.signal);
    cancelled.abort(); await assert.rejects(hung, /cancelled/);
    await assert.rejects(command('process.exit(0)', cancelled.signal), /cancelled/);

    const unicode = summarySnapshot('🙂'.repeat(20_000));
    assert.ok(Buffer.byteLength(unicode) <= 12 * 1024);
    assert.equal(unicode.includes('\ufffd'), false);
    assert.equal(Array.from(unicode).every((point) => point === '🙂'), true);
    assert.equal(summarySnapshot(Array.from({ length: 200 }, (_, i) => `row ${i}`).join('\n')).split('\n').length, 100);
    assert.equal(summarySnapshot('\u001b[31mhello\u001b[0m'), 'hello');
    assert.equal(summarySnapshot('ANTHROPIC_API_KEY=sk-ant-' + 'a'.repeat(60)).includes('a'.repeat(60)), false);
    console.log('auto-summary smoke tests passed');
  } finally {
    await service.dispose(); database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
