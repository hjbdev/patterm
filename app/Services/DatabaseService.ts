import path from 'node:path';
import fs from 'node:fs';
import { Migrator } from '../Database/Migrator';
import { migrations } from '../../database/migrations';
import { openSqliteConnection, type SqliteConnection } from '../Database/SqliteConnection';

export interface DatabaseServiceOptions {
  busyTimeoutMs?: number;
  readOnly?: boolean;
}

export class DatabaseService {
  private db: SqliteConnection | null = null;
  private currentDbPath: string | null = null;

  constructor(private readonly appDataPath: string, private readonly options: DatabaseServiceOptions = {}) {}

  get connection(): SqliteConnection {
    if (!this.db) {
      throw new Error('database has not been initialized');
    }

    return this.db;
  }

  get dbPath(): string {
    if (!this.currentDbPath) {
      throw new Error('database has not been initialized');
    }

    return this.currentDbPath;
  }

  initialize(options: { migrate?: boolean } = {}): void {
    fs.mkdirSync(this.appDataPath, { recursive: true });
    const dbPath = path.join(this.appDataPath, 'app.db');
    this.currentDbPath = dbPath;
    this.db = openSqliteConnection(dbPath, { readOnly: this.options.readOnly === true });
    if (this.options.readOnly === true) {
      this.db.exec('pragma query_only = ON');
      this.db.exec(`pragma busy_timeout = ${busyTimeoutMs(this.options.busyTimeoutMs)}`);
      this.db.exec('pragma cache_size = -32000');
      this.db.exec('pragma mmap_size = 134217728');
    } else {
      this.db.exec('pragma journal_mode = WAL');
      this.db.exec('pragma synchronous = NORMAL');
      this.db.exec('pragma foreign_keys = ON');
      this.db.exec(`pragma busy_timeout = ${busyTimeoutMs(this.options.busyTimeoutMs)}`);
      this.db.exec('pragma cache_size = -32000');
      this.db.exec('pragma mmap_size = 134217728');
      this.db.exec('pragma temp_store = MEMORY');
    }
    if (options.migrate ?? true) {
      new Migrator(this.db, migrations).migrate();
    }
  }

  migrator(): Migrator {
    return new Migrator(this.connection, migrations);
  }

  dispose(): void {
    this.db?.close();
    this.db = null;
    this.currentDbPath = null;
  }
}

function busyTimeoutMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 5000;
}
