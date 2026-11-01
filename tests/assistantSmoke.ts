import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';
import { registerBotTools } from '../app/MCP/registerBotTools';
import { INTEGRATED_CONTROL_TOOLS } from '../app/Http/BrowserTools';
import { listedProject, WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { ASSISTANT_PROJECT_ID } from '../app/Services/AssistantProject';
import type { BotRelayEvent } from '../app/Services/BotRelay';
import { ASSISTANT_BOT_ID } from '../app/Bots/BotIdentity';
import { assistantBot, setAssistant } from './fixtures/AssistantBotFixture';
import type { CodexRealtimeEvent, RealtimeInitialItem } from '../app/Services/CodexAppServerService';
import type { IntegratedConversationMessage } from '../app/Services/IntegratedConversation';
import { voiceBrief } from '../app/Services/AssistantVoiceBrief';
import { DatabaseService } from '../app/Services/DatabaseService';
import type { LaunchHarnessInput, HarnessResume } from '../app/Services/HarnessLauncher';
import type { NotificationRecord } from '../app/Services/NotificationService';
import { SettingsService } from '../app/Services/SettingsService';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { AgentContextService } from '../app/Services/AgentContextService';
import { botVoiceOptions, type RealtimeVoiceOptions, type VoiceSettings } from '../app/Services/AssistantVoiceProfile';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';
import { removeTree } from './fixtures/TempTree';
import { trySymlink } from './fixtures/SymlinkFixture';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-assistant-'));
  const database = new DatabaseService(dir);
  try {
    database.initialize();
    const db = database.connection;
    const now = new Date().toISOString();
    for (const id of ['p', 'q']) db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run(id, `Project ${id}`, dir, now, now);
    const settings = new SettingsService(database);
    const workbench = new WorkbenchRepository(database, settings);

    // The assistant's settings live on its built-in bot: voice, profile,
    // digests and Focus mode. Unknown voices and profiles are rejected, and
    // the name voices use is trimmed, cleared when blank, and bounded.
    const assistantSettings = () => settings.bots().bots.find((bot) => bot.id === ASSISTANT_BOT_ID)!;
    assert.deepEqual([assistantSettings().voice.enabled, assistantSettings().digests, assistantSettings().focus, assistantSettings().memory], [true, true, true, false]);
    assert.equal(assistantSettings().presetId, 'preset_default_codex', 'it starts on the Codex default profile');
    settings.updateHarnessPresets({ ...settings.harnessPresets(), presets: [...settings.harnessPresets().presets, { id: 'preset_fast', harness: 'codex', name: 'Fast', model: null, reasoning: null, serviceTier: null, look: null }] });
    setAssistant(settings, { voice: { ...assistantSettings().voice, voice: 'maple' }, presetId: 'preset_fast' });
    assert.equal(assistantSettings().voice.voice, 'maple');
    assert.throws(() => setAssistant(settings, { voice: { ...assistantSettings().voice, voice: 'robot' } }));
    assert.throws(() => setAssistant(settings, { voice: { ...assistantSettings().voice, profile: 'chatty' } }));
    assert.throws(() => setAssistant(settings, { voice: { ...assistantSettings().voice, acknowledgements: 'loud' } }));
    assert.throws(() => setAssistant(settings, { memoryBudgetTokens: 0 }));
    const nameTo = (userName: string) => settings.updateBots({ ...settings.bots(), userName }).userName;
    assert.equal(nameTo('  Alex '), 'Alex');
    assert.equal(nameTo('   '), null);
    assert.throws(() => nameTo('x'.repeat(61)));
    const voiceSettings = (change: Partial<VoiceSettings>): VoiceSettings => ({ profile: 'codex', acknowledgements: 'default', botName: 'Assistant', assistant: true, userName: null, ...change });

    // The Codex profile starts exactly the session Codex would; acknowledgements
    // are sent only when chosen explicitly.
    assert.deepEqual(botVoiceOptions(voiceSettings({ profile: 'codex', acknowledgements: 'default', userName: 'Alex' })), {});
    assert.deepEqual(botVoiceOptions(voiceSettings({ profile: 'codex', acknowledgements: 'on', userName: null })), { delegationAckFiller: true });
    assert.deepEqual(botVoiceOptions(voiceSettings({ profile: 'codex', acknowledgements: 'off', userName: null })), { delegationAckFiller: false });
    // The Patterm profile replaces the voice and backend instructions and keeps
    // the acknowledgement choice in both the parameter and the prompt.
    const patterm = botVoiceOptions(voiceSettings({ profile: 'patterm', acknowledgements: 'default', userName: null }));
    assert.deepEqual(Object.keys(patterm).sort(), ['backendReasoningStatus', 'prompt', 'realtimeStartInstructions']);
    assert.equal(patterm.backendReasoningStatus, true);
    assert.match(patterm.prompt!, /Answer directly, without handing over/);
    assert.match(patterm.prompt!, /a short acknowledgement is welcome reassurance/);
    assert.doesNotMatch(patterm.prompt!, /\[USER\]|\[BACKEND\]|tool return/, 'no realtime v2 conventions');
    assert.match(patterm.realtimeStartInstructions!, /spawn_agent/);
    assert.match(patterm.realtimeStartInstructions!, /send_message/);
    assert.doesNotMatch(patterm.prompt!, /The user's name is/, 'no name is set');
    assert.match(botVoiceOptions(voiceSettings({ profile: 'patterm', acknowledgements: 'default', userName: 'Alex' })).prompt!, /The user's name is Alex\./);
    const quiet = botVoiceOptions(voiceSettings({ profile: 'patterm', acknowledgements: 'off', userName: null }));
    assert.equal(quiet.delegationAckFiller, false);
    assert.match(quiet.prompt!, /do not add filler/);
    assert.equal(botVoiceOptions(voiceSettings({ profile: 'patterm', acknowledgements: 'on', userName: null })).delegationAckFiller, true);
    // Codex caps start instructions at 8,192 estimated tokens (about 4 bytes
    // each); stay well inside it.
    for (const text of [patterm.prompt!, patterm.realtimeStartInstructions!]) assert.ok(Buffer.byteLength(text) < 8_000, 'voice instructions stay small');
    assert.match(botVoiceOptions(voiceSettings({ profile: 'patterm', botName: 'Jarvis' })).prompt!, /the user's Patterm assistant, Jarvis/);
    assert.match(botVoiceOptions(voiceSettings({ profile: 'patterm', botName: 'Fable', assistant: false })).prompt!, /Fable, one of the user's Patterm bots/);

    // The voice brief keeps the user's words and the assistant's replies, drops
    // background messages and tool rows, and trims the oldest lines to fit.
    assert.equal(voiceBrief([], []), null);
    const text = (id: string, role: 'user' | 'assistant', value: string): IntegratedConversationMessage => ({ id, role, kind: 'text', text: value });
    const briefed = voiceBrief([
      text('1', 'user', '[report from process_9: completed] Done'),
      text('2', 'assistant', 'The review passed.'),
      text('3', 'user', 'typed  request'),
      { ...text('4', 'assistant', 'nested'), parentId: 't' }
    ], [{ name: 'Reviewer', project: null, activity: 'idle' }])!;
    assert.doesNotMatch(briefed, /report from|nested/);
    assert.match(briefed, /Recent conversation, oldest first:\n- Assistant: The review passed\.\n- User: typed request\n\nAgents the assistant started that are still running:\n- Reviewer: idle$/);
    const long = voiceBrief(Array.from({ length: 40 }, (_, index) => text(String(index), 'assistant', `${index} ${'x'.repeat(400)}`)), [])!;
    assert.ok(long.length <= 6_000, 'the brief stays bounded');
    assert.match(long, /- Assistant: 39 x+…$/, 'the newest lines are kept');
    assert.doesNotMatch(long, /- Assistant: 23 /, 'only the last 16 messages are considered');
    // A handoff the voice model started by itself, or Codex's end-of-call
    // flush, is not something the user said.
    const delegation = (input: string, delta: string) => `<realtime_delegation>\n  <input>${input}</input>\n  <transcript_delta>${delta}</transcript_delta>\n</realtime_delegation>`;
    const relayed = voiceBrief([
      text('1', 'user', delegation('Read the release notes agent and summarise its questions', 'assistant:  The release notes agent has two questions for you.')),
      text('2', 'user', delegation('The user just ended their realtime session.', 'user:  I prefer brief updates')),
      text('3', 'user', delegation('and the docs one?', 'user:  login?\nassistant:  It is testing.\nuser:  and the docs one?'))
    ], [])!;
    assert.doesNotMatch(relayed, /release notes|ended their realtime/);
    assert.match(relayed, /- User: and the docs one\?$/);
    // Agent rows are clipped, so long names cannot push the brief past its cap.
    const crowded = voiceBrief(Array.from({ length: 40 }, (_, index) => text(String(index), 'user', 'y'.repeat(400))),
      Array.from({ length: 20 }, () => ({ name: 'n'.repeat(500), project: 'p'.repeat(3_000), activity: 'idle' })))!;
    assert.ok(crowded.length <= 6_000, 'agent rows are bounded');
    assert.equal(crowded.split('\n').filter((line) => line.startsWith('- nnn')).length, 12);

    // A fake launcher registers rows the way HarnessLauncher does.
    const launches: Array<{ input: LaunchHarnessInput; resume: HarnessResume | null }> = [];
    let sequence = 0;
    const register = (input: LaunchHarnessInput, resume: HarnessResume | null) => {
      launches.push({ input, resume });
      sequence += 1;
      const processId = `proc-assistant-${sequence}`;
      db.prepare(`insert into processes(id,project_id,kind,name,status,created_at,updated_at) values(?,?,'agent','Assistant','running',?,?)`).run(processId, input.project_id, now, now);
      db.prepare(`insert into sessions(id,project_id,process_id,harness,interface_mode,session_role,bot_id,started_at,cwd,mcp_identity,resume_id) values(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(`session-assistant-${sequence}`, input.project_id, processId, 'codex', 'integrated', input.session_role, input.bot_id ?? null, new Date(Date.now() + sequence).toISOString(), input.cwd ?? dir, `mcp-assistant-${sequence}`, resume?.resume_id ?? `thread-${sequence}`);
      return { session_id: `session-assistant-${sequence}`, process_id: processId, pty_process_id: null, interface_mode: 'integrated' as const, harness: 'codex', name: 'Assistant' };
    };
    // A test can hold launches behind a gate, or make them fail.
    let launchGate: Promise<void> = Promise.resolve();
    let launchFailure: Error | null = null;
    const launcher = {
      launch: async (input: LaunchHarnessInput) => { await launchGate; if (launchFailure) throw launchFailure; return register(input, null); },
      resume: async (input: LaunchHarnessInput, resume: HarnessResume) => { await launchGate; if (launchFailure) throw launchFailure; return register(input, resume); }
    };
    const realtimeListeners = new Set<(event: CodexRealtimeEvent) => void>();
    const appended: string[] = [];
    let appendFailure: Error | null = null;
    const prompts: string[] = [];
    type VoiceOffer = { sdp: string; voice?: string | null; options?: RealtimeVoiceOptions; initialItems?: RealtimeInitialItem[] };
    let voiceOffer: VoiceOffer | null = null;
    let conversation: IntegratedConversationMessage[] = [];
    let stopped = 0;
    let voiceStartGate: Promise<void> = Promise.resolve();
    let voiceStopGate: Promise<void> = Promise.resolve();
    let compacting = false;
    const codex = {
      realtimeStart: async (_processId: string, input: VoiceOffer) => { await voiceStartGate; voiceOffer = input; return { sdp: 'answer-sdp' }; },
      realtimeStop: async () => { await voiceStopGate; stopped += 1; },
      realtimeAppendText: async (_processId: string, text: string) => { if (appendFailure) throw appendFailure; appended.push(text); },
      onRealtime: (_processId: string, listener: (event: CodexRealtimeEvent) => void) => { realtimeListeners.add(listener); return () => realtimeListeners.delete(listener); }
    };
    let promptResult: unknown = {};
    const integrated = {
      prompt: async (_processId: string, input: unknown) => { prompts.push(String(input)); return promptResult; },
      conversation: async () => ({ messages: { data: conversation } })
    };
    const stops: string[] = [];
    const timerTransfers: string[] = [];
    const processes = {
      stop: async (processId: string) => {
        stops.push(processId);
        db.prepare(`update processes set status = 'stopped' where id = ?`).run(processId);
        db.prepare(`update sessions set exited_at = ? where process_id = ?`).run(now, processId);
      },
      transferTimers: (from: readonly string[], to: string) => { timerTransfers.push(`${from.join(',')}->${to}`); }
    };
    const { inbox, assistant, bots, relay } = assistantBot(database, dir, launcher, codex, integrated, settings, processes, { digestDelayMs: 10, compacting: () => compacting });
    const events: BotRelayEvent[] = [];
    assistant.onEvent((event) => events.push(event));

    // The first ensure launches a Codex Integrated assistant in its hidden project.
    assert.equal(assistant.state().process_id, null);
    const [first, concurrent] = await Promise.all([assistant.ensure(), assistant.ensure()]);
    assert.equal(launches.length, 1, 'concurrent ensures launch once');
    assert.equal(first.process_id, 'proc-assistant-1');
    assert.equal(concurrent.process_id, 'proc-assistant-1');
    assert.equal(launches[0]!.input.harness, 'codex');
    assert.equal(launches[0]!.input.session_role, 'assistant');
    assert.equal(launches[0]!.input.interface_mode, 'integrated');
    assert.equal(launches[0]!.input.preset, 'preset_fast');
    assert.equal(launches[0]!.input.project_id, ASSISTANT_PROJECT_ID);
    assert.ok(fs.existsSync(path.join(dir, 'assistant')));
    assert.deepEqual(workbench.listProjects().map((project) => project.id), ['p', 'q'], 'the assistant project is not listed');
    // The snapshot carries it for the sidebar's Bots section, but no list of
    // the user's projects shows it.
    const carried = workbench.snapshot().projects.find((project) => project.project.id === ASSISTANT_PROJECT_ID);
    assert.equal(carried?.project.kind, 'assistant');
    assert.equal(listedProject(carried!), false);
    assert.equal(bots.botFor('proc-assistant-1'), ASSISTANT_BOT_ID);
    assert.ok(events.some((event) => event.type === 'state' && event.state.process_id === 'proc-assistant-1'));

    // A live assistant is reused; an exited one resumes its Codex thread.
    await assistant.ensure();
    assert.equal(launches.length, 1);
    db.prepare(`update processes set status = 'exited' where id = 'proc-assistant-1'`).run();
    db.prepare(`update sessions set exited_at = ? where id = 'session-assistant-1'`).run(now);
    assert.equal((await assistant.ensure()).process_id, 'proc-assistant-2');
    assert.deepEqual(launches[1]!.resume, { resume_id: 'thread-1', conversation_id: '', source_session_id: 'session-assistant-1' });

    // A restart stops the live assistant and resumes the same thread in a new
    // process; an ensure during it waits instead of launching a second one.
    // Agents and timers it started follow it, so their reports still arrive.
    db.prepare(`insert into processes(id,project_id,parent_process_id,kind,name,status,created_at,updated_at) values('proc-helper','p','proc-assistant-2','agent','Helper','running',?,?)`).run(now, now);
    await assert.rejects(assistant.restart('proc-assistant-1'), /already restarted/, 'a stale request does not restart the new assistant');
    const [restarted, during] = await Promise.all([assistant.restart('proc-assistant-2'), assistant.ensure()]);
    assert.deepEqual(stops, ['proc-assistant-2']);
    assert.equal((db.prepare(`select parent_process_id from processes where id = 'proc-helper'`).get() as { parent_process_id: string }).parent_process_id, 'proc-assistant-3');
    assert.deepEqual(timerTransfers.slice(-1), ['proc-assistant-1,proc-assistant-2->proc-assistant-3']);
    db.prepare(`update processes set status = 'exited' where id = 'proc-helper'`).run();
    assert.equal(launches.length, 3, 'a restart launches once');
    assert.equal(restarted.process_id, 'proc-assistant-3');
    assert.equal(during.process_id, 'proc-assistant-3');
    assert.deepEqual(launches[2]!.resume, { resume_id: 'thread-1', conversation_id: '', source_session_id: 'session-assistant-2' });
    assert.ok(events.some((event) => event.type === 'state' && event.state.process_id === 'proc-assistant-3'));

    // Notifications for the user arrive as one digest message.
    const notification = (id: string, overrides: Partial<NotificationRecord> = {}): NotificationRecord => ({
      id, project_id: 'p', process_id: 'proc-x', session_id: null, source: 'integrated', kind: 'permission', urgency: 'high', delivery: 'all', held: false, audience: 'user',
      routed_to_process_id: null, title: 'Reviewer', body: 'Waiting for your permission', occurrences: 1, created_at: now, updated_at: now,
      read_at: null, resolved_at: null, url: '/', project_name: 'Project p', process_name: 'Reviewer', ...overrides
    });
    assistant.handleNotification({ type: 'raised', notification: notification('n1') });
    assistant.handleNotification({ type: 'raised', notification: notification('n2', { kind: 'turn_finished', body: 'Finished its turn' }) });
    assistant.handleNotification({ type: 'raised', notification: notification('n3', { audience: 'parent' }) });
    assistant.handleNotification({ type: 'raised', notification: notification('n4', { kind: 'bell' }) });
    assistant.handleNotification({ type: 'raised', notification: notification('n5', { project_id: ASSISTANT_PROJECT_ID }) });
    assistant.handleNotification({ type: 'updated', notification: notification('n6') });
    await wait(40);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /^\[Patterm notifications\]/);
    assert.match(prompts[0]!, /\[permission\] Project p \/ Reviewer — Reviewer: Waiting for your permission \(process proc-x\)/);
    assert.match(prompts[0]!, /\[turn_finished\]/);
    assert.equal(prompts[0]!.split('\n').length, 3, 'parent-audience, bell, assistant, and update changes are not forwarded');

    // Voice answers the offer with the configured voice and speaks digests.
    compacting = true;
    await assert.rejects(assistant.startVoice('during-compaction'), /Assistant is compacting/);
    assert.equal(voiceOffer, null, 'voice never reaches Codex during auto-compaction');
    assert.equal(assistant.voiceActive(assistant.state().process_id!), false);
    compacting = false;
    let finishVoiceStart!: () => void;
    voiceStartGate = new Promise<void>((resolve) => { finishVoiceStart = resolve; });
    const startingVoice = assistant.startVoice('offer-sdp');
    await wait(0);
    assert.equal(assistant.voiceActive(assistant.state().process_id!), true, 'voice startup blocks compaction');
    finishVoiceStart();
    assert.deepEqual(await startingVoice, { sdp: 'answer-sdp' });
    assert.equal(assistant.voiceActive(assistant.state().process_id!), true);

    assert.deepEqual(voiceOffer, { sdp: 'offer-sdp', voice: 'maple', options: {} }, 'the default profile adds no start parameters, and an empty thread no brief');
    assert.equal(assistant.state().voice.active, true);
    assistant.handleNotification({ type: 'raised', notification: notification('n7', { kind: 'failure', body: 'Exited with code 1' }) });
    await wait(40);
    assert.equal(prompts.length, 1, 'voice sessions hear notifications instead of a thread message');
    assert.equal(appended.length, 1);
    assert.match(appended[0]!, /System notification, not from the user/);
    for (const listener of realtimeListeners) listener({ method: 'thread/realtime/transcript/done', params: { threadId: 'thread-1', role: 'assistant', text: 'Hello' } });
    assert.ok(events.some((event) => event.type === 'realtime' && event.method === 'thread/realtime/transcript/done'));
    for (const listener of [...realtimeListeners]) listener({ method: 'thread/realtime/closed', params: { threadId: 'thread-1' } });
    assert.equal(assistant.state().voice.active, false, 'an upstream close ends the voice session');
    assert.equal(realtimeListeners.size, 0);
    // A changed profile applies to the next voice session.
    setAssistant(settings, { voice: { ...assistantSettings().voice, profile: 'patterm', acknowledgements: 'on' } });
    nameTo('Alex');
    await assistant.startVoice('offer-2');
    assert.deepEqual((voiceOffer as { options?: RealtimeVoiceOptions } | null)?.options, botVoiceOptions(voiceSettings({ profile: 'patterm', acknowledgements: 'on', userName: 'Alex' })));
    // A new call is briefed from the thread and the agents the assistant started.
    conversation = [
      { id: 'u1', role: 'user', kind: 'text', text: '<realtime_delegation>\n  <input>Start a PAT-130 agent</input>\n  <transcript_delta>user: Start a PAT-130 agent</transcript_delta>\n</realtime_delegation>' },
      { id: 't1', role: 'assistant', kind: 'tool', text: 'spawn_agent' },
      { id: 'a1', role: 'assistant', kind: 'text', text: 'Started PAT-130.' }
    ];
    db.prepare(`insert into processes(id,project_id,parent_process_id,kind,name,status,activity,created_at,updated_at) values('proc-child','p','proc-assistant-3','agent','PAT-130','running','working',?,?)`).run(now, now);
    await assistant.startVoice('offer-3');
    assert.deepEqual((voiceOffer as VoiceOffer | null)?.initialItems?.map((item) => item.role), ['developer']);
    const brief = (voiceOffer as VoiceOffer | null)!.initialItems![0]!.text;
    assert.match(brief, /- User: Start a PAT-130 agent\n- Assistant: Started PAT-130\./);
    assert.match(brief, /- PAT-130 \(Project p\): working/);
    assert.doesNotMatch(brief, /spawn_agent|transcript_delta/);
    let finishVoiceStop!: () => void;
    voiceStopGate = new Promise<void>((resolve) => { finishVoiceStop = resolve; });
    const stoppingVoice = assistant.stopVoice();
    assert.equal(assistant.voiceActive(assistant.state().process_id!), true, 'voice shutdown blocks compaction');
    finishVoiceStop();
    await stoppingVoice;
    assert.equal(assistant.voiceActive(assistant.state().process_id!), false);
    assert.equal(stopped, 2, 'starting a new call stops the previous one');
    assert.equal(assistant.state().voice.active, false);

    // Forwarding can be turned off.
    setAssistant(settings, { digests: false });
    assistant.handleNotification({ type: 'raised', notification: notification('n8') });
    await wait(40);
    assert.equal(prompts.length, 1);

    // Agent messages reach the thread, or the voice session, framed as agents'.
    db.prepare(`insert into processes(id,project_id,kind,name,status,created_at,updated_at) values('proc-sender','p','agent','Sender','running',?,?)`).run(now, now);
    assert.deepEqual(await assistant.deliverAgentMessage('proc-sender', 'Build is green.'), { process_id: 'proc-assistant-3', delivery: 'delivered' });
    assert.equal(prompts.at(-1), '[agent message from proc-sender (Project p / Sender), not the user]\nBuild is green.');
    // A message held during a compaction says so instead of claiming delivery.
    promptResult = { delivery: 'queued', message_id: 'held_1', detail: 'Sent when the compaction ends.' };
    assert.deepEqual(await assistant.deliverAgentMessage('proc-sender', 'Compacting?'), { process_id: 'proc-assistant-3', delivery: 'queued', detail: 'Sent when the compaction ends.' });
    promptResult = {};
    await assistant.startVoice('offer-3');
    await assistant.deliverAgentMessage('proc-sender', 'Deploy finished.');
    assert.match(appended.at(-1)!, /not from the user[\s\S]*\[agent message from proc-sender \(Project p \/ Sender\), not the user\]\nDeploy finished\.$/);
    // A lost acknowledgement may follow delivery: uncertain, not failed.
    appendFailure = Object.assign(new Error('socket closed'), { definitive: false });
    assert.deepEqual(await assistant.deliverAgentMessage('proc-sender', 'Maybe heard.'), { process_id: 'proc-assistant-3', delivery: 'uncertain' });
    appendFailure = new Error('rejected');
    await assert.rejects(assistant.deliverAgentMessage('proc-sender', 'Refused.'), /rejected/);
    appendFailure = null;
    await assistant.stopVoice();
    await assert.rejects(assistant.deliverAgentMessage('proc-assistant-3', 'loop'), /cannot message itself/);
    // A restart ends a voice call before stopping the process.
    await assistant.startVoice('offer-4');
    const stoppedBefore = stopped;
    assert.equal((await assistant.restart('proc-assistant-3')).process_id, 'proc-assistant-4');
    assert.equal(stopped, stoppedBefore + 1);
    assert.equal(assistant.state().voice.active, false);
    assert.deepEqual(stops, ['proc-assistant-2', 'proc-assistant-3']);

    // A report or timer callback sent to the stopped process mid-restart waits
    // in the inbox and reaches the new process.
    let openGate!: () => void;
    launchGate = new Promise((resolve) => { openGate = resolve; });
    const gated = assistant.restart('proc-assistant-4');
    const freshRejected = assert.rejects(assistant.newSession('proc-assistant-4'), /already restarted/, '/new cannot succeed by joining a resume');
    await wait(5);
    assert.equal(assistant.state().process_id, null, 'the old process has stopped');
    assert.ok(inbox.hold('proc-assistant-4', { kind: 'report', sourceProcessId: 'proc-helper', title: 'Report from proc-helper: completed', body: 'Done during the restart', dedupeKey: 'report:restart' }));
    assert.ok(!inbox.hold('proc-not-assistant', { kind: 'report', title: 'x', body: 'y' }), 'other processes are delivered as usual');
    const promptsBefore = prompts.length;
    openGate();
    assert.equal((await gated).process_id, 'proc-assistant-5');
    await freshRejected;
    await wait(20);
    assert.match(prompts.slice(promptsBefore).join('\n'), /held while Focus mode was on or you were not running[\s\S]*Report from proc-helper/);

    // When the new process fails to launch, the next start still adopts the
    // old process's agents and timers.
    db.prepare(`update processes set parent_process_id = 'proc-assistant-5', status = 'running' where id = 'proc-helper'`).run();
    launchFailure = new Error('codex failed to start');
    await assert.rejects(assistant.restart('proc-assistant-5'), /codex failed to start/);
    assert.equal(assistant.state().process_id, null);
    launchFailure = null;
    assert.equal((await assistant.ensure()).process_id, 'proc-assistant-6');
    assert.equal((db.prepare(`select parent_process_id from processes where id = 'proc-helper'`).get() as { parent_process_id: string }).parent_process_id, 'proc-assistant-6');
    assert.match(timerTransfers.at(-1)!, /proc-assistant-5.*->proc-assistant-6$/);
    db.prepare(`update processes set status = 'exited' where id = 'proc-helper'`).run();
    // /new keeps the assistant role and its dependants, but starts a fresh
    // thread. The previous thread remains available in history.
    const ui = new McpToolRegistry();
    registerBotTools(ui, bots, relay, settings, () => undefined);
    assert.equal(ui.help('bot_restart').hidden, true);
    assert.ok(INTEGRATED_CONTROL_TOOLS.has('bot_restart'));
    db.prepare(`update processes set parent_process_id = 'proc-assistant-6', status = 'running' where id = 'proc-helper'`).run();
    await assistant.startVoice('before-new');
    await assert.rejects(ui.call('bot_restart', { process_id: 'proc-assistant-5', fresh: true }), /already restarted/);
    const [fresh, whileNew] = await Promise.all([
      ui.call('bot_restart', { process_id: 'proc-assistant-6', fresh: true }) as Promise<{ process_id: string }>,
      assistant.ensure()
    ]);
    assert.equal(fresh.process_id, 'proc-assistant-7');
    assert.equal(whileNew.process_id, fresh.process_id, 'ensure cannot race a fresh launch');
    assert.equal(launches.length, 7);
    assert.equal(launches[6]!.resume, null, 'new does not resume the old thread');
    assert.equal(launches[6]!.input.session_role, 'assistant');
    assert.equal(assistant.state().voice.active, false);
    assert.equal((db.prepare(`select parent_process_id from processes where id = 'proc-helper'`).get() as { parent_process_id: string }).parent_process_id, fresh.process_id);
    assert.match(timerTransfers.at(-1)!, /proc-assistant-6.*->proc-assistant-7$/);
    assert.equal((db.prepare(`select resume_id from sessions where id = 'session-assistant-6'`).get() as { resume_id: string }).resume_id, 'thread-1');
    await assistant.restart('proc-assistant-7');
    assert.equal(launches[7]!.resume?.resume_id, 'thread-7', 'later restarts resume the fresh thread');

    // Turning the assistant off ends its voice call and stops it, and nothing
    // starts it again until it is back on, when it resumes the same thread.
    const saveAssistant = async (change: Record<string, unknown>) => {
      await ui.call('settings_bots_update', { ...settings.bots(), bots: settings.bots().bots.map((bot) => bot.id === ASSISTANT_BOT_ID ? { ...bot, ...change } : bot) });
      // Starting and stopping bots carries on after the save returns.
      await wait(20);
    };
    assert.equal(assistant.state().enabled, true);
    await assistant.startVoice('before-off');
    const live = assistant.state().process_id!;
    await saveAssistant({ enabled: false });
    assert.equal(assistantSettings().enabled, false);
    assert.equal(stops.at(-1), live);
    assert.deepEqual({ enabled: assistant.state().enabled, process_id: assistant.state().process_id, voice: assistant.state().voice.active }, { enabled: false, process_id: null, voice: false });
    const lastState = () => events.filter((event): event is Extract<BotRelayEvent, { type: 'state' }> => event.type === 'state' && event.state.bot_id === ASSISTANT_BOT_ID).at(-1)?.state;
    assert.equal(lastState()?.enabled, false, 'clients hear that the assistant is off');
    await assert.rejects(assistant.ensure(), /turned off/);
    await assert.rejects(assistant.startVoice('while-off'), /turned off/);
    await assert.rejects(assistant.restart(live), /turned off/);
    await assert.rejects(assistant.newSession(live), /turned off/);
    assert.equal(launches.length, 8, 'nothing launches while the assistant is off');
    // Like any bot, turning it back on starts it again on the same thread.
    await saveAssistant({ enabled: true });
    assert.equal(lastState()?.enabled, true);
    assert.equal(launches.length, 9);
    assert.equal(launches[8]!.resume?.resume_id, 'thread-7', 'turning it back on resumes the thread');
    assert.ok(assistant.state().process_id);
    // Voice needs a Codex profile; another harness hides it.
    assert.equal(assistant.state().voice.available, true);
    settings.updateHarnessPresets({ ...settings.harnessPresets(), presets: [...settings.harnessPresets().presets, { id: 'preset_claude_bot', harness: 'claude', name: 'Claude', model: null, reasoning: null, serviceTier: null, look: null }] });
    setAssistant(settings, { presetId: 'preset_claude_bot' });
    assert.equal(assistant.state().voice.available, false);
    await assert.rejects(assistant.startVoice('on-claude'), /no voice/);
    setAssistant(settings, { presetId: 'preset_fast' });

    // A launch already under way when it is turned off is stopped without
    // delivering what the inbox holds; the next launch delivers it.
    await saveAssistant({ enabled: false });
    inbox.setFocus(ASSISTANT_BOT_ID, true);
    assert.ok(inbox.holdFor(ASSISTANT_BOT_ID, { kind: 'agent_message', sourceProcessId: 'proc-x', title: 'Held', body: 'Held while off' }));
    inbox.setFocus(ASSISTANT_BOT_ID, false);
    assert.equal(inbox.focus(ASSISTANT_BOT_ID).pending, 1);
    // On again without starting it, so a start can race turning it off.
    setAssistant(settings, { enabled: true });
    let releaseLaunch!: () => void;
    launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
    const promptsBeforeOff = prompts.length;
    const racing = assistant.ensure();
    await wait(5);
    const turningOff = saveAssistant({ enabled: false });
    await wait(5);
    releaseLaunch();
    await racing;
    await turningOff;
    await wait(20);
    assert.equal(launches[9]!.resume?.resume_id, 'thread-7');
    assert.equal(assistant.state().process_id, null);
    assert.equal(prompts.length, promptsBeforeOff, 'nothing is delivered to a launch that is being stopped');
    assert.equal(inbox.focus(ASSISTANT_BOT_ID).pending, 1);
    await saveAssistant({ enabled: true });
    await wait(20);
    assert.equal(inbox.focus(ASSISTANT_BOT_ID).pending, 0);
    assert.match(prompts.slice(promptsBeforeOff).join('\n'), /Held while off/);
    // Turning Focus mode off for the assistant ends a focus it was in.
    inbox.setFocus(ASSISTANT_BOT_ID, true);
    await saveAssistant({ focus: false });
    assert.equal(inbox.focus(ASSISTANT_BOT_ID).enabled, false);
    assert.throws(() => assistant.setFocus(true), /doesn't use Focus mode/);
    assert.equal(inbox.holdFor(ASSISTANT_BOT_ID, { kind: 'agent_message', title: 'x', body: 'y' }), false, 'nothing is held for a bot without Focus mode');
    await saveAssistant({ focus: true });
    assistant.dispose();
    const liveIdentity = (db.prepare(`select mcp_identity, process_id from sessions where session_role = 'assistant' and exited_at is null order by started_at desc limit 1`).get() as { mcp_identity: string; process_id: string });

    // The assistant's context names its cross-project role.
    assert.match(new AgentContextService().buildAssistant(), /assistant_overview/);
    assert.match(new AgentContextService().buildAssistant(), /never invent labels from IDs/);

    // MCP: the assistant is scoped like the owner across workspace projects,
    // and must name a project; other agents stay in their own.
    const agent = (id: string, project: string, role: string) => {
      db.prepare(`insert into processes(id,project_id,kind,name,status,created_at,updated_at) values(?,?,'agent',?,'running',?,?)`).run(`proc-${id}`, project, id, now, now);
      db.prepare(`insert into sessions(id,project_id,process_id,harness,session_role,started_at,cwd,mcp_identity) values(?,?,?,?,?,?,?,?)`)
        .run(id, project, `proc-${id}`, 'claude', role, now, dir, `mcp-${id}`);
    };
    agent('worker-p', 'p', 'orchestrator');
    agent('worker-q', 'q', 'orchestrator');
    const timeline = new TimelineService(database);
    const registry = createTestMcpRegistry({ tempDir: dir, database, timeline, terminal: { request: async () => ({}) } as unknown as TerminalService, workbench });
    const assistantIdentity = { identity: liveIdentity.mcp_identity };

    const overview = await registry.callPublic('assistant_overview', {}, assistantIdentity) as { projects: Array<{ project_id: string; processes: Array<{ process_id: string }> }> };
    assert.deepEqual(overview.projects.map((project) => project.project_id), ['p', 'q']);
    assert.ok(overview.projects[0]!.processes.some((process) => process.process_id === 'proc-worker-p'));
    await assert.rejects(registry.callPublic('assistant_overview', {}, { identity: 'mcp-worker-p' }), /only the assistant/);

    const listed = await registry.callPublic('list_processes', { project_id: 'q' }, assistantIdentity) as { processes: Array<{ process_id: string }> };
    assert.ok(listed.processes.some((process) => process.process_id === 'proc-worker-q'));
    await assert.rejects(registry.callPublic('list_processes', {}, assistantIdentity), /pass a project_id/);
    await assert.rejects(registry.callPublic('list_processes', { project_id: ASSISTANT_PROJECT_ID }, assistantIdentity), /not a workspace project/);
    const status = await registry.callPublic('get_process_status', { process_id: 'proc-worker-q' }, assistantIdentity) as { process_id: string };
    assert.equal(status.process_id, 'proc-worker-q');
    const projectStatus = await registry.callPublic('get_project_status', {}, assistantIdentity) as { projects?: unknown[] };
    assert.equal(projectStatus.projects?.length, 2, 'get_project_status without a project is the overview');
    await assert.rejects(registry.callPublic('spawn_agent', { agent: 'claude' }, assistantIdentity), /pass the project_id/);

    await assert.rejects(registry.callPublic('get_process_status', { process_id: 'proc-worker-q' }, { identity: 'mcp-worker-p' }), /outside the current caller scope/);
    await assert.rejects(registry.callPublic('spawn_agent', { agent: 'claude', project_id: 'q' }, { identity: 'mcp-worker-p' }), /outside the current caller scope/);
    // Todos and other project context work in a named workspace project.
    const todo = await registry.callPublic('todo_create', { project_id: 'q', title: 'Follow up on the build' }, assistantIdentity) as { todo?: { id: string; project_id: string } } & { id?: string; project_id?: string };
    assert.equal((todo.todo ?? todo).project_id, 'q');
    await assert.rejects(registry.callPublic('todo_list', {}, assistantIdentity), /must pass a workspace project_id/);
    await assert.rejects(registry.callPublic('todo_list', { project_id: ASSISTANT_PROJECT_ID }, assistantIdentity), /must pass a workspace project_id/);
    await assert.rejects(registry.callPublic('todo_list', { project_id: 'q' }, { identity: 'mcp-worker-p' }), /outside the caller scope/);
    const whoami = await registry.callPublic('whoami', {}, assistantIdentity) as { role: string };
    assert.equal(whoami.role, 'assistant');

    // Project management: the assistant lists, registers, and renames
    // workspace projects. Other agents and workspace routines see none of it,
    // and removal stays an owner action behind the UI's confirmation.
    agent('routine-r', 'p', 'routine');
    const projectTools = ['assistant_project_list', 'assistant_project_create', 'assistant_project_rename'];
    const assistantCatalog = registry.publicTools(assistantIdentity).map(({ name }) => name);
    for (const name of projectTools) assert.ok(assistantCatalog.includes(name), `${name} is in the assistant's catalogue`);
    assert.ok(!assistantCatalog.includes('project_remove') && !assistantCatalog.includes('project_create'), 'owner project tools stay hidden from the assistant');
    await assert.rejects(registry.callPublic('project_remove', { project_id: 'q' }, assistantIdentity), /unknown MCP tool/);
    for (const identity of ['mcp-worker-p', 'mcp-routine-r']) {
      const catalog = registry.publicTools({ identity }).map(({ name }) => name);
      for (const name of projectTools) {
        assert.ok(!catalog.includes(name), `${name} is not offered to ${identity}`);
        await assert.rejects(registry.callPublic(name, { path: dir, project_id: 'p', name: 'x' }, { identity }), /Only the assistant session can manage projects/);
      }
    }
    assert.ok(!registry.publicTools({ identity: null }).some(({ name }) => projectTools.includes(name)), 'an anonymous socket caller is not offered them');
    await assert.rejects(registry.call('assistant_project_list', {}, { remote: { host_id: 'h', host_name: 'peer', project_id: 'p' } }), /only the assistant/, 'a paired host cannot manage projects');

    const listProjects = async () => (await registry.callPublic('assistant_project_list', {}, assistantIdentity) as { projects: Array<{ project_id: string; name: string; path: string }> }).projects;
    assert.deepEqual((await listProjects()).map((project) => project.project_id), ['p', 'q'], 'lists workspace projects, not the assistant\'s own');
    assert.equal((await listProjects())[0]!.path, dir);

    type Created = { project_id: string; name: string; path: string; existed: boolean; created_directory: boolean };
    const create = (args: Record<string, unknown>) => registry.callPublic('assistant_project_create', args, assistantIdentity) as Promise<Created>;
    const createSchema = registry.helpPublic('assistant_project_create').inputSchema as { properties: Record<string, { default?: unknown }>; required: string[]; additionalProperties: boolean };
    assert.deepEqual(createSchema.required, ['path']);
    assert.equal(createSchema.properties.create_directory?.default, false, 'creating the directory is opt-in');
    assert.equal(createSchema.additionalProperties, false);
    await assert.rejects(create({ path: dir, mkdir: true }), /Unrecognized key/, 'a misspelled option is rejected, not ignored');

    // Registering an existing folder.
    const existing = path.join(dir, 'existing');
    fs.mkdirSync(existing);
    const registered = await create({ path: existing, name: 'Existing app' });
    assert.deepEqual([registered.name, registered.path, registered.existed, registered.created_directory], ['Existing app', existing, false, false]);
    const again = await create({ path: `${existing}/`, name: 'Other name' });
    assert.deepEqual([again.project_id, again.name, again.existed], [registered.project_id, 'Existing app', true], 'registering a path again returns the project unchanged');

    // A missing folder fails unless the caller asks for it to be created.
    const freshDir = path.join(dir, 'freshDir');
    await assert.rejects(create({ path: freshDir }), /path does not exist/);
    assert.ok(!fs.existsSync(freshDir), 'registering does not create the folder');
    const made = await create({ path: freshDir, create_directory: true });
    assert.deepEqual([made.name, made.existed, made.created_directory], ['freshDir', false, true]);
    assert.ok(fs.statSync(freshDir).isDirectory());
    const remade = await create({ path: freshDir, create_directory: true });
    assert.deepEqual([remade.project_id, remade.existed, remade.created_directory], [made.project_id, true, false], 'create-and-register is idempotent');
    await assert.rejects(create({ path: path.join(dir, 'missing-parent', 'app'), create_directory: true }), /parent directory does not exist/);
    assert.ok(!fs.existsSync(path.join(dir, 'missing-parent')), 'a missing parent is not created');
    fs.writeFileSync(path.join(dir, 'a-file'), 'x');
    await assert.rejects(create({ path: path.join(dir, 'a-file'), create_directory: true }), /not a directory/);
    await assert.rejects(create({ path: 'relative/app', create_directory: true }), /must be absolute/);
    assert.ok(!fs.existsSync(path.join(process.cwd(), 'relative')), 'a relative path creates nothing');
    const internal = db.prepare('select path from projects where id = ?').get(ASSISTANT_PROJECT_ID) as { path: string };
    await assert.rejects(create({ path: internal.path }), /internal project/, 'the assistant\'s own project is never handed back');
    if (trySymlink(internal.path, path.join(dir, 'internal-alias'), 'dir')) {
      await assert.rejects(create({ path: path.join(dir, 'internal-alias') }), /internal project/, 'nor registered again through a symlink');
    }
    // Windows real paths keep the link target's case, so a junction to the
    // same folder spelled in lower case must still match.
    if (process.platform === 'win32' && trySymlink(internal.path.toLowerCase(), path.join(dir, 'internal-junction'), 'junction')) {
      await assert.rejects(create({ path: path.join(dir, 'internal-junction') }), /internal project/, 'nor through a link whose target differs in case');
    }
    assert.deepEqual((await listProjects()).map((project) => project.project_id).sort(), ['p', 'q', registered.project_id, made.project_id].sort());

    // Renaming changes only the display name, and only for workspace projects.
    const renamed = await registry.callPublic('assistant_project_rename', { project_id: made.project_id, name: '  Fresh app ' }, assistantIdentity) as { name: string };
    assert.equal(renamed.name, 'Fresh app');
    assert.ok(fs.existsSync(freshDir), 'the folder keeps its name');
    await assert.rejects(registry.callPublic('assistant_project_rename', { project_id: ASSISTANT_PROJECT_ID, name: 'Mine' }, assistantIdentity), /unknown project/);
    await assert.rejects(registry.callPublic('assistant_project_rename', { project_id: 'q', name: '   ' }, assistantIdentity), /too_small|at least 1/);
    const created = db.prepare(`select actor_type, actor_id from timeline_events where event_type = 'project.created' and project_id = ?`).get(made.project_id) as { actor_type: string; actor_id: string };
    assert.deepEqual({ ...created }, { actor_type: 'agent', actor_id: liveIdentity.process_id }, 'the timeline records the assistant as the actor');
    console.log('assistant smoke passed');
  } finally {
    database.dispose();
    removeTree(dir);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
