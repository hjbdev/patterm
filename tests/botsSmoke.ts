import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSingleEmoji } from '../app/Bots/BotAvatar';
import { ASSISTANT_BOT_ID, botInput, botSettingsInput, purviewAllows, readBotSettings, type Bot } from '../app/Bots/BotSettings';
import { ASSISTANT_PROJECT_ID } from '../app/Services/AssistantProject';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { AgentContextService } from '../app/Services/AgentContextService';
import { BotService, botProjectId } from '../app/Services/BotService';
import { BROWSER_TOOLS, INTEGRATED_CONTROL_TOOLS } from '../app/Http/BrowserTools';
import type { AgentHistoryReadService } from '../app/Services/AgentHistory/AgentHistoryReadService';
import { DatabaseService } from '../app/Services/DatabaseService';
import type { HarnessResume, LaunchHarnessInput } from '../app/Services/HarnessLauncher';
import { SettingsService } from '../app/Services/SettingsService';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { assistantLine, assistantRow, botHidden, botHomeProjectId, botLine, botLinkTarget, botRows, botShownIn, hiddenFromBot, isGlobalBot } from '../resources/js/lib/bots';
import { randomLook } from '../resources/js/lib/faces';
import type { ProjectWorkbench, SessionRecord } from '../resources/js/types';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';
import { removeTree } from './fixtures/TempTree';

