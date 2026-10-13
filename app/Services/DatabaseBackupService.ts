import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import type { Migration } from '../Database/Migration';
import { assertKnownMigrations, migrationState } from '../Database/Migrator';
import { openSqliteConnection } from '../Database/SqliteConnection';
import { migrations } from '../../database/migrations';
import { historyMigrations } from '../../database/historyMigrations';

const BACKUP_PREFIX = 'pre-migration-';
const PARTIAL_PREFIX = '.partial-';
const MANIFEST = 'manifest.json';
const KEEP_BACKUPS = 2;
const FREE_SPACE_MARGIN = 64 * 1024 * 1024;

type DatabaseFile = 'app.db' | 'history.db';

interface DatabaseSpec {
  file: DatabaseFile;
  migrations: readonly Migration[];
  // integrity_check reads every page; quick_check skips index cross-checks, which matters for a large history.db.
  check: 'integrity_check' | 'quick_check';
}

const DATABASES: DatabaseSpec[] = [
  { file: 'app.db', migrations, check: 'integrity_check' },
  { file: 'history.db', migrations: historyMigrations, check: 'quick_check' }
];

interface DatabaseState {
  spec: DatabaseSpec;
  file: string;
  applied: string[];
  pending: string[];
}

interface ManifestEntry {
  applied: string[];
  pending: string[];
  // Set once the copy is written. history.db is copied later, by the import worker.
  sha256?: string;
  bytes?: number;
}

interface Manifest {
  version: 2;
  createdAt: string;
  // Also written to the live app.db's user_version once the set exists. A
  // restored app.db comes from the copy, which predates it, so a later update
  // is not mistaken for a retry of this one.
  marker: number;
  databases: Partial<Record<DatabaseFile, ManifestEntry>>;
}

export interface DatabaseBackup {
  directory: string;
  copied: DatabaseFile[];
}

// One backup set per update, in backups/pre-migration-<time>/, holds app.db and
// history.db as they were before it migrated either one. Startup copies the
// small app.db under the runtime lock and records history.db's state.
// history.db is large, so the import worker copies it into the same set
// (completeHistoryBackup) before its first write; a startup import runs soon
// after launch, and nothing else imports into history.db, so the two copies
// match. A failed update that is retried keeps its first set as the restore
// point instead of rotating it away for partly migrated copies; the marker
// tells a retry from a new update after a restore.
// Every call checks both databases, so an older build refuses a newer schema.
export function backupBeforeMigrations(dataDir: string, now = new Date()): DatabaseBackup | null {
  const states = readStates(dataDir);
  if (!states.some((state) => state.pending.length)) return null;
  const root = backupRoot(dataDir);
  removePartialBackups(root);
  const latest = latestBackup(root);
  if (latest && latest.manifest.marker === readMarker(dataDir) && updateUnfinished(latest.manifest, states)) return null;

  const app = states.find((state) => state.spec.file === 'app.db');
  const partial = fs.mkdtempSync(path.join(root, PARTIAL_PREFIX));
  let directory: string;
  let manifest: Manifest;
  try {
    manifest = { version: 2, createdAt: now.toISOString(), marker: randomInt(1, 2 ** 31), databases: {} };
    for (const state of states) manifest.databases[state.spec.file] = { applied: state.applied, pending: state.pending };
    if (app) manifest.databases['app.db'] = { ...manifest.databases['app.db']!, ...copyDatabase(app, partial) };
    writeManifest(partial, manifest);
    fsyncPath(partial);
    directory = path.join(root, `${BACKUP_PREFIX}${now.toISOString().replaceAll(':', '-')}`);
    fs.renameSync(partial, directory);
    fsyncPath(root);
  } catch (error) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw backupError('app.db', error);
  }
  pruneBackups(root);
  if (app) writeMarker(app.file, manifest.marker);
  return { directory, copied: app ? ['app.db'] : [] };
}

// Called by the history import worker before it migrates or writes history.db.
export function completeHistoryBackup(dataDir: string): DatabaseBackup | null {
  const states = readStates(dataDir);
  const history = states.find((state) => state.spec.file === 'history.db');
  const root = path.join(dataDir, 'backups');
  const latest = history && fs.existsSync(root) ? latestBackup(root) : null;
  const entry = latest?.manifest.databases['history.db'];
  // A set from before a restore no longer matches the databases in use.
  if (!history || !latest || !entry || entry.sha256 || latest.manifest.marker !== readMarker(dataDir)) return null;

  removePartialBackups(latest.directory);
  const temporary = fs.mkdtempSync(path.join(latest.directory, PARTIAL_PREFIX));
  try {
    const copy = copyDatabase(history, temporary);
    fs.renameSync(path.join(temporary, history.spec.file), path.join(latest.directory, history.spec.file));
    fs.rmSync(temporary, { recursive: true, force: true });
    latest.manifest.databases['history.db'] = { ...entry, ...copy };
    writeManifest(latest.directory, latest.manifest);
    fsyncPath(latest.directory);
    return { directory: latest.directory, copied: ['history.db'] };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw backupError('history.db', error);
  }
}

