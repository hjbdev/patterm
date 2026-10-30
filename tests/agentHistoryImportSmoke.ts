import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AgentHistoryDeleteService } from '../app/Services/AgentHistory/AgentHistoryDeleteService';
import { AgentHistoryImportService, type HistoryFileParser } from '../app/Services/AgentHistory/AgentHistoryImportService';
import { AgentHistoryImportQueueService, type HistoryImportQueueRunner, type HistoryImportQueueSnapshot, type HistoryImportWorkerLauncher, type HistoryImportWorkerProcess } from '../app/Services/AgentHistory/AgentHistoryImportQueueService';
import { AgentHistorySourceService } from '../app/Services/AgentHistory/AgentHistorySourceService';
import { AgentHistoryReadService } from '../app/Services/AgentHistory/AgentHistoryReadService';
import { AgentHistoryWatcherService } from '../app/Services/AgentHistory/AgentHistoryWatcherService';
import { runHistoryImportWorker } from '../app/Services/AgentHistory/AgentHistoryImportWorker';
import { HistorySearchIndexService } from '../app/Services/AgentHistory/HistorySearchIndexService';
import { ConversationTitleSync, sessionTitles } from '../app/Services/AgentHistory/ConversationTitleSync';
import { ClaudeHistoryAdapter } from '../app/Services/AgentHistory/ClaudeHistoryAdapter';
import { CodexHistoryAdapter } from '../app/Services/AgentHistory/CodexHistoryAdapter';
import { readJsonl } from '../app/Services/AgentHistory/HistoryAdapterUtils';
import { OpenCodeHistoryAdapter } from '../app/Services/AgentHistory/OpenCodeHistoryAdapter';
import { ProviderHistoryDiscoveryService } from '../app/Services/AgentHistory/ProviderHistoryDiscoveryService';
import { ResumeIdCaptureService } from '../app/Services/AgentHistory/ResumeIdCaptureService';
import { SecretRedactor } from '../app/Services/AgentHistory/SecretRedactor';
import { HISTORY_IMPORT_STALE_MS, type ParsedHistoryFile, type ParsedMessage } from '../app/Services/AgentHistory/AgentHistoryTypes';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HistoryDatabaseService } from '../app/Services/HistoryDatabaseService';
import { SearchService } from '../app/Services/SearchService';
import { TimelineService } from '../app/Services/TimelineService';
import { WorkbenchRepository } from '../app/Repositories/WorkbenchRepository';
import { integratedHistoryCheckpoints } from '../app/Listeners/IntegratedHistoryCheckpoints';
import { WorkbenchSeeder } from './fixtures/WorkbenchSeeder';

