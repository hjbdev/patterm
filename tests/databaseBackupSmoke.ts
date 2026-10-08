import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSqliteConnection } from '../app/Database/SqliteConnection';
import { backupBeforeMigrations, completeHistoryBackup } from '../app/Services/DatabaseBackupService';
import { DatabaseService } from '../app/Services/DatabaseService';
import { HistoryDatabaseService } from '../app/Services/HistoryDatabaseService';
import { migrations } from '../database/migrations';
import { historyMigrations } from '../database/historyMigrations';

export function assertDatabaseBackups(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-backup-'));
  const backups = path.join(directory, 'backups');
  const appDb = path.join(directory, 'app.db');
  const historyDb = path.join(directory, 'history.db');
  try {
    // A new data directory has nothing to keep.
    assert.equal(backupBeforeMigrations(directory), null);

    const app = new DatabaseService(directory);
    app.initialize();
    app.connection.exec(`insert into projects (id, name, path, created_at, updated_at) values ('p', 'Project', '/project', 'now', 'now')`);
    app.dispose();
    const history = new HistoryDatabaseService(directory);
    history.initialize();
    history.dispose();
    assert.equal(backupBeforeMigrations(directory), null, 'nothing pending, no backup');

    // An update that only migrates app.db still keeps a matching history.db.
    const [latest, second, third] = migrations.slice(-3).reverse().map((migration) => migration.name);
    unapply(appDb, latest!);
    fs.mkdirSync(path.join(backups, '.partial-crashed'), { recursive: true });
    const first = backupBeforeMigrations(directory, new Date('2026-10-04T10:00:00.000Z'));
    assert.ok(first);
    assert.deepEqual(first.copied, ['app.db']);
    assert.equal(path.basename(first.directory), 'pre-migration-2026-10-04T10-00-00.000Z');
    assert.equal(fs.statSync(backups).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(backups, '.partial-crashed')), false, 'incomplete backups are removed');
    let manifest = readManifest(first.directory);
    assert.deepEqual(manifest.databases['app.db'].pending, [latest]);
    assert.match(manifest.databases['app.db'].sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(manifest.databases['history.db'].pending, []);
    assert.equal(manifest.databases['history.db'].sha256, undefined, 'history.db waits for the import worker');
    withConnection(path.join(first.directory, 'app.db'), (db) => {
      assert.equal((db.prepare('select count(*) as n from projects').get() as { n: number }).n, 1);
    });

    assert.deepEqual(completeHistoryBackup(directory)?.copied, ['history.db']);
    assert.equal(completeHistoryBackup(directory), null, 'history.db is copied once per backup');
    manifest = readManifest(first.directory);
    assert.match(manifest.databases['history.db'].sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(fs.readdirSync(first.directory).sort(), ['app.db', 'history.db', 'manifest.json']);
    for (const file of ['app.db', 'history.db', 'manifest.json']) {
      assert.equal(fs.statSync(path.join(first.directory, file)).mode & 0o777, 0o600, `${file} is private`);
    }

    // A failed update that is retried keeps its first backup as the restore point.
    assert.equal(backupBeforeMigrations(directory, new Date('2026-10-04T10:05:00.000Z')), null);
    assert.equal(backupBeforeMigrations(directory, new Date('2026-10-04T10:10:00.000Z')), null);
    assert.deepEqual(backupNames(backups), ['pre-migration-2026-10-04T10-00-00.000Z']);

    // After a restore from that set, the old build's new data gets a new set when the update runs again.
    for (const file of ['app.db', 'history.db']) {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(directory, file + suffix), { force: true });
      fs.copyFileSync(path.join(first.directory, file), path.join(directory, file));
    }
    withConnection(appDb, (db) => db.exec(`insert into projects (id, name, path, created_at, updated_at) values ('q', 'After rollback', '/after', 'now', 'now')`));
    const again = backupBeforeMigrations(directory, new Date('2026-10-04T10:20:00.000Z'));
    assert.ok(again, 'an update after a restore is not a retry');
    assert.deepEqual(completeHistoryBackup(directory)?.copied, ['history.db']);
    withConnection(path.join(again.directory, 'app.db'), (db) => {
      assert.equal((db.prepare('select count(*) as n from projects').get() as { n: number }).n, 2);
    });

    // Once that update has finished, the next one gets a new backup, and only the last two are kept.
    reapply(appDb, latest!);
    unapply(appDb, second!);
    assert.ok(backupBeforeMigrations(directory, new Date('2026-10-05T10:00:00.000Z')));
    reapply(appDb, second!);
    unapply(appDb, third!);
    assert.ok(backupBeforeMigrations(directory, new Date('2026-10-06T10:00:00.000Z')));
    assert.deepEqual(backupNames(backups), ['pre-migration-2026-10-05T10-00-00.000Z', 'pre-migration-2026-10-06T10-00-00.000Z']);
    reapply(appDb, third!);

    // An update that only migrates history.db copies app.db at startup too.
    const latestHistory = historyMigrations.at(-1)!.name;
    unapply(historyDb, latestHistory);
    const historyOnly = backupBeforeMigrations(directory, new Date('2026-10-07T10:00:00.000Z'));
    assert.deepEqual(historyOnly?.copied, ['app.db']);
    assert.deepEqual(readManifest(historyOnly!.directory).databases['history.db'].pending, [latestHistory]);
    assert.deepEqual(completeHistoryBackup(directory)?.copied, ['history.db']);
    reapply(historyDb, latestHistory);

    // history.db that did not exist before an update has no entry, so a rollback removes it.
    const noHistory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-backup-'));
    try {
      const fresh = new DatabaseService(noHistory);
      fresh.initialize();
      fresh.dispose();
      unapply(path.join(noHistory, 'app.db'), latest!);
      const set = backupBeforeMigrations(noHistory);
      assert.equal(readManifest(set!.directory).databases['history.db'], undefined);
    } finally {
      fs.rmSync(noHistory, { recursive: true, force: true });
    }

    // An older build refuses a database a newer build migrated, before backing up or migrating.
    withConnection(historyDb, (db) => {
      db.prepare(`insert into migrations (migration, batch, applied_at) values ('2099_01_01_000001_from_the_future', 99, 'now')`).run();
    });
    assert.throws(() => backupBeforeMigrations(directory), /history\.db was migrated by a newer version of Patterm.*from_the_future/);
    assert.throws(() => completeHistoryBackup(directory), /newer version of Patterm/);
    const newer = new HistoryDatabaseService(directory);
    assert.throws(() => newer.initialize(), /newer version of Patterm/);
    newer.dispose();
    assert.equal(historyMigrations.some((migration) => migration.name.startsWith('2099')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Recording a migration as not run stands in for an update that adds it.
function unapply(file: string, migration: string): void {
  withConnection(file, (db) => db.prepare('delete from migrations where migration = ?').run(migration));
}

function reapply(file: string, migration: string): void {
  withConnection(file, (db) => db.prepare(`insert into migrations (migration, batch, applied_at) values (?, 1, 'now')`).run(migration));
}

function readManifest(directory: string) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
}

function backupNames(root: string): string[] {
  return fs.readdirSync(root).filter((name) => name.startsWith('pre-migration-')).sort();
}

function withConnection(file: string, run: (db: ReturnType<typeof openSqliteConnection>) => void): void {
  const db = openSqliteConnection(file);
  try {
    run(db);
  } finally {
    db.close();
  }
}
