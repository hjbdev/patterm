import { createRequire } from 'node:module';
import { WINDOWS_PATH_KEY } from '../Platform/PathIdentity';

const nodeRequire = createRequire(__filename);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NativeSqliteConnection;
};

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteConnection {
  close(): void;
  exec(statement: string): void;
  prepare(statement: string): SqliteStatement;
  registerFunction(name: string, fn: (...values: unknown[]) => unknown): void;
  transaction<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result;
}

interface NativeSqliteConnection {
  close(): void;
  exec(statement: string): void;
  prepare(statement: string): SqliteStatement;
  function(name: string, options: { deterministic?: boolean }, fn: (...values: unknown[]) => unknown): void;
}

export function openSqliteConnection(path: string, options: { readOnly?: boolean } = {}): SqliteConnection {
  const db = new DatabaseSync(path, options);
  // pathColumn() folds Windows paths with this, since SQLite's lower() only
  // folds ASCII and Windows compares paths case-insensitively in Unicode.
  if (process.platform === 'win32') {
    db.function(WINDOWS_PATH_KEY, { deterministic: true }, (value) => typeof value === 'string' ? value.replace(/\//g, '\\').toLowerCase() : value);
  }
  return new PattermSqliteConnection(db);
}

const STATEMENT_CACHE_LIMIT = 256;
const SCHEMA_MUTATION_PATTERN = /\b(?:drop|alter|detach)\b/i;

class PattermSqliteConnection implements SqliteConnection {
  private transactionDepth = 0;
  private readonly statementCache = new Map<string, PattermSqliteStatement>();

  constructor(private readonly db: NativeSqliteConnection) {}

  close(): void {
    this.statementCache.clear();
    this.db.close();
  }

  exec(statement: string): void {
    if (SCHEMA_MUTATION_PATTERN.test(statement)) this.statementCache.clear();
    this.db.exec(statement);
  }

  prepare(statement: string): SqliteStatement {
    const cached = this.statementCache.get(statement);
    if (cached) {
      this.statementCache.delete(statement);
      this.statementCache.set(statement, cached);
      return cached;
    }
    const prepared = new PattermSqliteStatement(this.db.prepare(statement));
    if (this.statementCache.size >= STATEMENT_CACHE_LIMIT) {
      this.statementCache.delete(this.statementCache.keys().next().value!);
    }
    this.statementCache.set(statement, prepared);
    return prepared;
  }

  registerFunction(name: string, fn: (...values: unknown[]) => unknown): void {
    this.db.function(name, {}, fn);
  }

  transaction<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
    return (...args: Args) => {
      // node:sqlite has no transaction helper; expose one small helper for callers.
      const depth = this.transactionDepth;
      const savepoint = `patterm_tx_${depth}`;
      this.db.exec(depth === 0 ? 'begin' : `savepoint ${savepoint}`);
      this.transactionDepth += 1;

      try {
        const result = callback(...args);
        this.transactionDepth -= 1;
        this.db.exec(depth === 0 ? 'commit' : `release savepoint ${savepoint}`);
        return result;
      } catch (error) {
        this.transactionDepth -= 1;
        if (depth === 0) {
          this.db.exec('rollback');
        } else {
          this.db.exec(`rollback to savepoint ${savepoint}`);
          this.db.exec(`release savepoint ${savepoint}`);
        }
        throw error;
      }
    };
  }
}

class PattermSqliteStatement implements SqliteStatement {
  constructor(private readonly native: SqliteStatement) {}

  run(...params: unknown[]): SqliteRunResult {
    return this.native.run(...params);
  }

  get(...params: unknown[]): unknown {
    return plainRow(this.native.get(...params));
  }

  all(...params: unknown[]): unknown[] {
    return this.native.all(...params).map((row) => plainRow(row));
  }
}

function plainRow(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return row;
  }

  return { ...(row as Record<string, unknown>) };
}
