import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openSqliteConnection, type SqliteConnection } from '../Database/SqliteConnection';

// Run during locked application startup, before workers or other writers start.
// VACUUM INTO includes committed WAL pages; copying the database file does not.
export function archiveBeforeTaskRemoval(db: SqliteConnection): void {
  const main = (db.prepare('pragma database_list').all() as Array<{ name: string; file: string }>).find((row) => row.name === 'main');
  const dataDir = main?.file ? path.dirname(main.file) : fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-migration-'));
  const archiveRoot = path.join(dataDir, 'archives');
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(archiveRoot, 'task-removal-v1-'));
  const connections: Array<{ name: string; db: SqliteConnection; close: boolean }> = [
    { name: main?.file ? path.basename(main.file) : 'app.db', db, close: false }
  ];
  const otherName = connections[0]!.name === 'history.db' ? 'app.db' : 'history.db';
  const otherPath = path.join(dataDir, otherName);
  if (fs.existsSync(otherPath)) connections.push({ name: otherName, db: openSqliteConnection(otherPath), close: true });
  try {
    const databases: Record<string, unknown> = {};
    for (const source of connections) {
      const backupPath = path.join(directory, source.name);
      source.db.prepare('vacuum into ?').run(backupPath);
      fs.chmodSync(backupPath, 0o600);
      const backup = openSqliteConnection(backupPath, { readOnly: true });
      try {
        const integrity = backup.prepare('pragma integrity_check').all() as Array<{ integrity_check: string }>;
        if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || backup.prepare('pragma foreign_key_check').all().length) {
          throw new Error(`task removal backup validation failed: ${source.name}`);
        }
        const tables = backup.prepare("select name, sql from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as Array<{ name: string; sql: string }>;
        const archive: Record<string, unknown> = {};
        for (const table of tables) {
          if (['tasks', 'task_comments', 'issue_links', 'revisions', 'projects', 'settings'].includes(table.name)) {
            archive[table.name] = backup.prepare(`select * from ${quote(table.name)}`).all();
          } else if (/\btask_id\b/.test(table.sql ?? '') && !/create virtual table/i.test(table.sql ?? '')) {
            // Retained content is in the backup. Export only its former scope mapping.
            const id = hasColumn(backup, table.name, 'id') ? 'id' : 'conversation_id';
            archive[table.name] = backup.prepare(`select ${quote(id)}, task_id${hasColumn(backup, table.name, 'project_id') ? ', project_id' : ''} from ${quote(table.name)} where task_id is not null`).all();
          }
        }
        databases[source.name] = { sha256: hashFile(backupPath), tables: archive };
      } finally {
        backup.close();
      }
    }
    const document = JSON.stringify({ version: 1, createdAt: new Date().toISOString(), databases }, null, 2);
    const archivePath = path.join(directory, 'task-archive.json');
    fs.writeFileSync(archivePath, document, { flag: 'wx', mode: 0o600 });
    if (fs.readFileSync(archivePath, 'utf8') !== document) throw new Error('task archive verification failed');
    // Preserve history ownership while the application still has the task map.
    const app = connections.find((entry) => entry.name !== 'history.db')?.db;
    const history = connections.find((entry) => entry.name === 'history.db')?.db;
    if (app && history && hasTable(app, 'tasks')) {
      const tasks = app.prepare('select id, project_id from tasks').all() as Array<{ id: string; project_id: string }>;
      history.transaction(() => {
        for (const table of ['conversations', 'conversation_import_batches']) {
          if (!hasColumn(history, table, 'task_id')) continue;
          const update = history.prepare(`update ${quote(table)} set project_id = ? where task_id = ? and project_id is null`);
          for (const task of tasks) update.run(task.project_id, task.id);
        }
      })();
    }
  } finally {
    for (const source of connections) if (source.close) source.db.close();
  }
}

export function hasTable(db: SqliteConnection, table: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table));
}

export function hasColumn(db: SqliteConnection, table: string, column: string): boolean {
  return (db.prepare(`pragma table_info(${quote(table)})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

export function removeTaskColumns(db: SqliteConnection): void {
  const tables = db.prepare("select name, sql from sqlite_master where type = 'table' and sql not like 'CREATE VIRTUAL TABLE%'").all() as Array<{ name: string; sql: string }>;
  for (const { name } of tables) {
    if (!hasColumn(db, name, 'task_id')) continue;
    const indexes = db.prepare("select name, sql from sqlite_master where type = 'index' and tbl_name = ? and sql is not null").all(name) as Array<{ name: string; sql: string }>;
    for (const index of indexes) if (/\btask_id\b/.test(index.sql)) db.exec(`drop index ${quote(index.name)}`);
    db.exec(`alter table ${quote(name)} drop column task_id`);
  }
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function hashFile(file: string): string {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let size: number;
    while ((size = fs.readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}
