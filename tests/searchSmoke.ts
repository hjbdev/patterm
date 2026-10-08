import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HistoryDatabaseService } from '../app/Services/HistoryDatabaseService';
import { TimelineService } from '../app/Services/TimelineService';
import { SearchService } from '../app/Services/SearchService';
import { HistorySearchIndexService } from '../app/Services/AgentHistory/HistorySearchIndexService';
import { AgentHistoryReadService } from '../app/Services/AgentHistory/AgentHistoryReadService';
import { WorkbenchSeeder } from './fixtures/WorkbenchSeeder';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-search-'));
const database = new DatabaseService(directory);
const history = new HistoryDatabaseService(directory);
try {
  database.initialize();
  history.initialize();
  const timeline = new TimelineService(database);
  new WorkbenchSeeder(database, timeline).seedIfEmpty();
  const search = new SearchService(database, history);
  search.ensureIndex();
  const session = database.connection.prepare("select id from sessions where last_title = 'scaffold shell'").get() as { id: string };
  database.connection.prepare('update sessions set last_summary = ? where id = ?').run('sapphire project summary', session.id);
  search.indexSession(session.id);
  const results = search.search({ query: 'sapphire', project_id: 'project_local', limit: 10 });
  assert.equal(results.results[0]?.kind, 'session');
  assert.equal(results.results[0]?.target.project_id, 'project_local');
  assert.equal('task_id' in results.results[0]!, false);
  assert.equal(search.search({ query: 'sapphire', project_id: 'other', limit: 10 }).results.length, 0);
  assert.equal(search.search({ query: '" OR )', limit: 10 }).results.length, 0);
  const eventId = timeline.append({ event_type: 'agent.reported', project_id: 'project_local', metadata: { body: 'ultramarine report' } });
  search.indexTimelineEvent(eventId);
  assert.equal(search.search({ query: 'ultramarine', limit: 10 }).results[0]?.target.tab, 'timeline');
  history.connection.exec(`
    insert into conversations (id, provider, project_id, provider_conversation_id, title, status, created_at, imported_at) values ('c', 'codex', 'project_local', 'resume-c', 'Prior conversation', 'complete', 'now', 'now');
    insert into conversation_messages (id, conversation_id, seq, role, kind, text, created_at) values ('m', 'c', 0, 'assistant', 'message', 'turquoise history needle', 'now');
  `);
  new HistorySearchIndexService(history).rebuildIndex();
  const historyResults = search.search({ query: 'turquoise', project_id: 'project_local', limit: 10 });
  assert.equal(historyResults.results[0]?.target.conversation_id, 'c');
  assert.equal(historyResults.results[0]?.target.conversation_message_id, 'm');
  const read = new AgentHistoryReadService(history);
  assert.equal(read.search({ query: 'turquoise', project_id: 'project_local' }).results.length, 1);
  assert.equal(read.search({ query: 'turquoise', project_id: 'other' }).results.length, 0);
  assert.equal(read.search({ query: 'turquoise', project_id: 'project_local', provider: 'claude' }).results.length, 0);
  console.log('project search smoke ok');
} finally {
  history.dispose();
  database.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
}
