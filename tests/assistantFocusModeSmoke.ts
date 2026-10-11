import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { AssistantInbox } from '../app/Services/AssistantInbox';
import { AssistantService, type AssistantEvent } from '../app/Services/AssistantService';
import type { CodexRealtimeEvent } from '../app/Services/CodexAppServerService';
import { DatabaseService } from '../app/Services/DatabaseService';
import type { LaunchHarnessInput, HarnessResume } from '../app/Services/HarnessLauncher';
import { NotificationService, type NotificationRecord } from '../app/Services/NotificationService';
import { SettingsService } from '../app/Services/SettingsService';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { TimerService } from '../app/Services/TimerService';
import { AgentContextService } from '../app/Services/AgentContextService';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';
import { registerAssistantTools } from '../app/MCP/registerAssistantTools';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DIGEST_MS = 10;

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-focus-'));
  const database = new DatabaseService(dir);
  try {
    database.initialize();
    const db = database.connection;
    const now = new Date().toISOString();
    db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run('p', 'Project p', dir, now, now);
    const settings = new SettingsService(database);
    const workbench = new WorkbenchRepository(database, settings);
    const timeline = new TimelineService(database);

    let sequence = 0;
    const register = (input: LaunchHarnessInput, resume: HarnessResume | null) => {
      sequence += 1;
      const processId = `proc-assistant-${sequence}`;
      db.prepare(`insert into processes(id,project_id,kind,name,status,created_at,updated_at) values(?,?,'agent','Assistant','running',?,?)`).run(processId, input.project_id, now, now);
      db.prepare(`insert into sessions(id,project_id,process_id,harness,interface_mode,session_role,started_at,cwd,mcp_identity,resume_id) values(?,?,?,?,?,?,?,?,?,?)`)
        .run(`session-assistant-${sequence}`, input.project_id, processId, 'codex', 'integrated', 'assistant', new Date(Date.now() + sequence).toISOString(), dir, `mcp-assistant-${sequence}`, resume?.resume_id ?? `thread-${sequence}`);
      return { session_id: `session-assistant-${sequence}`, process_id: processId, pty_process_id: null, interface_mode: 'integrated' as const, harness: 'codex', name: 'Assistant' };
    };
    const launcher = { launch: async (input: LaunchHarnessInput) => register(input, null), resume: async (input: LaunchHarnessInput, resume: HarnessResume) => register(input, resume) };

    // Everything that reaches the assistant's thread or voice session.
    const prompts: Array<{ processId: string; text: string }> = [];
    const appended: string[] = [];
    let promptGate: Promise<void> | null = null;
    let promptResult: { delivery?: string } | Error = {};
    const integrated = {
      prompt: async (processId: string, input: unknown) => {
        if (promptGate) await promptGate;
        if (promptResult instanceof Error) throw promptResult;
        prompts.push({ processId, text: String(input) });
        return promptResult;
      },
      conversation: async () => ({ messages: { data: [] } })
    };
    const realtime = new Set<(event: CodexRealtimeEvent) => void>();
    const codex = {
      realtimeStart: async () => ({ sdp: 'answer' }),
      realtimeStop: async () => undefined,
      realtimeAppendText: async (_processId: string, text: string) => { appended.push(text); },
      onRealtime: (_processId: string, listener: (event: CodexRealtimeEvent) => void) => { realtime.add(listener); return () => realtime.delete(listener); }
    };
    const terminal = { request: async () => ({}) } as unknown as TerminalService;
    const build = () => {
      const inbox = new AssistantInbox(database);
      const assistant = new AssistantService(database, dir, launcher, codex, integrated, settings, inbox, { stop: async () => undefined, transferTimers: () => undefined }, { digestDelayMs: DIGEST_MS });
      assistant.start();
      return { inbox, assistant };
    };
    let { inbox, assistant } = build();
    const events: AssistantEvent[] = [];
    assistant.onEvent((event) => events.push(event));
    const assistantId = (await assistant.ensure()).process_id!;
    const toAssistant = () => prompts.filter((prompt) => prompt.processId === assistantId);

    // A worker the assistant spawned, and an unrelated agent.
    const agent = (id: string, parent: string | null) => {
      db.prepare(`insert into processes(id,project_id,parent_process_id,kind,name,status,created_at,updated_at) values(?,?,?,'agent',?,'running',?,?)`).run(`proc-${id}`, 'p', parent, id, now, now);
      db.prepare(`insert into sessions(id,project_id,process_id,harness,interface_mode,session_role,started_at,cwd,mcp_identity) values(?,?,?,?,?,?,?,?,?)`)
        .run(id, 'p', `proc-${id}`, 'codex', 'integrated', parent ? 'child' : 'orchestrator', now, dir, `mcp-${id}`);
    };
    agent('worker', assistantId);
    agent('other', null);

    const timers = new TimerService(database, terminal, { integrated, assistantInbox: inbox });
    const registry = createTestMcpRegistry({ tempDir: dir, database, timeline, terminal, workbench, integrated: integrated as never, assistant, assistantInbox: inbox, timers });
    const asAssistant = { identity: `mcp-assistant-${sequence}` };
    const asWorker = { identity: 'mcp-worker' };
    const ui = new McpToolRegistry();
    registerAssistantTools(ui, assistant, settings);
    const notification = (id: string, overrides: Partial<NotificationRecord> = {}): NotificationRecord => ({
      id, project_id: 'p', process_id: 'proc-other', session_id: null, source: 'integrated', kind: 'turn_finished', urgency: 'normal', delivery: 'all', audience: 'user',
      routed_to_process_id: null, title: 'other', body: 'Finished its turn', occurrences: 1, created_at: now, updated_at: now,
      read_at: null, resolved_at: null, url: '/', project_name: 'Project p', process_name: 'other', ...overrides
    });

    // Focus is off by default, and an unfocused assistant hears notifications as before.
    assert.deepEqual(assistant.state().focus, { enabled: false, since: null, pending: 0 });
    assistant.handleNotification({ type: 'raised', notification: notification('n0') });
    await wait(DIGEST_MS * 4);
    assert.equal(toAssistant().length, 1);
    assert.match(toAssistant()[0]!.text, /^\[Patterm notifications\]/);
    prompts.length = 0;

    // Only the assistant can set focus over MCP; the UI has its own control.
    await assert.rejects(registry.callPublic('assistant_focus_set', { enabled: true }, asWorker), /only the assistant/);
    await assert.rejects(registry.callPublic('assistant_focus', {}, asWorker), /only the assistant/);
    await assert.rejects(registry.callPublic('assistant_focus_set', { enabled: 'yes' }, asAssistant));
    const focused = await registry.callPublic('assistant_focus_set', { enabled: true }, asAssistant) as { enabled: boolean; since: string | null; pending: number };
    assert.equal(focused.enabled, true);
    assert.ok(focused.since);
    assert.ok(events.some((event) => event.type === 'state' && event.state.focus.enabled), 'clients hear focus changes');
    assert.equal((await ui.call('assistant_set_focus_mode', { enabled: true }) as { focus: { enabled: boolean } }).focus.enabled, true, 'setting it again is harmless');

    // While focused, nothing unprompted reaches the thread.
    // 1. Notification digests, with repeats from one source coalesced.
    assistant.handleNotification({ type: 'raised', notification: notification('n1', { body: 'First finish' }) });
    assistant.handleNotification({ type: 'raised', notification: notification('n2', { body: 'Second finish' }) });
    assistant.handleNotification({ type: 'raised', notification: notification('n3', { kind: 'permission', title: 'other', body: 'Waiting for your permission' }) });
    // 2. Agent messages, through send_message.
    const sent = await registry.callPublic('send_message', { target_process_id: 'assistant', message: 'Build is green.' }, { identity: 'mcp-other' }) as { ok: boolean; delivery?: string; detail?: string };
    assert.equal(sent.ok, true);
    assert.equal(sent.delivery, 'queued');
    assert.match(sent.detail!, /do not resend/);
    // 3. Report timers and reports from the assistant's children.
    timers.setReport({ kind: 'report_all', watched: ['proc-worker'], ownerProcessId: assistantId, body: 'worker done' });
    const reported = await registry.callPublic('report_to_parent', { status: 'completed', title: 'Fixed login', body: `Details:\n${'x'.repeat(5_000)}` }, asWorker) as { ok: boolean; delivery?: string };
    assert.equal(reported.delivery, 'queued');
    // 4. The assistant's own delay timers.
    timers.setDelay({ seconds: 0.01, ownerProcessId: assistantId, body: '[system] timer check-in fired' });
    // 5. A child's notify_user, routed to its parent.
    const notices = new NotificationService(database, settings, timeline,
      async (processId, text, from) => { if (!inbox.holdNotice(processId, text, from)) prompts.push({ processId, text }); }, () => undefined);
    assert.equal((await notices.raise({ processId: 'proc-worker', source: 'mcp', kind: 'attention', title: 'Need a decision', body: 'Which database?' })).status, 'routed_to_parent');
    await wait(1_200);
    assert.deepEqual(toAssistant(), [], 'focus holds every unprompted path');
    // Workers carry on, and the user still sees their notifications in the app.
    assert.equal((db.prepare(`select status from processes where id = 'proc-worker'`).get() as { status: string }).status, 'running');
    // A child's reply to its parent assistant is held like any agent message.
    assert.equal((await registry.callPublic('send_message', { target_process_id: 'parent', message: 'ping' }, asWorker) as { delivery?: string }).delivery, 'queued');
    // Other agents are not affected by the assistant's focus.
    await registry.callPublic('send_message', { target_process_id: 'proc-other', message: 'hello other' }, asAssistant);
    assert.ok(prompts.some((prompt) => prompt.processId === 'proc-other'), 'the assistant still messages agents while focused');

    const held = await registry.callPublic('assistant_focus', {}, asAssistant) as { focus: { pending: number }; items: Array<{ kind: string; occurrences: number; body: string }>; total: number };
    // Timers fire on their own schedule, so only the first items' order is fixed.
    assert.deepEqual(held.items.slice(0, 4).map((item) => item.kind), ['notification', 'notification', 'agent_message', 'report']);
    const kinds = held.items.map((item) => item.kind).sort();
    assert.deepEqual(kinds, ['agent_message', 'agent_message', 'agent_notice', 'notification', 'notification', 'report', 'timer', 'timer']);
    assert.equal(held.total, held.focus.pending);
    assert.equal(held.items[0]!.occurrences, 2, 'repeated notifications from one source coalesce');
    assert.match(held.items[0]!.body, /Second finish/, 'the latest repeat wins');
    assert.equal(assistant.state().focus.pending, held.total);

    // Voice still works while focused, and stays quiet.
    await assistant.startVoice('offer');
    assistant.handleNotification({ type: 'raised', notification: notification('n4', { kind: 'failure', process_id: 'proc-worker', title: 'worker', body: 'Exited with code 1' }) });
    await wait(DIGEST_MS * 4);
    assert.deepEqual(appended, [], 'a focused voice session hears nothing unprompted');
    await assistant.stopVoice();

    // A restart keeps focus and every held item.
    assistant.dispose();
    timers.dispose();
    ({ inbox, assistant } = build());
    const pendingBefore = inbox.focus().pending;
    assert.equal(inbox.focus().enabled, true);
    assert.equal(pendingBefore, held.total + 1);
    // A crash mid-flush leaves a claimed digest; recovery delivers it again rather than losing it.
    assert.ok(inbox.claim());
    assistant.handleNotification({ type: 'raised', notification: notification('n5', { body: 'Third finish' }) });
    assistant.dispose();
    ({ inbox, assistant } = build());
    assert.equal(inbox.focus().pending, pendingBefore, 'a claimed repeat folds into its newer pending copy');
    assert.equal(inbox.list({ limit: 100, offset: 0 }).items.find((item) => item.kind === 'notification')!.occurrences, 3);

    // Turning focus off delivers one bounded digest, oldest first.
    prompts.length = 0;
    assistant.setFocus(false);
    await wait(20);
    assert.equal(toAssistant().length, 1, 'one turn, not one per item');
    const digest = toAssistant()[0]!.text;
    const digestId = /\[Patterm focus digest (digest_[\w-]+):/.exec(digest)?.[1];
    assert.ok(digestId);
    assert.match(digest, /not the user; they approve nothing/);
    assert.match(digest, /Read every item in full with assistant_focus digest_id/);
    assert.ok(digest.indexOf('Third finish') < digest.indexOf('Build is green') && digest.indexOf('Build is green') < digest.indexOf('Fixed login'), 'items keep their order');
    assert.match(digest, /\(3 times\)/);
    assert.ok(digest.length < 6_000, 'the digest is bounded');
    assert.equal(assistant.state().focus.pending, 0);
    // The full items stay readable.
    const full = await registry.callPublic('assistant_focus', { digest_id: digestId }, { identity: `mcp-assistant-${sequence}` }) as { items: Array<{ kind: string; body: string; delivery: string }> };
    assert.ok(full.items.find((item) => item.kind === 'report')!.body.length > 5_000);
    assert.ok(full.items.every((item) => item.delivery === 'delivered'));
    // Nothing is delivered twice.
    assistant.setFocus(false);
    await wait(20);
    assert.equal(toAssistant().length, 1);

    // Unfocused, deliveries go straight through again.
    assert.deepEqual(await assistant.deliverAgentMessage('proc-other', 'direct'), { process_id: assistantId, delivery: 'delivered' });
    prompts.length = 0;

    // Large backlogs name twelve items and count the rest.
    assistant.setFocus(true);
    for (let index = 0; index < 20; index += 1) await assistant.deliverAgentMessage('proc-other', `message ${index}`);
    assistant.setFocus(false);
    await wait(20);
    assert.equal(toAssistant().length, 1);
    assert.match(toAssistant()[0]!.text, /- 8 more: 8 agent_message/);
    assert.doesNotMatch(toAssistant()[0]!.text, /message 12/);
    prompts.length = 0;

    // Race: items arriving during a flush wait for the next digest, never overtaking it.
    assistant.setFocus(true);
    await assistant.deliverAgentMessage('proc-other', 'before off');
    let openGate!: () => void;
    promptGate = new Promise((resolve) => { openGate = resolve; });
    assistant.setFocus(false);
    await wait(5);
    const during = await assistant.deliverAgentMessage('proc-other', 'during flush');
    assert.equal(during.delivery, 'queued', 'a backlog keeps later items behind it');
    // Focus turned back on mid-flush holds the newer item.
    assistant.setFocus(true);
    promptGate = null;
    openGate();
    await wait(20);
    assert.equal(toAssistant().length, 1);
    assert.match(toAssistant()[0]!.text, /before off/);
    assert.doesNotMatch(toAssistant()[0]!.text, /during flush/);
    assert.equal(assistant.state().focus.pending, 1);
    assistant.setFocus(false);
    await wait(20);
    assert.equal(toAssistant().length, 2);
    assert.match(toAssistant()[1]!.text, /during flush/);
    prompts.length = 0;

    // Focus started while a notification batch gathered holds the batch.
    assistant.handleNotification({ type: 'raised', notification: notification('n6', { body: 'Late finish' }) });
    assistant.setFocus(true);
    await wait(DIGEST_MS * 4);
    assert.deepEqual(toAssistant(), []);
    assert.equal(assistant.state().focus.pending, 1);

    // A failed delivery keeps the items; an uncertain one is never resent.
    promptResult = new Error('thread busy');
    assistant.setFocus(false);
    await wait(20);
    assert.equal(assistant.state().focus.pending, 1, 'a definitive failure keeps every item');
    promptResult = { delivery: 'uncertain' };
    assistant.setFocus(false);
    await wait(20);
    assert.equal(assistant.state().focus.pending, 0);
    assert.equal(toAssistant().length, 1);
    promptResult = {};
    prompts.length = 0;

    // Ending focus during a voice session speaks one short digest.
    await assistant.startVoice('offer-2');
    assistant.setFocus(true);
    await assistant.deliverAgentMessage('proc-other', 'Deploy finished.');
    assistant.setFocus(false);
    await wait(20);
    assert.equal(appended.length, 1);
    assert.match(appended[0]!, /not from the user\. Focus mode ended/);
    assert.match(appended[0]!, /Deploy finished\./);
    assert.deepEqual(toAssistant(), []);
    await assistant.stopVoice();

    // Held items wait for a stopped assistant and arrive when it resumes.
    assistant.setFocus(true);
    await assistant.deliverAgentMessage('proc-other', 'While you were away.');
    db.prepare(`update processes set status = 'exited' where id = ?`).run(assistantId);
    db.prepare(`update sessions set exited_at = ? where process_id = ?`).run(now, assistantId);
    assistant.setFocus(false);
    await wait(20);
    assert.equal(assistant.state().focus.pending, 1);
    const resumed = (await assistant.ensure()).process_id!;
    await wait(20);
    assert.ok(prompts.some((prompt) => prompt.processId === resumed && /While you were away/.test(prompt.text)));
    assert.equal(assistant.state().focus.pending, 0);

    // The assistant is told how to use focus.
    assert.match(new AgentContextService().buildAssistant(), /let's go focus mode on this/);
    assistant.dispose();
    console.log('assistant focus mode smoke passed');
  } finally {
    database.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
