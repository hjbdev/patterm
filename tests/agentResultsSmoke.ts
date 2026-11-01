import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import type { AgentHistoryReadService } from '../app/Services/AgentHistory/AgentHistoryReadService';
import { snapshotText, tailUtf8, headUtf8 } from '../app/Services/ConversationText';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import type { TerminalService } from '../app/Services/TerminalService';
import { TimelineService } from '../app/Services/TimelineService';
import { createTestMcpRegistry } from './fixtures/McpRegistryFixture';
import { removeTree } from './fixtures/TempTree';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A snapshot shaped like the providers': rows, then harness metadata whose
// command catalogue used to be all a tail read returned.
function snapshot(rows: unknown[], extra: Record<string, unknown> = {}) {
  return {
    messages: { data: rows },
    permissions: { data: [] },
    questions: { data: [] },
    status: 'idle',
    commands: Array.from({ length: 200 }, (_, index) => ({ name: `skill-${index}`, description: 'A skill from the catalogue' })),
    revision: 19355,
    history_truncated: true,
    history_cursor: { next: 'native-1' },
    ...extra
  };
}

const liveRows = [
  { id: 'u1', role: 'user', kind: 'text', text: 'Investigate the flaky test' },
  { id: 'r1', role: 'assistant', kind: 'reasoning', text: 'Thinking about it' },
  { id: 't1', role: 'assistant', kind: 'tool', text: 'BUILD_READY on port 5173', title: 'Bash', tool: { name: 'Bash', input: { command: 'pnpm test\n--verbose' }, state: { status: 'completed' } } },
  { id: 's1', role: 'assistant', kind: 'text', text: 'subagent row', parentId: 't1' },
  { id: 'a2', role: 'assistant', kind: 'text', text: 'First finding.' },
  { id: 'u2', role: 'user', kind: 'text', text: 'Anything else?' },
  { id: 'n1', role: 'assistant', kind: 'notice', level: 'warning', text: 'Retrying' },
  { id: 'm1', role: 'assistant', kind: 'tool', text: 'sent', title: 'mcp__patterm__send_message', tool: { name: 'mcp__patterm__send_message', input: { target_process_id: 'parent', message: 'hi' } } },
  { id: 'a3', role: 'assistant', kind: 'text', text: 'The race is in the watcher.' },
  { id: 'a4', role: 'assistant', kind: 'text', text: 'Fixed by awaiting the flush. ✓' }
];
// The provider's own older page, in OpenCode's native shape: one assistant
// message whose parts are 30 tool calls and then text, so filtered pages are
// sparse. Parts become rows `<message id>-<part index>`.
const nativeRows = [
  { id: 'nu', type: 'user', content: [{ type: 'text', text: 'Earlier question' }], time: { created: 1 } },
  { id: 'nb', type: 'assistant', time: { created: 2 }, content: [
    ...Array.from({ length: 30 }, (_, index) => ({ type: 'tool', id: `call_${index}`, name: 'read', state: { status: 'completed', input: { filePath: `/tmp/f${index}` }, output: `output ${index}` } })),
    { type: 'text', text: 'Earlier answer' }
  ] }
];
const nativeToolIds = Array.from({ length: 30 }, (_, index) => `nb-${index}`);
// Imported history from before the live session, as the Claude importer
// stores it: tool output lives in toolOutputSummary, not text.
const archiveRows = [
  { id: 'h1', seq: 0, role: 'user', kind: 'message', text: 'Archived question', toolName: null, toolStatus: null, toolInputSummary: null, toolOutputSummary: null },
  { id: 'h2', seq: 1, role: 'assistant', kind: 'tool_call', text: '', toolName: 'Bash', toolStatus: null, toolInputSummary: '{"command":"pnpm test"}', toolOutputSummary: null },
  { id: 'h3', seq: 2, role: 'tool', kind: 'tool_result', text: '', toolName: 'Bash', toolStatus: 'completed', toolInputSummary: null, toolOutputSummary: '12 tests passed' },
  { id: 'h4', seq: 3, role: 'assistant', kind: 'message', text: 'Archived answer', toolName: null, toolStatus: null, toolInputSummary: null, toolOutputSummary: null }
];
// A live OpenCode agent's snapshot, in its native shape.
const openCodeSnapshot = {
  status: 'idle',
  history_cursor: null,
  messages: { data: [
    { id: 'oc_u', type: 'user', content: [{ type: 'text', text: 'Deploy it' }] },
    { id: 'oc_a', type: 'assistant', content: [
      { type: 'reasoning', text: 'Plan the deploy' },
      { type: 'tool', id: 'call_d', name: 'shell', state: { status: 'completed', input: { command: 'make deploy' }, output: 'DEPLOY_DONE in 4s' } },
      { type: 'text', text: 'Deployed.' }
    ] },
    // A child session's rows follow the parent's, marked with the tool row
    // that started them; this is OpenCode's native child prompt shape.
    { id: 'msg_sub_1', type: 'user', text: 'Look around', parentId: 'oc_a-1' },
    { id: 'msg_sub_2', type: 'assistant', content: [{ type: 'text', text: 'Child answer' }], parentId: 'oc_a-1' }
  ] }
};

