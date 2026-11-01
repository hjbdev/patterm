import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Migrator } from '../app/Database/Migrator';
import { openSqliteConnection } from '../app/Database/SqliteConnection';
import { migrations } from '../database/migrations';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HistoryDatabaseService } from '../app/Services/HistoryDatabaseService';
import { AgentHistoryReadService } from '../app/Services/AgentHistory/AgentHistoryReadService';
import { MemoryReviewService } from '../app/Services/MemoryReviewService';
import { removeTree } from './fixtures/TempTree';

// Existing assistant and bot notes move into the shared store intact, with
// their owner recorded, under one revision above every old counter.
function assertMigration(): void {
  const db = openSqliteConnection(':memory:');
  try {
    new Migrator(db, migrations.filter((migration) => migration.name !== '2026_11_02_000061_share_memory')).migrate();
    const insert = db.prepare(`insert into assistant_memory(id,text,importance,project_id,fact_at,recorded_at,revision,status,replaced_by,bot_id) values(?,?,?,?,?,?,?,?,?,?)`);
    insert.run('m_assistant', 'Prefers short answers.', 'high', null, '2026-10-01', '2026-10-01', 5, 'active', null, null);
    insert.run('m_old', 'Old fact.', 'low', null, '2026-10-01', '2026-10-01', 4, 'replaced', 'm_assistant', null);
    insert.run('m_bot', 'Likes being called Hal.', 'medium', null, '2026-10-02', '2026-10-02', 9, 'active', null, 'fable');
    const setting = db.prepare('insert into settings(key,value,updated_at) values(?,?,?)');
    setting.run('assistant.memory.revision.v1', '5', '2026-10-01');
    setting.run('bot.memory.revision.v1:fable', '9', '2026-10-02');
    new Migrator(db, migrations).migrate();
    const rows = db.prepare('select id, text, status, replaced_by, revision, bot_id, author_role, author_name from assistant_memory order by id').all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { id: 'm_assistant', text: 'Prefers short answers.', status: 'active', replaced_by: null, revision: 10, bot_id: null, author_role: 'assistant', author_name: null },
      { id: 'm_bot', text: 'Likes being called Hal.', status: 'active', replaced_by: null, revision: 10, bot_id: 'fable', author_role: 'bot', author_name: 'fable' },
      { id: 'm_old', text: 'Old fact.', status: 'replaced', replaced_by: 'm_assistant', revision: 10, bot_id: null, author_role: 'assistant', author_name: null }
    ], 'every note, its lineage and its owner survive');
    assert.deepEqual((db.prepare("select key, value from settings where key like '%memory.revision%'").all() as Array<Record<string, unknown>>).map((row) => ({ ...row })), [{ key: 'assistant.memory.revision.v1', value: '10' }], 'one shared revision above every old counter');
  } finally {
    db.close();
  }
}