// The /resume picker searches whole conversations: one ranked row each,
// prefix matching as the user types, scoped to the project and provider.
function verifyConversationSearch(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-history-search-'));
  const appDatabase = new DatabaseService(directory);
  const historyDatabase = new HistoryDatabaseService(directory);
  try {
    appDatabase.initialize();
    historyDatabase.initialize();
    const now = new Date().toISOString();
    const projectPath = path.join(directory, 'project');
    appDatabase.connection.prepare('insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)').run('search_project', 'Search', projectPath, now, now);
    const claudeDir = path.join(directory, 'claude');
    fs.mkdirSync(claudeDir);
    const row = (sessionId: string, uuid: string, role: 'user' | 'assistant', content: string) => JSON.stringify({ type: role, uuid, message: { role, content }, cwd: projectPath, sessionId, timestamp: now });
    fs.writeFileSync(path.join(claudeDir, 'needle.jsonl'), [
      row('search_needle', 'n1', 'user', 'Where is the sapphire-history-needle?'),
      row('search_needle', 'n2', 'assistant', 'The sapphire-history-needle is in the parser.')
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(claudeDir, 'titled.jsonl'), `${row('search_titled', 't1', 'user', 'Refactor the sapphire renderer')}\n`);
    fs.writeFileSync(path.join(claudeDir, 'plain.jsonl'), `${row('search_plain', 'p1', 'user', 'An unrelated note')}\n`);
    fs.writeFileSync(path.join(claudeDir, 'routine.jsonl'), `${row('search_routine', 'r1', 'user', 'Morning sapphire digest')}\n`);
    const search = new HistorySearchIndexService(historyDatabase);
    const imports = new AgentHistoryImportService(historyDatabase, new ProviderHistoryDiscoveryService(), null, search, appDatabase);
    imports.configure({ provider: 'claude', path: claudeDir, enabled: true, watch_enabled: false });
    imports.import({ provider: 'claude', trigger: 'manual' });
    const read = new AgentHistoryReadService(historyDatabase);

    const needle = read.searchConversations({ query: 'sapphire-history-need', project_id: 'search_project' }).conversations;
    assert.deepEqual(needle.map((conversation) => conversation.providerConversationId), ['search_needle'], 'two matching messages give one row, and the last term matches as a prefix');
    assert.ok(needle[0]?.match.messageId, 'a message hit names its message');
    assert.match(needle[0]?.match.preview ?? '', /\u0002sapphire/, 'the preview marks the match');
    const both = read.searchConversations({ query: 'sapphire', project_id: 'search_project' }).conversations;
    assert.deepEqual(new Set(both.map((conversation) => conversation.providerConversationId)), new Set(['search_needle', 'search_titled', 'search_routine']));
    assert.equal(read.searchConversations({ query: 'sapphire', project_id: 'search_project', provider: 'codex' }).conversations.length, 0, 'the provider filter applies');
    assert.equal(read.searchConversations({ query: 'sapphire', project_id: 'project_elsewhere' }).conversations.length, 0, 'search stays in the project');
    assert.deepEqual(read.searchConversations({ query: '"*', project_id: 'search_project' }).conversations, [], 'a query with no terms returns nothing');

    // Resumable listings hide sub-agents and order by the later of activity and closing.
    const setConversation = historyDatabase.connection.prepare('update conversations set session_id = ?, updated_at = ? where provider_conversation_id = ?');
    setConversation.run('session_child', now, 'search_needle');
    setConversation.run('session_closed', '2026-01-01T00:00:00.000Z', 'search_titled');
    setConversation.run('session_routine', now, 'search_routine');
    const closedAt = new Date(Date.now() + 60_000).toISOString();
    const sessions = [{ id: 'session_child', role: 'child', exitedAt: null }, { id: 'session_routine', role: 'routine', exitedAt: null }, { id: 'session_closed', role: 'orchestrator', exitedAt: closedAt }];
    const resumable = read.list({ project_id: 'search_project', resumable: true }, sessions).conversations;
    assert.deepEqual(resumable.map((conversation) => conversation.providerConversationId), ['search_titled', 'search_plain'], 'sub-agents and routine runs are hidden, and a recent close outranks older activity');
    assert.equal((resumable[0] as { sessionClosedAt?: string | null }).sessionClosedAt, closedAt, 'the close time is returned');
    assert.equal(read.list({ project_id: 'search_project' }, sessions).conversations.length, 4, 'plain listings still include them');
    assert.deepEqual(read.searchConversations({ query: 'sapphire', project_id: 'search_project', resumable: true }, sessions).conversations.map((conversation) => conversation.providerConversationId), ['search_titled'], 'resumable search hides them too');

    // Session titles are stored on the conversation their session resumes.
    const addSession = appDatabase.connection.prepare(`insert into sessions (id, project_id, harness, session_role, resume_id, started_at, interface_mode, display_name, auto_title, last_title)
      values (?, 'search_project', ?, 'orchestrator', ?, ?, ?, ?, ?, ?)`);
    addSession.run('title_old', 'claude', 'search_plain', '2026-01-01T00:00:00.000Z', 'integrated', null, 'Stale generated title', null);
    addSession.run('title_new', 'claude', 'search_plain', '2026-01-02T00:00:00.000Z', 'integrated', null, 'Emerald ledger cleanup', null);
    addSession.run('title_placeholder', 'claude', 'search_needle', now, 'integrated', null, null, 'Claude Code');
    addSession.run('title_codex_tui', 'codex', 'search_titled', now, 'tui', null, null, 'project');
    addSession.run('title_wrong_harness', 'codex', 'search_routine', now, 'integrated', 'Not this conversation', null, null);
    addSession.run('title_resumed', 'claude', 'search_titled', now, 'integrated', 'Refactor the sapphire renderer', 'Sapphire renderer cleanup', null);
    const titles = new ConversationTitleSync(historyDatabase, appDatabase);
    const retitled = titles.sync();
    assert.equal(retitled.length, 2, 'only an exact provider and resume ID match takes a title, and placeholders are ignored');
    assert.equal(read.list({ project_id: 'search_project' }).conversations.find((conversation) => conversation.providerConversationId === 'search_titled')?.title, 'Sapphire renderer cleanup', 'a name copied from the first prompt gives way to the generated title');
    assert.deepEqual(new Set(search.staleTitles()), new Set(retitled), 'retitled conversations need reindexing until it is done');
    for (const id of search.staleTitles()) search.indexConversation(id);
    assert.deepEqual(search.staleTitles(), [], 'a finished reindex is current');
    assert.deepEqual(titles.sync(), [], 'an unchanged title is not rewritten');
    const plain = read.list({ project_id: 'search_project' }).conversations.find((conversation) => conversation.providerConversationId === 'search_plain');
    assert.equal(plain?.title, 'Emerald ledger cleanup', 'the newest session title wins over the first prompt');
    assert.equal(plain?.nativeTitle, 'An unrelated note', 'the native title is kept');
    assert.deepEqual(read.searchConversations({ query: 'emerald', project_id: 'search_project' }).conversations.map((conversation) => conversation.providerConversationId), ['search_plain'], 'the session title is searchable');
    assert.equal(read.searchConversations({ query: 'unrelated', project_id: 'search_project' }).conversations.length, 1, 'the native title stays searchable');
    imports.import({ provider: 'claude', trigger: 'manual' });
    assert.equal(read.list({ project_id: 'search_project' }).conversations.find((conversation) => conversation.providerConversationId === 'search_plain')?.title, 'Emerald ledger cleanup', 're-importing keeps the session title');
    // A reindex interrupted after clearing its state row is found again.
    historyDatabase.connection.prepare(`delete from conversation_history_index_state where conversation_id = ?`).run(retitled[0]);
    assert.deepEqual(search.staleTitles(), [retitled[0]], 'an unfinished reindex is retried');
    search.indexConversation(retitled[0]!);
    // Renaming back to the first prompt clears the override.
    appDatabase.connection.prepare(`update sessions set display_name = 'An unrelated note', auto_title = null where id = 'title_new'`).run();
    assert.equal(titles.sync().length, 1);
    assert.equal(read.list({ project_id: 'search_project' }).conversations.find((conversation) => conversation.providerConversationId === 'search_plain')?.title, 'An unrelated note', 'a name equal to the native title shows the native title');
    assert.deepEqual(sessionTitles({ harness: 'claude', interface_mode: 'tui', display_name: null, auto_title: null, last_title: '\u2733 Fix the parser' }), ['Fix the parser'], 'a Claude terminal title drops its spinner');

    // A harness's own child threads link by directory but are not the session's conversation.
    historyDatabase.connection.prepare(`update conversations set session_id = 'session_main', updated_at = ?, metadata = json_set(metadata, '$.parentThreadId', 'search_plain') where provider_conversation_id = 'search_needle'`).run(closedAt);
    historyDatabase.connection.prepare(`update conversations set session_id = 'session_main' where provider_conversation_id = 'search_plain'`).run();
    const main = read.list({ project_id: 'search_project' }).conversations.find((conversation) => conversation.providerConversationId === 'search_plain')!;
    assert.equal(read.conversationIdForSession({ sessionId: 'session_main', provider: 'claude', resumeId: 'search_plain', projectId: 'search_project' }), main.id, 'the resume ID match wins over a newer linked thread');
    assert.equal(read.list({ project_id: 'search_project', resumable: true }, sessions).conversations.some((conversation) => conversation.providerConversationId === 'search_needle'), false, 'child threads are not offered for resume');
  } finally {
    historyDatabase.dispose();
    appDatabase.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Prompts sent mid-turn are recorded only as queued commands, and a Codex
// child rollout repeats its parent's session_meta after its own.
function verifyNativeThreadIdentity(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-history-identity-'));
  try {
    const claudeFile = path.join(directory, 'claude.jsonl');
    const base = { cwd: directory, sessionId: 'queued_session', timestamp: '2026-07-01T00:00:00.000Z' };
    fs.writeFileSync(claudeFile, [
      { ...base, type: 'user', uuid: 'u1', message: { role: 'user', content: 'Start the build' } },
      { ...base, type: 'queue-operation', operation: 'enqueue', content: 'Also check the logs' },
      { ...base, type: 'attachment', uuid: 'a1', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'Also check the logs' }], source_uuid: 'client_1', commandMode: 'prompt' } },
      { ...base, type: 'attachment', uuid: 'a2', attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>', source_uuid: 'task_1', commandMode: 'task-notification' } },
      { ...base, type: 'attachment', uuid: 'a3', attachment: { type: 'queued_command', prompt: 'Already a user row', source_uuid: 'u2', commandMode: 'prompt' } },
      { ...base, type: 'user', uuid: 'u2', message: { role: 'user', content: 'Already a user row' } },
      { ...base, type: 'assistant', uuid: 'r1', message: { role: 'assistant', content: 'Done' } },
      // Claude Code 2.1.312 records each API request, system prompt included.
      { type: 'api-request-blob', sessionId: 'queued_session', hash: 'h1', message: { role: 'system', content: [{ type: 'text', text: 'You are Claude Code' }] } },
      { type: 'api-request-blob', sessionId: 'queued_session', hash: 'h2', message: { role: 'user', content: 'Start the build' } }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const claude = new ClaudeHistoryAdapter().parseFile(claudeFile).conversations[0]!;
    assert.deepEqual(claude.messages.map((message) => [message.providerMessageId, message.role, message.text]), [
      ['u1', 'user', 'Start the build'],
      ['client_1', 'user', 'Also check the logs'],
      ['u2', 'user', 'Already a user row'],
      ['r1', 'assistant', 'Done']
    ], 'a mid-turn prompt is imported once under its submitted ID; task notifications, queue echoes and recorded API requests are not');

    const codexFile = path.join(directory, 'child.jsonl');
    fs.writeFileSync(codexFile, [
      { timestamp: '2026-07-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'child_thread', parent_thread_id: 'parent_thread', cwd: directory } },
      { timestamp: '2026-07-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'parent_thread', cwd: directory } },
      { timestamp: '2026-07-01T00:00:01.000Z', type: 'response_item', payload: { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: 'Review the PR' }] } }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const codex = new CodexHistoryAdapter().parseFile(codexFile).conversations[0]!;
    assert.equal(codex.providerConversationId, 'child_thread', 'a child rollout keeps its own thread ID instead of replacing its parent');
    assert.equal(codex.metadata.parentThreadId, 'parent_thread', 'the parent thread is recorded');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// A project-scoped scan reads every source file. Conversations must link by
// their own evidence, never to whichever project asked for the scan.
function verifyScopedScanLinking(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-history-scope-'));
  const database = new DatabaseService(directory);
  try {
    database.initialize();
    const now = new Date().toISOString();
    const insertProject = database.connection.prepare('insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)');
    insertProject.run('scope_asking', 'Asking', path.join(directory, 'asking'), now, now);
    insertProject.run('scope_other', 'Other', path.join(directory, 'other'), now, now);
    const claudeDir = path.join(directory, 'claude');
    fs.mkdirSync(claudeDir);
    const write = (id: string, cwd: string) => fs.writeFileSync(path.join(claudeDir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', uuid: `${id}_1`, message: { role: 'user', content: `Prompt ${id}` }, cwd, sessionId: id, timestamp: now })}\n`);
    write('scope_mine', path.join(directory, 'asking', 'src'));
    write('scope_theirs', path.join(directory, 'other'));
    write('scope_elsewhere', path.join(directory, 'unrelated'));
    const imports = new AgentHistoryImportService(database, new ProviderHistoryDiscoveryService(), null);
    imports.configure({ provider: 'claude', path: claudeDir, enabled: true, watch_enabled: false });
    imports.import({ provider: 'claude', project_id: 'scope_asking', trigger: 'manual' });
    const links = Object.fromEntries((database.connection.prepare(`select provider_conversation_id, project_id from conversations`).all() as Array<{ provider_conversation_id: string; project_id: string | null }>)
      .map((row) => [row.provider_conversation_id, row.project_id]));
    assert.deepEqual(links, { scope_mine: 'scope_asking', scope_theirs: 'scope_other', scope_elsewhere: null }, 'a scoped scan links conversations by path only');

    if (process.platform === 'win32') {
      // One directory reaches history as `c:/users/x`, `C:\Users\x`, or Git Bash's `/c/Users/x`.
      const asking = path.join(directory, 'asking', 'src');
      write('scope_lower', asking.toLowerCase().replace(/\\/g, '/'));
      write('scope_msys', asking.replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`).replace(/\\/g, '/'));
      write('scope_other_upper', path.join(directory, 'other').toUpperCase());
      imports.import({ provider: 'claude', trigger: 'manual' });
      const windowsLinks = Object.fromEntries((database.connection.prepare(`select provider_conversation_id, project_id from conversations where provider_conversation_id in ('scope_lower', 'scope_msys', 'scope_other_upper')`).all() as Array<{ provider_conversation_id: string; project_id: string | null }>)
        .map((row) => [row.provider_conversation_id, row.project_id]));
      assert.deepEqual(windowsLinks, { scope_lower: 'scope_asking', scope_msys: 'scope_asking', scope_other_upper: 'scope_other' }, 'Windows spellings of a project path link to it');
    }

    const manualDir = path.join(directory, 'manual');
    fs.mkdirSync(manualDir);
    const explicitFile = path.join(manualDir, 'scope_explicit.jsonl');
    fs.writeFileSync(explicitFile, `${JSON.stringify({ type: 'user', uuid: 'scope_explicit_1', message: { role: 'user', content: 'Explicit prompt' }, cwd: path.join(directory, 'unrelated'), sessionId: 'scope_explicit', timestamp: now })}\n`);
    imports.import({ provider: 'claude', path: explicitFile, project_id: 'scope_asking', trigger: 'manual' });
    assert.equal((database.connection.prepare(`select project_id from conversations where provider_conversation_id = 'scope_explicit'`).get() as { project_id: string }).project_id, 'scope_asking', 'an explicit file import assigns the requested project');
  } finally {
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  verifySecretRedaction();
  verifyScopedScanLinking();
  verifyConversationSearch();
  verifyNativeThreadIdentity();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-history-'));
  verifyChunkedJsonlReader(tempDir);
  let database: DatabaseService | null = null;
  let historyDatabase: HistoryDatabaseService | null = null;
  try {
    database = new DatabaseService(tempDir);
    database.initialize();
    historyDatabase = new HistoryDatabaseService(tempDir, { mode: 'read', busyTimeoutMs: 250 });
    historyDatabase.initialize({ migrate: false });
    const timeline = new TimelineService(database);
    new WorkbenchSeeder(database, timeline).seedIfEmpty();
    const repo = new WorkbenchRepository(database);
    const project = repo.snapshot().projects[0]?.project;
    assert.ok(project);
    const search = new SearchService(database, historyDatabase);
    const imports = new AgentHistoryImportService(database, new ProviderHistoryDiscoveryService(), timeline, search);
    const read = new AgentHistoryReadService(database);
    const del = new AgentHistoryDeleteService(database, search);
    verifyResumeCaptureNoOp(database);
    await verifyGuidanceReimport(tempDir, database, imports, read, project.id);

    const claudeDir = path.join(tempDir, 'claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeFile = path.join(claudeDir, 'claude-session.jsonl');
    fs.writeFileSync(claudeFile, [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'queued-prompt-should-not-store', sessionId: 'claude_resume_1', timestamp: '2026-07-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'attachment', uuid: 'c_meta_1', attachment: { type: 'deferred_tools_delta', addedNames: ['should-not-store-deferred-tool'] }, cwd: process.cwd(), sessionId: 'claude_resume_1', timestamp: '2026-07-01T00:00:00.000Z', version: '1.0.0' }),
      JSON.stringify({ type: 'user', uuid: 'c_msg_1', message: { role: 'user', content: 'Find the sapphire-history-needle using api_key=supersecretvalue12345' }, cwd: process.cwd(), sessionId: 'claude_resume_1', timestamp: '2026-07-01T00:00:00.000Z', version: '1.0.0' }),
      JSON.stringify({ type: 'assistant', uuid: 'c_thinking_1', parentUuid: 'c_msg_1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'thinking-signature-should-not-store' }] }, cwd: process.cwd(), sessionId: 'claude_resume_1', timestamp: '2026-07-01T00:00:30.000Z' }),
      JSON.stringify({ type: 'assistant', uuid: 'c_tool_1', parentUuid: 'c_msg_1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_history_1', name: 'Bash', input: { command: 'printf ok' } }] }, cwd: process.cwd(), sessionId: 'claude_resume_1', timestamp: '2026-07-01T00:00:45.000Z' }),
      JSON.stringify({ type: 'user', uuid: 'c_tool_result_1', parentUuid: 'c_tool_1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_history_1', content: 'tool-result-history-needle', is_error: false }] }, cwd: process.cwd(), sessionId: 'claude_resume_1', timestamp: '2026-07-01T00:00:50.000Z' }),
      JSON.stringify({ type: 'assistant', uuid: 'c_tool_2', parentUuid: 'c_tool_result_1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_history_2', name: 'Bash', input: { command: 'true' } }] }, cwd: process.cwd(), sessionId: 'claude_resume_1', timestamp: '2026-07-01T00:00:52.000Z' }),
      JSON.stringify({ type: 'user', uuid: 'c_tool_result_2', parentUuid: 'c_tool_2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_history_2', content: '', is_error: false }] }, cwd: process.cwd(), sessionId: 'claude_resume_1', timestamp: '2026-07-01T00:00:53.000Z' }),
      JSON.stringify({ type: 'assistant', uuid: 'c_msg_2', parentUuid: 'c_msg_1', message: { role: 'assistant', content: 'The sapphire-history-needle is in the parsed transcript. {"api_key":"jsonsecretvalue12345","password":"quotedpassword12345","secret":"quotedsecret12345"}' }, cwd: process.cwd(), sessionId: 'claude_resume_1', timestamp: '2026-07-01T00:01:00.000Z' })
    ].join('\n'));
    const parserWorkerResult = await runHistoryImportWorker({ action: 'parse_file', provider: 'claude', sourceKind: 'manual_file', sourcePath: claudeDir, filePath: claudeFile });
    assert.equal(parserWorkerResult.ok, true, 'worker parser mode still parses a single provider file');

    const codexDir = path.join(tempDir, 'codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'codex-session.jsonl'), [
      JSON.stringify({ timestamp: '2026-07-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'codex_resume_1', cwd: process.cwd(), cli_version: '2.0.0' } }),
      JSON.stringify({ timestamp: '2026-07-01T00:00:01.000Z', type: 'message', payload: { role: 'user', content: [{ type: 'text', text: 'Codex ruby-history-needle prompt' }] } }),
      JSON.stringify({ timestamp: '2026-07-01T00:00:02.000Z', type: 'message', payload: { role: 'assistant', content: [{ type: 'text', text: 'Codex response with ruby-history-needle' }] } }),
      JSON.stringify({ timestamp: '2026-07-01T00:00:03.000Z', type: 'response_item', payload: { type: 'message', id: 'codex_msg_1', role: 'developer', content: [{ type: 'input_text', text: 'Use concise answers.' }] } }),
      JSON.stringify({ timestamp: '2026-07-01T00:00:04.000Z', type: 'response_item', payload: { type: 'message', id: 'codex_msg_2', role: 'user', content: [{ type: 'input_text', text: 'Codex response-item-user-history-needle prompt' }] } }),
      JSON.stringify({ timestamp: '2026-07-01T00:00:05.000Z', type: 'response_item', payload: { type: 'function_call', id: 'codex_call_item_1', call_id: 'codex_call_1', name: 'shell', arguments: '{"cmd":"printf codex-tool-history-needle"}', status: 'completed' } }),
      JSON.stringify({ timestamp: '2026-07-01T00:00:06.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'codex_call_1', output: 'codex-tool-output-history-needle' } }),
      JSON.stringify({ timestamp: '2026-07-01T00:00:07.000Z', type: 'response_item', payload: { type: 'message', id: 'codex_msg_3', role: 'assistant', content: [{ type: 'output_text', text: 'Codex response-item-assistant-history-needle answer' }] } })
    ].join('\n'));

    const opencodeDb = path.join(tempDir, 'opencode.db');
    seedOpenCodeDb(opencodeDb);

    imports.configure({ provider: 'claude', path: claudeDir, enabled: true, watch_enabled: false });
    imports.configure({ provider: 'codex', path: codexDir, enabled: true, watch_enabled: false });
    imports.configure({ provider: 'opencode', path: opencodeDb, source_kind: 'opencode_db', enabled: true, watch_enabled: false });
    const sources = new AgentHistorySourceService(database, new ProviderHistoryDiscoveryService());
    database.connection.prepare(`insert into conversation_import_sources
      (id, provider, source_kind, path, enabled, watch_enabled, created_at, updated_at)
      values (?, ?, ?, ?, 1, 1, ?, ?)`)
      .run('removed_source', 'amp', 'amp_cli', claudeDir, new Date().toISOString(), new Date().toISOString());
    assert.ok(sources.sources().sources.every((source) => (source.provider as string) !== 'amp'), 'removed history sources stay out of settings');
    assert.ok(sources.importCandidates({}).every((source) => (source.provider as string) !== 'amp'), 'removed history sources never enter the import queue');
    assert.ok(sources.enabledWatchSources().every((source) => (source.provider as string) !== 'amp'), 'removed history sources never get watchers');
    assert.throws(() => imports.configure({ provider: 'amp', path: claudeDir } as never), /Invalid enum value/);

    const result = imports.import({ trigger: 'manual', project_id: project.id });
    assert.equal(result.errorCount, 0);
    assert.ok(result.conversationsImported >= 3, 'imports all provider conversations');

    const list = read.list({ project_id: project.id, limit: 20 });
    assert.ok(list.conversations.some((conversation) => conversation.provider === 'claude'));
    assert.ok(list.conversations.some((conversation) => conversation.provider === 'codex'));
    assert.ok(list.conversations.some((conversation) => conversation.provider === 'opencode'));

    // Readers page backwards from the newest messages by sequence number.
    const claudeConversationId = list.conversations.find((conversation) => conversation.provider === 'claude')!.id;
    const everything = read.get({ conversation_id: claudeConversationId, limit: 200 }).messages.map((message) => message.id);
    assert.ok(everything.length >= 3);
    const tail = read.tail(claudeConversationId, 2);
    assert.deepEqual(tail.messages.map((message) => message.id), everything.slice(-2));
    assert.equal(tail.has_more, everything.length > 2);
    assert.deepEqual(read.tail(claudeConversationId, 1, tail.messages[0]!.seq).messages.map((message) => message.id), everything.slice(-3, -2), 'tail pages back from a sequence number');

    const searchResults = search.search({ query: 'sapphire-history-needle', limit: 10 });
    assert.ok(searchResults.results.some((row) => row.kind === 'conversation_message'), 'conversation messages are searchable');
    assert.ok(searchResults.results[0]?.target.conversation_id, 'search target includes conversation id');

    const stored = database.connection.prepare(`select text from conversation_messages where text like '%sapphire-history-needle%' limit 1`).get() as { text: string } | undefined;
    assert.ok(stored?.text.includes('[REDACTED]'), 'secrets are redacted before storage');
    assert.ok(stored);
    assert.equal(stored.text.includes('supersecretvalue12345'), false, 'raw secret is not stored');
    assert.equal(stored.text.includes('jsonsecretvalue12345'), false, 'quoted JSON secret is not stored');
    assert.equal(stored.text.includes('quotedpassword12345'), false, 'quoted JSON password is not stored');

    const importedText = database.connection.prepare(`select group_concat(coalesce(text, '') || ' ' || coalesce(tool_input_summary, '') || ' ' || coalesce(tool_output_summary, ''), '\n') as text from conversation_messages`).get() as { text: string };
    assert.equal(importedText.text.includes('should-not-store-deferred-tool'), false, 'Claude metadata attachments are not imported as chat messages');
    assert.equal(importedText.text.includes('queued-prompt-should-not-store'), false, 'Claude queue operations do not duplicate prompts');
    assert.equal(importedText.text.includes('thinking-signature-should-not-store'), false, 'Claude thinking signatures are not imported as chat messages');
    assert.ok(importedText.text.includes('tool-result-history-needle'), 'Claude tool results are imported as tool output');

    const claudeToolResult = database.connection.prepare(`select tool_name, tool_output_summary from conversation_messages where metadata like '%toolu_history_1%' and kind = 'tool_result' limit 1`).get() as { tool_name: string; tool_output_summary: string } | undefined;
    assert.equal(claudeToolResult?.tool_name, 'Bash', 'Claude tool results inherit the preceding tool name');
    const emptyClaudeToolResults = database.connection.prepare(`select count(*) as count from conversation_messages where metadata like '%toolu_history_2%' and kind = 'tool_result'`).get() as { count: number };
    assert.equal(emptyClaudeToolResults.count, 0, 'Claude empty successful tool results are not imported as empty bubbles');

    const codexConversation = database.connection.prepare(`select provider_conversation_id from conversations where provider = 'codex' limit 1`).get() as { provider_conversation_id: string } | undefined;
    assert.equal(codexConversation?.provider_conversation_id, 'codex_resume_1', 'Codex response item ids do not replace the session id');
    assert.ok(importedText.text.includes('Codex response-item-user-history-needle prompt'), 'Codex response_item user messages are imported');
    assert.ok(importedText.text.includes('Codex response-item-assistant-history-needle answer'), 'Codex response_item assistant messages are imported');
    assert.ok(importedText.text.includes('codex-tool-history-needle'), 'Codex function_call arguments are imported as tool input');
    assert.ok(importedText.text.includes('codex-tool-output-history-needle'), 'Codex function_call_output is imported as tool output');

    const openCodeTool = database.connection.prepare(`select tool_output_summary, metadata from conversation_messages where tool_name = 'read' limit 1`).get() as { tool_output_summary: string; metadata: string } | undefined;
    assert.ok(openCodeTool?.tool_output_summary.includes('File: /tmp/large-history.csv'), 'OpenCode file tool output is summarized as a file reference');
    assert.equal(openCodeTool?.tool_output_summary.includes('csv-tail-should-not-store'), false, 'OpenCode file tool output does not store large file tails');
    assert.ok(openCodeTool?.metadata.includes('/tmp/large-history.csv'), 'OpenCode file references are kept in message metadata');

    const openCodeInlineFile = database.connection.prepare(`select text, metadata from conversation_messages where text like 'File: /tmp/inline-history.csv%' limit 1`).get() as { text: string; metadata: string } | undefined;
    assert.ok(openCodeInlineFile?.text.includes('inline-history-needle'), 'OpenCode inline file attachments keep a preview');
    assert.equal(openCodeInlineFile?.text.includes('inline-tail-should-not-store'), false, 'OpenCode inline file attachments do not store large file tails');
    assert.ok(openCodeInlineFile?.metadata.includes('/tmp/inline-history.csv'), 'OpenCode inline file attachment paths are kept in metadata');

    const queueBatchesBefore = database.connection.prepare(`select count(*) as count from conversation_import_batches`).get() as { count: number };
    const queuedImport = await runQueuedImport(tempDir, mainHistoryRunner(imports, del), { provider: 'claude', path: claudeDir, trigger: 'manual', project_id: project.id });
    const queueBatchesAfter = database.connection.prepare(`select count(*) as count from conversation_import_batches`).get() as { count: number };
    assert.equal(queueBatchesAfter.count, queueBatchesBefore.count + 1, 'queued child-process import records a batch');
    assert.equal(queuedImport.status.recent[0]?.status, 'succeeded', 'queued import is visible as a succeeded queue job');
    assert.ok(queuedImport.events.some((event) => event.source === 'history-import-queue' && event.event === 'job.succeeded'), 'queued import writes debug lifecycle events');
    const workerDir = path.join(tempDir, 'worker-claude');
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(workerDir, 'worker-session.jsonl'), JSON.stringify({ type: 'user', uuid: 'worker_msg_1', message: { role: 'user', content: 'worker-import-history-needle' }, cwd: process.cwd(), sessionId: 'worker_resume_1', timestamp: '2026-07-01T00:03:00.000Z' }));
    const workerProgress: unknown[] = [];
    const workerImport = await runHistoryImportWorker(
      { action: 'import', appDataPath: tempDir, input: { provider: 'claude', path: workerDir, trigger: 'manual', project_id: project.id } },
      (progress) => workerProgress.push(progress)
    );
    assert.equal(workerImport.ok, true, `history import worker can run a queued import against app db: ${workerImport.error ?? 'unknown error'}`);
    assert.ok(workerProgress.length > 0, 'history import worker reports queue progress');
    assert.ok(search.search({ query: 'worker-import-history-needle', limit: 10 }).results.some((row) => row.kind === 'conversation_message'), 'history import worker writes searchable messages');

    await runChunkedImportIntegrity(tempDir, database, imports, search, project.id);
    await runHistoryFtsAppend(tempDir);
    await runStreamingOpenCodeImport(tempDir);

    const conversationId = searchResults.results[0]!.target.conversation_id!;
    del.deleteConversation(conversationId);
    const deleted = read.get({ conversation_id: conversationId });
    assert.equal(deleted.conversation, null, 'delete removes local conversation records');
    assert.equal(fs.existsSync(claudeFile), true, 'delete does not remove provider source file');
    imports.import({ trigger: 'manual', project_id: project.id });
    const stillDeleted = read.get({ conversation_id: conversationId });
    assert.equal(stillDeleted.conversation, null, 'deleted conversation is not resurrected by reimport');

    const noOp = imports.import({ trigger: 'manual', project_id: project.id });
    assert.equal(noOp.conversationsImported, 0, 'unchanged files are skipped on no-op reimport');

    await runClaudeSubagentImport(tempDir, database, imports, project.id);
    await runClaudeWorktreeReplayImport(tempDir, database, imports, project.id);
    await runJsonlWatermarkImport(tempDir, database, imports, project.id);

    const staleBatchId = 'stale_batch_fixture';
    database.connection.prepare(`insert into conversation_import_batches (id, trigger, provider, project_id, started_at, status) values (?, 'startup', 'codex', ?, ?, 'running')`)
      .run(staleBatchId, project.id, new Date(Date.now() - HISTORY_IMPORT_STALE_MS - 1_000).toISOString());
    assert.equal(read.importStatus(20).batches.find((batch) => batch.id === staleBatchId)?.status, 'stale', 'old running import batches are surfaced as stale');
    assert.equal(read.importStatus(20, [staleBatchId]).batches.find((batch) => batch.id === staleBatchId)?.status, 'running', 'active queue batch ids are not marked stale');
    const problemPaths = read.importStatus(1_000).files.map((file) => file.path);
    assert.equal(problemPaths.includes(opencodeDb), false, 'unchanged skipped files are not listed for review');
    assert.ok(problemPaths.every((filePath) => !filePath.includes('claude-replay')), 'Claude worktree replays are not listed for review');
    await runIncrementalScanRecovery(tempDir, database, imports, project.id);
    await runIncrementalScanEdgeCases(tempDir, database, imports, project.id);

    database.connection.prepare(`update conversation_import_files set content_hash = ?, metadata = ? where provider = 'opencode' and path = ?`).run('legacy-sqlite-sidecar-fingerprint', '{}', opencodeDb);
    fs.utimesSync(opencodeDb, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    const openCodeTouched = imports.import({ provider: 'opencode', path: opencodeDb, trigger: 'manual', project_id: project.id });
    assert.equal(openCodeTouched.conversationsImported, 0, 'OpenCode mtime churn without logical DB changes is skipped');
    assert.ok(openCodeTouched.skippedCount > 0, 'legacy OpenCode fingerprints are refreshed without rewriting conversations');

    appendOpenCodeMessage(opencodeDb);
    const openCodeChanged = imports.import({ provider: 'opencode', path: opencodeDb, trigger: 'manual', project_id: project.id });
    assert.equal(openCodeChanged.conversationsImported, 1, 'OpenCode reimport only rewrites logically changed sessions');

    await runOpenCodeWatermarkImport(tempDir, imports, project.id);
    await runOpenCodeLookbackImport(tempDir, database, imports, project.id);

    fs.appendFileSync(path.join(codexDir, 'codex-session.jsonl'), `\n${JSON.stringify({ timestamp: '2026-07-01T00:00:08.000Z', type: 'message', payload: { role: 'assistant', content: [{ type: 'text', text: 'Codex appended-history-needle' }] } })}`);
    const appended = imports.import({ provider: 'codex', path: codexDir, trigger: 'manual', project_id: project.id });
    assert.equal(appended.errorCount, 0, 'changed JSONL files re-import cleanly');
    assert.ok(appended.conversationsImported > 0, 'changed JSONL files are not skipped');
    const appendedText = database.connection.prepare(`select text from conversation_messages where text like '%appended-history-needle%' limit 1`).get() as { text: string } | undefined;
    assert.ok(appendedText, 'appended JSONL messages are stored after reimport');

    const outsideDir = path.join(tempDir, 'outside-claude');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'outside-session.jsonl'), JSON.stringify({ type: 'user', uuid: 'outside_msg_1', message: { role: 'user', content: 'outside-global-history-needle' }, cwd: path.join(tempDir, 'not-a-project'), sessionId: 'outside_resume_1', timestamp: '2026-07-01T00:02:00.000Z' }));
    imports.configure({ provider: 'claude', path: outsideDir, enabled: true, watch_enabled: false });
    imports.import({ provider: 'claude', path: outsideDir, trigger: 'manual' });
    const outside = database.connection.prepare(`select project_id, session_id from conversations where provider_conversation_id = 'outside_resume_1'`).get() as { project_id: string | null; session_id: string | null } | undefined;
    assert.deepEqual(outside, { project_id: null, session_id: null }, 'outside conversations with unknown cwd stay global/unlinked');

    const missingSource = path.join(tempDir, 'missing-provider-source', 'sessions');
    const watcher = new AgentHistoryWatcherService({
      enabledWatchSources: () => [{ provider: 'codex', sourceKind: 'manual_directory', path: missingSource, exists: false, enabled: true, watch_enabled: true }],
      import: () => ({ job_id: 'test', status: 'queued', position: null, queue_depth: 1 })
    });
    try {
      watcher.start();
      const watcherStatus = watcher.status();
      assert.equal(watcherStatus.sourceCount, 1, 'watcher tracks configured missing sources');
      assert.equal(watcherStatus.missingCount, 1, 'watcher reports missing source paths');
      assert.ok(watcherStatus.watchedPathCount >= 1, 'watcher observes the nearest existing parent for missing sources');
    } finally {
      watcher.stop();
    }

    await runLargeWatcherStart(tempDir);

    await runWatcherCoalescing(tempDir);

    const queuedReset = await runQueuedReset(tempDir, mainHistoryRunner(imports, del), { trigger: 'manual', project_id: project.id }, false);
    assert.equal(read.list({ project_id: project.id, limit: 20 }).conversations.length, 0, 'queued reset clears local imported conversations');
    assert.equal(historyWatermarkCount(database), 0, 'queued reset clears history import watermarks');
    assert.equal(queuedReset.recent[0]?.action, 'reset_imports', 'queued reset is visible in queue status');
    const queuedResetReimport = await runQueuedReset(tempDir, mainHistoryRunner(imports, del), { trigger: 'manual', project_id: project.id }, true);
    const resetList = read.list({ project_id: project.id, limit: 20 });
    assert.ok(resetList.conversations.some((conversation) => conversation.provider === 'claude'), 'queued reset and reimport restores Claude conversations');
    assert.ok(resetList.conversations.some((conversation) => conversation.provider === 'codex'), 'queued reset and reimport restores Codex conversations');
    assert.ok(resetList.conversations.some((conversation) => conversation.provider === 'opencode'), 'queued reset and reimport restores OpenCode conversations');
    assert.equal(queuedResetReimport.recent[0]?.status, 'succeeded', 'queued reset and reimport is visible as succeeded');

    const launchFailure = await runQueueFailure(tempDir, () => {
      throw new Error('worker launch history failure');
    });
    assert.equal(launchFailure.status.recent[0]?.status, 'failed', 'worker launch failure is visible in queue status');
    assert.equal(launchFailure.status.recent[0]?.error, 'worker launch history failure');
    assert.ok(launchFailure.events.some((event) => event.event === 'job.failed'), 'worker launch failure writes debug logs');

    const workerFailure = await runQueueFailure(tempDir, () => new FailingMessageWorker());
    assert.equal(workerFailure.status.recent[0]?.status, 'failed', 'worker failure message is visible in queue status');
    assert.equal(workerFailure.status.recent[0]?.error, 'worker reported history failure');

    const exitFailure = await runQueueFailure(tempDir, () => new ExitOnlyWorker());
    assert.equal(exitFailure.status.recent[0]?.status, 'failed', 'worker exit before result is visible in queue status');
    assert.ok(exitFailure.status.recent[0]?.error?.includes('exited before reporting'), 'worker exit before result records a useful error');

    const staleFailure = await runQueueStale(tempDir);
    assert.equal(staleFailure.status.recent[0]?.status, 'stale', 'worker without heartbeat is marked stale');
    assert.equal(staleFailure.status.counts.running, 0, 'stale worker releases the running queue slot');
    assert.ok(staleFailure.events.some((event) => event.event === 'job.stale'), 'stale worker writes a debug lifecycle event');
    await runQueueHeartbeat(tempDir);
    verifyInterruptedBatch(tempDir);
    await runWatcherCoalescing(tempDir);
    await runWatcherFollowUpCap(tempDir);
    await runOpenCodeWatcherDebounce(tempDir);
    await runWatcherMaxWait(tempDir);
    await runIntegratedTurnFlush(tempDir);
    await runTitleSyncCoalescing(tempDir);
    await runLargeWatcherStart(tempDir);

    // Removing a project deletes its conversations and keeps them from returning.
    const countProjectConversations = () => (database!.connection.prepare(`select count(*) as count from conversations where project_id = ?`).get(project.id) as { count: number }).count;
    const projectConversations = countProjectConversations();
    assert.ok(projectConversations > 0, 'the fixture project has imported history');
    assert.equal(del.deleteProjectConversations(project.id).deletedConversations, projectConversations);
    assert.equal(countProjectConversations(), 0, 'project history is deleted');
    assert.equal(database!.connection.prepare(`select 1 from conversation_import_batches where project_id = ?`).get(project.id), undefined, 'with its import batches');
    imports.import({ trigger: 'manual', project_id: project.id });
    assert.equal(countProjectConversations(), 0, 'and not re-imported');

    historyDatabase?.dispose();
    historyDatabase = null;
    database?.dispose();
    database = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('agent history import smoke ok');
    process.exit(0);
  } finally {
    historyDatabase?.dispose();
    database?.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function verifyChunkedJsonlReader(directory: string): void {
  const file = path.join(directory, 'chunked-jsonl.jsonl');
  const longText = `${'x'.repeat(256 * 1024 - 2)}😀`;
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'chunked_codex' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: longText }] } }),
    '{invalid}',
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'done' }] } }),
    '{partial'
  ].join('\n'));
  const originalReadFile = fs.readFileSync;
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = (() => { throw new Error('whole-file read'); }) as typeof fs.readFileSync;
  try {
    const parsed = readJsonl(file);
    const rows = [...parsed.records] as Array<Record<string, unknown>>;
    assert.equal(rows.length, 3);
    assert.equal(parsed.warnings.length, 1, 'invalid middle line is reported');
    assert.equal(parsed.partialTrailingLine, true, 'incomplete trailing line is retried');
    const codex = new CodexHistoryAdapter().parseFile(file);
    assert.equal(codex.conversations[0]?.messages.length, 2, 'Codex adapter parses bounded JSONL chunks');
    assert.equal(codex.conversations[0]?.messages[0]?.text, longText, 'UTF-8 content survives chunk boundaries');
    assert.equal(codex.conversations[0]?.status, 'active', 'partial trailing lines keep the session active');
    const claude = new ClaudeHistoryAdapter().parseFile(file);
    assert.ok(claude.warnings.some(warning => warning.includes('partial trailing JSONL line')), 'Claude adapter also reads JSONL without a whole-file read');
  } finally {
    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalReadFile;
  }
}

async function runQueuedImport(appDataPath: string, runJob: HistoryImportQueueRunner, input: Parameters<AgentHistoryImportQueueService['import']>[0]): Promise<{ status: HistoryImportQueueSnapshot; events: QueueLogEvent[] }> {
  let timeout: NodeJS.Timeout | null = null;
  let doneResolve!: () => void;
  const events: QueueLogEvent[] = [];
  const queue = new AgentHistoryImportQueueService(appDataPath, () => {
    if (timeout) clearTimeout(timeout);
    doneResolve();
  }, undefined, fakeLogger(events), { runJob });
  try {
    await new Promise<void>((resolve, reject) => {
      doneResolve = resolve;
      timeout = setTimeout(() => reject(new Error('queued import timed out')), 15_000);
      queue.import(input);
    });
    return { status: queue.status(), events };
  } finally {
    if (timeout) clearTimeout(timeout);
    queue.dispose();
  }
}

function mainHistoryRunner(imports: AgentHistoryImportService, del: AgentHistoryDeleteService): HistoryImportQueueRunner {
  return async (message, reportProgress) => {
    if (message.action === 'reset_imports') {
      const reset = del.resetImportedHistory();
      const imported = message.reimport === false ? null : await imports.importWithParser(message.input, localParseFile, reportProgress);
      return { ...reset, import: imported };
    }
    return imports.importWithParser(message.input, localParseFile, reportProgress);
  };
}

const localParseFile: HistoryFileParser = async (input) => {
  return new ProviderHistoryDiscoveryService().adapter(input.candidate.provider).parseFile(input.filePath, input.options);
};

async function runClaudeSubagentImport(appDataPath: string, database: DatabaseService, imports: AgentHistoryImportService, projectId: string): Promise<void> {
  const sourceDir = path.join(appDataPath, 'claude-subagents');
  const subagentDir = path.join(sourceDir, 'parent-session', 'subagents');
  fs.mkdirSync(subagentDir, { recursive: true });
  const row = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', sessionId: 'parent-session', uuid: text, timestamp: '2026-09-28T12:00:00.000Z', message: { role: 'user', content: text }, ...extra });
  fs.writeFileSync(path.join(sourceDir, 'parent-session.jsonl'), [row('parent-conversation-needle'), row('parent follow-up')].join('\n'));
  fs.writeFileSync(path.join(subagentDir, 'agent-a1.jsonl'), row('subagent-review-needle', { isSidechain: true, agentId: 'a1' }));
  await imports.import({ provider: 'claude', path: sourceDir, trigger: 'manual', project_id: projectId });
  const stored = database.connection.prepare(`
    select conversations.title, count(conversation_messages.id) as messages from conversations
    join conversation_messages on conversation_messages.conversation_id = conversations.id
    where conversations.provider = 'claude' and conversations.provider_conversation_id = 'parent-session'
    group by conversations.id
  `).get() as { title: string; messages: number } | undefined;
  assert.deepEqual({ ...stored }, { title: 'parent-conversation-needle', messages: 2 }, 'Claude subagent transcripts do not replace the parent conversation');
}

async function runClaudeWorktreeReplayImport(appDataPath: string, database: DatabaseService, imports: AgentHistoryImportService, projectId: string): Promise<void> {
  const row = (uuid: string, role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: role, sessionId: 'replay-session', uuid, cwd: appDataPath, timestamp: '2026-10-01T12:00:00.000Z', message: { role, content: text }, ...extra });
  // Claude Code re-appends the chain with a new cwd and slug when a session enters a worktree.
  const replay = { cwd: path.join(appDataPath, '.worktrees', 'replay'), slug: 'replay-slug', promptId: 'replayed-prompt' };
  const lines = [row('u1', 'user', 'replay-first-prompt'), row('a1', 'assistant', 'replay-first-answer'), row('u1', 'user', 'replay-first-prompt', replay), row('a1', 'assistant', 'replay-first-answer', replay), row('u2', 'user', 'replay-after-worktree-needle', replay)];
  const storedTexts = () => (database.connection.prepare(`
    select conversation_messages.text from conversation_messages
    join conversations on conversations.id = conversation_messages.conversation_id
    where conversations.provider = 'claude' and conversations.provider_conversation_id = 'replay-session'
    order by conversation_messages.seq
  `).all() as Array<{ text: string }>).map((stored) => stored.text);
  const expected = ['replay-first-prompt', 'replay-first-answer', 'replay-after-worktree-needle'];

  const syncDir = path.join(appDataPath, 'claude-replay-sync');
  fs.mkdirSync(syncDir, { recursive: true });
  fs.writeFileSync(path.join(syncDir, 'replay-session.jsonl'), lines.join('\n'));
  const syncImport = imports.import({ provider: 'claude', path: syncDir, trigger: 'manual', project_id: projectId });
  assert.equal(syncImport.errorCount, 0, 'Claude worktree replays import without repeated message ids');
  assert.deepEqual(storedTexts(), expected, 'Claude worktree replays keep the first copy of each row');
  const fileStatus = database.connection.prepare(`select status from conversation_import_files where provider = 'claude' and path = ?`).get(path.join(syncDir, 'replay-session.jsonl')) as { status: string };
  assert.equal(fileStatus.status, 'imported', 'the Claude parser drops worktree replays itself, without the repeated-id warning');

  const chunkedDir = path.join(appDataPath, 'claude-replay-chunked');
  fs.mkdirSync(chunkedDir, { recursive: true });
  fs.writeFileSync(path.join(chunkedDir, 'replay-session.jsonl'), [...lines, row('a2', 'assistant', 'replay-chunked-answer', replay)].join('\n'));
  const chunkedImport = await imports.importWithParser({ provider: 'claude', path: chunkedDir, trigger: 'manual', project_id: projectId }, localParseFile);
  assert.equal(chunkedImport.errorCount, 0, 'chunked Claude worktree replays import without repeated message ids');
  assert.deepEqual(storedTexts(), [...expected, 'replay-chunked-answer'], 'chunked Claude worktree replays append after the first copy');
}

async function runJsonlWatermarkImport(appDataPath: string, database: DatabaseService, imports: AgentHistoryImportService, projectId: string): Promise<void> {
  const sourceDir = path.join(appDataPath, 'watermark-codex');
  fs.mkdirSync(sourceDir, { recursive: true });
  const firstFile = path.join(sourceDir, 'first.jsonl');
  const secondFile = path.join(sourceDir, 'second.jsonl');
  fs.writeFileSync(firstFile, JSON.stringify(codexMessage('watermark_a', 'watermark-history-needle-a', '2026-07-01T03:00:00.000Z')));
  fs.writeFileSync(secondFile, JSON.stringify(codexMessage('watermark_b', 'watermark-history-needle-b', '2026-07-01T03:01:00.000Z')));
  const oldMtime = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(firstFile, oldMtime, oldMtime);

  let parsedFiles: string[] = [];
  const countingParser: HistoryFileParser = async (input) => {
    parsedFiles.push(input.filePath);
    return localParseFile(input);
  };
  const initial = await imports.importWithParser({ provider: 'codex', path: sourceDir, trigger: 'manual', project_id: projectId }, countingParser);
  assert.equal(initial.conversationsImported, 2, 'watermark fixture full import stores both JSONL files');
  assert.equal(parsedFiles.length, 2, 'watermark fixture full import parses all files');
  imports.configure({ provider: 'codex', path: sourceDir, enabled: true, watch_enabled: false });

  parsedFiles = [];
  const noChange = await imports.importWithParser({ provider: 'codex', path: sourceDir, trigger: 'startup', project_id: projectId }, countingParser);
  assert.equal(noChange.conversationsImported, 0, 'watermark no-change startup import stores nothing');
  assert.equal(parsedFiles.length, 0, 'watermark no-change startup import does not parse unchanged JSONL files');

  database.connection.prepare(`update conversation_import_files set status = 'importing' where provider = 'codex' and path = ?`).run(firstFile);
  parsedFiles = [];
  const recovered = await imports.importWithParser({ provider: 'codex', path: sourceDir, trigger: 'watcher', project_id: projectId }, countingParser);
  assert.equal(recovered.errorCount, 0, 'watermark retries an interrupted JSONL import');
  assert.deepEqual(parsedFiles, [firstFile], 'watermark does not strand interrupted JSONL files outside the lookback');

  fs.appendFileSync(secondFile, `\n${JSON.stringify(codexMessage('watermark_b2', 'watermark-history-needle-b2', '2026-07-01T03:02:00.000Z'))}`);
  fs.utimesSync(secondFile, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
  parsedFiles = [];
  const changed = await imports.importWithParser({ provider: 'codex', path: sourceDir, trigger: 'watcher', project_id: projectId }, countingParser);
  assert.equal(changed.conversationsImported, 1, 'watermark watcher import stores changed JSONL file');
  assert.deepEqual(parsedFiles, [secondFile], 'watermark watcher import parses only the changed JSONL file');
  const stored = database.connection.prepare(`select text from conversation_messages where text like '%watermark-history-needle-b2%' limit 1`).get() as { text: string } | undefined;
  assert.ok(stored, 'watermark watcher import persists appended JSONL content');
}

async function runOpenCodeWatermarkImport(appDataPath: string, imports: AgentHistoryImportService, projectId: string): Promise<void> {
  const opencodeDb = path.join(appDataPath, 'watermark-opencode.db');
  seedOpenCodeDb(opencodeDb);
  ageOpenCodeSession(opencodeDb, 'opencode_resume_2', Date.now() - 10 * 60_000);
  imports.configure({ provider: 'opencode', path: opencodeDb, source_kind: 'opencode_db', enabled: true, watch_enabled: false });
  const initial = await imports.importWithParser({ provider: 'opencode', path: opencodeDb, trigger: 'manual', project_id: projectId }, localParseFile);
  assert.equal(initial.conversationsImported, 2, 'OpenCode watermark fixture full import stores both sessions');
  const adapter = new OpenCodeHistoryAdapter();
  const currentFingerprint = adapter.fingerprintFile(opencodeDb).metadata;
  assert.deepEqual(
    adapter.changedProviderConversationIds({ schema: 'opencode-logical-v2', historyMaxUpdated: currentFingerprint.historyMaxUpdated }, currentFingerprint),
    ['opencode_resume_1'],
    'legacy OpenCode fingerprints upgrade through the latest session instead of forcing a full reimport'
  );

  appendOpenCodeMessage(opencodeDb);
  const selectedSessionIds: Array<string[] | undefined> = [];
  const recordingParser: HistoryFileParser = async (input) => {
    selectedSessionIds.push(input.options?.providerConversationIds);
    return localParseFile(input);
  };
  const changed = await imports.importWithParser({ provider: 'opencode', path: opencodeDb, trigger: 'watcher', project_id: projectId }, recordingParser);
  assert.equal(changed.conversationsImported, 1, 'OpenCode watermark watcher import stores only changed sessions');
  assert.deepEqual(selectedSessionIds, [['opencode_resume_1']], 'OpenCode watermark watcher import passes only updated session ids to parser');
}

async function runOpenCodeLookbackImport(appDataPath: string, database: DatabaseService, imports: AgentHistoryImportService, projectId: string): Promise<void> {
  const opencodeDb = path.join(appDataPath, 'lookback-opencode.db');
  seedOpenCodeDb(opencodeDb);
  imports.configure({ provider: 'opencode', path: opencodeDb, source_kind: 'opencode_db', enabled: true, watch_enabled: false });
  const initial = await imports.importWithParser({ provider: 'opencode', path: opencodeDb, trigger: 'manual', project_id: projectId }, localParseFile);
  assert.equal(initial.errorCount, 0, 'OpenCode lookback fixture imports cleanly');

  updateOpenCodePart(opencodeDb);
  const selectedSessionIds: Array<string[] | undefined> = [];
  const recordingParser: HistoryFileParser = async (input) => {
    selectedSessionIds.push(input.options?.providerConversationIds);
    return localParseFile(input);
  };
  const changed = await imports.importWithParser({ provider: 'opencode', path: opencodeDb, trigger: 'watcher', project_id: projectId }, recordingParser);
  assert.equal(changed.errorCount, 0, 'OpenCode lookback skips unchanged recent sessions without failing the batch');
  assert.equal(changed.conversationsImported, 1, 'OpenCode lookback imports only the changed recent session');
  assert.deepEqual(selectedSessionIds, [['opencode_resume_1']], 'OpenCode selects the session whose logical fingerprint changed');
  const updated = database.connection.prepare(`select text from conversation_messages where text like '%updated-part-history-needle%'`).get();
  assert.ok(updated, 'OpenCode imports same-count part updates without relying on the session timestamp');
  const state = database.connection.prepare(`select status from conversation_import_files where provider = 'opencode' and path = ?`).get(opencodeDb) as { status: string };
  assert.notEqual(state.status, 'importing', 'completed imports finalize their file state');

  updateOpenCodePartAt(opencodeDb, 'opart_4', 'OpenCode older-timestamp-history-needle', Date.now() - 60_000);
  const olderTimestamp = await imports.importWithParser({ provider: 'opencode', path: opencodeDb, trigger: 'watcher', project_id: projectId }, recordingParser);
  assert.equal(olderTimestamp.conversationsImported, 1, 'OpenCode imports changed sessions below the global update watermark');
  assert.deepEqual(selectedSessionIds.at(-1), ['opencode_resume_2'], 'OpenCode identifies older per-session changes without a full parse');
  const olderTimestampText = database.connection.prepare(`select text from conversation_messages where text like '%older-timestamp-history-needle%'`).get();
  assert.ok(olderTimestampText, 'OpenCode compares same-count transcripts when their effective timestamp is unchanged');

  database.connection.prepare(`update conversation_import_files set status = 'error' where provider = 'opencode' and path = ?`).run(opencodeDb);
  updateOpenCodePart(opencodeDb, 'OpenCode error-recovery-history-needle', 25_000);
  const errorRecovery = await imports.importWithParser({ provider: 'opencode', path: opencodeDb, trigger: 'watcher', project_id: projectId }, localParseFile);
  assert.equal(errorRecovery.errorCount, 0, 'OpenCode retries a failed import cleanly');
  assert.equal(errorRecovery.conversationsImported, 2, 'OpenCode failed-import recovery rewrites every potentially partial session');
  const errorRecoveryText = database.connection.prepare(`select text from conversation_messages where text like '%error-recovery-history-needle%'`).get();
  assert.ok(errorRecoveryText, 'OpenCode failed-import recovery replaces potentially stale messages');

  database.connection.prepare(`update conversation_import_files set status = 'importing' where provider = 'opencode' and path = ?`).run(opencodeDb);
  const interruptedAt = updateOpenCodePart(opencodeDb, 'OpenCode interrupted-import-history-needle', 30_000);
  database.connection.prepare(`update conversations set updated_at = ? where provider = 'opencode' and provider_conversation_id = 'opencode_resume_1'`).run(new Date(interruptedAt).toISOString());
  let parseCount = 0;
  const recovered = await imports.importWithParser({ provider: 'opencode', path: opencodeDb, trigger: 'watcher', project_id: projectId }, async (input) => {
    parseCount += 1;
    return localParseFile(input);
  });
  assert.equal(recovered.errorCount, 0, 'OpenCode retries an interrupted import cleanly');
  assert.equal(parseCount, 1, 'OpenCode never treats an importing file as already current');
  const recoveredText = database.connection.prepare(`select text from conversation_messages where text like '%interrupted-import-history-needle%'`).get();
  assert.ok(recoveredText, 'OpenCode interrupted-import recovery replaces stale messages');
}

function codexMessage(id: string, text: string, timestamp: string): Record<string, unknown> {
  return { timestamp, type: 'message', payload: { id, role: 'assistant', content: [{ type: 'text', text }] } };
}

async function runIncrementalScanRecovery(appDataPath: string, database: DatabaseService, imports: AgentHistoryImportService, projectId: string): Promise<void> {
  const sourceDir = path.join(appDataPath, 'incremental-claude');
  fs.mkdirSync(sourceDir, { recursive: true });
  const row = (sessionId: string, uuid: string, text: string) => JSON.stringify({ type: 'user', sessionId, uuid, timestamp: '2026-10-05T12:00:00.000Z', message: { role: 'user', content: text } });
  const oldFile = path.join(sourceDir, 'old-session.jsonl');
  const liveFile = path.join(sourceDir, 'live-session.jsonl');
  const brokenFile = path.join(sourceDir, 'broken-session.jsonl');
  fs.writeFileSync(oldFile, `${row('old-session', 'old-1', 'incremental-old-needle')}\n`);
  fs.writeFileSync(liveFile, `${row('live-session', 'live-1', 'incremental-live-needle')}\n`);
  const oldMtime = new Date(Date.now() - 30 * 60_000);
  fs.utimesSync(oldFile, oldMtime, oldMtime);
  imports.configure({ provider: 'claude', path: sourceDir, enabled: true, watch_enabled: false });
  const input = (trigger: 'manual' | 'watcher') => ({ provider: 'claude' as const, path: sourceDir, trigger, project_id: projectId });
  await imports.importWithParser(input('manual'), localParseFile);

  // Rows that no scan can update, such as a deleted transcript or a subagent
  // file from before subagents were read with their parent, used to force
  // every watcher scan to be full.
  const sourceId = (database.connection.prepare(`select id from conversation_import_sources where provider = 'claude' and path = ?`).get(sourceDir) as { id: string }).id;
  const insertStale = database.connection.prepare(`insert into conversation_import_files (id, source_id, provider, path, source_kind, parser_version, status, metadata) values (?, ?, 'claude', ?, 'default', 'claude-jsonl-v1', 'imported', '{}')`);
  const deletedPath = path.join(sourceDir, 'deleted-session.jsonl');
  const subagentPath = path.join(sourceDir, 'live-session', 'subagents', 'agent-a1.jsonl');
  insertStale.run('stale-deleted', sourceId, deletedPath);
  insertStale.run('stale-subagent', sourceId, subagentPath);
  const outsidePath = path.join(appDataPath, 'incremental-claude-other', 'outside.jsonl');
  insertStale.run('stale-outside', sourceId, outsidePath);

  const parsed: string[] = [];
  const fingerprinted: string[] = [];
  const countingParser: HistoryFileParser = async (parseInput) => {
    parsed.push(parseInput.filePath);
    if (parseInput.filePath === brokenFile) throw new Error('broken transcript');
    return localParseFile(parseInput);
  };
  const fingerprintFile = ClaudeHistoryAdapter.prototype.fingerprintFile;
  ClaudeHistoryAdapter.prototype.fingerprintFile = function (filePath: string) {
    fingerprinted.push(filePath);
    return fingerprintFile.call(this, filePath);
  };
  try {
    const full = await imports.importWithParser(input('watcher'), countingParser);
    assert.equal(full.filesSeen, 2, 'a stale parser version still makes one scan full');
    const status = (id: string) => (database.connection.prepare(`select status from conversation_import_files where id = ?`).get(id) as { status: string }).status;
    assert.equal(status('stale-deleted'), 'retired', 'a full scan retires rows for deleted transcripts');
    assert.equal(status('stale-subagent'), 'retired', 'a full scan retires rows for files it no longer imports');
    assert.equal(status('stale-outside'), 'imported', 'a full scan only retires rows under the scanned path');
    database.connection.prepare(`delete from conversation_import_files where id = 'stale-outside'`).run();
    assert.equal(parsed.length, 0, 'unchanged files are not parsed');
    assert.equal(fingerprinted.length, 0, 'unchanged files are skipped on size and mtime without hashing');

    parsed.length = 0;
    const incremental = await imports.importWithParser(input('watcher'), countingParser);
    assert.equal(incremental.filesSeen, 1, 'retired rows no longer force a full scan');

    fs.writeFileSync(brokenFile, `${row('broken-session', 'broken-1', 'incremental-broken-needle')}\n`);
    fs.appendFileSync(liveFile, `${row('live-session', 'live-2', 'incremental-appended-needle')}\n`);
    parsed.length = 0;
    const withError = await imports.importWithParser(input('watcher'), countingParser);
    assert.equal(withError.errorCount, 1, 'the broken transcript fails');
    assert.ok(database.connection.prepare(`select 1 from conversation_messages where text = 'incremental-appended-needle'`).get(), 'appended messages are imported');
    const watermark = database.connection.prepare(`select value_ms from conversation_import_watermarks where source_id = ?`).get(sourceId) as { value_ms: number };
    assert.ok(watermark.value_ms >= Math.round(fs.statSync(liveFile).mtimeMs), 'a failed file does not hold the watermark back');

    const brokenOld = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(brokenFile, brokenOld, brokenOld);
    parsed.length = 0;
    await imports.importWithParser(input('watcher'), countingParser);
    assert.ok(parsed.includes(brokenFile), 'a failed file is retried after the watermark passes it');

    const touched = new Date(Date.now() + 5_000);
    fs.utimesSync(liveFile, touched, touched);
    parsed.length = 0;
    fingerprinted.length = 0;
    await imports.importWithParser(input('watcher'), countingParser);
    assert.ok(fingerprinted.includes(liveFile), 'a changed mtime falls back to the content fingerprint');
    fingerprinted.length = 0;
    await imports.importWithParser(input('watcher'), countingParser);
    assert.equal(fingerprinted.includes(liveFile), false, 'the refreshed row lets the touched file skip hashing next time');
  } finally {
    ClaudeHistoryAdapter.prototype.fingerprintFile = fingerprintFile;
  }
}

async function runIncrementalScanEdgeCases(appDataPath: string, database: DatabaseService, imports: AgentHistoryImportService, projectId: string): Promise<void> {
  const row = (sessionId: string, text: string) => JSON.stringify({ type: 'user', sessionId, uuid: `${sessionId}-1`, timestamp: '2026-10-05T12:00:00.000Z', message: { role: 'user', content: text } });
  const old = new Date(Date.now() - 60 * 60_000);
  const writeSession = (dir: string, sessionId: string, text: string, mtime?: Date) => {
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, `${row(sessionId, text)}\n`);
    if (mtime) fs.utimesSync(filePath, mtime, mtime);
    return filePath;
  };
  const hasMessage = (text: string) => Boolean(database.connection.prepare(`select 1 from conversation_messages where text = ?`).get(text));
  const fileStatus = (filePath: string) => (database.connection.prepare(`select status from conversation_import_files where provider = 'claude' and path = ?`).get(filePath) as { status: string } | undefined)?.status;
  const input = (sourceDir: string, trigger: 'manual' | 'watcher') => ({ provider: 'claude' as const, path: sourceDir, trigger, project_id: projectId });

  // An unreadable file still gets an error row, so it is retried after the
  // watermark passes its mtime.
  const unreadableDir = path.join(appDataPath, 'edge-unreadable');
  fs.mkdirSync(unreadableDir, { recursive: true });
  writeSession(unreadableDir, 'edge-recent', 'edge-recent-needle');
  const unreadable = writeSession(unreadableDir, 'edge-unreadable', 'edge-unreadable-needle', old);
  imports.configure({ provider: 'claude', path: unreadableDir, enabled: true, watch_enabled: false });
  // chmod 000 does not make a file unreadable on Windows, so the failure checks skip there.
  if (process.platform !== 'win32') {
    fs.chmodSync(unreadable, 0o000);
    try {
      const failed = await imports.importWithParser(input(unreadableDir, 'watcher'), localParseFile);
      assert.equal(failed.errorCount, 1, 'an unreadable transcript fails');
      assert.equal(fileStatus(unreadable), 'error', 'an unreadable transcript still records an error row');
    } finally {
      fs.chmodSync(unreadable, 0o644);
    }
  }
  await imports.importWithParser(input(unreadableDir, 'watcher'), localParseFile);
  assert.ok(hasMessage('edge-unreadable-needle'), 'a transcript that becomes readable is imported after the watermark passed it');

  // A transcript a full scan could not see is retired, and imported again
  // when it reappears with its old mtime.
  const reappearDir = path.join(appDataPath, 'edge-reappear');
  fs.mkdirSync(reappearDir, { recursive: true });
  writeSession(reappearDir, 'edge-anchor', 'edge-anchor-needle');
  imports.configure({ provider: 'claude', path: reappearDir, enabled: true, watch_enabled: false });
  await imports.importWithParser(input(reappearDir, 'watcher'), localParseFile);
  const reappearing = writeSession(appDataPath, 'edge-away', 'edge-reappear-needle', old);
  const hidden = path.join(reappearDir, 'edge-away.jsonl');
  database.connection.prepare(`insert into conversation_import_files (id, source_id, provider, path, source_kind, parser_version, status, metadata) values ('edge-hidden', (select id from conversation_import_sources where provider = 'claude' and path = ?), 'claude', ?, 'default', 'claude-jsonl-v1', 'error', '{}')`).run(reappearDir, hidden);
  await imports.importWithParser(input(reappearDir, 'watcher'), localParseFile);
  assert.equal(fileStatus(hidden), 'retired', 'a full scan retires a transcript it cannot see');
  fs.renameSync(reappearing, hidden);
  fs.utimesSync(hidden, old, old);
  await imports.importWithParser(input(reappearDir, 'watcher'), localParseFile);
  assert.ok(hasMessage('edge-reappear-needle'), 'a retired transcript that reappears with an old mtime is imported');
  assert.equal(fileStatus(hidden), 'imported', 'a reappearing transcript is no longer retired');

  // Files imported before their directory became a source are adopted by it,
  // and the source gets a watermark, even though they are skipped unread.
  const adoptDir = path.join(appDataPath, 'edge-adopt');
  fs.mkdirSync(adoptDir, { recursive: true });
  writeSession(adoptDir, 'edge-adopt-recent', 'edge-adopt-recent-needle', new Date(Date.now() - 45 * 60_000));
  writeSession(adoptDir, 'edge-adopt-old', 'edge-adopt-old-needle', old);
  // A subagent file newer than every parent sets the watermark.
  const adoptSubagents = path.join(adoptDir, 'edge-adopt-old', 'subagents');
  fs.mkdirSync(adoptSubagents, { recursive: true });
  const adoptChild = path.join(adoptSubagents, 'agent-a1.jsonl');
  fs.writeFileSync(adoptChild, `${JSON.stringify({ type: 'user', sessionId: 'edge-adopt-old', uuid: 'edge-adopt-child-1', isSidechain: true, agentId: 'a1', timestamp: '2026-10-05T12:00:00.000Z', message: { role: 'user', content: 'edge-adopt-child-needle' } })}\n`);
  await imports.importWithParser({ ...input(adoptDir, 'manual'), project_id: null }, localParseFile);
  imports.configure({ provider: 'claude', path: adoptDir, enabled: true, watch_enabled: false });
  const adoptSource = (database.connection.prepare(`select id from conversation_import_sources where provider = 'claude' and path = ?`).get(adoptDir) as { id: string }).id;
  const adopting = await imports.importWithParser(input(adoptDir, 'watcher'), localParseFile);
  assert.equal(adopting.filesSeen, 2, 'the first scan of a new source is full');
  const unadopted = database.connection.prepare(`select count(*) as count from conversation_import_files where provider = 'claude' and path like ? and source_id is not ?`).get(`${adoptDir}%`, adoptSource) as { count: number };
  assert.equal(unadopted.count, 0, 'a new source adopts files imported before it existed');
  assert.ok(database.connection.prepare(`select 1 from conversation_import_watermarks where source_id = ?`).get(adoptSource), 'a scan of skipped files still sets the watermark');
  const incremental = await imports.importWithParser(input(adoptDir, 'watcher'), localParseFile);
  assert.equal(incremental.filesSeen, 1, 'the next scan of the new source is incremental');

  // For example, when the first scan was unstable, so it recorded no watermark.
  database.connection.prepare(`delete from conversation_import_watermarks where source_id = ?`).run(adoptSource);
  await imports.importWithParser(input(adoptDir, 'watcher'), localParseFile);
  const rebuilt = database.connection.prepare(`select value_ms from conversation_import_watermarks where source_id = ?`).get(adoptSource) as { value_ms: number } | undefined;
  assert.equal(rebuilt?.value_ms, Math.round(fs.statSync(adoptChild).mtimeMs), 'files skipped unread rebuild the watermark from their newest subagent file');
  const rebuiltScan = await imports.importWithParser(input(adoptDir, 'watcher'), localParseFile);
  assert.equal(rebuiltScan.filesSeen, 1, 'a rebuilt watermark keeps scans incremental');
}

function historyWatermarkCount(database: DatabaseService): number {
  const row = database.connection.prepare(`select count(*) as count from conversation_import_watermarks`).get() as { count: number };
  return row.count;
}

function ageOpenCodeSession(dbPath: string, sessionId: string, time: number): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(`update session set time_created = ?, time_updated = ? where id = ?`).run(time, time, sessionId);
  db.prepare(`update message set time_created = ?, time_updated = ? where session_id = ?`).run(time, time, sessionId);
  db.prepare(`update part set time_created = ?, time_updated = ? where session_id = ?`).run(time, time, sessionId);
  db.close();
}

async function runChunkedImportIntegrity(appDataPath: string, database: DatabaseService, imports: AgentHistoryImportService, search: SearchService, projectId: string): Promise<void> {
  const sourceDir = path.join(appDataPath, 'chunked-codex');
  fs.mkdirSync(sourceDir, { recursive: true });
  const sourceFile = path.join(sourceDir, 'chunked-session.jsonl');
  fs.writeFileSync(sourceFile, '{}\n');
  imports.configure({ provider: 'codex', path: sourceDir, enabled: true, watch_enabled: false });

  const firstParser: HistoryFileParser = async ({ filePath }) => chunkedParsedFile(filePath, 1_200, '2026-07-01T01:00:00.000Z');
  const first = await imports.importWithParser({ provider: 'codex', path: sourceDir, trigger: 'manual', project_id: projectId }, firstParser);
  assert.equal(first.messagesImported, 1_200, 'chunked async import stores all staged messages');
  assert.equal(chunkedMessageCount(database), 1_200, 'chunked async import commits all messages');
  assert.ok(search.search({ query: 'chunked-history-needle-1199', limit: 10 }).results.some((row) => row.kind === 'conversation_message'), 'chunked async import indexes staged messages');

  fs.appendFileSync(sourceFile, '{}\n');
  const secondParser: HistoryFileParser = async ({ filePath }) => chunkedParsedFile(filePath, 650, '2026-07-01T02:00:00.000Z');
  const second = await imports.importWithParser({ provider: 'codex', path: sourceDir, trigger: 'manual', project_id: projectId }, secondParser);
  assert.equal(second.messagesImported, 650, 'changed chunked async import rewrites the conversation');
  assert.equal(chunkedMessageCount(database), 650, 'chunked async reimport removes stale messages');
  assert.equal(search.search({ query: 'chunked-history-needle-1199', limit: 10 }).results.some((row) => row.kind === 'conversation_message'), false, 'chunked async reimport removes stale FTS rows');
  assert.ok(search.search({ query: 'chunked-history-needle-649', limit: 10 }).results.some((row) => row.kind === 'conversation_message'), 'chunked async reimport indexes replacement messages');

  fs.appendFileSync(sourceFile, '{}\n');
  const repeatedParser: HistoryFileParser = async ({ filePath }) => {
    const parsed = chunkedParsedFile(filePath, 700, '2026-07-01T03:00:00.000Z');
    const conversation = parsed.conversations[0]!;
    return { ...parsed, conversations: [{ ...conversation, messages: [...conversation.messages, { ...conversation.messages[5]!, seq: 700, text: 'repeated-id-needle' }] }] };
  };
  const repeated = await imports.importWithParser({ provider: 'codex', path: sourceDir, trigger: 'manual', project_id: projectId }, repeatedParser);
  assert.equal(repeated.errorCount, 0, 'a repeated provider message id does not fail the conversation');
  assert.equal(chunkedMessageCount(database), 700, 'a repeated provider message id keeps the first copy');
  assert.equal(search.search({ query: 'repeated-id-needle', limit: 10 }).results.some((row) => row.kind === 'conversation_message'), false, 'the repeated copy is not stored');
  const file = database.connection.prepare(`select status, warning from conversation_import_files where provider = 'codex' and path = ?`).get(sourceFile) as { status: string; warning: string | null };
  assert.equal(file.status, 'imported_with_warnings', 'a repeated provider message id is recorded as a warning');
  assert.match(file.warning ?? '', /skipped 1 repeated codex message/);
  const conversation = database.connection.prepare(`select updated_at from conversations where provider_conversation_id = 'chunked_resume_1'`).get() as { updated_at: string };
  assert.equal(conversation.updated_at, '2026-07-01T03:00:00.000Z', 'the conversation row is refreshed after its messages are stored');
}

async function runStreamingOpenCodeImport(appDataPath: string): Promise<void> {
  const directory = path.join(appDataPath, 'streaming-history');
  const app = new DatabaseService(directory);
  app.initialize();
  const source = path.join(directory, 'opencode.db');
  seedOpenCodeDb(source);
  const originalParseFile = OpenCodeHistoryAdapter.prototype.parseFile;
  const originalStream = OpenCodeHistoryAdapter.prototype.parseFileStream;
  let parsedCount = 0;
  let streamClosed = false;
  OpenCodeHistoryAdapter.prototype.parseFileStream = function(filePath, options) {
    const parsed = originalStream.call(this, filePath, options);
    return { ...parsed, conversations: (function*() {
      try {
        for (const conversation of parsed.conversations) {
          const db = new DatabaseSync(path.join(directory, 'history.db'), { readOnly: true });
          try {
            assert.equal((db.prepare('select count(*) as count from conversations').get() as { count: number }).count, parsedCount, 'each conversation is imported before requesting the next');
          } finally {
            db.close();
          }
          parsedCount += 1;
          yield conversation;
        }
      } finally {
        streamClosed = true;
      }
    })() };
  };
  OpenCodeHistoryAdapter.prototype.parseFile = () => { throw new Error('worker must not materialise the entire history file'); };
  try {
    const result = await runHistoryImportWorker({ action: 'import', appDataPath: directory, input: { provider: 'opencode', path: source, trigger: 'manual' } });
    assert.equal(result.ok, true);
    const imported = result.result as { errorCount: number; conversationsImported: number };
    assert.equal(imported.errorCount, 0, 'worker uses the streaming OpenCode parser');
    assert.equal(imported.conversationsImported, 2);
    assert.equal(parsedCount, 2);
    assert.equal(streamClosed, true);
    appendOpenCodeMessage(source);
    streamClosed = false;
    OpenCodeHistoryAdapter.prototype.parseFileStream = function(filePath, options) {
      const parsed = originalStream.call(this, filePath, options);
      return { ...parsed, conversations: (function*() {
        try {
          for (const conversation of parsed.conversations) {
            yield conversation;
            throw new Error('interrupted streaming parser');
          }
        } finally {
          streamClosed = true;
        }
      })() };
    };
    const interrupted = await runHistoryImportWorker({ action: 'import', appDataPath: directory, input: { provider: 'opencode', path: source, trigger: 'watcher' } });
    assert.equal((interrupted.result as { errorCount: number }).errorCount, 1);
    assert.equal(streamClosed, true, 'failed streams are closed');
    const history = new HistoryDatabaseService(directory, { mode: 'read' });
    history.initialize();
    try {
      assert.equal((history.connection.prepare('select status from conversation_import_files where path = ?').get(source) as { status: string }).status, 'error', 'interrupted files remain retryable');
    } finally {
      history.dispose();
    }
    OpenCodeHistoryAdapter.prototype.parseFileStream = originalStream;
    const recovered = await runHistoryImportWorker({ action: 'import', appDataPath: directory, input: { provider: 'opencode', path: source, trigger: 'watcher' } });
    assert.equal((recovered.result as { errorCount: number }).errorCount, 0);
    assert.equal((recovered.result as { conversationsImported: number }).conversationsImported, 2, 'retry repairs an interrupted stream');
    let mutated = false;
    // Force a parse, then change the source after its initial fingerprint.
    const touch = () => {
      const db = new DatabaseSync(source);
      db.prepare('update session set time_updated = time_updated + 1000').run();
      db.close();
    };
    touch();
    const unstable = await runHistoryImportWorker({ action: 'import', appDataPath: directory, input: { provider: 'opencode', path: source, trigger: 'watcher' } }, progress => {
      if (!mutated && progress.conversationsImported > 0) {
        mutated = true;
        touch();
      }
    });
    assert.equal((unstable.result as { errorCount: number }).errorCount, 0);
    assert.equal((unstable.result as { retrySuggested: boolean }).retrySuggested, true, 'source changes during streaming request a retry');
  } finally {
    OpenCodeHistoryAdapter.prototype.parseFile = originalParseFile;
    OpenCodeHistoryAdapter.prototype.parseFileStream = originalStream;
    app.dispose();
  }
}

async function runHistoryFtsAppend(appDataPath: string): Promise<void> {
  const directory = path.join(appDataPath, 'fts-append');
  const database = new HistoryDatabaseService(directory);
  try {
    database.initialize();
    const now = new Date().toISOString();
    database.connection.prepare(`
      insert into conversations (id, provider, provider_conversation_id, title, status, metadata, created_at, imported_at)
      values ('fts_conversation', 'opencode', 'fts_provider_conversation', 'FTS append fixture', 'active', '{}', ?, ?)
    `).run(now, now);
    const insert = database.connection.prepare(`
      insert into conversation_messages (id, conversation_id, seq, role, kind, text, redaction_count, metadata, created_at)
      values (?, 'fts_conversation', ?, 'assistant', 'message', ?, 0, '{}', ?)
    `);
    for (let index = 0; index < 3; index += 1) insert.run(`fts_message_${index}`, index, `fts append ${index}`, now);

    const search = new HistorySearchIndexService(database);
    await search.indexConversationAsync('fts_conversation');
    assert.equal((database.connection.prepare('select count(*) as count from conversation_history_rows').get() as { count: number }).count, 4, 'search rows have an indexed conversation lookup');
    const firstRowId = historyFtsRowId(database, 'fts_message_0');
    insert.run('fts_message_3', 3, 'fts append 3', now);
    await search.indexConversationAppend('fts_conversation', 3);
    assert.equal(historyFtsMessageCount(database), 4, 'FTS append adds the new message');
    assert.equal(historyFtsRowId(database, 'fts_message_0'), firstRowId, 'FTS append preserves existing message rows');

    database.connection.prepare(`update conversations set status = 'imported' where id = 'fts_conversation'`).run();
    insert.run('fts_message_4', 4, 'fts append 4', now);
    await search.indexConversationAppend('fts_conversation', 4);
    const updatedHeader = database.connection.prepare(`select body from conversation_history_fts where kind = 'conversation' and owner_id = 'fts_conversation'`).get() as { body: string };
    assert.ok(updatedHeader.body.includes('imported'), 'FTS append rebuilds a stale conversation header body');

    database.connection.prepare(`update conversations set project_id = 'fts_project', title = 'Renamed FTS fixture' where id = 'fts_conversation'`).run();
    insert.run('fts_message_5', 5, 'fts append 5', now);
    await search.indexConversationAppend('fts_conversation', 5);
    const relinked = database.connection.prepare(`select project_id, title from conversation_history_fts where owner_id = 'fts_message_0'`).get() as { project_id: string; title: string };
    assert.deepEqual(relinked, { project_id: 'fts_project', title: 'opencode assistant: Renamed FTS fixture' }, 'FTS append rebuilds stale message scope metadata');

    database.connection.prepare(`delete from conversation_history_fts where owner_id = 'fts_message_1'`).run();
    database.connection.prepare(`delete from conversation_history_index_state where conversation_id = 'fts_conversation'`).run();
    insert.run('fts_message_6', 6, 'fts append 6', now);
    await search.indexConversationAppend('fts_conversation', 6);
    assert.equal(historyFtsMessageCount(database), 7, 'FTS append repairs an incomplete conversation index');

    database.connection.prepare(`
      insert into conversations (id, provider, provider_conversation_id, title, status, metadata, created_at, imported_at)
      values ('fts_gap_conversation', 'opencode', 'fts_gap_provider_conversation', 'FTS gap fixture', 'active', '{}', ?, ?)
    `).run(now, now);
    const insertGap = database.connection.prepare(`
      insert into conversation_messages (id, conversation_id, seq, role, kind, text, redaction_count, metadata, created_at)
      values (?, 'fts_gap_conversation', ?, 'assistant', 'message', ?, 0, '{}', ?)
    `);
    database.connection.transaction(() => {
      for (let index = 0; index < 501; index += 1) insertGap.run(`fts_gap_message_${index}`, index * 2 + 1, `fts gap ${index}`, now);
    })();
    await search.indexConversationAsync('fts_gap_conversation');
    assert.equal(historyFtsMessageCount(database, 'fts_gap_conversation'), 501, 'FTS keyset indexing handles non-contiguous message sequences');
    search.removeConversation('fts_conversation');
    assert.equal(historyFtsMessageCount(database), 0, 'targeted removal clears the conversation');
    assert.equal(historyFtsMessageCount(database, 'fts_gap_conversation'), 501, 'targeted removal preserves other conversations');
    assert.equal((database.connection.prepare('select count(*) as count from conversation_history_rows where conversation_id = ?').get('fts_conversation') as { count: number }).count, 0, 'targeted removal clears row mappings');
  } finally {
    database.dispose();
  }
}

function historyFtsMessageCount(database: HistoryDatabaseService, conversationId = 'fts_conversation'): number {
  const row = database.connection.prepare(`select count(*) as count from conversation_history_fts where kind = 'conversation_message' and conversation_id = ?`).get(conversationId) as { count: number };
  return row.count;
}

function historyFtsRowId(database: HistoryDatabaseService, ownerId: string): number {
  const row = database.connection.prepare(`select rowid from conversation_history_fts where owner_id = ?`).get(ownerId) as { rowid: number } | undefined;
  assert.ok(row);
  return row.rowid;
}

function chunkedParsedFile(filePath: string, messageCount: number, updatedAt: string): ParsedHistoryFile {
  return {
    provider: 'codex',
    sourcePath: filePath,
    sourceKind: 'jsonl',
    parserVersion: 'codex-jsonl-v2',
    warnings: [],
    conversations: [{
      provider: 'codex',
      providerConversationId: 'chunked_resume_1',
      title: 'Chunked import fixture',
      cwd: process.cwd(),
      providerVersion: '2.0.0',
      startedAt: '2026-07-01T01:00:00.000Z',
      updatedAt,
      endedAt: updatedAt,
      status: 'imported',
      sourcePath: filePath,
      metadata: { source: 'chunked-smoke' },
      messages: chunkedMessages(messageCount)
    }]
  };
}

function chunkedMessages(count: number): ParsedMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    providerMessageId: `chunked_msg_${index}`,
    parentProviderMessageId: index > 0 ? `chunked_msg_${index - 1}` : null,
    turnId: `chunked_turn_${Math.floor(index / 2)}`,
    seq: index,
    role: index % 2 === 0 ? 'user' : 'assistant',
    kind: 'message',
    text: `chunked-history-needle-${index}`,
    toolName: null,
    toolStatus: null,
    toolInputSummary: null,
    toolOutputSummary: null,
    providerCreatedAt: new Date(Date.parse('2026-07-01T01:00:00.000Z') + index * 1000).toISOString(),
    tokenCount: null,
    metadata: { source: 'chunked-smoke', index }
  }));
}

function chunkedMessageCount(database: DatabaseService): number {
  const row = database.connection.prepare(`select count(*) as count from conversation_messages join conversations on conversations.id = conversation_messages.conversation_id where conversations.provider_conversation_id = 'chunked_resume_1'`).get() as { count: number };
  return row.count;
}

async function runQueuedReset(appDataPath: string, runJob: HistoryImportQueueRunner, input: Parameters<AgentHistoryImportQueueService['resetImports']>[0], reimport: boolean): Promise<HistoryImportQueueSnapshot> {
  let timeout: NodeJS.Timeout | null = null;
  let doneResolve!: () => void;
  const queue = new AgentHistoryImportQueueService(appDataPath, () => {
    if (timeout) clearTimeout(timeout);
    doneResolve();
  }, undefined, null, { runJob });
  try {
    await new Promise<void>((resolve, reject) => {
      doneResolve = resolve;
      timeout = setTimeout(() => reject(new Error('queued reset timed out')), 15_000);
      queue.resetImports(input, reimport);
    });
    return queue.status();
  } finally {
    if (timeout) clearTimeout(timeout);
    queue.dispose();
  }
}

async function runQueueFailure(appDataPath: string, launcher: HistoryImportWorkerLauncher): Promise<{ status: HistoryImportQueueSnapshot; events: QueueLogEvent[] }> {
  let timeout: NodeJS.Timeout | null = null;
  let doneResolve!: () => void;
  const events: QueueLogEvent[] = [];
  const queue = new AgentHistoryImportQueueService(appDataPath, () => {
    if (timeout) clearTimeout(timeout);
    doneResolve();
  }, launcher, fakeLogger(events));
  try {
    await new Promise<void>((resolve, reject) => {
      doneResolve = resolve;
      timeout = setTimeout(() => reject(new Error('queued failure timed out')), 15_000);
      queue.import({ trigger: 'manual' });
    });
    return { status: queue.status(), events };
  } finally {
    if (timeout) clearTimeout(timeout);
    queue.dispose();
  }
}

async function runQueueStale(appDataPath: string): Promise<{ status: HistoryImportQueueSnapshot; events: QueueLogEvent[] }> {
  let timeout: NodeJS.Timeout | null = null;
  let doneResolve!: () => void;
  const events: QueueLogEvent[] = [];
  const queue = new AgentHistoryImportQueueService(appDataPath, () => {
    if (timeout) clearTimeout(timeout);
    doneResolve();
  }, () => new HangingWorker(), fakeLogger(events), { staleMs: 25 });
  try {
    await new Promise<void>((resolve, reject) => {
      doneResolve = resolve;
      timeout = setTimeout(() => reject(new Error('queued stale timed out')), 2_000);
      queue.import({ trigger: 'manual' });
    });
    return { status: queue.status(), events };
  } finally {
    if (timeout) clearTimeout(timeout);
    queue.dispose();
  }
}

async function runQueueHeartbeat(appDataPath: string): Promise<void> {
  let doneResolve!: () => void;
  let timeout: NodeJS.Timeout | null = null;
  const queue = new AgentHistoryImportQueueService(appDataPath, () => doneResolve(), () => new HeartbeatWorker(), null, { staleMs: 25 });
  try {
    await new Promise<void>((resolve, reject) => {
      doneResolve = () => {
        if (timeout) clearTimeout(timeout);
        resolve();
      };
      timeout = setTimeout(() => reject(new Error('heartbeat worker timed out')), 2_000);
      queue.import({ trigger: 'manual' });
    });
    assert.equal(queue.status().recent[0]?.status, 'succeeded', 'worker heartbeats prevent healthy long imports from being marked stale');
  } finally {
    if (timeout) clearTimeout(timeout);
    queue.dispose();
  }
}

async function runWatcherCoalescing(appDataPath: string): Promise<void> {
  const workers: ControlledWorker[] = [];
  let doneCount = 0;
  const queue = new AgentHistoryImportQueueService(appDataPath, () => {
    doneCount += 1;
  }, () => {
    const worker = new ControlledWorker({ batch_id: `batch_${workers.length}`, status: 'completed', unstableFiles: 0, retrySuggested: false });
    workers.push(worker);
    return worker;
  });
  try {
    queue.import({ provider: 'claude', path: '/tmp/history-coalesce', trigger: 'watcher' });
    queue.import({ provider: 'claude', path: '/tmp/history-coalesce', trigger: 'watcher' });
    let status = queue.status();
    assert.equal(status.counts.running, 1, 'duplicate watcher import keeps one running job');
    assert.equal(status.counts.queued, 0, 'duplicate watcher import is not queued while matching job runs');
    assert.equal(workers.length, 1, 'only one worker is spawned for coalesced watcher imports');

    workers[0]!.complete();
    await waitFor(() => workers.length === 2);
    assert.equal(doneCount, 1, 'first watcher job completes before dirty follow-up runs');
    status = queue.status();
    assert.equal(status.counts.running, 1, 'dirty watcher event starts one follow-up import');
    assert.equal(status.counts.queued, 0, 'dirty watcher event enqueues only one follow-up');

    workers[1]!.complete();
    await waitFor(() => doneCount === 2);
    assert.equal(queue.status().recent.filter((job) => job.trigger === 'watcher').length, 2, 'coalesced watcher follow-up is visible in recent jobs');
  } finally {
    queue.dispose();
  }
}

async function runWatcherFollowUpCap(appDataPath: string): Promise<void> {
  const workers: ControlledWorker[] = [];
  const events: QueueLogEvent[] = [];
  const queue = new AgentHistoryImportQueueService(appDataPath, () => {}, () => {
    const worker = new ControlledWorker({ batch_id: `batch_${workers.length}`, status: 'completed', unstableFiles: 1, retrySuggested: true });
    workers.push(worker);
    return worker;
  }, fakeLogger(events));
  try {
    queue.import({ provider: 'opencode', path: '/tmp/opencode.db', trigger: 'watcher' });
    workers[0]!.complete();
    await waitFor(() => workers.length === 2);
    queue.import({ provider: 'opencode', path: '/tmp/opencode.db', trigger: 'watcher' });
    workers[1]!.complete();
    await waitFor(() => queue.status().counts.running === 0);
    assert.equal(workers.length, 2, 'watcher imports get at most one automatic follow-up');
    assert.ok(events.some((event) => event.event === 'job.follow_up_suppressed'), 'suppressed watcher follow-up is logged');
  } finally {
    queue.dispose();
  }
}

async function runOpenCodeWatcherDebounce(appDataPath: string): Promise<void> {
  const opencodeDb = path.join(appDataPath, 'watch-opencode.db');
  seedOpenCodeDb(opencodeDb);
  let importCount = 0;
  const watcher = new AgentHistoryWatcherService({
    enabledWatchSources: () => [{ provider: 'opencode', sourceKind: 'opencode_db', path: opencodeDb, exists: true, enabled: true, watch_enabled: true }],
    import: () => {
      importCount += 1;
      return { job_id: 'test', status: 'queued', position: null, queue_depth: 1 };
    }
  }, { opencodeDebounceMs: 25 });
  try {
    watcher.start();
    appendOpenCodeMessage(opencodeDb);
    fs.utimesSync(opencodeDb, new Date(), new Date());
    await waitFor(() => importCount === 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(importCount, 1, 'OpenCode watcher waits for a quiet window before importing once');
  } finally {
    watcher.stop();
  }
}

async function runWatcherMaxWait(appDataPath: string): Promise<void> {
  const sourceDir = path.join(appDataPath, 'busy-watch-source');
  fs.mkdirSync(sourceDir, { recursive: true });
  const transcript = path.join(sourceDir, 'busy.jsonl');
  fs.writeFileSync(transcript, '');
  let importCount = 0;
  const watcher = new AgentHistoryWatcherService({
    enabledWatchSources: () => [{ provider: 'claude', sourceKind: 'manual_directory', path: sourceDir, exists: true, enabled: true, watch_enabled: true }],
    import: () => {
      importCount += 1;
      return { job_id: 'test', status: 'queued', position: null, queue_depth: 1 };
    }
  }, { debounceMs: 60, maxWaitMs: 150 });
  try {
    watcher.start();
    const started = Date.now();
    // Keep writing faster than the debounce so only the maximum wait can fire.
    while (importCount === 0 && Date.now() - started < 1_000) {
      fs.appendFileSync(transcript, '{}\n');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(importCount, 1, 'watcher imports during continuous writes once the maximum wait passes');
  } finally {
    watcher.stop();
  }
}

// An Integrated turn's end imports its provider at once, not after the debounce.
async function runIntegratedTurnFlush(appDataPath: string): Promise<void> {
  const sourceDir = path.join(appDataPath, 'turn-flush-source');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'turn.jsonl'), '{}\n');
  const imports: unknown[] = [];
  const watcher = new AgentHistoryWatcherService({
    enabledWatchSources: () => [{ provider: 'claude', sourceKind: 'manual_directory', path: sourceDir, exists: true, enabled: true, watch_enabled: true }],
    import: (input) => {
      imports.push(input);
      return { job_id: 'test', status: 'queued', position: null, queue_depth: 1 };
    }
  }, { debounceMs: 60_000, maxWaitMs: 60_000 });
  try {
    watcher.start();
    const checkpoint = integratedHistoryCheckpoints({ provider: (processId) => processId === 'process_claude' ? 'claude' : null, flush: (provider) => watcher.flush(provider) });
    checkpoint({ processId: 'process_claude', previous: 'idle', activity: 'working', snapshot: false });
    checkpoint({ processId: 'process_claude', previous: 'working', activity: 'thinking', snapshot: false });
    assert.equal(imports.length, 0, 'a turn in progress waits');
    checkpoint({ processId: 'process_raw', previous: 'working', activity: 'idle', snapshot: false });
    assert.equal(imports.length, 0, 'agents without native history are skipped');
    checkpoint({ processId: 'process_claude', previous: 'thinking', activity: 'idle', snapshot: false });
    assert.deepEqual(imports, [{ provider: 'claude', path: sourceDir, trigger: 'watcher' }], 'the end of a turn imports its provider now');
    checkpoint({ processId: 'process_claude', previous: 'working', activity: 'permission', snapshot: false });
    assert.equal(imports.length, 2, 'stopping for the user also imports the turn so far');
    watcher.flush('codex');
    assert.equal(imports.length, 2, 'other providers are left alone');
  } finally {
    watcher.stop();
  }
}

async function runTitleSyncCoalescing(appDataPath: string): Promise<void> {
  const workers: ControlledWorker[] = [];
  const queue = new AgentHistoryImportQueueService(appDataPath, () => {}, () => {
    const worker = new ControlledWorker({ retitled: 1 });
    workers.push(worker);
    return worker;
  });
  try {
    queue.syncTitles();
    queue.syncTitles();
    queue.import({ provider: 'claude', trigger: 'manual' });
    queue.syncTitles();
    assert.equal(queue.status().counts.queued, 1, 'a title sync behind a running one waits as a follow-up, not a queued copy');
    workers[0]!.complete();
    await waitFor(() => workers.length === 2);
    workers[1]!.complete();
    await waitFor(() => workers.length === 3);
    // A rename during the follow-up still gets its own sync: no file event
    // would bring it in later.
    queue.syncTitles();
    workers[2]!.complete();
    await waitFor(() => workers.length === 4);
    workers[3]!.complete();
    await waitFor(() => queue.status().counts.running === 0);
    assert.equal(workers.length, 4, 'each rename during a sync is covered by one more sync');
  } finally {
    queue.dispose();
  }
}

async function runLargeWatcherStart(appDataPath: string): Promise<void> {
  const sourceDir = path.join(appDataPath, 'large-watch-source');
  for (let index = 0; index < 120; index += 1) {
    const nested = path.join(sourceDir, `dir-${index}`);
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, `session-${index}.jsonl`), JSON.stringify({ type: 'user', sessionId: `large_${index}`, message: { role: 'user', content: 'large watcher start' } }));
  }
  const watcher = new AgentHistoryWatcherService({
    enabledWatchSources: () => [{ provider: 'claude', sourceKind: 'manual_directory', path: sourceDir, exists: true, enabled: true, watch_enabled: true }],
    import: () => ({ job_id: 'test', status: 'queued', position: null, queue_depth: 1 })
  });
  try {
    const started = Date.now();
    watcher.start();
    assert.ok(Date.now() - started < 100, 'large watcher start returns before recursive scan completes');
    assert.equal(watcher.status().sourceCount, 1, 'large watcher source is tracked immediately');
    await waitFor(() => {
      const status = watcher.status();
      return status.sources[0]?.scanning === false && status.watchedPathCount > 1;
    });
  } finally {
    watcher.stop();
  }
}

class ControlledWorker extends EventEmitter implements HistoryImportWorkerProcess {
  private messageReceived = false;

  constructor(private readonly result: unknown) {
    super();
  }

  postMessage(): void {
    this.messageReceived = true;
  }

  complete(): void {
    if (!this.messageReceived) throw new Error('controlled worker completed before receiving a message');
    this.emit('message', { ok: true, result: this.result });
    this.emit('exit', 0, null);
  }

  kill(): void {
    this.emit('exit', null, 'SIGTERM');
  }
}

class FailingMessageWorker extends EventEmitter implements HistoryImportWorkerProcess {
  postMessage(): void {
    setImmediate(() => {
      this.emit('message', { ok: false, error: 'worker reported history failure' });
      this.emit('exit', 1, null);
    });
  }

  kill(): void {
    this.emit('exit', null, 'SIGTERM');
  }
}

class ExitOnlyWorker extends EventEmitter implements HistoryImportWorkerProcess {
  postMessage(): void {
    setImmediate(() => this.emit('exit', 1, null));
  }

  kill(): void {
    this.emit('exit', null, 'SIGTERM');
  }
}

class HangingWorker extends EventEmitter implements HistoryImportWorkerProcess {
  postMessage(): void {}

  kill(): void {
    this.emit('exit', null, 'SIGTERM');
  }
}

class HeartbeatWorker extends EventEmitter implements HistoryImportWorkerProcess {
  private heartbeat: NodeJS.Timeout | null = null;
  private started = false;

  postMessage(): void {
    if (this.started) return;
    this.started = true;
    this.heartbeat = setInterval(() => this.emit('message', { type: 'heartbeat' }), 5);
    setTimeout(() => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.emit('message', { type: 'result', ok: true, result: { status: 'completed' } });
      this.emit('exit', 0, null);
    }, 60);
  }

  kill(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.emit('exit', null, 'SIGTERM');
  }
}

function verifySecretRedaction(): void {
  const redactor = new SecretRedactor();
  for (const text of ['x'.repeat(65_536), 'auth'.repeat(16_384), `${'auth'.repeat(16_384)}=short`]) {
    const started = performance.now();
    assert.deepEqual(redactor.redact(text), { text, redactionCount: 0 });
    // A generous ceiling catches repeated token scans, not ordinary host jitter.
    assert.ok(performance.now() - started < 1_000, '64 KiB non-secret tokens must not take seconds to redact');
  }
  for (const key of ['api_key', 'API-KEY', 'myToken', 'client_secret', 'PASSWORD', 'credentials', 'oauth']) {
    for (const prefix of ['', 'ordinary=']) {
      const input = `${prefix}${key}=synthetic-value-12345`;
      assert.deepEqual(redactor.redact(input), { text: `${prefix}${key}=[REDACTED]`, redactionCount: 1 });
    }
    assert.deepEqual(redactor.redact(`{"${key}":"synthetic-value-12345"}`), { text: `{"${key}":"[REDACTED]"}`, redactionCount: 1 });
  }
  const secret = `sk-${'x'.repeat(24)}`;
  assert.equal(redactor.redact(`authorization: bearer ${secret}`).text.includes(secret), false);
  assert.equal(redactor.redactAndCap(`api_key=${'x'.repeat(65_536)}`, 100).text, 'api_key=[REDACTED]');
}

function verifyInterruptedBatch(appDataPath: string): void {
  const history = new HistoryDatabaseService(appDataPath);
  history.initialize();
  const workers: ControlledWorker[] = [];
  const queue = new AgentHistoryImportQueueService(appDataPath, undefined, () => {
    const worker = new ControlledWorker({});
    workers.push(worker);
    return worker;
  });
  const batchId = 'worker-exit-batch';
  const now = new Date().toISOString();
  const db = history.connection;
  db.prepare(`insert into conversation_import_batches (id, trigger, started_at, status) values (?, 'manual', ?, 'running')`).run(batchId, now);
  db.prepare(`insert into conversation_import_batches (id, trigger, started_at, status) values (?, 'manual', ?, 'running')`).run('unrelated-running-batch', now);
  try {
    queue.import({ trigger: 'manual' });
    const worker = workers[0]!;
    worker.emit('message', { type: 'progress', progress: { batchId, currentFile: '/synthetic.jsonl', filesSeen: 1, filesImported: 0, conversationsImported: 100, messagesImported: 2000, skippedCount: 0, errorCount: 0 } });
    worker.emit('exit', 1, 'SIGKILL');
    assert.equal(queue.status().recent[0]?.status, 'failed');
    const batch = new AgentHistoryReadService(history).importStatus().batches.find((row) => row.id === batchId);
    assert.equal(batch?.status, 'failed', 'worker exit finalises its persisted batch immediately');
    assert.equal(batch.finishedAt, queue.status().recent[0]?.finishedAt);
    assert.equal(batch.messagesImported, 2000, 'worker exit preserves the last reported progress');
    assert.equal(batch.errorCount, 1);
    assert.equal(new AgentHistoryReadService(history).importStatus().batches.find((row) => row.id === 'unrelated-running-batch')?.status, 'running');

    // A retry must neither revive the failed batch nor overwrite a committed
    // result if its worker exits before the result message reaches the queue.
    const retryId = 'worker-exit-retry';
    db.prepare(`insert into conversation_import_batches (id, trigger, started_at, finished_at, status, messages_imported) values (?, 'manual', ?, ?, 'completed', 20)`).run(retryId, now, now);
    queue.import({ trigger: 'manual' });
    workers[1]!.emit('message', { type: 'progress', progress: { batchId: retryId, currentFile: null, filesSeen: 1, filesImported: 1, conversationsImported: 1, messagesImported: 20, skippedCount: 0, errorCount: 0 } });
    workers[1]!.emit('exit', 1, 'SIGKILL');
    const batches = new AgentHistoryReadService(history).importStatus().batches;
    assert.equal(batches.find((row) => row.id === batchId)?.status, 'failed');
    assert.equal(batches.find((row) => row.id === retryId)?.status, 'completed');
    assert.equal(batches.find((row) => row.id === retryId)?.errorCount, 0);
  } finally {
    queue.dispose();
    history.dispose();
  }
}

interface QueueLogEvent { source: string; event: string; data?: unknown }

function fakeLogger(events: QueueLogEvent[]): { write(source: string, event: string, data?: unknown): void } {
  return { write: (source, event, data) => events.push({ source, event, data }) };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function seedOpenCodeDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table session (id text primary key, directory text not null, title text not null, version text not null, time_created integer not null, time_updated integer not null, parent_id text, agent text, model text, metadata text, time_archived integer);
    create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
  `);
  const now = Date.now();
  db.prepare(`insert into session values (?, ?, ?, ?, ?, ?, null, ?, ?, ?, null)`).run('opencode_resume_1', process.cwd(), 'OpenCode fixture', '0.0.1', now, now, 'build', 'model', '{}');
  db.prepare(`insert into message values (?, ?, ?, ?, ?)`).run('omsg_1', 'opencode_resume_1', now, now, JSON.stringify({ role: 'assistant', path: { cwd: process.cwd() } }));
  db.prepare(`insert into part values (?, ?, ?, ?, ?, ?)`).run('opart_1', 'omsg_1', 'opencode_resume_1', now, now, JSON.stringify({ type: 'text', text: 'OpenCode emerald-history-needle response' }));
  db.prepare(`insert into message values (?, ?, ?, ?, ?)`).run('omsg_2', 'opencode_resume_1', now + 1, now + 1, JSON.stringify({ role: 'user', path: { cwd: process.cwd() } }));
  const inlineCsv = `${Array.from({ length: 200 }, (_, index) => `${index},inline-history-needle,value`).join('\n')}\ninline-tail-should-not-store`;
  db.prepare(`insert into part values (?, ?, ?, ?, ?, ?)`).run('opart_3', 'omsg_2', 'opencode_resume_1', now + 1, now + 1, JSON.stringify({
    type: 'text',
    text: `<path>/tmp/inline-history.csv</path>\n<type>file</type>\n<content>${inlineCsv}</content>`
  }));
  const longCsv = `${Array.from({ length: 200 }, (_, index) => `${index},emerald-history-needle,value`).join('\n')}\ncsv-tail-should-not-store`;
  db.prepare(`insert into part values (?, ?, ?, ?, ?, ?)`).run('opart_2', 'omsg_1', 'opencode_resume_1', now, now, JSON.stringify({
    type: 'tool',
    tool: 'read',
    state: {
      status: 'completed',
      input: { filePath: '/tmp/large-history.csv' },
      output: `<path>/tmp/large-history.csv</path>\n<type>file</type>\n<content>${longCsv}</content>`,
      metadata: { preview: '0,emerald-history-needle,value', truncated: true, loaded: [] }
    }
  }));
  db.prepare(`insert into session values (?, ?, ?, ?, ?, ?, null, ?, ?, ?, null)`).run('opencode_resume_2', process.cwd(), 'OpenCode unchanged fixture', '0.0.1', now + 2, now + 2, 'build', 'model', '{}');
  db.prepare(`insert into message values (?, ?, ?, ?, ?)`).run('omsg_3', 'opencode_resume_2', now + 2, now + 2, JSON.stringify({ role: 'assistant', path: { cwd: process.cwd() } }));
  db.prepare(`insert into part values (?, ?, ?, ?, ?, ?)`).run('opart_4', 'omsg_3', 'opencode_resume_2', now + 2, now + 2, JSON.stringify({ type: 'text', text: 'OpenCode unchanged-history-needle response' }));
  db.close();
}

function appendOpenCodeMessage(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  const now = Date.now() + 10_000;
  db.prepare(`update session set time_updated = ? where id = ?`).run(now, 'opencode_resume_1');
  db.prepare(`insert into message values (?, ?, ?, ?, ?)`).run('omsg_incremental_1', 'opencode_resume_1', now, now, JSON.stringify({ role: 'assistant', path: { cwd: process.cwd() } }));
  db.prepare(`insert into part values (?, ?, ?, ?, ?, ?)`).run('opart_incremental_1', 'omsg_incremental_1', 'opencode_resume_1', now, now, JSON.stringify({ type: 'text', text: 'OpenCode incremental-history-needle response' }));
  db.close();
}

function updateOpenCodePart(dbPath: string, text = 'OpenCode updated-part-history-needle', offsetMs = 20_000): number {
  const db = new DatabaseSync(dbPath);
  const now = Date.now() + offsetMs;
  db.prepare(`update part set time_updated = ?, data = ? where id = 'opart_1'`).run(now, JSON.stringify({ type: 'text', text }));
  db.prepare(`update session set time_updated = ? where id = 'opencode_resume_1'`).run(now);
  db.close();
  return now;
}

function updateOpenCodePartAt(dbPath: string, partId: string, text: string, updatedAt: number): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(`update part set time_updated = ?, data = ? where id = ?`).run(updatedAt, JSON.stringify({ type: 'text', text }), partId);
  db.prepare(`update session set time_updated = ? where id = (select session_id from part where id = ?)`).run(updatedAt, partId);
  db.close();
}

async function verifyGuidanceReimport(root: string, database: DatabaseService, imports: AgentHistoryImportService, read: AgentHistoryReadService, projectId: string): Promise<void> {
  const directory = path.join(root, 'guidance-reimport');
  fs.mkdirSync(directory);
  const file = path.join(directory, 'guidance.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'system', subtype: 'informational', sessionId: 'guidance-only', cwd: process.cwd(), content: 'auto-mode-guidance-needle' }));
  const corrected = new ClaudeHistoryAdapter().parseFile(file);
  const conversation = corrected.conversations[0]!;
  assert.ok(conversation, 'empty native session identity is available for reimport');
  const oldParser: HistoryFileParser = async () => ({ ...corrected, parserVersion: 'claude-jsonl-v3', conversations: [{ ...conversation, messages: [{
    providerMessageId: 'guidance', parentProviderMessageId: null, turnId: null, seq: 0, role: 'unknown', kind: 'message', text: 'auto-mode-guidance-needle',
    toolName: null, toolStatus: null, toolInputSummary: null, toolOutputSummary: null, providerCreatedAt: null, tokenCount: null, metadata: {}
  }] }] });
  await imports.importWithParser({ provider: 'claude', path: directory, trigger: 'manual', project_id: projectId }, oldParser);
  const before = database.connection.prepare("select id from conversations where provider_conversation_id = 'guidance-only'").get() as { id: string };
  assert.ok(read.list({ project_id: projectId }).conversations.some(c => c.id === before.id));
  const result = await imports.importWithParser({ provider: 'claude', path: directory, trigger: 'startup', project_id: projectId }, localParseFile);
  assert.equal(result.errorCount, 0);
  assert.equal(read.get({ conversation_id: before.id }).messages.length, 0, 'parser upgrade clears stale guidance without a source-file change');
  assert.equal(read.findConversation(before.id)?.providerConversationId, 'guidance-only', 'native resume identity survives reimport');
  assert.equal(read.list({ project_id: projectId }).conversations.some(c => c.id === before.id), false, 'empty guidance-only sessions are absent from history');
}

function verifyResumeCaptureNoOp(database: DatabaseService): void {
  const row = database.connection.prepare(`select id from sessions limit 1`).get() as { id: string };
  database.connection.prepare(`update sessions set resume_id = null, resume_status = 'unknown' where id = ?`).run(row.id);
  const capture = new ResumeIdCaptureService(database);
  assert.equal(capture.markImported(row.id, 'resume_capture_fixture'), true, 'first resume capture updates the session');
  assert.equal(capture.markImported(row.id, 'resume_capture_fixture'), false, 'repeated resume capture is a no-op');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
