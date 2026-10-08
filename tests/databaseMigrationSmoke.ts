import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Migrator } from '../app/Database/Migrator';
import type { Migration } from '../app/Database/Migration';
import { openSqliteConnection, type SqliteConnection } from '../app/Database/SqliteConnection';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HistoryDatabaseService } from '../app/Services/HistoryDatabaseService';
import { migrations } from '../database/migrations';
import addSessionTitleOverride from '../database/migrations/2026_09_09_000019_add_session_title_override';
import { historyMigrations } from '../database/historyMigrations';
import { assertTaskRemovalMigration } from './taskRemovalMigrationSmoke';
import { assertDatabaseBackups } from './databaseBackupSmoke';

function main(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-db-'));
  try {
    const service = new DatabaseService(tempDir);
    service.initialize();
    const migrationNames = migrations.map((migration) => migration.name);

    const rows = service.connection.prepare('select migration, batch from migrations').all() as Array<{ migration: string; batch: number }>;
    assert.deepEqual(rows, migrationNames.map((migration) => ({ migration, batch: 1 })));
    assert.equal(tableExists(service.connection, 'projects'), true);
    assert.equal(tableExists(service.connection, 'tasks'), false);
    assert.equal(tableExists(service.connection, 'conversations'), true);
    assert.equal(tableExists(service.connection, 'conversation_messages'), true);
    assert.equal(tableExists(service.connection, 'conversation_import_sources'), true);
    assert.equal(tableExists(service.connection, 'conversation_deletions'), true);
    assert.equal(indexExists(service.connection, 'idx_diff_snapshots_project_created'), true);

    // The runtime-columns migration added the process PTY handle + auto-restart flag.
    const processColumns = new Set(
      (service.connection.prepare('pragma table_info(processes)').all() as Array<{ name: string }>).map((row) => row.name)
    );
    assert.ok(processColumns.has('pty_process_id'), 'processes.pty_process_id exists');
    assert.ok(processColumns.has('auto_restart'), 'processes.auto_restart exists');
    assert.ok(processColumns.has('worktree_id'), 'processes.worktree_id exists');
    assert.ok(processColumns.has('activity'), 'processes.activity exists');
    assert.ok(processColumns.has('exited_at'), 'processes.exited_at exists');
    assert.ok(processColumns.has('exit_code'), 'processes.exit_code exists');
    const sessionColumns = new Set(
      (service.connection.prepare('pragma table_info(sessions)').all() as Array<{ name: string }>).map((row) => row.name)
    );
    assert.ok(sessionColumns.has('mcp_identity'), 'sessions.mcp_identity exists');
    assert.ok(sessionColumns.has('display_name'), 'sessions.display_name exists');
    assert.ok(sessionColumns.has('title_set_by_user'), 'sessions.title_set_by_user exists');
    assert.ok(sessionColumns.has('model'), 'sessions.model exists');
    assert.ok(sessionColumns.has('reasoning'), 'sessions.reasoning exists');
    assert.ok(sessionColumns.has('interface_mode'), 'sessions.interface_mode exists');
    assert.equal(tableExists(service.connection, 'integrated_submissions'), true);
    assert.equal(tableExists(service.connection, 'feed_threads'), false);
    assert.equal(tableExists(service.connection, 'feed_posts'), false);
    assert.equal(tableExists(service.connection, 'session_worktrees'), true);
    assert.equal(indexExists(service.connection, 'idx_session_worktrees_worktree'), true);
    // Historical snapshots stay readable after the snapshot feature was removed.
    assert.equal(tableExists(service.connection, 'diff_snapshots'), true);
    const appFtsColumns = new Set(
      (service.connection.prepare('pragma table_info(app_artifacts_fts)').all() as Array<{ name: string }>).map((row) => row.name)
    );
    assert.ok(appFtsColumns.has('project_id'), 'app_artifacts_fts.project_id exists');
    assert.equal(appFtsColumns.has('task_id'), false);

    assert.deepEqual(service.migrator().migrate(), []);
    assert.equal(service.migrator().status()[0]?.status, 'ran');

    assert.throws(() => service.migrator().rollback(), /forward-only/);
    service.dispose();
    assertHistoryDatabaseMigrations(tempDir);
    assertHistoryIndexStateUpgrade(tempDir);
    assertFailureDoesNotRecordMigration();
    assertNestedTransactionsCommit();
    assertNestedRollbackCanBeCaughtByOuterTransaction();
    assertOuterRollbackUndoesInnerTransaction();
    assertTaskIdentifierBackfill();
    assertSessionTitleOverrideUpgrade(tempDir);
    assertBranchUpgradePaths();
    assertTaskRemovalMigration();
    assertDatabaseBackups();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertBranchUpgradePaths(): void {
  for (const branch of ['main', 'integrated'] as const) {
    const db = openSqliteConnection(':memory:');
    try {
      const priorMigrations = migrations.filter((migration) => branch === 'main'
        ? !migration.name.includes('integrated_sessions') && !migration.name.includes('integrated_submissions')
        : !migration.name.includes('session_model'));
      new Migrator(db, priorMigrations).migrate();
      db.prepare(`insert into projects (id, name, path, created_at, updated_at) values ('upgrade_project', 'Upgrade', '/tmp/upgrade', '2026-09-23', '2026-09-23')`).run();
      db.prepare(`insert into sessions (id, project_id, harness, session_role, started_at) values ('upgrade_session', 'upgrade_project', 'codex', 'orchestrator', '2026-09-23')`).run();
      if (branch === 'main') {
        db.prepare(`update sessions set model = 'gpt-5', reasoning = 'high' where id = 'upgrade_session'`).run();
      } else {
        db.prepare(`update sessions set interface_mode = 'integrated' where id = 'upgrade_session'`).run();
        db.prepare(`insert into integrated_submissions (process_id, message_id, payload_hash, state, created_at) values ('upgrade_process', 'upgrade_message', 'hash', 'uncertain', '2026-09-23')`).run();
      }
      const applied = new Migrator(db, migrations).migrate();
      assert.equal(applied.length, branch === 'main' ? 2 : 1, `${branch} applies only missing migrations`);
      const row = db.prepare(`select model, reasoning, interface_mode from sessions where id = 'upgrade_session'`).get() as
        { model: string | null; reasoning: string | null; interface_mode: string };
      assert.deepEqual(row, branch === 'main'
        ? { model: 'gpt-5', reasoning: 'high', interface_mode: 'tui' }
        : { model: null, reasoning: null, interface_mode: 'integrated' });
      if (branch === 'integrated') {
        assert.equal((db.prepare(`select state from integrated_submissions where message_id = 'upgrade_message'`).get() as { state: string }).state, 'uncertain');
      }
    } finally {
      db.close();
    }
  }
}

function assertTaskIdentifierBackfill(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-id-migration-'));
  try {
    const db = openSqliteConnection(path.join(tempDir, 'legacy.db'));
    db.exec(`
      create table projects (id text primary key, name text not null, path text not null, created_at text not null, updated_at text not null);
      create table tasks (id text primary key, project_id text not null, title text not null, status text not null, created_at text not null, updated_at text not null);
      insert into projects values ('p1', 'Patterm', '/p1', '2026-01-01', '2026-01-01');
      insert into projects values ('p2', 'Pattern', '/p2', '2026-01-02', '2026-01-02');
      insert into tasks values ('t2', 'p1', 'second', 'active', '2026-01-02', '2026-01-02');
      insert into tasks values ('t1', 'p1', 'first', 'active', '2026-01-01', '2026-01-01');
      insert into tasks values ('t3', 'p2', 'other', 'active', '2026-01-01', '2026-01-01');
    `);
    const identifierMigration = migrations.find((migration) => migration.name === '2026_07_17_000015_add_task_identifiers');
    assert.ok(identifierMigration, 'task identifier migration is registered');
    new Migrator(db, [identifierMigration]).migrate();
    assert.deepEqual(
      db.prepare(`select identifier_key, next_task_number from projects order by id`).all(),
      [{ identifier_key: 'PAT', next_task_number: 3 }, { identifier_key: 'PAE', next_task_number: 2 }]
    );
    assert.deepEqual(
      db.prepare(`select id, number from tasks order by id`).all(),
      [{ id: 't1', number: 1 }, { id: 't2', number: 2 }, { id: 't3', number: 1 }]
    );
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertHistoryDatabaseMigrations(tempDir: string): void {
  const service = new HistoryDatabaseService(tempDir);
  service.initialize();
  const migrationNames = historyMigrations.map((migration) => migration.name);
  const rows = service.connection.prepare('select migration, batch from migrations').all() as Array<{ migration: string; batch: number }>;
  assert.deepEqual(rows, migrationNames.map((migration) => ({ migration, batch: 1 })));
  assert.equal(tableExists(service.connection, 'conversations'), true);
  assert.equal(tableExists(service.connection, 'conversation_messages'), true);
  assert.equal(tableExists(service.connection, 'conversation_history_fts'), true);
  assert.equal(tableExists(service.connection, 'conversation_history_index_state'), true);
  assert.equal(tableExists(service.connection, 'conversation_history_rows'), true);
  assert.equal(indexExists(service.connection, 'idx_history_rows_conversation'), true);
  service.dispose();
}

function assertHistoryIndexStateUpgrade(tempDir: string): void {
  const upgradeDir = path.join(tempDir, 'history-upgrade');
  fs.mkdirSync(upgradeDir, { recursive: true });
  const db = openSqliteConnection(path.join(upgradeDir, 'history.db'));
  new Migrator(db, [historyMigrations[0]!]).migrate();
  const now = new Date().toISOString();
  db.prepare(`insert into conversation_import_batches (id, trigger, started_at, finished_at, status) values ('completed_batch', 'startup', ?, ?, 'completed')`).run(now, now);
  db.prepare(`
    insert into conversation_import_files (id, batch_id, provider, path, source_kind, parser_version, status, metadata)
    values ('upgrade_file', 'completed_batch', 'opencode', '/tmp/opencode.db', 'opencode_db', 'opencode-sqlite-v3', 'imported', '{}')
  `).run();
  db.prepare(`insert into conversation_import_batches (id, trigger, started_at, status) values ('interrupted_batch', 'startup', ?, 'running')`).run(now);
  db.prepare(`
    insert into conversation_import_files (id, batch_id, provider, path, source_kind, parser_version, status, metadata)
    values ('interrupted_file', 'interrupted_batch', 'codex', '/tmp/interrupted.jsonl', 'manual_file', 'codex-jsonl-v2', 'imported', '{}')
  `).run();
  db.prepare(`
    insert into conversations (id, provider, provider_conversation_id, source_file_id, title, status, metadata, created_at, imported_at)
    values ('upgrade_conversation', 'opencode', 'upgrade_provider_conversation', 'upgrade_file', 'Upgrade fixture', 'active', '{}', ?, ?)
  `).run(now, now);
  db.prepare(`
    insert into conversation_messages (id, conversation_id, seq, role, kind, text, redaction_count, metadata, created_at)
    values ('upgrade_message', 'upgrade_conversation', 0, 'assistant', 'message', 'upgrade message', 0, '{}', ?)
  `).run(now);
  db.prepare(`
    insert into conversation_history_fts (kind, owner_id, conversation_id, title, body)
    values ('conversation', 'upgrade_conversation', 'upgrade_conversation', 'Upgrade fixture', 'opencode'),
      ('conversation_message', 'upgrade_message', 'upgrade_conversation', 'opencode assistant: Upgrade fixture', 'upgrade message')
  `).run();
  db.close();

  const upgraded = new HistoryDatabaseService(upgradeDir);
  upgraded.initialize();
  const state = upgraded.connection.prepare(`select message_count, title, body_signature from conversation_history_index_state where conversation_id = 'upgrade_conversation'`).get();
  assert.deepEqual(state, {
    message_count: 1,
    title: 'Upgrade fixture',
    body_signature: JSON.stringify(['opencode', 'upgrade_provider_conversation', null, null, 'active', null, '{}'])
  }, 'history index state is backfilled for completed v1 imports');
  const file = upgraded.connection.prepare(`select status from conversation_import_files where id = 'upgrade_file'`).get() as { status: string };
  assert.equal(file.status, 'imported', 'a completed legacy batch keeps its file state');
  const interruptedFile = upgraded.connection.prepare(`select status from conversation_import_files where id = 'interrupted_file'`).get() as { status: string };
  assert.equal(interruptedFile.status, 'importing', 'completed file state from an interrupted legacy batch is queued for recovery');
  const ftsRows = upgraded.connection.prepare('select rowid, conversation_id from conversation_history_fts order by rowid').all();
  assert.deepEqual(upgraded.connection.prepare('select fts_rowid as rowid, conversation_id from conversation_history_rows order by fts_rowid').all(), ftsRows, 'lookup migration maps every existing search row');
  assert.equal(ftsRows.length, 2, 'migration preserves existing history search entries');
  assert.equal((upgraded.connection.prepare("select count(*) as count from conversation_history_fts where conversation_history_fts match 'upgrade'").get() as { count: number }).count, 2, 'existing history remains searchable after migration');
  upgraded.dispose();
}

function assertNestedTransactionsCommit(): void {
  const db = openSqliteConnection(':memory:');
  db.exec('create table nested_probe (id text primary key);');

  db.transaction(() => {
    db.prepare('insert into nested_probe (id) values (?)').run('outer');
    db.transaction(() => {
      db.prepare('insert into nested_probe (id) values (?)').run('inner');
    })();
  })();

  assert.equal(countRows(db, 'nested_probe'), 2);
  db.close();
}

function assertNestedRollbackCanBeCaughtByOuterTransaction(): void {
  const db = openSqliteConnection(':memory:');
  db.exec('create table nested_probe (id text primary key);');

  db.transaction(() => {
    db.prepare('insert into nested_probe (id) values (?)').run('outer');
    assert.throws(() => {
      db.transaction(() => {
        db.prepare('insert into nested_probe (id) values (?)').run('inner');
        throw new Error('inner failure');
      })();
    }, /inner failure/);
  })();

  assert.deepEqual(
    db.prepare('select id from nested_probe order by id').all(),
    [{ id: 'outer' }]
  );
  db.close();
}

function assertOuterRollbackUndoesInnerTransaction(): void {
  const db = openSqliteConnection(':memory:');
  db.exec('create table nested_probe (id text primary key);');

  assert.throws(() => {
    db.transaction(() => {
      db.prepare('insert into nested_probe (id) values (?)').run('outer');
      db.transaction(() => {
        db.prepare('insert into nested_probe (id) values (?)').run('inner');
      })();
      throw new Error('outer failure');
    })();
  }, /outer failure/);

  assert.equal(countRows(db, 'nested_probe'), 0);
  db.close();
}

function assertFailureDoesNotRecordMigration(): void {
  const db = openSqliteConnection(':memory:');
  const failingMigration: Migration = {
    name: '2026_06_03_000002_failing_migration',
    up(schema) {
      schema.sql('create table failure_probe (id text primary key);');
      throw new Error('expected failure');
    },
    down(schema) {
      schema.dropTableIfExists('failure_probe');
    }
  };

  const migrator = new Migrator(db, [...migrations, failingMigration]);
  assert.throws(() => migrator.migrate(), /expected failure/);
  assert.deepEqual(db.prepare('select migration from migrations where migration = ?').all(failingMigration.name), []);
  assert.equal(tableExists(db, 'failure_probe'), false);
  db.close();
}

function tableExists(db: SqliteConnection, name: string): boolean {
  const row = db.prepare("select name from sqlite_master where type in ('table', 'virtual table') and name = ?").get(name);
  return Boolean(row);
}

function indexExists(db: SqliteConnection, name: string): boolean {
  const row = db.prepare("select name from sqlite_master where type = 'index' and name = ?").get(name);
  return Boolean(row);
}

function countRows(db: SqliteConnection, table: string): number {
  const row = db.prepare(`select count(*) as n from ${table}`).get() as { n: number };
  return row.n;
}

main();

function assertSessionTitleOverrideUpgrade(tempDir: string): void {
  const filename = path.join(tempDir, 'title-upgrade.db');
  let db = openSqliteConnection(filename);
  try {
    db.exec("create table sessions (id text primary key, display_name text)");
    db.exec("insert into sessions values ('custom', 'User title'), ('automatic', null)");
    new Migrator(db, [addSessionTitleOverride]).migrate();
    db.close();
    db = openSqliteConnection(filename);
    assert.deepEqual(db.prepare('select id, display_name, title_set_by_user from sessions order by id').all(), [
      { id: 'automatic', display_name: null, title_set_by_user: 0 },
      { id: 'custom', display_name: 'User title', title_set_by_user: 1 }
    ]);
    db.exec("insert into sessions (id) values ('new')");
    assert.equal((db.prepare("select title_set_by_user from sessions where id = 'new'").get() as { title_set_by_user: number }).title_set_by_user, 0);
  } finally {
    db.close();
  }
}
