import fs from 'node:fs';
import path from 'node:path';
import { Migrator } from '../Database/Migrator';
import { openSqliteConnection, type SqliteConnection } from '../Database/SqliteConnection';
import { historyMigrations } from '../../database/historyMigrations';

export interface HistoryDatabaseServiceOptions {
  busyTimeoutMs?: number;
  mode?: 'read' | 'write';
}

export class HistoryDatabaseService {
  private db: SqliteConnection | null = null;
  private currentDbPath: string | null = null;
  private available = false;

  constructor(private readonly appDataPath: string, private readonly options: HistoryDatabaseServiceOptions = {}) {}

  get connection(): SqliteConnection {
    if (!this.db) {
      throw new Error('history database has not been initialized');
    }
    return this.db;
  }

  get isAvailable(): boolean {
    return this.available;
  }

  ensureAvailable(): boolean {
    if (this.available) return true;
    if ((this.options.mode ?? 'write') !== 'read') return false;
    this.dispose();
    this.initialize({ migrate: false });
    return this.available;
  }

  get dbPath(): string {
    if (!this.currentDbPath) {
      throw new Error('history database has not been initialized');
    }
    return this.currentDbPath;
  }

  initialize(options: { migrate?: boolean } = {}): void {
    const mode = this.options.mode ?? 'write';
    const dbPath = path.join(this.appDataPath, 'history.db');
    this.currentDbPath = dbPath;
    if (mode === 'read' && !fs.existsSync(dbPath)) {
      this.available = false;
      return;
    }
    if (mode === 'write') fs.mkdirSync(this.appDataPath, { recursive: true });

    this.db = openSqliteConnection(dbPath, { readOnly: mode === 'read' });
    if (mode === 'write') {
      this.db.exec('pragma journal_mode = WAL');
      this.db.exec('pragma synchronous = NORMAL');
      this.db.exec('pragma foreign_keys = ON');
      this.db.exec(`pragma busy_timeout = ${busyTimeoutMs(this.options.busyTimeoutMs)}`);
      this.db.exec('pragma cache_size = -32000');
      this.db.exec('pragma mmap_size = 134217728');
      this.db.exec('pragma temp_store = MEMORY');
    }
    if (mode === 'read') {
      this.db.exec('pragma query_only = ON');
      this.db.exec(`pragma busy_timeout = ${busyTimeoutMs(this.options.busyTimeoutMs)}`);
      this.db.exec('pragma cache_size = -32000');
      this.db.exec('pragma mmap_size = 134217728');
      this.available = hasHistorySchema(this.db);
      return;
    }
    if (options.migrate ?? true) {
      new Migrator(this.db, historyMigrations).migrate();
    }
    this.available = true;
  }

  migrator(): Migrator {
    return new Migrator(this.connection, historyMigrations);
  }

  dispose(): void {
    this.db?.close();
    this.db = null;
    this.currentDbPath = null;
    this.available = false;
  }
}

function busyTimeoutMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 5000;
}

function hasHistorySchema(db: SqliteConnection): boolean {
  const row = db.prepare(`select name from sqlite_master where type in ('table', 'virtual table') and name = 'conversations'`).get();
  return Boolean(row);
}