const look = randomLook(1);
const bot = (id: string, name: string, extra: Partial<Bot> = {}): Bot => botInput.parse({
  id, name, presetId: 'preset_default_claude', avatar: { kind: 'face', look, emoji: null, picture: null }, purview: { kind: 'none' }, instructions: '', memory: true, ...extra
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
  assert.deepEqual(readBotSettings({ bots: [bot('b1', 'Fable'), { ...bot('b2', 'Odd'), avatar: { kind: 'hologram' } }] }).bots.map((item) => item.id), [ASSISTANT_BOT_ID, 'b1']);
  // The assistant is always there and leads the list.
  assert.deepEqual(readBotSettings('nonsense').bots.map((item) => item.id), [ASSISTANT_BOT_ID]);
  const seeded = readBotSettings({}).bots[0]!;
  assert.equal(seeded.name, 'Assistant');
  assert.equal(seeded.avatar.kind, 'mark');
  assert.deepEqual(seeded.purview, { kind: 'all' });
  assert.equal(seeded.voice.enabled, true);
  assert.equal(seeded.digests, true);
  assert.equal(seeded.focus, true);
  // Its settings from before it was a bot carry over.
  const legacySettings = { enabled: false, voice: 'cove', presetId: 'preset_codex_fast', forwardNotifications: false, voiceProfile: 'patterm', voiceAcknowledgements: 'off', userName: 'Sam', memoryEnabled: true, memoryBudgetTokens: 8000 };
  const legacy = readBotSettings({}, legacySettings);
  assert.equal(legacy.userName, 'Sam');
  assert.deepEqual({ ...legacy.bots[0]!, avatar: undefined }, { ...seeded, avatar: undefined, enabled: false, presetId: 'preset_codex_fast', memory: true, memoryBudgetTokens: 8000, digests: false, voice: { enabled: true, voice: 'cove', profile: 'patterm', acknowledgements: 'off' } });
  // Saved bots win over the legacy settings, and the assistant always sees every project.
  const saved = readBotSettings({ bots: [bot('b1', 'Fable'), { ...seeded, name: 'Jarvis', purview: { kind: 'none' } }], userName: null }, legacySettings);
  assert.deepEqual(saved.bots.map((item) => item.name), ['Jarvis', 'Fable']);
  assert.deepEqual(saved.bots[0]!.purview, { kind: 'all' });
  assert.equal(saved.userName, null);
  // Bots saved before these options read with them off.
  const older = readBotSettings({ bots: [{ id: 'b1', name: 'Fable', presetId: 'preset_default_claude', avatar: { kind: 'face', look, emoji: null, picture: null }, purview: { kind: 'none' }, instructions: '', memory: true }] }).bots[1]!;
  assert.deepEqual([older.enabled, older.voice.enabled, older.digests, older.focus, older.memoryBudgetTokens], [true, false, false, false, 4000]);

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
  // OpenCode takes at most 8 KiB of JSON-encoded instructions, so long
  // project lists and About notes are cut to fit, multi-byte text included.
  const crowded = context.buildBot({ name: 'x'.repeat(40), instructions: '日本語のメモ"\n'.repeat(250) }, Array.from({ length: 50 }, (_, index) => ({ id: `project_${'0123456789abcdef'.repeat(2)}${index}`, name: `A project with a fairly long descriptive name number ${index}` })));
  assert.ok(Buffer.byteLength(JSON.stringify(crowded), 'utf8') <= 8192);
  assert.ok(crowded.split('日本語のメモ').length - 1 < 250, 'the About note is cut to fit');
  const packed = context.buildBot({ name: 'Pal', instructions: '' }, Array.from({ length: 50 }, (_, index) => ({ id: `project_${'0123456789abcdef'.repeat(6)}${String(index).padStart(4, '0')}`, name: `${'A very long project name '.repeat(4)}${index}` })));
  assert.ok(Buffer.byteLength(JSON.stringify(packed), 'utf8') <= 8192);
  assert.match(packed, /and \d+ more; get_project_status without project_id lists them all/);
  assert.match(context.buildBot({ name: 'Pal', instructions: 'Short.' }, [{ id: 'p', name: 'Website' }]), /About you, from the user:\nShort\.$/);

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

    // Leaving the assistant out keeps it: it can't be deleted.
    settings.updateBots({ bots: [bot('fable', 'Fable', { purview: { kind: 'projects', projectIds: ['p'] } }), bot('pal', 'Pal')] });
    assert.deepEqual(settings.bots().bots.map((item) => item.id), [ASSISTANT_BOT_ID, 'fable', 'pal']);
    // Its purview stays every project, whatever is saved.
    settings.updateBots({ bots: [{ ...settings.bots().bots[0]!, purview: { kind: 'none' } }, ...settings.bots().bots.slice(1)] });
    assert.deepEqual(settings.bots().bots[0]!.purview, { kind: 'all' });
    // The assistant is off here until its own checks below.
    settings.updateBots({ bots: [{ ...settings.bots().bots[0]!, enabled: false }, ...settings.bots().bots.slice(1)] });
    assert.equal(settings.bots().bots[0]!.enabled, false);

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
    // A test can hold launches back.
    let gate: Promise<void> = Promise.resolve();
    let gateReached = false;
    const launcher = {
      launch: async (input: LaunchHarnessInput) => { gateReached = true; await gate; return register(input, null); },
      resume: async (input: LaunchHarnessInput, resume: HarnessResume) => { await gate; if (resumeFails) throw new Error('thread is gone'); return register(input, resume); }
    };
    const stopped: string[] = [];
    const transferred: Array<{ from: readonly string[]; to: string }> = [];
    // Fake timers: which process owns each, and which are held.
    const timerOwners = new Map<string, string>();
    const paused = new Set<string>();
    const events: string[] = [];
    const stop = (processId: string) => {
      stopped.push(processId);
      events.push(`stop ${processId}`);
      db.prepare(`update processes set status = 'exited' where id = ?`).run(processId);
      db.prepare(`update sessions set exited_at = ? where process_id = ?`).run(new Date().toISOString(), processId);
      return Promise.resolve();
    };
    const unsaved = new Set<string>();
    const bots = new BotService(database, dir, launcher, settings, workbench, {
      stop,
      transferTimers: (from, to) => {
        transferred.push({ from, to });
        for (const [id, owner] of timerOwners) if (from.includes(owner)) timerOwners.set(id, to);
      },
      holdTimers: (processId) => {
        const ids = [...timerOwners].filter(([id, owner]) => owner === processId && !paused.has(id)).map(([id]) => id);
        for (const id of ids) { paused.add(id); events.push(`hold ${id}`); }
        return ids;
      },
      releaseTimers: (ids) => { for (const id of ids) { paused.delete(id); events.push(`release ${id} to ${timerOwners.get(id)}`); } }
    },
      { conversationSaved: (_harness, _cwd, resumeId) => !unsaved.has(resumeId) });

    // Every bot starts once, in its own folder in the hidden bots project.
    await Promise.all([bots.ensure('fable'), bots.ensure('fable')]);
    await bots.ensureAll();
    assert.deepEqual(launches.map((launch) => [launch.input.bot_id, launch.input.session_role, launch.input.interface_mode, launch.resume]), [['fable', 'bot', 'integrated', null], ['pal', 'bot', 'integrated', null]]);
    // Each bot has its own hidden project, so agent scoping keeps bots apart.
    assert.equal(launches[0]!.input.project_id, botProjectId('fable'));
    assert.equal(launches[1]!.input.project_id, botProjectId('pal'));
    assert.equal(launches[0]!.input.harness, 'claude');
    assert.ok(fs.statSync(launches[0]!.input.cwd!).isDirectory());
    assert.deepEqual(db.prepare('select name, kind from projects where id = ?').get(botProjectId('fable')), { name: 'Fable', kind: 'bots' });
    assert.match(bots.context('fable'), /Project p \(p\)/);
    // The bots' project never joins the user's project lists, but the snapshot carries it.
    assert.deepEqual(workbench.listProjects().map((project) => project.id), ['p', 'q']);
    assert.equal(workbench.snapshot().projects.find((project) => project.project.id === botProjectId('fable'))?.projectSessions.find((session) => session.processId === 'proc-bot-1')?.botId, 'fable');

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
    settings.updateBots({ bots: [settings.bots().bots[1]!] });
    await bots.reconcile();
    assert.ok(stopped.includes('proc-bot-2'));
    assert.equal(bots.state('pal').process_id, null);
    // A bot whose profile is gone doesn't start, and an unknown one rejects.
    settings.updateBots({ bots: [...settings.bots().bots, bot('lost', 'Lost', { presetId: 'preset_gone' })] });
    await assert.rejects(bots.ensure('lost'), /profile no longer exists/);
    await assert.rejects(bots.ensure('nobody'), /unknown bot/);
    settings.updateBots({ bots: [settings.bots().bots[1]!] });

    const running = (botId: string) => (db.prepare(`select count(*) as count from sessions join processes on processes.id = sessions.process_id
      where sessions.bot_id = ? and sessions.exited_at is null and processes.status = 'running'`).get(botId) as { count: number }).count;
    // Restarts that overlap still leave one session.
    await Promise.all([bots.restart('fable'), bots.restart('fable'), bots.ensure('fable')]);
    assert.equal(running('fable'), 1);
    // A restart naming a process that's no longer the bot's is refused.
    const live = bots.state('fable').process_id!;
    await assert.rejects(bots.restart('fable', false, 'proc-stale'), /already restarted/);
    await assert.rejects(bots.restartProcess('proc-q-none'), /not a bot/);
    await bots.restartProcess(live);
    assert.notEqual(bots.state('fable').process_id, live);
    assert.equal(running('fable'), 1);
    // A bot removed while it starts is stopped once the start finishes.
    let release!: () => void;
    gate = new Promise((resolve) => { release = resolve; });
    gateReached = false;
    settings.updateBots({ bots: [...settings.bots().bots, bot('late', 'Late')] });
    const starting = bots.ensure('late');
    // Let the launch begin before the bot is removed.
    while (!launches.some((launch) => launch.input.bot_id === 'late') && !gateReached) await new Promise((resolve) => setImmediate(resolve));
    settings.updateBots({ bots: [settings.bots().bots[1]!] });
    const reconciled = bots.reconcile();
    release();
    gate = Promise.resolve();
    await starting;
    await reconciled;
    assert.equal(running('late'), 0);
    // A restart holds the bot's timers before its session stops, so none
    // fires into the gap, and releases them once the new session owns them.
    const before = bots.state('fable').process_id!;
    timerOwners.set('timer-1', before);
    events.length = 0;
    await bots.restart('fable');
    const after = bots.state('fable').process_id!;
    assert.deepEqual(events, ['hold timer-1', `stop ${before}`, `release timer-1 to ${after}`]);
    // At startup, a stopped bot's timers are held before the first await,
    // ahead of timers activating, until its new session adopts them.
    await stop(after);
    events.length = 0;
    const startup = bots.ensureAll();
    assert.deepEqual([...paused], ['timer-1'], 'held synchronously');
    await startup;
    assert.deepEqual(events, ['hold timer-1', `release timer-1 to ${bots.state('fable').process_id}`]);
    assert.equal(paused.size, 0);
    // New conversation on a stopped bot starts fresh; a running bot is left alone.
    await stop(bots.state('fable').process_id!);
    await bots.ensure('fable', true);
    assert.equal(launches.at(-1)!.resume, null);
    const count = launches.length;
    await bots.ensure('fable', true);
    assert.equal(launches.length, count);
    // Restarting a bot needs control of its conversation, like writing to it.
    assert.equal(INTEGRATED_CONTROL_TOOLS.has('bot_restart'), true);
    assert.equal(BROWSER_TOOLS.has('bot_restart'), false);
    assert.equal(BROWSER_TOOLS.has('bot_start'), true);

    // Bots reach only the projects their purview names, through every scoped tool.
    const conversations: Record<string, { projectId: string }> = { permitted: { projectId: 'p' }, elsewhere: { projectId: 'q' }, private: { projectId: botProjectId('other') } };
    const historyReadService = { get: (input: { conversation_id: string }) => ({ conversation: conversations[input.conversation_id] ?? null, messages: [] }) } as unknown as AgentHistoryReadService;
    const registry = createTestMcpRegistry({ tempDir: dir, database, timeline, terminal: { request: async () => ({}) } as unknown as TerminalService, workbench, bots, historyReadService });
    const fable = { identity: (db.prepare(`select mcp_identity from sessions where bot_id = 'fable' and exited_at is null`).get() as { mcp_identity: string }).mcp_identity };
    db.prepare(`insert into processes(id,project_id,kind,name,status,created_at,updated_at) values('proc-q','q','agent','Other','running',?,?)`).run(now, now);
    const listed = await registry.callPublic('list_processes', { project_id: 'p' }, fable) as { processes: Array<{ process_id: string }> };
    assert.ok(Array.isArray(listed.processes), 'its own project lists');
    await assert.rejects(registry.callPublic('list_processes', { project_id: 'q' }, fable), /outside this bot's projects/);
    await assert.rejects(registry.callPublic('get_process_status', { process_id: 'proc-q' }, fable), /outside the current caller scope/);
    await assert.rejects(registry.callPublic('todo_list', { project_id: 'q' }, fable), /outside this bot's projects/);
    await registry.callPublic('todo_list', { project_id: 'p' }, fable);
    const overview = await registry.callPublic('get_project_status', {}, fable) as { projects: Array<{ project_id: string }> };
    assert.deepEqual(overview.projects.map((project) => project.project_id), ['p']);
    await assert.rejects(registry.callPublic('spawn_agent', { agent: 'claude', project_id: 'q' }, fable), /outside this bot's projects/);
    // Helpers start only in a named project the bot works in, never in its
    // own hidden one, where the user couldn't open them.
    await assert.rejects(registry.callPublic('spawn_agent', { agent: 'claude' }, fable), /pass the project_id of one of this bot's projects/);
    await assert.rejects(registry.callPublic('spawn_agent', { agent: 'claude', project_id: botProjectId('fable') }, fable), /pass the project_id/);
    await assert.rejects(registry.callPublic('spawn_process', { argv: ['true'] }, fable), /pass the project_id/);
    // History reads follow the purview too.
    await registry.callPublic('history_get', { conversation_id: 'permitted' }, fable);
    await assert.rejects(registry.callPublic('history_get', { conversation_id: 'elsewhere' }, fable), /outside the caller project scope/);
    await assert.rejects(registry.callPublic('history_get', { conversation_id: 'private' }, fable), /outside the caller project scope/);
    // Reads that omit a project see only the bot itself, never every project.
    const own = await registry.callPublic('list_processes', {}, fable) as { processes: Array<{ process_id: string }> };
    assert.deepEqual(own.processes.map((process) => process.process_id), [bots.state('fable').process_id]);
    assert.equal('open_notifications' in overview, false);
    await registry.callPublic('todo_list', {}, fable);
    // Even with every project, a bot can't reach the assistant or another bot.
    settings.updateBots({ bots: [{ ...settings.bots().bots[1]!, purview: { kind: 'all' } }] });
    db.prepare(`insert into projects(id,name,path,kind,created_at,updated_at) values('project_assistant','Assistant',?, 'assistant',?,?), (?, 'Other', ?, 'bots', ?, ?)`).run(dir, now, now, botProjectId('other'), dir, now, now);
    db.prepare(`insert into processes(id,project_id,kind,name,status,created_at,updated_at) values('proc-assistant','project_assistant','agent','Assistant','running',?,?), ('proc-other-bot',?,'agent','Other','running',?,?)`).run(now, now, botProjectId('other'), now, now);
    await registry.callPublic('get_process_status', { process_id: 'proc-q' }, fable);
    await assert.rejects(registry.callPublic('get_process_status', { process_id: 'proc-assistant' }, fable), /outside the current caller scope/);
    await assert.rejects(registry.callPublic('get_process_status', { process_id: 'proc-other-bot' }, fable), /outside the current caller scope/);
    await assert.rejects(registry.callPublic('list_processes', { project_id: botProjectId('other') }, fable), /outside this bot's projects/);
    await assert.rejects(registry.callPublic('todo_list', { project_id: 'project_assistant' }, fable), /outside this bot's projects/);

    // The assistant runs like any bot: turned off it doesn't start, and on
    // it keeps its own role, project and folder, so its thread resumes.
    const launchesBefore = launches.length;
    await bots.ensureAll();
    assert.equal(launches.slice(launchesBefore).some((launch) => launch.input.bot_id === ASSISTANT_BOT_ID), false);
    await assert.rejects(bots.ensure(ASSISTANT_BOT_ID), /turned off/);
    settings.updateBots({ bots: [{ ...settings.bots().bots[0]!, enabled: true, presetId: null }, ...settings.bots().bots.slice(1)] });
    // Until its first conversation it starts only when opened, not with Patterm.
    await bots.ensureAll();
    assert.equal(bots.currentProcess(ASSISTANT_BOT_ID), null);
    assert.equal(bots.harness(ASSISTANT_BOT_ID), 'codex', 'no profile runs Codex with its own configuration');
    await bots.ensure(ASSISTANT_BOT_ID);
    const assistantLaunch = launches.at(-1)!.input;
    assert.deepEqual([assistantLaunch.bot_id, assistantLaunch.session_role, assistantLaunch.project_id, assistantLaunch.harness, 'preset' in assistantLaunch], [ASSISTANT_BOT_ID, 'assistant', ASSISTANT_PROJECT_ID, 'codex', false]);
    assert.equal(path.basename(assistantLaunch.cwd!), 'assistant');
    assert.equal((db.prepare('select kind from projects where id = ?').get(ASSISTANT_PROJECT_ID) as { kind: string }).kind, 'assistant');
    assert.match(bots.context(ASSISTANT_BOT_ID), /You are the user's Patterm assistant/);
    const assistantProcess = bots.currentProcess(ASSISTANT_BOT_ID)!;
    assert.equal(bots.botFor(assistantProcess), ASSISTANT_BOT_ID);
    // Restarting resumes its thread; turning it off stops it.
    await bots.restartProcess(assistantProcess);
    assert.equal(launches.at(-1)!.resume?.resume_id, `thread-${launches.length - 1}`);
    settings.updateBots({ bots: [{ ...settings.bots().bots[0]!, enabled: false }, ...settings.bots().bots.slice(1)] });
    await bots.reconcile();
    assert.equal(bots.currentProcess(ASSISTANT_BOT_ID), null);
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
    project: { id, name: id, path: '/tmp', kind: id.startsWith('project_bot_') ? 'bots' : 'workspace' }, projectSessions: sessions, processes, worktrees: [], timers: []
  } as unknown as ProjectWorkbench);
  const botsProject = workbenchOf(botProjectId('fable'), [session('bot', { sessionRole: 'bot', botId: 'fable', activity: 'idle', summary: { status: 'Watching the deploy', text: '', generatedAt: '', provider: '', model: '' } })]);
  const projects = [
    workbenchOf('p', [
      session('helper', { sessionRole: 'child', parentProcessId: 'proc-bot', activity: 'working' }),
      session('deep', { sessionRole: 'child', parentId: 'helper', parentProcessId: 'proc-helper', activity: 'question', asking: 'Deploy to production?' }),
      session('mine', {})
    ], [{ id: 'proc-server', parentProcessId: 'proc-helper' } as ProjectWorkbench['processes'][number]])
  ];
  const hidden = botHidden(projects, [botsProject]);
  assert.deepEqual([...hidden.sessions].sort(), ['bot', 'deep', 'helper']);
  assert.ok(hidden.processes.has('proc-server'), 'a helper\'s server stays out of view too');
  assert.equal(botHidden(projects, []).sessions.size, 0);
  const [row] = botRows({ bots: [bot('fable', 'Fable')], userName: null }, projects, [botsProject]);
  assert.equal(row!.session?.id, 'bot');
  assert.equal(row!.activity?.subagents.working, 1);
  assert.equal(row!.waitingHelper?.id, 'deep');
  assert.equal(row!.waitingHelperProjectId, 'p');
  assert.equal(row!.line, 'A helper is waiting: Deploy to production?');
  assert.equal(botRows({ bots: [bot('fable', 'Fable')], userName: null }, [], [botsProject])[0]!.line, 'Watching the deploy');
  assert.equal(botRows({ bots: [bot('new', 'New')], userName: null }, projects, [botsProject])[0]!.session, null);
  // Global bots list in every project; a bot with chosen projects only in those.
  const scoped = bot('scoped', 'Scoped', { purview: { kind: 'projects', projectIds: ['q'] } });
  assert.equal(botShownIn(bot('generic', 'Generic'), 'p'), true);
  assert.equal(botShownIn(bot('everywhere', 'Everywhere', { purview: { kind: 'all' } }), 'p'), true);
  assert.equal(botShownIn(scoped, 'p'), false);
  assert.equal(botShownIn(scoped, 'q'), true);
  // Only global bots list on the projects page.
  assert.deepEqual([bot('generic', 'Generic'), bot('everywhere', 'Everywhere', { purview: { kind: 'all' } }), scoped].map(isGlobalBot), [true, true, false]);
  // A link into a bot's project opens it beside a project it lists in.
  assert.equal(botHomeProjectId(scoped, ['p', 'q']), 'q');
  assert.equal(botHomeProjectId(bot('generic', 'Generic'), ['p', 'q']), 'p');
  assert.equal(botHomeProjectId(scoped, ['p']), 'p', 'its projects are gone: any project will do');
  assert.equal(botHomeProjectId(undefined, []), null);
  // A cold link waits for the bots' settings, whichever loads first, then
  // opens the bot beside a project it lists in.
  const scopedProject = workbenchOf(botProjectId('scoped'), [session('scoped-bot', { sessionRole: 'bot', botId: 'scoped' })]);
  assert.equal(botLinkTarget(scopedProject, 'scoped-bot', null, ['p', 'q'], true), 'wait');
  assert.deepEqual(botLinkTarget(scopedProject, 'scoped-bot', [scoped], ['p', 'q'], true), { botId: 'scoped', projectId: 'q' });
  assert.equal(botLinkTarget(scopedProject, 'scoped-bot', [scoped], [], false), 'wait');
  assert.equal(botLinkTarget(scopedProject, 'scoped-bot', [scoped], [], true), 'projects');
  assert.equal(botLinkTarget(workbenchOf(botProjectId('empty'), []), undefined, null, ['p'], true), 'projects');
  // The assistant's row reads its live session, not the routine runs that
  // share its project.
  const assistantProject = { ...workbenchOf('project_assistant', [
    session('old-assistant', { sessionRole: 'assistant', exitedAt: '2026-10-29T10:30:00.000Z' }),
    session('assistant', { sessionRole: 'assistant', activity: 'question', asking: 'Which project?', startedAt: '2026-10-29T11:00:00.000Z' }),
    session('routine', { sessionRole: 'routine', activity: 'working', startedAt: '2026-10-29T12:00:00.000Z' })
  ]), project: { id: 'project_assistant', name: 'Assistant', path: '/tmp', kind: 'assistant' } } as ProjectWorkbench;
  const live = assistantRow(assistantProject, 'proc-assistant');
  assert.equal(live.session?.id, 'assistant');
  assert.equal(live.activity?.self, 'question');
  assert.equal(live.line, 'Which project?');
  assert.deepEqual(assistantRow(assistantProject, null), { session: null, activity: null, line: null }, 'not started yet, not exited');
  assert.equal(assistantRow(assistantProject, 'proc-routine').session, null, 'never a routine run');
  assert.deepEqual(assistantRow(null, null), { session: null, activity: null, line: null });
  // The assistant and turned-off bots don't list as bot rows: the assistant has its own.
  assert.deepEqual(botRows({ bots: [readBotSettings({}).bots[0]!, bot('off', 'Off', { enabled: false }), bot('on', 'On')], userName: null }, projects, [botsProject]).map((item) => item.bot.id), ['on']);
  const idle = { voiceActive: false, focus: false, focusPending: 0, processId: null };
  assert.equal(assistantLine(idle, assistantRow(null, null)), 'Starts when you open it');
  assert.equal(assistantLine({ ...idle, processId: 'proc-assistant' }, live), 'Which project?');
  assert.equal(assistantLine({ ...idle, processId: 'proc-assistant', voiceActive: true }, live), 'On a voice call');
  assert.equal(assistantLine({ ...idle, processId: 'proc-assistant', focus: true, focusPending: 2 }, assistantRow(null, null)), 'Focus · 2 held');
  assert.equal(botLine(botRows({ bots: [bot('new', 'New')], userName: null }, projects, [botsProject])[0]!), 'Starting…');
  assert.equal(botLine(row!), 'A helper is waiting: Deploy to production?');
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
