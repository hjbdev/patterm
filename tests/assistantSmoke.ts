import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';
import { registerAssistantTools } from '../app/MCP/registerAssistantTools';
import { INTEGRATED_CONTROL_TOOLS } from '../app/Http/BrowserTools';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { ASSISTANT_PROJECT_ID, AssistantService, type AssistantEvent } from '../app/Services/AssistantService';
import { AssistantInbox } from '../app/Services/AssistantInbox';
import type { CodexRealtimeEvent, RealtimeInitialItem } from '../app/Services/CodexAppServerService';
import type { IntegratedConversationMessage } from '../app/Services/IntegratedConversation';
import { voiceBrief } from '../app/Services/AssistantVoiceBrief';
import { DatabaseService } from '../app/Services/DatabaseService';
import type { LaunchHarnessInput, HarnessResume } from '../app/Services/HarnessLauncher';
import type { NotificationRecord } from '../app/Services/NotificationService';
import { DEFAULT_ASSISTANT_SETTINGS, SettingsService } from '../app/Services/SettingsService';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { AgentContextService } from '../app/Services/AgentContextService';
import { assistantVoiceOptions, type RealtimeVoiceOptions } from '../app/Services/AssistantVoiceProfile';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';

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

    // Settings default, merge, and reject unknown voices.
    assert.deepEqual(settings.assistantSettings(), DEFAULT_ASSISTANT_SETTINGS);
    // Clients that predate the voice profile settings save Codex's defaults.
    assert.deepEqual(settings.updateAssistantSettings({ voice: 'maple', presetId: 'preset_fast', forwardNotifications: true }),
      { voice: 'maple', presetId: 'preset_fast', forwardNotifications: true, voiceProfile: 'codex', voiceAcknowledgements: 'default', userName: null });
    assert.throws(() => settings.updateAssistantSettings({ voice: 'robot', presetId: null, forwardNotifications: true }));
    assert.throws(() => settings.updateAssistantSettings({ voice: null, presetId: null, forwardNotifications: true, voiceProfile: 'chatty' }));
    assert.throws(() => settings.updateAssistantSettings({ voice: null, presetId: null, forwardNotifications: true, voiceAcknowledgements: 'loud' }));
    // Names are trimmed, a blank one is cleared, and long ones are rejected.
    const base = { voice: null, presetId: null, forwardNotifications: true };
    assert.equal(settings.updateAssistantSettings({ ...base, userName: '  Alex ' }).userName, 'Alex');
    assert.equal(settings.updateAssistantSettings({ ...base, userName: '   ' }).userName, null);
    assert.throws(() => settings.updateAssistantSettings({ ...base, userName: 'x'.repeat(61) }));
    settings.updateAssistantSettings({ voice: 'maple', presetId: 'preset_fast', forwardNotifications: true });

    // The Codex profile starts exactly the session Codex would; acknowledgements
    // are sent only when chosen explicitly.
    assert.deepEqual(assistantVoiceOptions({ voiceProfile: 'codex', voiceAcknowledgements: 'default', userName: 'Alex' }), {});
    assert.deepEqual(assistantVoiceOptions({ voiceProfile: 'codex', voiceAcknowledgements: 'on', userName: null }), { delegationAckFiller: true });
    assert.deepEqual(assistantVoiceOptions({ voiceProfile: 'codex', voiceAcknowledgements: 'off', userName: null }), { delegationAckFiller: false });
    // The Patterm profile replaces the voice and backend instructions and keeps
    // the acknowledgement choice in both the parameter and the prompt.
    const patterm = assistantVoiceOptions({ voiceProfile: 'patterm', voiceAcknowledgements: 'default', userName: null });
    assert.deepEqual(Object.keys(patterm).sort(), ['backendReasoningStatus', 'prompt', 'realtimeStartInstructions']);
    assert.equal(patterm.backendReasoningStatus, true);
    assert.match(patterm.prompt!, /Answer directly, without handing over/);
    assert.match(patterm.prompt!, /a short acknowledgement is welcome reassurance/);
    assert.doesNotMatch(patterm.prompt!, /\[USER\]|\[BACKEND\]|tool return/, 'no realtime v2 conventions');
    assert.match(patterm.realtimeStartInstructions!, /spawn_agent/);
    assert.match(patterm.realtimeStartInstructions!, /send_message/);
    assert.doesNotMatch(patterm.prompt!, /The user's name is/, 'no name is set');
    assert.match(assistantVoiceOptions({ voiceProfile: 'patterm', voiceAcknowledgements: 'default', userName: 'Alex' }).prompt!, /The user's name is Alex\./);
    const quiet = assistantVoiceOptions({ voiceProfile: 'patterm', voiceAcknowledgements: 'off', userName: null });
    assert.equal(quiet.delegationAckFiller, false);
    assert.match(quiet.prompt!, /do not add filler/);
    assert.equal(assistantVoiceOptions({ voiceProfile: 'patterm', voiceAcknowledgements: 'on', userName: null }).delegationAckFiller, true);
    // Codex caps start instructions at 8,192 estimated tokens (about 4 bytes
    // each); stay well inside it.
    for (const text of [patterm.prompt!, patterm.realtimeStartInstructions!]) assert.ok(Buffer.byteLength(text) < 8_000, 'voice instructions stay small');
    assert.equal(settings.assistantSettings().voice, 'maple');

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
      db.prepare(`insert into sessions(id,project_id,process_id,harness,interface_mode,session_role,started_at,cwd,mcp_identity,resume_id) values(?,?,?,?,?,?,?,?,?,?)`)
        .run(`session-assistant-${sequence}`, input.project_id, processId, 'codex', 'integrated', input.session_role, new Date(Date.now() + sequence).toISOString(), input.cwd ?? dir, `mcp-assistant-${sequence}`, resume?.resume_id ?? `thread-${sequence}`);
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
    const codex = {
      realtimeStart: async (_processId: string, input: VoiceOffer) => { voiceOffer = input; return { sdp: 'answer-sdp' }; },
      realtimeStop: async () => { stopped += 1; },
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
    const inbox = new AssistantInbox(database);
    const assistant = new AssistantService(database, dir, launcher, codex, integrated, settings, inbox, processes, { digestDelayMs: 10 });
    const events: AssistantEvent[] = [];
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
    assert.ok(!workbench.snapshot().projects.some((project) => project.project.id === ASSISTANT_PROJECT_ID));
    assert.ok(assistant.isAssistantProcess('proc-assistant-1'));
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
      id, project_id: 'p', process_id: 'proc-x', session_id: null, source: 'integrated', kind: 'permission', urgency: 'high', delivery: 'all', audience: 'user',
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
    assert.deepEqual(await assistant.startVoice('offer-sdp'), { sdp: 'answer-sdp' });
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
    settings.updateAssistantSettings({ ...settings.assistantSettings(), voiceProfile: 'patterm', voiceAcknowledgements: 'on', userName: 'Alex' });
    await assistant.startVoice('offer-2');
    assert.deepEqual((voiceOffer as { options?: RealtimeVoiceOptions } | null)?.options, assistantVoiceOptions({ voiceProfile: 'patterm', voiceAcknowledgements: 'on', userName: 'Alex' }));
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
    await assistant.stopVoice();
    assert.equal(stopped, 2, 'starting a new call stops the previous one');
    assert.equal(assistant.state().voice.active, false);

    // Forwarding can be turned off.
    settings.updateAssistantSettings({ voice: null, presetId: null, forwardNotifications: false });
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
    await wait(5);
    assert.equal(assistant.state().process_id, null, 'the old process has stopped');
    assert.ok(inbox.hold('proc-assistant-4', { kind: 'report', sourceProcessId: 'proc-helper', title: 'Report from proc-helper: completed', body: 'Done during the restart', dedupeKey: 'report:restart' }));
    assert.ok(!inbox.hold('proc-not-assistant', { kind: 'report', title: 'x', body: 'y' }), 'other processes are delivered as usual');
    const promptsBefore = prompts.length;
    openGate();
    assert.equal((await gated).process_id, 'proc-assistant-5');
    await wait(20);
    assert.match(prompts.slice(promptsBefore).join('\n'), /held while Focus mode was on or the assistant was not running[\s\S]*Report from proc-helper/);

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
    registerAssistantTools(ui, assistant, settings);
    assert.equal(ui.help('patterm.assistant.new').hidden, true);
    assert.ok(INTEGRATED_CONTROL_TOOLS.has('patterm.assistant.new'));
    db.prepare(`update processes set parent_process_id = 'proc-assistant-6', status = 'running' where id = 'proc-helper'`).run();
    await assistant.startVoice('before-new');
    await assert.rejects(ui.call('patterm.assistant.new', { process_id: 'proc-assistant-5' }), /already restarted/);
    const [fresh, whileNew] = await Promise.all([
      ui.call('patterm.assistant.new', { process_id: 'proc-assistant-6' }) as Promise<{ process_id: string }>,
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
    assistant.dispose();

    // The assistant's context names its cross-project role.
    assert.match(new AgentContextService().buildAssistant(), /assistant\.overview/);
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
    const assistantIdentity = { identity: 'mcp-assistant-8' };

    const overview = await registry.callPublic('assistant.overview', {}, assistantIdentity) as { projects: Array<{ project_id: string; processes: Array<{ process_id: string }> }> };
    assert.deepEqual(overview.projects.map((project) => project.project_id), ['p', 'q']);
    assert.ok(overview.projects[0]!.processes.some((process) => process.process_id === 'proc-worker-p'));
    await assert.rejects(registry.callPublic('assistant.overview', {}, { identity: 'mcp-worker-p' }), /only the assistant/);

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
    const todo = await registry.callPublic('todo.create', { project_id: 'q', title: 'Follow up on the build' }, assistantIdentity) as { todo?: { id: string; project_id: string } } & { id?: string; project_id?: string };
    assert.equal((todo.todo ?? todo).project_id, 'q');
    await assert.rejects(registry.callPublic('todo.list', {}, assistantIdentity), /must pass a workspace project_id/);
    await assert.rejects(registry.callPublic('todo.list', { project_id: ASSISTANT_PROJECT_ID }, assistantIdentity), /must pass a workspace project_id/);
    await assert.rejects(registry.callPublic('todo.list', { project_id: 'q' }, { identity: 'mcp-worker-p' }), /outside the caller scope/);
    const whoami = await registry.callPublic('whoami', {}, assistantIdentity) as { role: string };
    assert.equal(whoami.role, 'assistant');
    console.log('assistant smoke passed');
  } finally {
    database.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