function readStates(dataDir: string): DatabaseState[] {
  return DATABASES.flatMap((spec) => {
    const file = path.join(dataDir, spec.file);
    if (!fs.existsSync(file)) return [];
    const db = openSqliteConnection(file, { readOnly: true });
    try {
      const state = migrationState(db, spec.migrations);
      assertKnownMigrations(spec.migrations, new Set(state.applied), file);
      // A database no migration has run on is new, so there is nothing to keep.
      return state.applied.length ? [{ spec, file, ...state }] : [];
    } finally {
      db.close();
    }
  });
}

function readMarker(dataDir: string): number {
  const file = path.join(dataDir, 'app.db');
  if (!fs.existsSync(file)) return 0;
  const db = openSqliteConnection(file, { readOnly: true });
  try {
    return (db.prepare('pragma user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

function writeMarker(file: string, marker: number): void {
  const db = openSqliteConnection(file);
  try {
    db.exec(`pragma user_version = ${Math.trunc(marker)}`);
  } finally {
    db.close();
  }
}

// The update the set was made for has not finished while any migration it was
// about to run is still pending, for example after a failed migration.
function updateUnfinished(manifest: Manifest, states: DatabaseState[]): boolean {
  return states.some((state) => {
    const pending = new Set(state.pending);
    return manifest.databases[state.spec.file]?.pending.some((name) => pending.has(name)) ?? false;
  });
}

function copyDatabase(state: DatabaseState, directory: string): Required<Pick<ManifestEntry, 'sha256' | 'bytes'>> {
  assertFreeSpace(directory, state.file);
  const target = path.join(directory, state.spec.file);
  // VACUUM INTO accepts an empty target, so the file keeps 0600 whatever the umask.
  fs.closeSync(fs.openSync(target, 'wx', 0o600));
  const source = openSqliteConnection(state.file, { readOnly: true });
  try {
    // Includes committed WAL pages; copying the file would not.
    source.prepare('vacuum into ?').run(target);
  } finally {
    source.close();
  }
  fsyncPath(target);
  verifyBackup(target, state.spec.check);
  return { sha256: hashFile(target), bytes: fs.statSync(target).size };
}

function writeManifest(directory: string, manifest: Manifest): void {
  const temporary = path.join(directory, `${PARTIAL_PREFIX}${MANIFEST}`);
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fsyncPath(temporary);
  fs.renameSync(temporary, path.join(directory, MANIFEST));
}

function backupRoot(dataDir: string): string {
  const root = path.join(dataDir, 'backups');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  return root;
}

function latestBackup(root: string): { directory: string; manifest: Manifest } | null {
  const name = backupNames(root).at(-1);
  if (!name) return null;
  const directory = path.join(root, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST), 'utf8')) as Manifest;
  return manifest.version === 2 ? { directory, manifest } : null;
}

function backupNames(root: string): string[] {
  return fs.readdirSync(root).filter((name) => name.startsWith(BACKUP_PREFIX)).sort();
}

function backupError(file: DatabaseFile, error: unknown): Error {
  return new Error(`Patterm could not back up ${file} before migrating, so it left the databases unchanged: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

function assertFreeSpace(root: string, file: string): void {
  const needed = fileSize(file) + fileSize(`${file}-wal`) + FREE_SPACE_MARGIN;
  const stats = fs.statfsSync(root);
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (available < needed) {
    throw new Error(`not enough disk space in ${root}: ${formatBytes(needed)} needed, ${formatBytes(available)} free`);
  }
}

function verifyBackup(file: string, check: DatabaseSpec['check']): void {
  const backup = openSqliteConnection(file, { readOnly: true });
  try {
    const rows = backup.prepare(`pragma ${check}`).all() as Array<Record<string, string>>;
    if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== 'ok') throw new Error(`${check} failed for ${path.basename(file)}`);
  } finally {
    backup.close();
  }
}

function pruneBackups(root: string): void {
  const backups = backupNames(root);
  for (const name of backups.slice(0, -KEEP_BACKUPS)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
}

// Left by a crash during an earlier backup. They were never complete. Startup
// runs before the import worker starts, so neither removes the other's copy.
function removePartialBackups(directory: string): void {
  for (const name of fs.readdirSync(directory)) {
    if (name.startsWith(PARTIAL_PREFIX)) fs.rmSync(path.join(directory, name), { recursive: true, force: true });
  }
}

function fsyncPath(target: string): void {
  // Windows flushes a file only through a writable handle and cannot fsync a
  // directory; NTFS journals the directory entries itself.
  if (process.platform === 'win32' && fs.statSync(target).isDirectory()) return;
  const descriptor = fs.openSync(target, process.platform === 'win32' ? 'r+' : 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MiB`;
}

function hashFile(file: string): string {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let size: number;
    while ((size = fs.readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}