function assertReview(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-memory-review-'));
  const app = new DatabaseService(directory);
  const history = new HistoryDatabaseService(directory);
  try {
    app.initialize();
    history.initialize();
    let now = new Date('2026-11-02T06:00:00Z');
    const at = now.toISOString();
    app.connection.prepare('insert into projects(id,name,path,created_at,updated_at) values(?,?,?,?,?)').run('p', 'Patterm', directory, at, at);
    app.connection.prepare("insert into sessions(id,project_id,process_id,harness,session_role,started_at) values('s_task','p','proc_task','claude','orchestrator',?)").run(at);
    app.connection.prepare("insert into sessions(id,project_id,process_id,harness,session_role,started_at) values('s_review','p','proc_review','claude','routine',?)").run(at);
    const h = history.connection;
    const conversation = (id: string, session: string | null, importedAt: string) => h.prepare(`insert into conversations(id,provider,project_id,session_id,title,status,created_at,imported_at) values(?, 'claude', 'p', ?, ?, 'active', ?, ?)
      on conflict(id) do update set imported_at = excluded.imported_at`).run(id, session, `Title ${id}`, importedAt, importedAt);
    let seq = new Map<string, number>();
    const message = (conversationId: string, role: string, text: string, createdAt: string, kind = 'message') => {
      const next = seq.get(conversationId) ?? 0;
      seq.set(conversationId, next + 1);
      h.prepare('insert into conversation_messages(id,conversation_id,seq,role,kind,text,provider_created_at,created_at) values(?,?,?,?,?,?,?,?)').run(`${conversationId}_${next}`, conversationId, next, role, kind, text, createdAt, createdAt);
    };
    // A long session that began weeks ago: only its last week is read at first.
    conversation('c_long', 's_task', '2026-11-01T20:00:00Z');
    message('c_long', 'user', 'Ancient request.', '2026-10-01T10:00:00Z');
    message('c_long', 'user', 'Please always use British spelling.', '2026-11-01T10:00:00Z');
    message('c_long', 'tool', 'tool output', '2026-11-01T10:01:00Z', 'tool_result');
    message('c_long', 'assistant', 'Noted.', '2026-11-01T10:02:00Z');
    // The review's own conversation is never read back.
    conversation('c_self', 's_review', '2026-11-01T21:00:00Z');
    message('c_self', 'assistant', 'Reviewing.', '2026-11-01T21:00:00Z');
    // Old conversations untouched since before the first review are skipped.
    conversation('c_stale', null, '2026-10-01T00:00:00Z');
    message('c_stale', 'user', 'Stale.', '2026-10-01T00:00:00Z');
    const review = new MemoryReviewService(app, new AgentHistoryReadService(history), () => now);
    const caller = { sessionId: 's_review', processId: 'proc_review' };
    assert.throws(() => review.checkpoint(caller), /memory_review_activity first/);
    const first = review.activity({}, caller);
    assert.equal(first.coverage, 'complete');
    assert.deepEqual(first.conversations.map((row) => [row.conversation_id, row.session_role, row.project_name, row.messages.map((item) => item.text)]), [
      ['c_long', 'orchestrator', 'Patterm', ['Please always use British spelling.', 'Noted.']]
    ]);
    // Unchecked pages are read again.
    assert.equal(review.activity({}, caller).conversations.length, 1);
    assert.equal(review.checkpoint(caller).coverage, 'complete');
    assert.equal(review.activity({}, caller).conversations.length, 0, 'nothing new after a checkpoint');
    review.checkpoint(caller);

    // The next night: the long session gained two messages, and a full
    // reimport rewrote its earlier rows. Only the new messages are read.
    now = new Date('2026-11-03T06:00:00Z');
    message('c_long', 'user', 'Ship nothing without review.', '2026-11-02T12:00:00Z');
    message('c_long', 'assistant', 'Understood.', '2026-11-02T12:01:00Z');
    h.prepare("update conversation_messages set created_at = '2026-11-02T12:05:00Z' where conversation_id = 'c_long'").run();
    conversation('c_long', 's_task', '2026-11-02T12:05:00Z');
    conversation('c_new', null, '2026-11-02T13:00:00Z');
    for (let index = 0; index < 30; index += 1) message('c_new', index % 2 ? 'assistant' : 'user', `Detail ${index} ${'x'.repeat(400)}`, '2026-11-02T13:00:00Z');
    const page = review.activity({ max_bytes: 4000 }, caller);
    assert.equal(page.coverage, 'partial', 'a small page leaves the rest for the next call');
    assert.deepEqual(page.conversations[0]!.messages.map((item) => item.text), ['Ship nothing without review.', 'Understood.']);
    assert.ok(page.conversations.at(-1)!.more);
    review.checkpoint(caller);
    let pages = 1;
    let last = page;
    while (last.coverage === 'partial') {
      last = review.activity({ max_bytes: 4000 }, caller);
      review.checkpoint(caller);
      pages += 1;
      assert.ok(pages < 20);
    }
    assert.equal(review.activity({}, caller).conversations.length, 0, 'every message is read exactly once across pages');
  } finally {
    history.dispose();
    app.dispose();
    removeTree(directory);
  }
}

assertMigration();
assertReview();
console.log('memory review smoke passed');
