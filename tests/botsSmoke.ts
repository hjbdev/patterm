import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSingleEmoji } from '../app/Bots/BotAvatar';
import { botSettingsInput, purviewAllows, readBotSettings, type Bot } from '../app/Bots/BotSettings';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { AgentContextService } from '../app/Services/AgentContextService';
import { BOTS_PROJECT_ID, BotService } from '../app/Services/BotService';
import { DatabaseService } from '../app/Services/DatabaseService';
import type { HarnessResume, LaunchHarnessInput } from '../app/Services/HarnessLauncher';
import { SettingsService } from '../app/Services/SettingsService';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { botHidden, botRows, hiddenFromBot } from '../resources/js/lib/bots';
import { randomLook } from '../resources/js/lib/faces';
import type { ProjectWorkbench, SessionRecord } from '../resources/js/types';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';
import { removeTree } from './fixtures/TempTree';

const look = randomLook(1);
const bot = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id, name, presetId: 'preset_default_claude', avatar: { kind: 'face', look, emoji: null, picture: null }, purview: { kind: 'none' }, instructions: '', ...extra
});

async function main(): Promise<void> {
  // Avatars: one emoji, a small picture, and the kind's own field.
  assert.equal(isSingleEmoji('🦊'), true);
  assert.equal(isSingleEmoji('👩‍💻'), true, 'a joined emoji is one character');
  assert.equal(isSingleEmoji('🇬🇧'), true);
  assert.equal(isSingleEmoji('🦊🐙'), false);
  assert.equal(isSingleEmoji('A'), false);
  assert.equal(isSingleEmoji('hello'), false);
  const valid = { bots: [bot('b1', 'Fable', { avatar: { kind: 'emoji', look, emoji: '🦊', picture: null } })] };
  assert.equal(botSettingsInput.parse(valid).bots[0]?.avatar.emoji, '🦊');
  assert.throws(() => botSettingsInput.parse({ bots: [bot('b1', 'Fable', { avatar: { kind: 'emoji', look, emoji: null, picture: null } })] }), /choose an emoji/);
  assert.throws(() => botSettingsInput.parse({ bots: [bot('b1', 'Fable', { avatar: { kind: 'picture', look, emoji: null, picture: 'data:image/svg+xml;base64,PHN2Zz4=' } })] }), /PNG, JPEG or WebP/);
  assert.equal(botSettingsInput.parse({ bots: [bot('b1', 'Fable', { avatar: { kind: 'picture', look, emoji: null, picture: 'data:image/webp;base64,UklGRg==' } })] }).bots[0]?.avatar.kind, 'picture');
  assert.throws(() => botSettingsInput.parse({ bots: [bot('b1', 'Fable'), bot('b2', 'fable')] }), /already exists/);
  assert.throws(() => botSettingsInput.parse({ bots: [bot('b1', 'Fable', { purview: { kind: 'projects', projectIds: [] } })] }));
  // A bot this version can't read is left out, not every bot.
  assert.deepEqual(readBotSettings({ bots: [bot('b1', 'Fable'), { ...bot('b2', 'Odd'), avatar: { kind: 'hologram' } }] }).bots.map((item) => item.id), ['b1']);
  assert.deepEqual(readBotSettings('nonsense').bots, []);

  // Purview: none, chosen projects, or all.
  assert.equal(purviewAllows({ kind: 'none' }, 'p'), false);
  assert.equal(purviewAllows({ kind: 'all' }, 'p'), true);
  assert.equal(purviewAllows({ kind: 'projects', projectIds: ['p'] }, 'p'), true);
  assert.equal(purviewAllows({ kind: 'projects', projectIds: ['p'] }, 'q'), false);

  // Bots are told to text briefly, where they work, and that the user can't see their helpers.
  const context = new AgentContextService();
  const brief = context.buildBot({ name: 'Fable', instructions: 'Looks after the website.' }, [{ id: 'p', name: 'Website' }]);
  assert.match(brief, /You are Fable/);
  assert.match(brief, /text message: one to three short sentences/);
  assert.match(brief, /Website \(p\)/);
  assert.match(brief, /doesn't see your helpers/);
  assert.match(brief, /About you, from the user:\nLooks after the website\./);
  assert.match(context.buildBot({ name: 'Pal', instructions: '' }, 'none'), /no projects to work in/);
  assert.match(context.buildBot({ name: 'Pal', instructions: '' }, 'all'), /any of the user's workspace projects/);
  // OpenCode takes at most 8 KiB of instructions.
  assert.ok(context.buildBot({ name: 'x'.repeat(40), instructions: 'y'.repeat(2000) }, Array.from({ length: 50 }, (_, index) => ({ id: `project_${index}`, name: `Project ${index}` }))).length < 8192);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-bots-'));
  const database = new DatabaseService(dir);
  try {
    database.initialize();
    const db = database.connection;
    const now = new Date().toISOString();
    for (const id of ['p', 'q']) db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run(id, `Project ${id}`, dir, now, now);
    const settings = new SettingsService(database);
    const workbench = new WorkbenchRepository(database, settings);
    const timeline = new TimelineService(database);

    settings.updateBots({ bots: [bot('fable', 'Fable', { purview: { kind: 'projects', projectIds: ['p'] } }), bot('pal', 'Pal')] });
    assert.deepEqual(settings.bots().bots.map((item) => item.id), ['fable', 'pal']);

    // A fake launcher registers rows the way HarnessLauncher does.
    const launches: Array<{ input: LaunchHarnessInput; resume: HarnessResume | null }> = [];
    let sequence = 0;
    const register = (input: LaunchHarnessInput, resume: HarnessResume | null) => {
      launches.push({ input, resume });
      sequence += 1;
      const processId = `proc-bot-${sequence}`;
      db.prepare(`insert into processes(id,project_id,kind,name,status,created_at,updated_at) values(?,?,'agent',?,'running',?,?)`).run(processId, input.project_id, input.name ?? 'Bot', now, now);
      db.prepare(`insert into sessions(id,project_id,process_id,harness,interface_mode,session_role,bot_id,started_at,cwd,mcp_identity,resume_id) values(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(`session-bot-${sequence}`, input.project_id, processId, input.harness ?? 'claude', 'integrated', input.session_role, input.bot_id ?? null, new Date(Date.now() + sequence).toISOString(), input.cwd ?? dir, `mcp-bot-${sequence}`, resume?.resume_id ?? `thread-${sequence}`);
      return { session_id: `session-bot-${sequence}`, process_id: processId, pty_process_id: null, interface_mode: 'integrated' as const, harness: 'claude', name: input.name ?? 'Bot' };
    };
    let resumeFails = false;
    const launcher = {
      launch: async (input: LaunchHarnessInput) => register(input, null),
      resume: async (input: LaunchHarnessInput, resume: HarnessResume) => { if (resumeFails) throw new Error('thread is gone'); return register(input, resume); }
    };
    const stopped: string[] = [];
    const transferred: Array<{ from: readonly string[]; to: string }> = [];
    const stop = (processId: string) => {
      stopped.push(processId);
      db.prepare(`update processes set status = 'exited' where id = ?`).run(processId);
      db.prepare(`update sessions set exited_at = ? where process_id = ?`).run(new Date().toISOString(), processId);
      return Promise.resolve();
    };
    const unsaved = new Set<string>();
    const bots = new BotService(database, dir, launcher, settings, workbench, { stop, transferTimers: (from, to) => transferred.push({ from, to }) },
      { conversationSaved: (_harness, _cwd, resumeId) => !unsaved.has(resumeId) });

    // Every bot starts once, in its own folder in the hidden bots project.
    await Promise.all([bots.ensure('fable'), bots.ensure('fable')]);
    await bots.ensureAll();
    assert.deepEqual(launches.map((launch) => [launch.input.bot_id, launch.input.session_role, launch.input.interface_mode, launch.resume]), [['fable', 'bot', 'integrated', null], ['pal', 'bot', 'integrated', null]]);
    assert.equal(launches[0]!.input.project_id, BOTS_PROJECT_ID);
    assert.equal(launches[0]!.input.harness, 'claude');
    assert.ok(fs.statSync(launches[0]!.input.cwd!).isDirectory());
    assert.equal((db.prepare('select kind from projects where id = ?').get(BOTS_PROJECT_ID) as { kind: string }).kind, 'bots');
    assert.match(bots.context('fable'), /Project p \(p\)/);
    // The bots' project never joins the user's project lists, but the snapshot carries it.
    assert.deepEqual(workbench.listProjects().map((project) => project.id), ['p', 'q']);
    assert.ok(workbench.snapshot().projects.some((project) => project.project.id === BOTS_PROJECT_ID));
    assert.equal(workbench.snapshot().projects.find((project) => project.project.id === BOTS_PROJECT_ID)?.projectSessions.find((session) => session.processId === 'proc-bot-1')?.botId, 'fable');

    // After a restart the bot resumes its conversation, and its helpers follow it.
    db.prepare(`insert into processes(id,project_id,parent_process_id,kind,name,status,created_at,updated_at) values('proc-helper','p','proc-bot-1','agent','Helper','running',?,?)`).run(now, now);
    await stop('proc-bot-1');
    await bots.ensure('fable');
    assert.equal(launches.at(-1)!.resume?.resume_id, 'thread-1');
    assert.equal((db.prepare(`select parent_process_id from processes where id = 'proc-helper'`).get() as { parent_process_id: string }).parent_process_id, 'proc-bot-3');
    assert.deepEqual(transferred.at(-1), { from: ['proc-bot-1'], to: 'proc-bot-3' });
    // A conversation the CLI can't resume starts over.
    resumeFails = true;
    await stop('proc-bot-3');
    await bots.ensure('fable');
    assert.equal(launches.at(-1)!.resume, null);
    resumeFails = false;
    // A bot nobody messaged has no saved conversation, so it starts fresh.
    unsaved.add('thread-4');
    await stop('proc-bot-4');
    await bots.ensure('fable');
    assert.equal(launches.at(-1)!.resume, null);
    // A new conversation skips resuming.
    await bots.restart('fable', true);
    assert.equal(launches.at(-1)!.resume, null);
    assert.equal(stopped.at(-1), 'proc-bot-5');
    // Removing a bot stops its session.
    settings.updateBots({ bots: [settings.bots().bots[0]!] });
    await bots.reconcile();
    assert.ok(stopped.includes('proc-bot-2'));
    assert.equal(bots.state('pal').process_id, null);
    // A bot whose profile is gone doesn't start.
    settings.updateBots({ bots: [...settings.bots().bots, bot('lost', 'Lost', { presetId: 'preset_gone' })] });
    await assert.rejects(bots.ensure('lost'), /profile no longer exists/);

    // Bots reach only the projects their purview names, through every scoped tool.
    const registry = createTestMcpRegistry({ tempDir: dir, database, timeline, terminal: { request: async () => ({}) } as unknown as TerminalService, workbench, bots });
    const fable = { identity: (db.prepare(`select mcp_identity from sessions where bot_id = 'fable' and exited_at is null`).get() as { mcp_identity: string }).mcp_identity };
    db.prepare(`insert into processes(id,project_id,kind,name,status,created_at,updated_at) values('proc-q','q','agent','Other','running',?,?)`).run(now, now);
    const listed = await registry.callPublic('list_processes', { project_id: 'p' }, fable) as { processes: Array<{ process_id: string }> };
    assert.ok(Array.isArray(listed.processes), 'its own project lists');
    await assert.rejects(registry.callPublic('list_processes', { project_id: 'q' }, fable), /outside this bot's projects/);
    await assert.rejects(registry.callPublic('get_process_status', { process_id: 'proc-q' }, fable), /outside this bot's projects/);
    await assert.rejects(registry.callPublic('todo_list', { project_id: 'q' }, fable), /outside this bot's projects/);
    await registry.callPublic('todo_list', { project_id: 'p' }, fable);
    const overview = await registry.callPublic('get_project_status', {}, fable) as { projects: Array<{ project_id: string }> };
    assert.deepEqual(overview.projects.map((project) => project.project_id), ['p']);
    await assert.rejects(registry.callPublic('spawn_agent', { agent: 'claude', project_id: 'q' }, fable), /outside this bot's projects/);
  } finally {
    database.dispose();
    removeTree(dir);
  }

  // The renderer leaves a bot's conversation and helpers out of agent lists,
  // finds its helpers across projects, and surfaces one waiting on the user.
  const session = (id: string, extra: Partial<SessionRecord>): SessionRecord => ({
    id, parentId: null, parentProcessId: null, processId: `proc-${id}`, ptyProcessId: null, worktreeId: null, harness: 'claude', interfaceMode: 'integrated',
    sessionRole: 'orchestrator', resumeStatus: 'unknown', activity: 'idle', startedAt: '2026-10-29T10:00:00.000Z', exitedAt: null, lastTitle: null, ...extra
  } as SessionRecord);
  const workbenchOf = (id: string, sessions: SessionRecord[], processes: ProjectWorkbench['processes'] = []): ProjectWorkbench => ({
    project: { id, name: id, path: '/tmp', kind: id === BOTS_PROJECT_ID ? 'bots' : 'workspace' }, projectSessions: sessions, processes, worktrees: [], timers: []
  } as unknown as ProjectWorkbench);
  const botsProject = workbenchOf(BOTS_PROJECT_ID, [session('bot', { sessionRole: 'bot', botId: 'fable', activity: 'idle', summary: { status: 'Watching the deploy', text: '', generatedAt: '', provider: '', model: '' } })]);
  const projects = [
    workbenchOf('p', [
      session('helper', { sessionRole: 'child', parentProcessId: 'proc-bot', activity: 'working' }),
      session('deep', { sessionRole: 'child', parentId: 'helper', parentProcessId: 'proc-helper', activity: 'question', asking: 'Deploy to production?' }),
      session('mine', {})
    ], [{ id: 'proc-server', parentProcessId: 'proc-helper' } as ProjectWorkbench['processes'][number]])
  ];
  const hidden = botHidden(projects, botsProject);
  assert.deepEqual([...hidden.sessions].sort(), ['bot', 'deep', 'helper']);
  assert.ok(hidden.processes.has('proc-server'), 'a helper\'s server stays out of view too');
  assert.equal(botHidden(projects, null).sessions.size, 0);
  const [row] = botRows({ bots: [bot('fable', 'Fable')] }, projects, botsProject);
  assert.equal(row!.session?.id, 'bot');
  assert.equal(row!.activity?.subagents.working, 1);
  assert.equal(row!.waitingHelper?.id, 'deep');
  assert.equal(row!.waitingHelperProjectId, 'p');
  assert.equal(row!.line, 'A helper is waiting: Deploy to production?');
  assert.equal(botRows({ bots: [bot('fable', 'Fable')] }, [], botsProject)[0]!.line, 'Watching the deploy');
  assert.equal(botRows({ bots: [bot('new', 'New')] }, projects, botsProject)[0]!.session, null);
  // Helpers' reports and Patterm's notes stay out of a bot's conversation.
  for (const text of ['[report from process_7: completed]\nDone', '[message from process_7]\nhi', '[Patterm timer t1: condition met]', '[Attention needed by process_7]', '[Close requested by process_7]\nall done']) {
    assert.equal(hiddenFromBot(text), true, text);
  }
  assert.equal(hiddenFromBot('Can you check the deploy?'), false);

  console.log('botsSmoke: ok');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
