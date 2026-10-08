import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AmpHistoryAdapter } from '../app/Services/AgentHistory/AmpHistoryAdapter';
import { AgentHistoryImportService } from '../app/Services/AgentHistory/AgentHistoryImportService';
import { AgentHistoryReadService } from '../app/Services/AgentHistory/AgentHistoryReadService';
import { ProviderHistoryDiscoveryService } from '../app/Services/AgentHistory/ProviderHistoryDiscoveryService';
import { DatabaseService } from '../app/Services/DatabaseService';
import { IntegratedAgentService, type IntegratedProviderService } from '../app/Services/IntegratedAgentService';
import { runHistoryImportWorker } from '../app/Services/AgentHistory/AgentHistoryImportWorker';
import { archiveTranscript } from '../resources/js/lib/historyTranscript';
import type { ConversationMessageRecord } from '../resources/js/types';

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-amp-history-'));
  const database = new DatabaseService(directory);
  try {
  database.initialize();
  const projectPath = path.join(directory, 'project');
  const unrelatedPath = path.join(directory, 'unrelated');
  fs.mkdirSync(projectPath);
  fs.mkdirSync(unrelatedPath);
  database.connection.prepare(`insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)`).run('amp_project', 'Amp project', projectPath, new Date().toISOString(), new Date().toISOString());
  database.connection.prepare(`insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)`).run('other_project', 'Other project', unrelatedPath, new Date().toISOString(), new Date().toISOString());
  database.connection.prepare(`insert into sessions (id, project_id, harness, session_role, resume_id, resume_status, started_at, created_by_actor) values (?, ?, 'amp', 'orchestrator', ?, 'found', ?, 'user')`).run('other_session', 'other_project', 'T-unrelated', '2026-09-24T10:00:00.000Z');

  const now = '2026-09-24T15:43:27.150Z';
  const summaries = [
    { id: 'T-project', title: 'Project thread', updated: now, tree: pathToFileURL(projectPath).href, messageCount: 3 },
    { id: 'T-unrelated', title: 'Other thread', updated: now, tree: pathToFileURL(projectPath).href, messageCount: 1 }
  ];
  const projectExport = {
    id: 'T-project', title: 'Project thread', created: Date.parse(now), updatedAt: now, v: 1,
    env: { initial: { workingDirectory: projectPath, trees: [{ uri: pathToFileURL(projectPath).href }] } },
    meta: { executorType: 'local', visibility: 'private', lastKnownAgentState: { state: 'idle' } },
    messages: [
      { messageId: 1, protocolMessageID: 'user-1', role: 'user', createdAt: now, content: [{ type: 'text', text: 'Amp import marker api_key=ampsecret123456789' }] },
      { messageId: 2, protocolMessageID: 'assistant-2', role: 'assistant', createdAt: now, content: [
        { type: 'thinking', thinking: 'private-amp-reasoning', signature: 'private-amp-signature' },
        { type: 'text', text: 'Found the Amp import marker' },
        { type: 'tool_use', id: 'call-1', name: 'read', input: { filePath: 'README.md' }, complete: true }
      ] },
      { messageId: 3, protocolMessageID: 'user-3', role: 'user', createdAt: now, content: [
        { type: 'tool_result', toolUseID: 'call-1', run: { status: 'completed', result: { output: 'README content' } } }
      ] }
    ]
  };
  const calls: string[] = [];
  const amp = new AmpHistoryAdapter((_executable, args) => {
    calls.push(args.join(' '));
    if (args[1] === 'list') return JSON.stringify(summaries);
    if (args[1] === 'export' && args[2] === 'T-project') return JSON.stringify(projectExport);
    throw new Error(`unexpected Amp command: ${args.join(' ')}`);
  });
  const discovery = new ProviderHistoryDiscoveryService([amp]);
  const imports = new AgentHistoryImportService(database, discovery, null);
  const read = new AgentHistoryReadService(database);
  const executable = process.execPath;
  imports.configure({ provider: 'amp', path: executable, source_kind: 'amp_cli', enabled: true, watch_enabled: true });
  assert.equal(imports.sources().sources.find((source) => source.provider === 'amp')?.watch_enabled, false, 'Amp sources never install filesystem watchers');
  assert.equal(imports.enabledWatchSources().length, 0);

  const first = imports.import({ provider: 'amp', project_id: 'amp_project', trigger: 'manual' });
  assert.equal(first.errorCount, 0);
  assert.equal(first.conversationsImported, 1, 'only the matching project thread is imported');
  assert.equal(calls.filter((call) => call.startsWith('threads export')).length, 1, 'a thread assigned to another Patterm project is not exported even when its tree matches');
  const conversation = read.list({ project_id: 'amp_project', provider: 'amp' }).conversations[0];
  assert.equal(conversation?.providerConversationId, 'T-project');
  assert.equal(conversation?.messageCount, 4, 'text and tool content are imported without thinking');
  const stored = database.connection.prepare(`select group_concat(coalesce(text, '') || ' ' || coalesce(tool_input_summary, '') || ' ' || coalesce(tool_output_summary, ''), '\n') as content from conversation_messages`).get() as { content: string };
  assert.ok(stored.content.includes('Amp import marker'));
  assert.ok(stored.content.includes('[REDACTED]'));
  assert.equal(stored.content.includes('ampsecret123456789'), false);
  assert.equal(stored.content.includes('private-amp-reasoning'), false);
  assert.equal(stored.content.includes('private-amp-signature'), false);
  assert.ok(stored.content.includes('README content'));

  const second = imports.import({ provider: 'amp', project_id: 'amp_project', trigger: 'startup' });
  assert.equal(second.conversationsImported, 0);
  assert.equal(calls.filter((call) => call.startsWith('threads export')).length, 1, 'unchanged threads are not exported twice');

  summaries[0]!.updated = '2026-09-24T16:43:27.150Z';
  summaries[0]!.messageCount = 4;
  projectExport.updatedAt = summaries[0]!.updated;
  projectExport.messages.push({ messageId: 4, protocolMessageID: 'assistant-4', role: 'assistant', createdAt: summaries[0]!.updated, content: [{ type: 'text', text: 'New Amp answer' }] });
  const third = imports.import({ provider: 'amp', project_id: 'amp_project', trigger: 'startup' });
  assert.equal(third.conversationsImported, 1, 'updated thread is imported again');
  assert.equal(read.list({ project_id: 'amp_project', provider: 'amp' }).conversations[0]?.messageCount, 5);
  assert.equal(read.list({ provider: 'amp' }).conversations.length, 1);

  const attachedAt = '2026-09-24T17:43:27.150Z';
  database.connection.prepare(`insert into processes (id, project_id, kind, name, status, created_at, updated_at) values (?, ?, 'agent', 'Amp', 'running', ?, ?)`).run('amp_process', 'amp_project', attachedAt, attachedAt);
  database.connection.prepare(`
    insert into sessions (id, project_id, process_id, harness, interface_mode, session_role, resume_id, resume_status, started_at, created_by_actor)
    values (?, ?, ?, 'amp', 'integrated', 'orchestrator', ?, 'found', ?, 'user')
  `).run('amp_session', 'amp_project', 'amp_process', 'T-project', attachedAt);
  const integrated = new IntegratedAgentService(database, {
    amp: { conversation: async () => ({ provider: 'amp', status: 'idle', messages: { data: [{ id: 'live-1', type: 'assistant', content: [{ type: 'text', text: 'Live Amp answer' }] }] } }) } as unknown as IntegratedProviderService
  });
  integrated.setHistoryReadService(read);
  const live = await integrated.conversation('amp_process') as { history_truncated: boolean; history_cursor: { next: string } };
  assert.equal(live.history_truncated, true, 'Integrated Amp exposes earlier imported messages');
  const older = await integrated.olderMessages('amp_process', live.history_cursor.next) as { archived_messages: ConversationMessageRecord[]; cursor: string | null };
  assert.equal(older.archived_messages.length, 5);
  assert.equal(older.cursor, null);
  const archivedText = older.archived_messages.map((message) => [message.text, message.toolInputSummary, message.toolOutputSummary].join('\n')).join('\n');
  assert.ok(archivedText.includes('[REDACTED]'));
  assert.equal(archivedText.includes('ampsecret123456789'), false);
  const archivedRows = archiveTranscript(older.archived_messages, { projectPath: null, showReasoning: true });
  assert.ok(archivedRows.some((row) => row.kind === 'tool' && row.tool?.output === 'README content'), 'imported tool output is visible in Integrated history');

  const nestedPath = path.join(projectPath, 'nested');
  fs.mkdirSync(nestedPath);
  database.connection.prepare(`insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)`).run('nested_project', 'Nested project', nestedPath, now, now);
  summaries.push({ id: 'T-nested', title: 'Nested thread', updated: now, tree: pathToFileURL(nestedPath).href, messageCount: 1 });
  const nestedExport = { ...projectExport, id: 'T-nested', title: 'Nested thread', env: { initial: { workingDirectory: nestedPath, trees: [{ uri: pathToFileURL(nestedPath).href }] } }, messages: [projectExport.messages[0]!] };
  const nestedAmp = new AmpHistoryAdapter((_executable, args) => {
    if (args[1] === 'list') return JSON.stringify(summaries);
    if (args[2] === 'T-nested') return JSON.stringify(nestedExport);
    return JSON.stringify(projectExport);
  });
  const nestedImports = new AgentHistoryImportService(database, new ProviderHistoryDiscoveryService([nestedAmp]), null);
  nestedImports.import({ provider: 'amp', project_id: 'amp_project', trigger: 'manual' });
  assert.equal((database.connection.prepare(`select status from conversation_import_files where provider = 'amp' and path = 'amp://thread/T-nested'`).get() as { status: string }).status, 'scope_mismatch');
  const nestedResult = nestedImports.import({ provider: 'amp', project_id: 'nested_project', trigger: 'manual' });
  assert.equal(nestedResult.conversationsImported, 1, 'a parent-project import cannot poison a nested-project thread fingerprint');
  assert.equal(read.list({ project_id: 'nested_project', provider: 'amp' }).conversations[0]?.providerConversationId, 'T-nested');

  const errorExport = { ...projectExport, id: 'T-error', messages: [{ messageId: 1, protocolMessageID: 'error-1', role: 'user', createdAt: now, content: [{ type: 'tool_result', toolUseID: 'call-1', run: { status: 'error', error: { message: 'permission denied api_key=ampsecret123456789' } } }] }] };
  const errorAmp = new AmpHistoryAdapter((_executable, args) => args[1] === 'list'
    ? JSON.stringify([{ id: 'T-error', updated: now, tree: pathToFileURL(projectPath).href }])
    : JSON.stringify(errorExport));
  errorAmp.discoverFiles(executable);
  assert.match(errorAmp.parseFile('amp://thread/T-error').conversations[0]?.messages[0]?.toolOutputSummary ?? '', /permission denied/, 'Amp tool errors retain their explanation');
  new AgentHistoryImportService(database, new ProviderHistoryDiscoveryService([errorAmp]), null).import({ provider: 'amp', project_id: 'amp_project', trigger: 'manual' });
  const errorRow = database.connection.prepare(`select tool_output_summary from conversation_messages join conversations on conversations.id = conversation_messages.conversation_id where conversations.provider_conversation_id = 'T-error'`).get() as { tool_output_summary: string };
  assert.match(errorRow.tool_output_summary, /permission denied/);
  assert.ok(errorRow.tool_output_summary.includes('[REDACTED]'), 'Amp tool errors are redacted before storage');

  let ticks = 0;
  const heartbeat = setInterval(() => { ticks += 1; }, 5);
  const asyncAmp = new AmpHistoryAdapter(() => { throw new Error('synchronous Amp command used'); }, process.env, async (_path, args) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (args[1] === 'export') return JSON.stringify({ ...projectExport, id: 'T-async' });
    return args[args.indexOf('--offset') + 1] === '0'
      ? JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: `T-${index}`, updated: now, tree: pathToFileURL(projectPath).href })))
      : JSON.stringify([{ id: 'T-async', updated: now, tree: pathToFileURL(projectPath).href }]);
  });
  try {
    await asyncAmp.discoverFilesAsync(executable);
    await asyncAmp.parseFileAsync('amp://thread/T-async');
  } finally {
    clearInterval(heartbeat);
  }
  assert.ok(ticks >= 5, 'Amp discovery and export let worker heartbeats run between CLI calls');

  const failingCli = path.join(directory, 'failing-amp');
  fs.writeFileSync(failingCli, '#!/bin/sh\nprintf "private-cli-error-marker\\n" >&2\nexit 1\n', { mode: 0o700 });
  assert.throws(() => new AmpHistoryAdapter().discoverFiles(failingCli), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Amp history command failed/);
    assert.equal(error.message.includes('private-cli-error-marker'), false, 'CLI stderr is not retained in import errors');
    return true;
  });

  const workerDirectory = path.join(directory, 'worker');
  fs.mkdirSync(workerDirectory);
  const workerDatabase = new DatabaseService(workerDirectory);
  try {
    workerDatabase.initialize();
    const workerProjectPath = path.join(workerDirectory, 'project');
    fs.mkdirSync(workerProjectPath);
    workerDatabase.connection.prepare(`insert into projects (id, name, path, created_at, updated_at) values (?, ?, ?, ?, ?)`).run('worker_project', 'Worker project', workerProjectPath, now, now);
    const listPath = path.join(workerDirectory, 'amp-list.json');
    const exportPath = path.join(workerDirectory, 'amp-export.json');
    fs.writeFileSync(listPath, JSON.stringify([{ ...summaries[0], tree: pathToFileURL(workerProjectPath).href }]));
    fs.writeFileSync(exportPath, JSON.stringify({ ...projectExport, env: { initial: { workingDirectory: workerProjectPath } } }));
    const workerCli = path.join(workerDirectory, 'amp');
    fs.writeFileSync(workerCli, `#!${process.execPath}\nconst fs = require('node:fs');\nconst file = process.argv[3] === 'list' ? ${JSON.stringify(listPath)} : ${JSON.stringify(exportPath)};\nsetTimeout(() => process.stdout.write(fs.readFileSync(file, 'utf8')), 40);\n`, { mode: 0o700 });
    new AgentHistoryImportService(workerDatabase, new ProviderHistoryDiscoveryService(), null).configure({ provider: 'amp', path: workerCli, source_kind: 'amp_cli', enabled: true, watch_enabled: false });
    let workerTicks = 0;
    const workerHeartbeat = setInterval(() => { workerTicks += 1; }, 5);
    const result = await runHistoryImportWorker({ action: 'import', appDataPath: workerDirectory, input: { provider: 'amp', project_id: 'worker_project', trigger: 'manual' } }).finally(() => clearInterval(workerHeartbeat));
    assert.equal(result.ok, true, `Amp import worker succeeds: ${result.error ?? 'unknown error'}`);
    assert.ok(workerTicks >= 5, 'the real Amp CLI path does not block worker heartbeats');
    assert.equal((result.result as { conversationsImported: number }).conversationsImported, 1);
    const history = new DatabaseSync(path.join(workerDirectory, 'history.db'), { readOnly: true });
    try {
      assert.equal((history.prepare(`select count(*) as count from conversations where provider = 'amp' and project_id = 'worker_project'`).get() as { count: number }).count, 1);
    } finally {
      history.close();
    }
  } finally {
    workerDatabase.dispose();
  }

  for (let index = 0; index < 90; index += 1) {
    projectExport.messages.push({ messageId: 500 + index, protocolMessageID: `older-${index}`, role: 'assistant', createdAt: new Date(Date.parse(now) + (index + 1) * 1_000).toISOString(), content: [{ type: 'text', text: `Older message ${index}` }] });
  }
  const recentStart = Date.parse(attachedAt) + 1_000;
  for (let index = 0; index < 401; index += 1) {
    projectExport.messages.push({ messageId: 1000 + index, protocolMessageID: `recent-${index}`, role: 'assistant', createdAt: new Date(recentStart + index * 1_000).toISOString(), content: [{ type: 'text', text: `Recent message ${index}` }] });
  }
  summaries[0]!.updated = new Date(recentStart + 401_000).toISOString();
  summaries[0]!.messageCount = projectExport.messages.length;
  projectExport.updatedAt = summaries[0]!.updated;
  imports.import({ provider: 'amp', project_id: 'amp_project', trigger: 'manual' });
  const retained = Array.from({ length: 400 }, (_, index) => ({ id: `live-${index + 1}`, role: 'assistant', kind: 'text', text: `Recent message ${index + 1}`, created_at: new Date(recentStart + (index + 1) * 1_000).toISOString() }));
  const paged = new IntegratedAgentService(database, { amp: { conversation: async () => ({ provider: 'amp', status: 'idle', messages: { data: retained } }) } as unknown as IntegratedProviderService });
  paged.setHistoryReadService(read);
  const pagedSnapshot = await paged.conversation('amp_process') as { history_cursor?: { next: string } };
  assert.ok(pagedSnapshot.history_cursor, 'Integrated Amp can page imported messages evicted after session start');
  const evicted = await paged.olderMessages('amp_process', pagedSnapshot.history_cursor!.next) as { archived_messages: Array<{ text: string }>; cursor: string | null };
  assert.ok(evicted.archived_messages.some((message) => message.text === 'Recent message 0'));
  assert.equal(evicted.archived_messages.some((message) => message.text === 'Recent message 1'), false, 'the first live message is not duplicated in archive paging');
  assert.ok(evicted.cursor, 'older Amp history exposes another page when needed');
  const oldest = await paged.olderMessages('amp_process', evicted.cursor!) as { archived_messages: Array<{ text: string }>; cursor: string | null };
  assert.equal(oldest.cursor, null);
  assert.equal(oldest.archived_messages.length + evicted.archived_messages.length, 96, 'Amp paging covers each imported earlier message once');
  console.log('Amp history import smoke passed');
  } finally {
    database.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
