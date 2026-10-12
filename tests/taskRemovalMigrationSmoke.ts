import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Migrator } from '../app/Database/Migrator';
import { openSqliteConnection } from '../app/Database/SqliteConnection';
import { migrations } from '../database/migrations';
import { historyMigrations } from '../database/historyMigrations';
import { removeTree } from './fixtures/TempTree';

const previousAppMigrations = migrations.slice(0, migrations.findIndex((migration) => migration.name === '2026_09_08_000017_remove_tasks'));
const previousHistoryMigrations = historyMigrations.slice(0, historyMigrations.findIndex((migration) => migration.name === '2026_09_08_000003_remove_task_scope'));

export function assertTaskRemovalMigration(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-task-upgrade-'));
  const app = openSqliteConnection(path.join(directory, 'app.db'));
  const history = openSqliteConnection(path.join(directory, 'history.db'));
  try {
    app.exec('pragma foreign_keys = on; pragma journal_mode = WAL');
    history.exec('pragma foreign_keys = on; pragma journal_mode = WAL');
    new Migrator(app, previousAppMigrations).migrate();
    new Migrator(history, previousHistoryMigrations).migrate();
    app.exec(`
      insert into projects (id, name, path, identifier_key, created_at, updated_at) values ('p', 'Project', '/project', 'PRJ', 'now', 'now');
      insert into tasks (id, project_id, title, number, created_at, updated_at) values ('t', 'p', 'Archived work', 42, 'now', 'now');
      insert into task_comments (id, task_id, kind, body, document_body, actor_type, created_at, updated_at) values ('doc', 't', 'plan', 'Plan', 'Keep this document', 'user', 'now', 'now');
      insert into revisions (id, revisionable_type, revisionable_id, key, old_value, new_value, actor_type, created_at) values ('rev', 'task', 't', 'plan', 'Before', 'After', 'user', 'now');
      insert into issue_links (id, task_id, provider, external_id, url, created_at, updated_at) values ('issue', 't', 'github', '7', 'https://example.test/7', 'now', 'now');
      insert into worktrees (id, project_id, task_id, repo_path, worktree_path, branch, created_by, created_at) values ('w', 'p', 't', '/project', '/retained/worktree', 'patterm/old-name', 'user', 'now');
      insert into processes (id, project_id, task_id, kind, name, status, worktree_id, created_at, updated_at) values ('proc', 'p', 't', 'agent', 'Agent', 'exited', 'w', 'now', 'now');
      insert into sessions (id, project_id, task_id, process_id, session_role, resume_id, worktree_id, started_at) values ('s', 'p', 't', 'proc', 'child', 'native-resume', 'w', 'now');
      insert into diff_snapshots (id, task_id, worktree_id, patch, created_at) values ('d', 't', 'w', 'retained patch', 'now');
      insert into diff_snapshots (id, task_id, patch, created_at) values ('d_without_worktree', 't', 'retained detached patch', 'now');
      insert into timeline_events (id, event_type, task_id, session_id, process_id, actor_type, metadata, created_at) values ('event', 'agent.reported', 't', 's', 'proc', 'agent', '{"body":"retained report"}', 'now');
      insert into settings values ('ui.sidebar.expanded.v1', '{"tasks":["t"],"knownTasks":["t"],"projects":["p"]}', 'now');
      insert into settings values ('ui.workspace.layout.v1', '{broken', 'now');
      insert into conversations (id, provider, task_id, status, created_at, imported_at) values ('legacy', 'codex', 't', 'complete', 'now', 'now');
    `);
    history.exec(`
      insert into conversations (id, provider, provider_conversation_id, task_id, session_id, process_id, worktree_id, cwd, status, created_at, imported_at) values ('c', 'codex', 'native-resume', 't', 's', 'proc', 'w', '/retained/worktree', 'complete', 'now', 'now');
      insert into conversation_messages (id, conversation_id, seq, role, kind, text, created_at) values ('m', 'c', 0, 'assistant', 'message', 'retained history needle', 'now');
      insert into conversation_import_batches (id, trigger, task_id, started_at, status) values ('batch', 'manual', 't', 'now', 'completed');
      insert into conversation_history_fts (kind, owner_id, conversation_id, task_id, title, body) values ('conversation_message', 'm', 'c', 't', 'History', 'retained history needle');
    `);
    // An unwritable archive aborts before ownership changes or destructive SQL.
    fs.writeFileSync(path.join(directory, 'archives'), 'blocked');
    assert.throws(() => new Migrator(app, migrations).migrate(), /EEXIST|ENOTDIR/);
    assert.equal((app.prepare('select count(*) as count from tasks').get() as { count: number }).count, 1);
    assert.equal((history.prepare("select project_id from conversations where id = 'c'").get() as { project_id: string | null }).project_id, null);
    fs.unlinkSync(path.join(directory, 'archives'));
    new Migrator(app, migrations).migrate();
    const firstArchive = fs.readdirSync(path.join(directory, 'archives'))[0]!;
    new Migrator(history, historyMigrations).migrate();
    for (const db of [app, history]) {
      assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
      const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as Array<{ name: string }>;
      for (const { name } of tables) assert.ok(!(db.prepare(`pragma table_info("${name}")`).all() as Array<{ name: string }>).some((column) => column.name === 'task_id'), name);
    }
    assert.equal(app.prepare("select name from sqlite_master where name = 'tasks'").get(), undefined);
    assert.equal(app.prepare("select value from settings where key = 'ui.workspace.layout.v1'").get(), undefined);
    assert.deepEqual(app.prepare("select value from settings where key = 'ui.sidebar.expanded.v1'").get(), { value: '{"projects":["p"]}' });
    assert.deepEqual(app.prepare('select id, project_id, resume_id, worktree_id from sessions').get(), { id: 's', project_id: 'p', resume_id: 'native-resume', worktree_id: 'w' });
    assert.deepEqual(app.prepare('select id, project_id, worktree_path, branch from worktrees').get(), { id: 'w', project_id: 'p', worktree_path: '/retained/worktree', branch: 'patterm/old-name' });
    assert.deepEqual(app.prepare('select id, project_id from diff_snapshots order by id').all(), [{ id: 'd', project_id: 'p' }, { id: 'd_without_worktree', project_id: 'p' }]);
    assert.deepEqual(app.prepare('select id, project_id from timeline_events').get(), { id: 'event', project_id: 'p' });
    assert.deepEqual(app.prepare('select id, project_id from conversations').get(), { id: 'legacy', project_id: 'p' });
    assert.deepEqual(history.prepare('select id, project_id, provider_conversation_id, worktree_id from conversations').get(), { id: 'c', project_id: 'p', provider_conversation_id: 'native-resume', worktree_id: 'w' });
    assert.deepEqual(history.prepare('select id, project_id from conversation_import_batches').get(), { id: 'batch', project_id: 'p' });
    assert.deepEqual(history.prepare('select id, text from conversation_messages').get(), { id: 'm', text: 'retained history needle' });
    assert.deepEqual(history.prepare("select owner_id from conversation_history_fts where conversation_history_fts match 'needle'").all(), [{ owner_id: 'm' }]);
    const archiveDir = path.join(directory, 'archives', firstArchive);
    const archive = JSON.parse(fs.readFileSync(path.join(archiveDir, 'task-archive.json'), 'utf8')) as { version: number; databases: Record<string, { tables: Record<string, Array<Record<string, unknown>>> }> };
    assert.equal(archive.version, 1);
    assert.equal(archive.databases['app.db']?.tables.task_comments?.[0]?.document_body, 'Keep this document');
    assert.equal(archive.databases['app.db']?.tables.tasks?.[0]?.number, 42);
    // Restore to separate copies and prove the previous migration chain can read both.
    for (const [name, chain] of [['app.db', previousAppMigrations], ['history.db', previousHistoryMigrations]] as const) {
      const restoredPath = path.join(directory, `restored-${name}`);
      fs.copyFileSync(path.join(archiveDir, name), restoredPath);
      const restored = openSqliteConnection(restoredPath);
      try {
        assert.deepEqual(new Migrator(restored, chain).migrate(), []);
        assert.equal((restored.prepare("select task_id from " + (name === 'app.db' ? 'sessions' : 'conversations')).get() as { task_id: string }).task_id, 't');
      } finally { restored.close(); }
    }
  } finally {
    history.close();
    app.close();
    removeTree(directory);
  }
}
