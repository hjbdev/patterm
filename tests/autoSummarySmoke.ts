import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutoSummaryActions, registerAutoSummaryControl } from '../app/Actions/AutoSummaryActions';
import { McpToolRegistry } from '../app/MCP/ToolRegistry';
import { DatabaseService } from '../app/Services/DatabaseService';
import { SettingsService } from '../app/Services/SettingsService';
import { AutoSummaryService, summarySnapshot } from '../app/Services/AutoSummaryService';
import { AutoSummaryRunner, claudeSummaryArgs, codexSummaryArgs, codexSummaryEnvironment, finishCodexSummaryHome, runSummaryCommand, summaryEnvironment } from '../app/Services/AutoSummaryRunner';
import { autoSummarySettingsInput, SUMMARY_INPUT_BYTES, SUMMARY_SYSTEM_PROMPT, SUMMARY_TEST_SYSTEM_PROMPT, type SummaryContext, type SummaryResult } from '../app/Services/AutoSummarySettings';
import type { TerminalService } from '../app/Services/TerminalService';
import { HistoryDatabaseService } from '../app/Services/HistoryDatabaseService';
import { AgentHistoryImportService } from '../app/Services/AgentHistory/AgentHistoryImportService';
import { ProviderHistoryDiscoveryService } from '../app/Services/AgentHistory/ProviderHistoryDiscoveryService';
import { DatabaseSync } from 'node:sqlite';
import { AutoSummaryHistory, type SummaryThread } from '../app/Services/AutoSummaryHistory';
import { OpenCodeHistoryAdapter } from '../app/Services/AgentHistory/OpenCodeHistoryAdapter';
import { ClaudeHistoryAdapter } from '../app/Services/AgentHistory/ClaudeHistoryAdapter';
import { SummaryProseIndex } from '../app/Services/AgentHistory/SummaryProseIndex';
import { SessionContextService } from '../app/Services/SessionContextService';
import type { TimelineService } from '../app/Services/TimelineService';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-summary-test-'));
  const database = new DatabaseService(directory); database.initialize();
  const history = new HistoryDatabaseService(directory); history.initialize();
  const settings = new SettingsService(database), db = database.connection, hdb = history.connection;
  const index = new SummaryProseIndex(hdb);
  let now = Date.UTC(2026, 9, 12), snapshots = 0;
  const calls: Array<{ text: string; context: SummaryContext }> = [];
  const memory = { goal: 'Fix parsing', decisions: 'Keep the public API', completed: 'Parser fixed', unresolved: 'Review remains' };
  let run: (signal: AbortSignal) => Promise<SummaryResult> = async () => ({ summary: 'Fix parsing while keeping the public API. Parser fixed; review remains.', status: 'Waiting on review', title: 'Fix parsing', memory });
  const terminal = { onFrame: () => () => {}, async request() { snapshots++; return { screen: 'Shell build completed successfully, with all tests passing.' }; } } as Pick<TerminalService, 'request' | 'onFrame'>;
  const makeService = () => new AutoSummaryService(database, settings, terminal, {
    availability: () => ({ available: true, reason: null }),
    async run(_settings, text, signal, mode, context = {}) {
      if (mode === 'test') return { summary: 'patterm okay' };
      assert.ok(Buffer.byteLength(JSON.stringify({ ...context, conversation_text: text })) + Buffer.byteLength(SUMMARY_SYSTEM_PROMPT) <= SUMMARY_INPUT_BYTES);
      calls.push({ text, context }); return run(signal);
    }
  }, () => {}, () => now, history);
  let service = makeService();
  const enabled = { ...settings.autoSummarySettings(), enabled: true };
  const add = (id: string, parent: string | null = null, native = id) => {
    db.prepare(`insert into processes (id,project_id,parent_process_id,kind,name,status,activity,pty_process_id,created_at,updated_at)
      values (?, 'project', ?, 'agent', ?, 'running', 'idle', ?, 'now', 'now')`).run(id, parent, id, id);
    db.prepare(`insert into sessions(id,project_id,process_id,harness,session_role,resume_id,started_at)
      values (?, 'project', ?, 'claude', 'orchestrator', ?, ?)`).run(`${id}-session`, id, native, String(now));
    hdb.prepare(`insert into conversations(id,provider,provider_conversation_id,project_id,session_id,process_id,status,created_at,imported_at)
      values (?, 'claude', ?, 'project', ?, ?, 'active', 'now', 'now')`).run(id, native, `${id}-session`, id);
  };
  const message = (conv: string, seq: number, role: string, text: string, kind = 'message', metadata = '{}') => {
    hdb.prepare(`insert into conversation_messages(id,conversation_id,seq,role,kind,text,metadata,created_at)
      values (?, ?, ?, ?, ?, ?, ?, 'now')`).run(`${conv}-${seq}`, conv, seq, role, kind, text, metadata);
  };
  const advance = async (ms = 30_000) => { now += ms; service.tick(); await flush(); };
  const discover = async () => { service.tick(); await advance(2000); };
  const summary = (id: string) => db.prepare('select auto_summary, auto_status, auto_summary_coverage from processes where id = ?').get(id) as Record<string, unknown>;
  const state = (native: string, provider = 'claude') => db.prepare("select * from auto_summary_memory where project_id = 'project' and provider = ? and native_id = ?").get(provider, native) as { position: number; byte_offset: number; revision: number; stale: number; origin: string; paused: number; recap: string };
  try {
    db.exec("insert into projects(id,name,path,created_at,updated_at) values('project','Test','/tmp','now','now')");
    add('root'); add('child', 'root');
    const registry = new McpToolRegistry();
    registerAutoSummaryControl(registry, new AutoSummaryActions(service));
    await assert.rejects(registry.callPublic('auto_summary_control', { session_id: 'root-session', project_id: 'project' }), /unknown MCP tool/);
    message('root', 0, 'user', 'Fix parsing and retain the public API.');
    message('root', 1, 'assistant', 'I found the issue in nested expressions.');
    message('root', 2, 'assistant', 'TOOL SECRET', 'tool_call');
    message('root', 3, 'assistant', 'PRIVATE REASONING', 'message', '{"type":"reasoning"}');
    message('root', 4, 'assistant', 'CLAUDE THINKING', 'message', '{"contentType":"thinking"}');
    message('root', 5, 'user', '[Patterm timer reminder] Noise');
    message('root', 6, 'user', '<T> is the generic syntax to preserve.');
    message('root', 7, 'user', '[report from process_2: completed] Parser fixed.');
    message('root', 8, 'user', 'ANTHROPIC_API_KEY=sk-ant-' + 'a'.repeat(60));
    message('root', 9, 'assistant', 'Parser fixed. Review remains.'); index.publish('root');
    hdb.prepare(`insert into conversations(id,provider,provider_conversation_id,project_id,session_id,status,created_at,imported_at)
      values('collision','claude','unrelated-native','project','root-session','active','now','zzz-newest')`).run();
    message('collision', 0, 'user', 'UNRELATED CONVERSATION'); index.publish('collision');
    const rootThread = db.prepare(`select p.*, s.id as session_id, s.harness, s.resume_id, s.display_name, s.auto_title, s.last_title
      from processes p join sessions s on s.process_id = p.id where p.id = 'root'`).get() as SummaryThread;
    const historyReader = new AutoSummaryHistory(db, hdb);
    assert.equal(historyReader.source(rootThread)?.native_id, 'root', 'exact native identity beats a newer heuristic session link');
    assert.equal(historyReader.source({ ...rootThread, resume_id: 'missing-native' }), null, 'a conflicting native conversation is never a fallback');
    assert.equal(historyReader.source({ ...rootThread, resume_id: null }), null, 'ambiguous session-only links do not spend usage');
    hdb.prepare("delete from summary_prose_sources where conversation_id = 'collision'").run();
    assert.equal(historyReader.source({ ...rootThread, resume_id: null }), null, 'unindexed conflicting links are still ambiguous'); index.publish('collision');
    service.userInput('root'); await discover(); assert.equal(calls.length, 0, 'disabled by default');
    service.update(enabled); service.userInput('child'); await discover(); assert.equal(calls.length, 0, 'children excluded');
    service.userInput('root'); await discover(); assert.equal(calls.length, 1);
    assert.equal(snapshots, 0, 'agent summaries never read the terminal screen');
    assert.ok(calls[0]!.text.includes('nested expressions'));
    assert.ok(!calls[0]!.text.includes('UNRELATED CONVERSATION'));
    assert.ok(calls[0]!.text.includes('<T>'));
    assert.ok(calls[0]!.text.includes('Agent report:'));
    assert.ok(!/TOOL SECRET|PRIVATE REASONING|CLAUDE THINKING|timer reminder|a{60}/.test(calls[0]!.text));
    assert.equal(calls[0]!.context.coverage, 'complete');
    assert.equal(summary('root').auto_summary_coverage, 'complete');
    assert.equal(JSON.parse(state('root').recap).decisions, memory.decisions);
    assert.equal(new WorkbenchRepository(database).snapshot().projects[0]?.projectSessions.find(s => s.processId === 'root')?.summary?.coverage, 'complete');
    await advance(); assert.equal(calls.length, 1, 'unchanged content is free');
    message('root', 10, 'assistant', 'TOOL ONLY CHANGE', 'tool_result'); index.publish('root');
    await discover(); await advance(); assert.equal(calls.length, 1, 'tool-only imports never call');
    message('root', 11, 'user', 'Keep the public API'); message('root', 12, 'user', 'Keep the public API'); index.publish('root');
    await discover(); await advance();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.text.split('Keep the public API').length, 3, 'repeated instructions are not deduplicated');
    assert.ok(!calls[1]!.text.includes('nested expressions'), 'old prose is not resent');
    assert.deepEqual(calls[1]!.context.memory, memory, 'internal recap, not visible summary, carries earlier decisions');

    // Replacing UUIDs with identical source content preserves the hash cursor.
    const oldRows = hdb.prepare("select * from conversation_messages where conversation_id = 'root'").all() as Array<{ id: string; seq: number; role: string; kind: string; text: string; metadata: string }>;
    hdb.transaction(() => {
      hdb.prepare("delete from conversation_messages where conversation_id = 'root'").run();
      for (const row of oldRows) hdb.prepare("insert into conversation_messages(id,conversation_id,seq,role,kind,text,metadata,created_at) values (?, 'root', ?, ?, ?, ?, ?, 'now')")
        .run(row.id + '-new', row.seq, row.role, row.kind, row.text, row.metadata);
      index.publish('root');
    })();
    await advance(); assert.equal(calls.length, 2); assert.equal(state('root').stale, 0);
    hdb.prepare("update conversation_messages set text = 'Changed original request' where conversation_id = 'root' and seq = 0").run(); index.publish('root');
    await advance(); assert.equal(calls.length, 2); assert.equal(state('root').stale, 1);
    assert.equal(summary('root').auto_summary_coverage, 'stale');
    assert.throws(() => service.control('root-session', 'rebuild', 'wrong-project'), /not found/);
    service.control('root-session', 'rebuild', 'project'); await discover(); assert.equal(state('root').stale, 0); assert.equal(calls.length, 3);

    // A new process with the same native conversation inherits durable coverage.
    db.prepare("update processes set status = 'closed' where id = 'root'").run();
    db.prepare("insert into processes(id,project_id,kind,name,status,activity,created_at,updated_at) values('resumed','project','agent','Resumed','running','idle','now','now')").run();
    db.prepare("insert into sessions(id,project_id,process_id,harness,session_role,resume_id,started_at) values('resumed-session','project','resumed','claude','orchestrator','root','later')").run();
    new SessionContextService(database).inherit('resumed-session', 'project', 'claude', 'root', { append() {} } as unknown as TimelineService, 'root-session');
    hdb.prepare("update conversations set session_id = 'resumed-session', process_id = 'resumed' where id = 'root'").run();
    service.userInput('resumed'); await discover(); assert.equal(calls.length, 3, 'resume does not reread history');
    message('root', 13, 'assistant', 'Final result after exit.'); index.publish('root');
    db.prepare("update processes set status = 'exited', activity = 'idle' where id = 'resumed'").run();
    await advance(); await advance(2000); assert.equal(calls.length, 4, 'delayed exit import gets its final recap');

    assert.throws(() => service.control('root-session', 'rebuild', 'project'), /not found|latest resumed/);

    // Byte offsets cover a long multibyte message without tail truncation.
    add('long'); const longText = '🙂'.repeat(6000);
    message('long', 0, 'user', longText); index.publish('long'); service.userInput('long');
    const beforeLong = calls.length; await discover();
    assert.ok(state('long').byte_offset > 0); assert.equal(state('long').position, 0);
    assert.equal(summary('long').auto_summary, null, 'historical intermediate status is not displayed as current');
    for (let i = 0; i < 20 && state('long').position < 1; i++) await advance();
    const chunks = calls.slice(beforeLong).map(c => c.text.replace(/^User(?: \(continued\))?: /, ''));
    assert.equal(chunks.join(''), longText); assert.ok(!chunks.join('').includes('�'));
    assert.equal(state('long').position, 1); assert.equal(state('long').byte_offset, 0);

    // Huge existing threads stay partial and cheap until a deliberate rebuild.
    add('huge');
    for (let seq = 0; seq < 40; seq++) message('huge', seq, seq % 2 ? 'assistant' : 'user', `Message ${seq}: ` + 'x'.repeat(1200));
    index.publish('huge'); service.userInput('huge'); const beforeHuge = calls.length;
    await discover(); for (let i = 0; i < 6 && state('huge').position < 40; i++) await advance();
    assert.ok(calls.length - beforeHuge < 3, 'bootstrap samples a bounded tail');
    assert.equal(state('huge').origin, 'partial'); assert.equal(summary('huge').auto_summary_coverage, 'partial');
    message('huge', 40, 'user', 'New direction'); index.publish('huge'); await advance(); await advance(2000);
    assert.equal(summary('huge').auto_summary_coverage, 'partial', 'new activity does not erase incomplete origin');
    const info = service.control('huge-session', 'rebuild', 'project'); assert.ok(info.estimatedCalls > 1); assert.equal(info.rebuilding, true);
    await discover(); assert.ok(state('huge').position < 40);
    assert.equal(summary('huge').auto_summary_coverage, 'catching_up');
    hdb.prepare("update conversation_messages set text = text || ' corrected' where conversation_id = 'huge' and seq = 0").run(); index.publish('huge');
    const obsolete = service.control('huge-session', 'inspect', 'project');
    assert.equal(obsolete.coverage, 'stale'); assert.equal(obsolete.rebuilding, false, 'an invalidated rebuild no longer blocks restart');
    service.control('huge-session', 'rebuild', 'project'); await discover();
    assert.equal(state('huge').stale, 0, 'the exposed rebuild operation recovers stale history');
    service.control('huge-session', 'cancel', 'project'); const pausedAt = calls.length;
    await advance(); assert.equal(calls.length, pausedAt); assert.equal(state('huge').paused, 1);
    const pausedPosition = state('huge').position;
    service.control('huge-session', 'resume', 'project'); assert.equal(state('huge').position, pausedPosition, 'resume preserves already-paid coverage'); await discover();
    for (let i = 0; i < 20 && state('huge').position < 41; i++) await advance();
    assert.equal(state('huge').position, 41); assert.equal(summary('huge').auto_summary_coverage, 'complete');

    // Imports that change only tools or UUIDs must not discard a paid recap.
    add('paid'); message('paid', 0, 'user', 'Preserve paid summary progress'); index.publish('paid'); service.userInput('paid');
    let paidRelease!: () => void;
    run = () => new Promise(resolve => { paidRelease = () => resolve({ summary: 'Paid recap', memory }); });
    const beforePaid = calls.length; await discover();
    const contentRevision = (hdb.prepare("select revision from summary_prose_sources where conversation_id = 'paid'").get() as { revision: number }).revision;
    message('paid', 1, 'tool', 'New tool result', 'tool_result'); index.publish('paid');
    hdb.transaction(() => {
      const rows = hdb.prepare("select * from conversation_messages where conversation_id = 'paid'").all() as Array<{ id: string; seq: number; role: string; kind: string; text: string; metadata: string }>;
      hdb.prepare("delete from conversation_messages where conversation_id = 'paid'").run();
      for (const row of rows) hdb.prepare("insert into conversation_messages(id,conversation_id,seq,role,kind,text,metadata,created_at) values (?, 'paid', ?, ?, ?, ?, ?, 'now')")
        .run(row.id + '-replacement', row.seq, row.role, row.kind, row.text, row.metadata);
      index.publish('paid');
    })();
    assert.equal((hdb.prepare("select revision from summary_prose_sources where conversation_id = 'paid'").get() as { revision: number }).revision, contentRevision);
    paidRelease(); await flush(); assert.equal(state('paid').position, 1); assert.equal(calls.length, beforePaid + 1);
    message('paid', 2, 'user', 'Also preserve the cursor'); index.publish('paid'); await advance(); await advance(2000);
    message('paid', 3, 'assistant', 'New tail while recap runs'); index.publish('paid'); paidRelease(); await flush();
    assert.equal(state('paid').position, 2, 'append-only activity preserves successfully summarized prefix');
    assert.equal(summary('paid').auto_summary_coverage, 'catching_up');
    run = async () => ({ summary: 'Updated', memory }); await advance(); await advance(2000);
    assert.equal(state('paid').position, 3);

    // A successful but obsolete response may not move coverage, including cancel.
    add('race'); message('race', 0, 'user', 'Fix another thing.'); index.publish('race'); service.userInput('race');
    let release!: () => void, signal: AbortSignal | undefined;
    run = (s) => { signal = s; return new Promise(resolve => { release = () => resolve({ summary: 'Late recap', memory }); }); };
    await discover(); const raceRevision = state('race').revision;
    message('race', 1, 'assistant', 'More progress');
    hdb.prepare("update conversation_messages set text = 'Changed consumed goal' where conversation_id = 'race' and seq = 0").run();
    index.publish('race'); release(); await flush();
    assert.equal(state('race').revision, raceRevision); assert.equal(state('race').position, 0, 'changed source rejects stale response');
    service.control('race-session', 'rebuild', 'project'); await discover(); service.control('race-session', 'cancel', 'project'); assert.equal(signal?.aborted, true); release(); await flush();
    assert.equal(state('race').position, 0);
    run = async () => ({ summary: 'Updated', memory });

    // Small active-turn prose is batched locally; permission waits never call.
    add('busy'); message('busy', 0, 'user', 'Fix the batching bug'); index.publish('busy');
    db.prepare("update processes set activity = 'working' where id = 'busy'").run();
    service.userInput('busy'); const beforeBusy = calls.length; await discover();
    assert.equal(calls.length, beforeBusy); await advance(57_999); assert.equal(calls.length, beforeBusy);
    await advance(1); assert.equal(calls.length, beforeBusy + 1);
    message('busy', 1, 'assistant', 'Waiting for permission'); index.publish('busy');
    db.prepare("update processes set activity = 'permission' where id = 'busy'").run();
    await advance(120_000); assert.equal(calls.length, beforeBusy + 1);
    db.prepare("update processes set activity = 'idle' where id = 'busy'").run();
    await advance(); await advance(2000); assert.equal(calls.length, beforeBusy + 2);

    // An unchanged multi-chunk source must not strand its small final slice
    // while the agent remains active: each queued slice gets a batching clock.
    add('working-tail'); message('working-tail', 0, 'user', 'w'.repeat(17_000)); index.publish('working-tail');
    db.prepare("update processes set activity = 'working' where id = 'working-tail'").run();
    service.userInput('working-tail'); const beforeTail = calls.length; await discover(); await advance();
    assert.equal(calls.length, beforeTail + 2); assert.ok(state('working-tail').byte_offset > 16_000);
    await advance(); await advance(59_999); assert.equal(calls.length, beforeTail + 2, 'small final slice is batched');
    await advance(1); assert.equal(calls.length, beforeTail + 3);
    assert.equal(state('working-tail').position, 1); assert.equal(state('working-tail').byte_offset, 0);
    assert.equal(summary('working-tail').auto_summary_coverage, 'complete');

    // Real OpenCode SQLite parts remain outside coverage until native completion.
    add('stream'); db.prepare("update sessions set harness = 'opencode' where id = 'stream-session'").run();
    hdb.prepare("update conversations set provider = 'opencode' where id = 'stream'").run();
    const streamFile = path.join(directory, 'opencode-stream.db'), nativeDb = new DatabaseSync(streamFile);
    const openCodeImports = new AgentHistoryImportService(history, new ProviderHistoryDiscoveryService(), null, undefined, database);
    const streamInput = { provider: 'opencode' as const, path: streamFile, project_id: 'project', trigger: 'manual' as const };
    try {
      nativeDb.exec(`create table session (id text primary key, directory text, title text, version text, time_created integer, time_updated integer, parent_id text, agent text, model text, metadata text, time_archived integer);
        create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
        create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
        insert into session values('stream','/tmp','Streaming','test',1,1,null,null,null,'{}',null);
        insert into message values('u','stream',1,1,'{"role":"user"}');
        insert into message values('a','stream',2,2,'{"role":"assistant"}');
        insert into part values('up','u','stream',1,1,'{"type":"text","text":"Fix streaming safely"}');
        insert into part values('ap','a','stream',2,2,'{"type":"text","text":"","time":{"start":2}}');`);
      assert.equal(openCodeImports.import(streamInput).errorCount, 0);
      service.userInput('stream'); await discover(); assert.equal(state('stream', 'opencode').position, 1);
      const beforeStreaming = calls.length;
      nativeDb.exec(`insert into message values('later','stream',3,3,'{"role":"user"}');
        insert into part values('laterp','later','stream',3,3,'{"type":"text","text":"Keep the original constraint"}');`);
      const updatePart = (text: string, end?: number) => {
        nativeDb.prepare("update part set data = ?, time_updated = ? where id = 'ap'")
          .run(JSON.stringify({ type: 'text', text, time: { start: 2, ...(end ? { end } : {}) } }), ++now);
        nativeDb.prepare("update session set time_updated = ? where id = 'stream'").run(now);
      };
      updatePart('Growing '.repeat(500)); assert.equal(openCodeImports.import(streamInput).errorCount, 0);
      assert.ok((hdb.prepare("select text from conversation_messages where conversation_id = 'stream' and provider_message_id = 'ap'").get() as { text: string }).text.includes('Growing'));
      await advance(); assert.equal(calls.length, beforeStreaming); assert.equal(state('stream', 'opencode').stale, 0);
      assert.equal((hdb.prepare("select message_count from summary_prose_sources where conversation_id = 'stream'").get() as { message_count: number }).message_count, 1, 'later prompts do not jump an unfinished part');
      updatePart('Growing '.repeat(600)); openCodeImports.import(streamInput); await advance();
      assert.equal(calls.length, beforeStreaming); assert.equal(state('stream', 'opencode').stale, 0);
      updatePart('Final result: stream is safe.', now); assert.equal(openCodeImports.import(streamInput).errorCount, 0);
      await advance(); await advance(2000); assert.equal(state('stream', 'opencode').position, 3); assert.equal(state('stream', 'opencode').stale, 0);
      assert.ok(calls.at(-1)!.text.includes('Final result')); assert.ok(calls.at(-1)!.text.includes('Keep the original constraint'));
      const adapter = new OpenCodeHistoryAdapter();
      assert.equal(adapter.parseFile(streamFile).conversations[0]!.messages.find(m => m.providerMessageId === 'ap')!.metadata.prose_finalized, true);
      nativeDb.exec(`create table session_v2 as select * from session;
        update session_v2 set id = 'stream-v2';
        create table session_message (id text, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);`);
      const v2Data = (messageCompleted: boolean, partCompleted = false) => JSON.stringify({ time: { created: 2, ...(messageCompleted ? { completed: now } : {}) },
        content: [{ type: 'text', text: 'V2 prose', time: { created: 2, ...(partCompleted ? { completed: now } : {}) } }] });
      nativeDb.prepare("insert into session_message values('v2-a','stream-v2','assistant',0,2,2,?)").run(v2Data(false));
      const finalizedV2 = () => adapter.parseFile(streamFile).conversations.find(c => c.providerConversationId === 'stream-v2')!.messages[0]!.metadata.prose_finalized;
      assert.equal(finalizedV2(), false, 'V2 unfinished text is identified');
      nativeDb.prepare("update session_message set data = ? where id = 'v2-a'").run(v2Data(true));
      assert.equal(finalizedV2(), true, 'V2 envelope completion finalizes prose');
      nativeDb.prepare("update session_message set data = ? where id = 'v2-a'").run(v2Data(false, true));
      assert.equal(finalizedV2(), true, 'V2 part completion finalizes prose');
    } finally { nativeDb.close(); }

    // No hourly cap: even an obsolete saved zero limit cannot pause summaries.
    const uncappedSettings = service.update({ ...enabled, maxCallsPerHour: 0 });
    assert.equal('maxCallsPerHour' in uncappedSettings, false);
    add('uncapped'); message('uncapped', 0, 'user', 'Keep summarizing new conversation prose'); index.publish('uncapped'); service.userInput('uncapped');
    const beforeUncapped = calls.length, startUncapped = now;
    await discover();
    for (let seq = 1; seq <= 13; seq++) {
      message('uncapped', seq, 'assistant', `Meaningful update ${seq}`); index.publish('uncapped');
      await advance(); await advance(2000);
    }
    assert.ok(now - startUncapped < 3_600_000);
    assert.equal(calls.length, beforeUncapped + 14, 'more than twelve calls run in the same hour');
    assert.equal(state('uncapped').position, 14);
    assert.equal(db.prepare("select name from sqlite_master where name = 'auto_summary_usage'").get(), undefined);

    // Failures still back off and never move coverage or expose diagnostics.
    add('failure'); message('failure', 0, 'user', 'Please fix this failure.'); index.publish('failure'); service.userInput('failure');
    run = async () => { throw new Error('secret diagnostic'); };
    const beforeFailure = calls.length;
    await discover(); assert.equal(calls.length, beforeFailure + 1);
    assert.ok(!JSON.stringify(service.status()).includes('secret diagnostic')); assert.equal(state('failure').position, 0);
    await advance(); assert.equal(calls.length, beforeFailure + 1, 'failed calls retain retry backoff');
    await advance(); assert.equal(calls.length, beforeFailure + 2);
    await service.dispose(); service = makeService();
    run = async () => ({ summary: 'Updated', memory });
    await discover(); assert.equal(state('failure').position, 1, 'restart continues from retained coverage');
    assert.deepEqual(await service.test(enabled), { ok: true });
    service.update({ ...enabled, titles: false });
    assert.equal((db.prepare("select count(*) as n from sessions where auto_title is not null").get() as { n: number }).n, 0);

    // Missing history never falls back to an agent's tool-filled terminal screen.
    const absent = new AutoSummaryService(database, settings, terminal, { availability: () => ({ available: true, reason: null }), run: async () => { throw new Error('must not call'); } }, () => {}, () => now);
    absent.userInput('failure'); absent.tick(); await flush(); await absent.dispose(); assert.equal(snapshots, 0);
    // A fresh app opens history read-only before the import worker creates it.
    // Summaries must discover that file without another history consumer.
    const freshDirectory = path.join(directory, 'fresh-start');
    const freshApp = new DatabaseService(freshDirectory); freshApp.initialize();
    const freshHistory = new HistoryDatabaseService(freshDirectory, { mode: 'read' }); freshHistory.initialize({ migrate: false });
    const freshWriter = new HistoryDatabaseService(freshDirectory);
    const freshSettings = new SettingsService(freshApp); freshSettings.updateAutoSummarySettings(enabled);
    let freshCalls = 0;
    const freshService = new AutoSummaryService(freshApp, freshSettings, terminal, {
      availability: () => ({ available: true, reason: null }), run: async () => { freshCalls++; return { summary: 'Parser fixed.', memory }; }
    }, () => {}, () => now, freshHistory);
    try {
      freshApp.connection.exec(`insert into projects(id,name,path,created_at,updated_at) values('fresh','Fresh','/tmp','now','now');
        insert into processes(id,project_id,kind,name,status,activity,created_at,updated_at) values('fresh-agent','fresh','agent','Fresh','running','idle','now','now');
        insert into sessions(id,project_id,process_id,harness,session_role,resume_id,started_at) values('fresh-session','fresh','fresh-agent','claude','orchestrator','fresh-native','now');`);
      freshService.userInput('fresh-agent'); freshService.tick(); assert.equal(freshCalls, 0);
      freshWriter.initialize();
      freshWriter.connection.exec(`insert into conversations(id,provider,provider_conversation_id,project_id,session_id,status,created_at,imported_at)
        values('fresh-conversation','claude','fresh-native','fresh','fresh-session','active','now','now');
        insert into conversation_messages(id,conversation_id,seq,role,kind,text,created_at)
        values('fresh-message','fresh-conversation',0,'user','message','Fix parsing please','now');`);
      new SummaryProseIndex(freshWriter.connection).publish('fresh-conversation');
      freshService.historyChanged(); now += 2000; freshService.tick(); await flush();
      assert.equal(freshCalls, 1, 'fresh history is discovered without opening the History page');
    } finally { await freshService.dispose(); freshHistory.dispose(); freshWriter.dispose(); freshApp.dispose(); }

    // The real importer publishes hashes in both replacement and append paths,
    // and backfills projections even when an unchanged file is skipped.
    add('imported');
    const nativeFile = path.join(directory, 'imported.jsonl');
    const nativeRow = (seq: number, role: string, text: string) => JSON.stringify({ type: role, uuid: `native-${seq}`,
      sessionId: 'imported', cwd: '/tmp', timestamp: new Date(now).toISOString(), message: { role, content: text } }) + '\n';
    fs.writeFileSync(nativeFile, nativeRow(0, 'user', 'Fix the real import path') + nativeRow(1, 'assistant', 'Import path fixed.'));
    const imports = new AgentHistoryImportService(history, new ProviderHistoryDiscoveryService(), null, undefined, database);
    const input = { provider: 'claude' as const, path: nativeFile, project_id: 'project', trigger: 'manual' as const };
    assert.equal(imports.import(input).errorCount, 0);
    const projection = () => hdb.prepare("select * from summary_prose_sources where conversation_id = 'imported'").get() as { message_count: number };
    assert.equal(projection().message_count, 2);
    const prefixBefore = (hdb.prepare("select prefix_hash from summary_prose where conversation_id = 'imported' and position = 1").get() as { prefix_hash: string }).prefix_hash;
    fs.appendFileSync(nativeFile, nativeRow(2, 'user', 'Keep the earlier decision'));
    const adapter = new ClaudeHistoryAdapter();
    assert.equal((await imports.importWithParser(input, async ({ filePath }) => adapter.parseFile(filePath))).errorCount, 0);
    assert.equal(projection().message_count, 3);
    assert.equal((hdb.prepare("select prefix_hash from summary_prose where conversation_id = 'imported' and position = 1").get() as { prefix_hash: string }).prefix_hash, prefixBefore);
    hdb.prepare("delete from summary_prose_sources where conversation_id = 'imported'").run();
    assert.equal(imports.import(input).errorCount, 0); assert.equal(projection().message_count, 3);

    const runner = new AutoSummaryRunner(database, process.env);
    assert.equal(runner.availability('claude').available, false);
    assert.equal(runner.availability('codex').available, false);
    const gated = new AutoSummaryService(database, settings, terminal, runner, () => {});
    assert.throws(() => gated.update({ ...enabled, provider: 'codex' }), /not discovered/);
    await gated.dispose();
    await assert.rejects(runner.run({ ...enabled, provider: 'opencode' }, 'test', new AbortController().signal), /not discovered/);
    // Windows cannot execute a shebang script, so each fixture runs through an
    // npm-style .cmd shim that starts it with node.
    const installFixture = (name: string, source: string): string => {
      const file = path.join(directory, name);
      if (process.platform !== 'win32') {
        fs.copyFileSync(path.resolve(source), file);
        fs.chmodSync(file, 0o700);
        return file;
      }
      fs.copyFileSync(path.resolve(source), `${file}.cjs`);
      fs.writeFileSync(`${file}.cmd`, `@ECHO off\r\n"%~dp0\\${name}.cjs" %*\r\n`);
      return `${file}.cmd`;
    };
    const fixture = installFixture('claude', 'tests/fixtures/summaryCli.cjs');
    db.prepare("insert into harness_installations values ('fake', 'claude', ?, 'fixture', 'available', 'now', 'now')").run(fixture);
    assert.deepEqual(await runner.run(enabled, 'synthetic terminal text', new AbortController().signal), { summary: 'patterm okay' });
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
    const providerFixture = installFixture('summary-providers', 'tests/fixtures/summaryProviders.cjs');
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
        assert.deepEqual(await providers.run(providerSettings, 'synthetic terminal output', new AbortController().signal), { summary: 'patterm okay' });
        for (const model of ['bad-json', 'bad-schema', 'error']) {
          await assert.rejects(providers.run({ ...providerSettings, models: { ...providerSettings.models, [provider]: model } }, 'synthetic', new AbortController().signal), /Summari[sz]|Summary/);
        }
      } finally { await providerService.dispose(); }
    }
    const newer = { ...enabled, provider: 'codex' as const, models: { ...enabled.models, codex: 'newer-model' } };
    assert.deepEqual(await providers.run(newer, 'synthetic', new AbortController().signal), { summary: 'patterm okay' }, 'models missing from the bundled catalogue use the refreshed one');
    await assert.rejects(providers.run({ ...newer, models: { ...newer.models, codex: 'unknown-model' } }, 'synthetic', new AbortController().signal), /not in this Codex build/);
    assert.equal(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'), '{}', 'native login survives temporary-home cleanup');
    const env = summaryEnvironment({ HOME: directory, PATH: process.env.PATH, ANTHROPIC_API_KEY: 'secret', PATTERM_PROCESS_ID: 'child', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', NODE_OPTIONS: '--require evil' });
    assert.equal(env.HOME, directory);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.PATTERM_PROCESS_ID, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    if (process.platform === 'win32') {
      // Windows spells PATH as `Path`, and its programs need the system variables.
      const windows = summaryEnvironment({ Path: 'C:\\bin', systemroot: 'C:\\Windows', PATHEXT: '.EXE', LocalAppData: 'C:\\Users\\x\\AppData\\Local', ANTHROPIC_API_KEY: 'secret' });
      assert.equal(windows.PATH, 'C:\\bin');
      assert.equal(windows.SystemRoot, 'C:\\Windows');
      assert.equal(windows.PATHEXT, '.EXE');
      assert.equal(windows.LOCALAPPDATA, 'C:\\Users\\x\\AppData\\Local');
      assert.equal(windows.ANTHROPIC_API_KEY, undefined);
    }
    // The summariser's Codex home shares the login: a refresh written there reaches the native file.
    const linkedHome = path.join(directory, 'linked-codex');
    fs.mkdirSync(linkedHome);
    fs.writeFileSync(path.join(linkedHome, 'auth.json'), '{"token":"old"}');
    const linkedDirectory = fs.mkdtempSync(path.join(directory, 'home-'));
    const linkedEnv = await codexSummaryEnvironment(linkedDirectory, { CODEX_HOME: linkedHome });
    fs.writeFileSync(path.join(linkedEnv.CODEX_HOME!, 'auth.json'), '{"token":"new"}');
    await finishCodexSummaryHome(linkedDirectory);
    assert.equal(fs.readFileSync(path.join(linkedHome, 'auth.json'), 'utf8'), '{"token":"new"}', 'token refresh is written through to the native login');
    if (process.platform === 'win32') {
      // Across volumes the login is a copy: a refresh is written back, unless the
      // native file changed meanwhile, whose login is then the valid one.
      const realLink = fs.linkSync;
      (fs as unknown as { linkSync: unknown }).linkSync = () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };
      try {
        for (const concurrent of [false, true]) {
          const copyDirectory = fs.mkdtempSync(path.join(directory, 'home-'));
          fs.writeFileSync(path.join(linkedHome, 'auth.json'), '{"token":"old"}');
          const copyEnv = await codexSummaryEnvironment(copyDirectory, { CODEX_HOME: linkedHome });
          assert.equal(fs.readFileSync(path.join(copyEnv.CODEX_HOME!, 'auth.json'), 'utf8'), '{"token":"old"}');
          fs.writeFileSync(path.join(copyEnv.CODEX_HOME!, 'auth.json'), '{"token":"refreshed"}');
          if (concurrent) fs.writeFileSync(path.join(linkedHome, 'auth.json'), '{"token":"other"}');
          await finishCodexSummaryHome(copyDirectory);
          assert.equal(fs.readFileSync(path.join(linkedHome, 'auth.json'), 'utf8'), concurrent ? '{"token":"other"}' : '{"token":"refreshed"}');
        }
      } finally {
        (fs as unknown as { linkSync: unknown }).linkSync = realLink;
      }
    }
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
    await service.dispose(); history.dispose(); database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