async function main(): Promise<void> {
  // Rendering: readable rows with tool output, no snapshot metadata or reasoning.
  const text = snapshotText(snapshot(liveRows));
  assert.match(text, /^\[user\] Investigate the flaky test\n\n\[tool Bash\] pnpm test\nBUILD_READY on port 5173\n\n\[assistant\] First finding\./);
  for (const leaked of ['revision', 'history_cursor', 'skill-1', 'subagent row', 'Thinking']) assert.ok(!text.includes(leaked), `rendered text leaks ${leaked}`);
  assert.equal(tailUtf8('aé✓', 3).text, '✓');
  assert.equal(tailUtf8('aé✓', 4).text, '✓', 'a tail never starts inside a character');
  assert.equal(headUtf8('✓é', 4).text, '✓', 'a head never ends inside a character');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-agent-results-'));
  const database = new DatabaseService(dir);
  try {
    database.initialize();
    const db = database.connection;
    const now = new Date().toISOString();
    for (const id of ['p', 'q']) db.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run(id, `Project ${id}`, dir, now, now);
    const agent = (id: string, project: string, options: { mode?: string; role?: string; status?: string; activity?: string; resume?: string; parent?: string } = {}) => {
      db.prepare(`insert into processes(id,project_id,parent_process_id,kind,name,status,activity,created_at,updated_at) values(?,?,?,'agent',?,?,?,?,?)`)
        .run(`proc-${id}`, project, options.parent ?? null, id, options.status ?? 'running', options.activity ?? 'idle', now, now);
      db.prepare(`insert into sessions(id,project_id,process_id,harness,interface_mode,session_role,started_at,cwd,mcp_identity,resume_id) values(?,?,?,?,?,?,?,?,?,?)`)
        .run(id, project, `proc-${id}`, 'claude', options.mode ?? 'tui', options.role ?? 'orchestrator', now, dir, `mcp-${id}`, options.resume ?? null);
    };
    agent('live', 'p', { mode: 'integrated' });
    agent('tui', 'p', { resume: 'native-tui' });
    agent('old', 'p', { status: 'exited' });
    agent('other', 'q');
    db.prepare(`insert into projects(id,name,path,kind,created_at,updated_at) values('project_assistant','Assistant',?,'assistant',?,?)`).run(dir, now, now);
    agent('assistant', 'project_assistant', { role: 'assistant' });
    agent('helper', 'q', { parent: 'proc-assistant', role: 'worker' });
    agent('oc', 'p', { mode: 'integrated' });

    let liveSnapshot: Record<string, unknown> = snapshot(liveRows);
    const integrated = {
      prompt: async (_processId: string, text: string) => text.includes('maybe') ? { delivery: 'uncertain', message_id: null } : {},
      conversation: async (processId: string) => processId === 'proc-oc' ? openCodeSnapshot : liveSnapshot,
      olderMessages: async (_processId: string, cursor: string) => {
        if (cursor === 'native-1') return { messages: { data: nativeRows }, cursor: 'archive:1' };
        if (cursor === 'archive:1') return { messages: [], archived_messages: archiveRows, cursor: null };
        throw new Error(`unexpected cursor ${cursor}`);
      }
    } as unknown as Parameters<typeof createTestMcpRegistry>[0]['integrated'];
    const historyRows = Array.from({ length: 450 }, (_, index) => ({
      id: `h${index}`, seq: index, role: index % 2 ? 'assistant' : 'user', kind: index % 10 === 5 ? 'tool_call' : 'message', text: `history ${index}`, toolName: null, toolInputSummary: null, toolStatus: null
    }));
    let importedAt = '2000-01-01T00:00:00.000Z';
    const history = {
      conversationIdForSession: ({ sessionId }: { sessionId: string }) => sessionId === 'tui' || sessionId === 'old' ? `conv-${sessionId}` : null,
      tail: (_id: string, limit: number, beforeSeq?: number) => {
        const before = historyRows.filter((row) => row.seq < (beforeSeq ?? Infinity));
        return { conversation: { importedAt }, messages: before.slice(-limit), has_more: before.length > limit };
      }
    } as unknown as AgentHistoryReadService;
    const delivered: Array<{ from: string; message: string }> = [];
    let assistantRunning = true;
    let deliveryDelay = 0;
    const assistant = {
      deliverAgentMessage: async (from: string, message: string) => {
        if (!assistantRunning) throw new Error('send_message: the assistant is not running');
        if (deliveryDelay) await wait(deliveryDelay);
        delivered.push({ from, message });
        return { process_id: 'proc-assistant', delivery: message.startsWith('uncertain') ? 'uncertain' as const : 'delivered' as const };
      }
    };
    const terminalInputs: Array<Record<string, unknown>> = [];
    const ptyOutput = new Map<string, string>([['pty-dry-run', '[DRY RUN] 1 chunk\nDone in 1.6 min failures=0']]);
    const terminal = { request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'terminal.process.input') terminalInputs.push(params);
      if (method === 'terminal.process.search' && params.scope === 'all') {
        const lines = (ptyOutput.get(String(params.process_id)) ?? '').split('\n').filter((line) => line.includes(String(params.query)));
        return { scope: 'all', total: lines.length, matches: lines.slice(-1).map((text) => ({ line: 0, text })) };
      }
      return {};
    } } as unknown as TerminalService;
    const timeline = new TimelineService(database);
    const settings = new SettingsService(database);
    const registry = createTestMcpRegistry({ tempDir: dir, database, timeline, terminal, workbench: new WorkbenchRepository(database, settings), integrated, historyReadService: history, assistant });
    const worker = { identity: 'mcp-tui' };
    const assistantIdentity = { identity: 'mcp-assistant' };
    type Page = {
      messages: Array<{ id: string; title?: string; text: string; truncated: boolean }>; next_before: string | null; has_more: boolean; sources: string[];
      latest_answer?: { message_id: string; text?: string; truncated?: boolean; in_page?: true } | null; turn: { state: string };
      last_report: { status: string; title: string; body: string } | null; stale?: boolean; source_updated_at?: string; conversation_id?: string;
    };
    const read = (args: Record<string, unknown>, identity = worker) => registry.callPublic('get_conversation_output', args, identity) as Promise<Page>;
    const all = async (args: Record<string, unknown>) => {
      const ids: string[] = [];
      let before: string | undefined;
      for (let pages = 0; pages < 200; pages += 1) {
        const page = await read({ ...args, ...(before ? { before } : {}) });
        assert.ok(page.messages.length <= Number(args.limit ?? 20), 'a page never exceeds its limit');
        ids.unshift(...page.messages.map((message) => message.id));
        if (!page.has_more) return ids;
        assert.ok(page.next_before);
        before = page.next_before!;
      }
      throw new Error('paging did not finish');
    };

    // get_process_output: an Integrated agent reads as dialogue.
    const output = await registry.callPublic('get_process_output', { process_id: 'proc-live', max_lines: 3 }, worker) as { content: string; mode: string; status: string; activity: string; truncated: boolean; hint: string };
    assert.equal(output.mode, 'conversation');
    assert.equal(output.status, 'running');
    assert.equal(output.activity, 'idle');
    assert.equal(output.content, '[assistant] The race is in the watcher.\n\n[assistant] Fixed by awaiting the flush. ✓');
    assert.ok(output.truncated);
    assert.match(output.hint, /get_conversation_output/);
    const bytes = await registry.callPublic('get_process_output', { process_id: 'proc-live', max_bytes: 5 }, worker) as { content_bytes: number };
    assert.ok(bytes.content_bytes <= 5, 'max_bytes counts bytes');
    const found = await registry.callPublic('search_output', { process_id: 'proc-live', pattern: 'BUILD_READY' }, worker) as { matches: string[] };
    assert.deepEqual(found.matches, ['BUILD_READY on port 5173'], 'searches see tool output');
    // wait_for_pattern never blocks: it answers from what is already true,
    // or returns a watch whose callback arrives as a message later.
    type Watch = { status: string; line?: string; timer_id?: string; process_status?: string; exit_code?: number | null };
    const watch = (args: Record<string, unknown>) => registry.callPublic('wait_for_pattern', args, worker) as Promise<Watch>;
    const already = await watch({ process_id: 'proc-live', pattern: 'BUILD_READY' });
    assert.deepEqual([already.status, already.line], ['matched', 'BUILD_READY on port 5173'], 'pattern waits see tool output');
    db.prepare(`insert into processes(id,project_id,parent_process_id,kind,name,status,exit_code,pty_process_id,created_at,updated_at) values('proc-dry-run','p','proc-tui','command','dry-run','exited',0,'pty-dry-run',?,?)`).run(now, now);
    db.prepare(`insert into processes(id,project_id,parent_process_id,kind,name,status,pty_process_id,created_at,updated_at) values('proc-serve','p','proc-tui','command','serve','running','pty-serve',?,?)`).run(now, now);
    const ended = await watch({ process_id: 'proc-dry-run', pattern: 'Done in|FAILED', timeout_seconds: 900 });
    assert.deepEqual([ended.status, ended.process_status, ended.exit_code, ended.timer_id], ['exited', 'exited', 0, undefined], 'an exited process without the text answers at once, and the pattern is literal');
    assert.equal((await watch({ process_id: 'proc-dry-run', pattern: 'Done in' })).status, 'matched', 'output an exited process left is still matched');
    const started = Date.now();
    const pending = await watch({ process_id: 'proc-serve', pattern: 'ready on', timeout_seconds: 900, body: 'open the app' });
    assert.ok(Date.now() - started < 1000, 'a pending watch returns at once');
    assert.equal(pending.status, 'watching');
    const listed = (await registry.callPublic('timer_list', {}, worker) as Array<{ timer_id: string; kind: string; pattern?: string; owner_process_id: string }>).find((timer) => timer.timer_id === pending.timer_id);
    assert.deepEqual([listed?.kind, listed?.pattern, listed?.owner_process_id], ['output', 'ready on', 'proc-tui']);
    const inputsBefore = terminalInputs.length;
    ptyOutput.set('pty-serve', 'compiling\nready on http://localhost:5173');
    for (let attempt = 0; attempt < 40 && terminalInputs.length === inputsBefore; attempt += 1) await wait(50);
    assert.equal(terminalInputs.length, inputsBefore + 1, 'the watch calls its owner back');
    assert.match(String(terminalInputs.at(-1)?.text), /^\[Patterm wait_for_pattern timer_\w+: matched\]\n- proc-serve "serve": printed "ready on": ready on http:\/\/localhost:5173\n.*\nopen the app$/);
    const cancelled = await watch({ process_id: 'proc-serve', pattern: 'never printed' });
    await registry.callPublic('timer_cancel', { timer_id: cancelled.timer_id }, worker);
    await wait(1200);
    assert.equal(terminalInputs.length, inputsBefore + 1, 'a cancelled watch sends nothing');
    db.prepare(`delete from processes where id in ('proc-dry-run', 'proc-serve')`).run();

    // The first page: newest text rows, the latest answer, state, and report.
    timeline.append({ event_type: 'agent.reported', project_id: 'p', process_id: 'proc-live', actor_type: 'agent', metadata: { status: 'completed', title: 'Flake fixed', body: 'Awaited the flush.' } });
    const first = await read({ process_id: 'proc-live', limit: 3 });
    assert.deepEqual(first.messages.map((message) => message.id), ['u2', 'a3', 'a4']);
    assert.deepEqual(first.latest_answer, { message_id: 'a4', in_page: true }, 'the latest answer is the last assistant text, sent once in the page');
    const toolsOnly = await read({ process_id: 'proc-live', limit: 1, include: ['tools', 'notices'] });
    assert.deepEqual(toolsOnly.messages.map((message) => message.id), ['a4']);
    liveSnapshot = snapshot([...liveRows, { id: 'n2', role: 'assistant', kind: 'notice', level: 'info', text: 'Compacted' }]);
    const afterNotice = await read({ process_id: 'proc-live', limit: 1, include: ['notices'] });
    assert.deepEqual(afterNotice.messages.map((message) => message.id), ['n2']);
    assert.deepEqual(afterNotice.latest_answer, { message_id: 'a4', text: 'Fixed by awaiting the flush. ✓', truncated: false }, 'an answer outside the page is sent with the page');
    liveSnapshot = snapshot(liveRows);
    assert.equal(first.turn.state, 'ended');
    assert.deepEqual(first.sources, ['live']);
    assert.deepEqual([first.last_report?.status, first.last_report?.title, first.last_report?.body], ['completed', 'Flake fixed', 'Awaited the flush.']);

    // Paging runs from the live window through the provider's older page into
    // imported history, with no gaps or repeats, however small the pages.
    const expected = ['h1', 'h4', 'nu', 'nb-30', 'u1', 'a2', 'u2', 'a3', 'a4'];
    assert.deepEqual(await all({ process_id: 'proc-live', limit: 2 }), expected);
    assert.deepEqual(await all({ process_id: 'proc-live', limit: 1 }), expected, 'sparse pages still reach older text');
    const withTools = await all({ process_id: 'proc-live', limit: 7, include: ['tools', 'notices'] });
    assert.deepEqual(withTools, ['h1', 'h2', 'h3', 'h4', 'nu', ...nativeToolIds, 'nb-30', 'u1', 't1', 'a2', 'u2', 'n1', 'm1', 'a3', 'a4']);
    const named = (await read({ process_id: 'proc-live', include: ['tools'] })).messages.find((message) => message.id === 'm1') as { title?: string } | undefined;
    assert.equal(named?.title, 'mcp__patterm__send_message', 'tool rows keep the native tool name');
    const archivedTools = await read({ process_id: 'proc-live', limit: 2, include: ['tools'], before: (await read({ process_id: 'proc-live', limit: 39, include: ['tools'] })).next_before! });
    assert.equal(archivedTools.messages.find((message) => message.id === 'h3')?.text, '12 tests passed', 'archived tool results keep their output');
    assert.deepEqual(archivedTools.sources, ['archive']);
    const tool = (await read({ process_id: 'proc-live', include: ['tools'] })).messages.find((message) => message.id === 't1');
    assert.equal(tool?.text, 'pnpm test\nBUILD_READY on port 5173', 'tool rows carry their output');
    const deeper = await read({ process_id: 'proc-live', limit: 3, before: first.next_before });
    assert.equal(deeper.latest_answer, undefined, 'only the newest page carries the latest answer');

    // The byte budget is strict: rows that do not fit start the next page, and
    // only a row that alone exceeds it is cut.
    const tight = await read({ process_id: 'proc-live', limit: 100, max_bytes: 40 });
    const used = tight.messages.reduce((sum, message) => sum + Buffer.byteLength(message.text), 0);
    assert.ok(used <= 40, `page text is ${used} bytes`);
    assert.deepEqual(tight.messages.map((message) => message.id), ['a4']);
    const resumed = await read({ process_id: 'proc-live', limit: 100, max_bytes: 40, before: tight.next_before });
    assert.equal(resumed.messages.at(-1)?.id, 'a3', 'the row that did not fit starts the next page');
    const cut = await read({ process_id: 'proc-live', limit: 1, max_bytes: 6, before: tight.next_before });
    assert.deepEqual(cut.messages.map((message) => [message.id, message.text, message.truncated]), [['a3', 'The ra', true]]);
    // A Codex command row's title is the whole command; it counts and is cut.
    liveSnapshot = snapshot([...liveRows, { id: 'big', role: 'assistant', kind: 'tool', title: `cat <<EOF\n${'x'.repeat(5000)}\nEOF`, text: 'done', tool: { name: 'commandExecution', input: {} } }]);
    const titled = await read({ process_id: 'proc-live', limit: 5, include: ['tools'], max_bytes: 300 });
    const titledBytes = titled.messages.reduce((sum, message) => sum + Buffer.byteLength(message.title ?? '') + Buffer.byteLength(message.text), 0);
    assert.ok(titledBytes <= 300, `titles count against max_bytes (${titledBytes})`);
    assert.equal(Buffer.byteLength(titled.messages.find((message) => message.id === 'big')?.title ?? ''), 200);
    const tiny = await read({ process_id: 'proc-live', limit: 1, include: ['tools'], max_bytes: 10 });
    assert.deepEqual(tiny.messages.map((message) => [message.id, message.title, message.text, message.truncated]), [['big', 'cat <<EOF\n', '', true]], 'a lone oversized row is cut to the budget, title first');
    liveSnapshot = snapshot(liveRows);
    const longReport = 'r'.repeat(10_000);
    timeline.append({ event_type: 'agent.reported', project_id: 'p', process_id: 'proc-live', actor_type: 'agent', metadata: { status: 'completed', body: longReport } });
    const bounded = await read({ process_id: 'proc-live', limit: 1 }) as Page & { last_report: { body: string; truncated?: boolean } };
    assert.equal(Buffer.byteLength(bounded.last_report.body), 4000);
    assert.equal(bounded.last_report.truncated, true, 'report bodies are bounded');

    // Turn state follows activity and pending requests.
    // A live snapshot's status is fresher than the stored activity.
    db.prepare(`update processes set activity = 'idle' where id = 'proc-live'`).run();
    liveSnapshot = snapshot([...liveRows, { id: 'u3', role: 'user', kind: 'text', text: 'Now the docs' }], { status: 'working' });
    const working = await read({ process_id: 'proc-live' });
    assert.equal(working.turn.state, 'working');
    assert.equal(working.latest_answer, null, 'no answer since the latest prompt');
    // A cursor whose row has left the live window has expired.
    liveSnapshot = snapshot(liveRows.slice(6));
    await assert.rejects(read({ process_id: 'proc-live', limit: 3, before: first.next_before }), /cursor expired/);
    liveSnapshot = snapshot(liveRows, { permissions: { data: [{ id: 'perm' }] } });
    assert.equal((await read({ process_id: 'proc-live' })).turn.state, 'awaiting_permission');
    // Codex reports a pending question as permission activity.
    liveSnapshot = snapshot(liveRows, { status: 'permission', questions: { data: [{ id: 'q1' }] } });
    const question = await read({ process_id: 'proc-live', limit: 3 });
    assert.equal(question.turn.state, 'awaiting_answer');
    assert.equal((await read({ process_id: 'proc-live', limit: 3, before: question.next_before })).turn.state, 'awaiting_answer', 'older pages report the current turn state');
    liveSnapshot = snapshot(liveRows, { status: 'error' });
    assert.equal((await read({ process_id: 'proc-live' })).turn.state, 'errored');
    liveSnapshot = snapshot(liveRows, { status: 'failed' });
    db.prepare(`update processes set activity = 'working' where id = 'proc-live'`).run();
    assert.equal((await read({ process_id: 'proc-live' })).turn.state, 'working', 'an unknown snapshot status falls back to the stored activity');
    db.prepare(`update processes set activity = 'idle' where id = 'proc-live'`).run();
    liveSnapshot = snapshot(liveRows);
    await assert.rejects(read({ process_id: 'proc-live', before: 'not-a-cursor' }), /invalid cursor/);
    liveSnapshot = snapshot(liveRows, { history_unavailable: true, history_cursor: null });
    assert.equal((await read({ process_id: 'proc-live' }) as Page & { history_unavailable?: boolean }).history_unavailable, true, 'unreadable older history is flagged');
    liveSnapshot = snapshot(liveRows);

    // OpenCode's native rows read like any other agent's.
    const openCode = await read({ process_id: 'proc-oc', include: ['tools'] });
    assert.deepEqual(openCode.messages.map((message) => [message.id, message.text]), [['oc_u', 'Deploy it'], ['oc_a-1', 'make deploy\nDEPLOY_DONE in 4s'], ['oc_a-2', 'Deployed.']]);
    assert.deepEqual(openCode.latest_answer, { message_id: 'oc_a-2', in_page: true }, 'child-session rows are not the parent\'s');
    assert.ok(!openCode.messages.some((message) => message.id.startsWith('msg_sub')));
    const deploy = await registry.callPublic('search_output', { process_id: 'proc-oc', pattern: 'DEPLOY_DONE' }, worker) as { matches: string[] };
    assert.deepEqual(deploy.matches, ['DEPLOY_DONE in 4s'], 'searches see OpenCode tool output');

    // Terminal agents page through imported history, flagged when it may be behind.
    const tui = await read({ process_id: 'proc-tui', limit: 5 });
    assert.deepEqual(tui.sources, ['history']);
    assert.equal(tui.stale, true);
    assert.equal(tui.conversation_id, 'conv-tui');
    assert.deepEqual(tui.latest_answer, { message_id: 'h449', in_page: true });
    const textRows = historyRows.filter((row) => row.kind === 'message').map((row) => row.id);
    assert.deepEqual(await all({ process_id: 'proc-tui', limit: 37 }), textRows, 'history pages cross batches with no gaps or repeats');
    // Imported reasoning is marked in metadata; it is not an answer.
    (historyRows as Array<Record<string, unknown>>).push({ id: 'hreason', seq: 450, role: 'assistant', kind: 'message', text: 'Pondering', toolName: null, toolInputSummary: null, toolStatus: null, metadata: { type: 'reasoning' } });
    const pondering = await read({ process_id: 'proc-tui', limit: 2 });
    assert.deepEqual(pondering.messages.map((message) => message.id), ['h448', 'h449']);
    assert.deepEqual(pondering.latest_answer, { message_id: 'h449', in_page: true });
    assert.equal((await read({ process_id: 'proc-tui', limit: 1, include: ['reasoning'] })).messages[0]?.id, 'hreason');
    historyRows.splice(450);
    for (let index = 0; index < 250; index += 1) historyRows.push({ id: `ht${index}`, seq: 450 + index, role: 'tool', kind: 'tool_result', text: `tool ${index}`, toolName: null, toolInputSummary: null, toolStatus: null });
    const buried = await read({ process_id: 'proc-tui', limit: 2, include: ['tools'] });
    assert.deepEqual(buried.messages.map((message) => message.id), ['ht248', 'ht249']);
    assert.equal((buried.latest_answer as { message_id: string } | null)?.message_id, 'h449', 'the latest answer is found beyond the first batch');
    historyRows.splice(450);
    importedAt = new Date(Date.now() + 60_000).toISOString();
    assert.equal((await read({ process_id: 'proc-tui' })).stale, true, 'a running agent can always be ahead of its import');
    db.prepare(`update processes set exited_at = ? where id = 'proc-old'`).run(now);
    assert.equal((await read({ process_id: 'proc-old' })).stale, false, 'an exited agent imported after it exited is current');
    importedAt = '2000-01-01T00:00:00.000Z';
    assert.equal((await read({ process_id: 'proc-old' })).stale, true, 'an exited agent can still be ahead of its import');
    await assert.rejects(read({ process_id: 'proc-other' }), /outside the current caller scope/);

    // list_processes shows running processes unless asked for all.
    const running = await registry.callPublic('list_processes', {}, worker) as { processes: Array<{ process_id: string }> };
    assert.ok(!running.processes.some((process) => process.process_id === 'proc-old'));
    const everything = await registry.callPublic('list_processes', { status: 'all', limit: 2 }, worker) as { processes: Array<{ process_id: string }>; omitted: number };
    assert.equal(everything.processes.length, 2);
    assert.equal(everything.omitted, 2);

    // Any agent can message the assistant; other projects stay out of reach.
    const sent = await registry.callPublic('send_message', { target_process_id: 'assistant', message: 'Here is the answer you asked for.' }, worker) as { ok: boolean; event_id: string };
    assert.equal(sent.ok, true);
    assert.deepEqual(delivered.at(-1), { from: 'proc-tui', message: 'Here is the answer you asked for.' });
    const event = db.prepare(`select event_type, project_id, process_id, metadata from timeline_events where id = ?`).get(sent.event_id) as { event_type: string; project_id: string; process_id: string; metadata: string };
    assert.deepEqual([event.event_type, event.project_id, event.process_id], ['message.sent', 'p', 'proc-tui']);
    assert.equal(JSON.parse(event.metadata).to_process_id, 'proc-assistant');
    await registry.callPublic('send_message', { target_process_id: 'proc-assistant', message: 'By ID too.' }, worker);
    assert.equal(delivered.at(-1)?.message, 'By ID too.');
    await assert.rejects(registry.callPublic('send_message', { target_process_id: 'proc-other', message: 'hi' }, worker), /outside the current caller scope/);
    await assert.rejects(registry.callPublic('send_message', { target_process_id: 'assistant', message: 'x'.repeat(8 * 1024 + 1) }, worker), /limited to 8 KB/);
    for (let index = 0; index < 4; index += 1) await registry.callPublic('send_message', { target_process_id: 'assistant', message: `burst ${index}` }, worker);
    await assert.rejects(registry.callPublic('send_message', { target_process_id: 'assistant', message: 'one too many' }, worker), /too many messages/);
    assistantRunning = false;
    await assert.rejects(registry.callPublic('send_message', { target_process_id: 'assistant', message: 'hello?' }, { identity: 'mcp-live' }), /not running/);
    assistantRunning = true;
    // Concurrent messages count against each other before delivery finishes.
    deliveryDelay = 30;
    const burst = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => registry.callPublic('send_message', { target_process_id: 'assistant', message: `parallel ${index}` }, { identity: 'mcp-live' })));
    deliveryDelay = 0;
    assert.equal(burst.filter((result) => result.status === 'fulfilled').length, 6, 'concurrent messages cannot pass the rate limit');
    assert.equal(burst.filter((result) => result.status === 'rejected' && /too many messages/.test(String(result.reason))).length, 2);
    await assert.rejects(registry.callPublic('send_message', { target_process_id: 'assistant', message: 'me?' }, assistantIdentity), /cannot message itself/);
    // A delivery that may or may not have arrived is reported as uncertain.
    const uncertain = await registry.callPublic('send_message', { target_process_id: 'assistant', message: 'uncertain hello' }, { identity: 'mcp-helper' }) as { ok: boolean; delivery: string; event_id: string };
    assert.deepEqual([uncertain.ok, uncertain.delivery], [false, 'uncertain']);
    const uncertainEvent = db.prepare(`select metadata from timeline_events where id = ?`).get(uncertain.event_id) as { metadata: string };
    assert.equal(JSON.parse(uncertainEvent.metadata).delivery, 'uncertain');

    // The assistant's own children reach it through "parent" under the same rules.
    const viaParent = await registry.callPublic('send_message', { target_process_id: 'parent', message: 'Child update.' }, { identity: 'mcp-helper' }) as { event_id: string };
    assert.deepEqual(delivered.at(-1), { from: 'proc-helper', message: 'Child update.' });
    assert.ok(viaParent.event_id, 'messages to the assistant through "parent" are recorded');

    // The assistant's requests carry a reply route and are recorded.
    const maybe = await registry.callPublic('send_message', { target_process_id: 'proc-live', message: 'maybe now' }, assistantIdentity) as { ok: boolean; delivery: string; event_id: string };
    assert.deepEqual([maybe.ok, maybe.delivery], [false, 'uncertain'], 'an uncertain delivery to an agent is not reported as sent');
    assert.equal(JSON.parse((db.prepare(`select metadata from timeline_events where id = ?`).get(maybe.event_id) as { metadata: string }).metadata).delivery, 'uncertain');
    const asked = await registry.callPublic('send_message', { target_process_id: 'proc-other', message: 'What changed?' }, assistantIdentity) as { event_id: string };
    assert.match(String(terminalInputs.at(-1)?.text), /^\[message from proc-assistant\]\nWhat changed\?\n\n\(Reply with send_message target_process_id "assistant"\.\)$/);
    assert.ok(asked.event_id);

    // A reply answers the assistant's report timer in the same message,
    // naming who answered, so the assistant wakes once. An uncertain delivery
    // does not answer it.
    const timer = await registry.callPublic('timer_fire_when_reported_any', { watched: ['proc-other'], body: 'Check the answer.' }, assistantIdentity) as { timer_id: string };
    await wait(20);
    const before = terminalInputs.length;
    await registry.callPublic('send_message', { target_process_id: 'assistant', message: 'uncertain reply' }, { identity: 'mcp-other' });
    await wait(700);
    assert.equal(terminalInputs.length, before, 'an uncertain delivery is not a reply');
    await registry.callPublic('send_message', { target_process_id: 'assistant', message: 'The schema changed.' }, { identity: 'mcp-other' });
    assert.equal(delivered.at(-1)?.from, 'proc-other');
    assert.match(delivered.at(-1)!.message, new RegExp(`^The schema changed\\.\\n\\n\\[Patterm timer ${timer.timer_id}: condition met\\]\\n- proc-other "other": sent you a message at \\S+: The schema changed\\.\\nCheck the answer\\.$`));
    await wait(700);
    assert.equal(terminalInputs.length, before, 'no separate callback repeats the reply');
    assert.ok(!(await registry.callPublic('timer_list', {}, assistantIdentity) as Array<{ timer_id: string }>).some((entry) => entry.timer_id === timer.timer_id));
    console.log('agent results smoke passed');
  } finally {
    database.dispose();
    removeTree(dir);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
