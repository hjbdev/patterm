import type { Migration, MigrationSchema, MigrationStatus } from './Migration';
import type { SqliteConnection } from './SqliteConnection';

interface MigrationRow {
  migration: string;
  batch: number;
}

export class Migrator {
  constructor(
    private readonly db: SqliteConnection,
    private readonly migrations: Migration[]
  ) {}

  migrate(): string[] {
    this.ensureMigrationTable();
    const applied = new Set(this.appliedRows().map((row) => row.migration));
    assertKnownMigrations(this.migrations, applied, this.label());
    const pending = this.migrations.filter((migration) => !applied.has(migration.name));
    if (pending.length === 0) return [];

    const batch = this.nextBatch();
    const ran: string[] = [];
    for (const migration of pending) {
      this.runMigration(migration, batch);
      ran.push(migration.name);
    }
    return ran;
  }

  rollback(): string[] {
    this.ensureMigrationTable();
    const latestBatch = this.latestBatch();
    if (latestBatch === null) return [];

    const migrationsByName = new Map(this.migrations.map((migration) => [migration.name, migration]));
    const rows = this.appliedRows()
      .filter((row) => row.batch === latestBatch)
      .reverse();
    const rolledBack: string[] = [];

    for (const row of rows) {
      const migration = migrationsByName.get(row.migration);
      if (!migration) {
        throw new Error(`migration file missing for rollback: ${row.migration}`);
      }

      this.rollbackMigration(migration);
      rolledBack.push(row.migration);
    }

    return rolledBack;
  }

  reset(): string[] {
    const rolledBack: string[] = [];
    while (true) {
      const batch = this.rollback();
      if (batch.length === 0) return rolledBack;
      rolledBack.push(...batch);
    }
  }

  refresh(): { rolledBack: string[]; migrated: string[] } {
    const rolledBack = this.reset();
    const migrated = this.migrate();
    return { rolledBack, migrated };
  }

  status(): MigrationStatus[] {
    this.ensureMigrationTable();
    const applied = new Map(this.appliedRows().map((row) => [row.migration, row.batch]));
    return this.migrations.map((migration) => ({
      migration: migration.name,
      batch: applied.get(migration.name) ?? null,
      status: applied.has(migration.name) ? 'ran' : 'pending'
    }));
  }

  private label(): string {
    const main = (this.db.prepare('pragma database_list').all() as Array<{ name: string; file: string }>).find((row) => row.name === 'main');
    return main?.file || 'the database';
  }

  private runMigration(migration: Migration, batch: number): void {
    migration.beforeUp?.(this.db);
    const schema = migrationSchema(this.db);
    const runInTransaction = this.db.transaction(() => {
      migration.up(schema);
      this.db
        .prepare('insert into migrations (migration, batch, applied_at) values (?, ?, ?)')
        .run(migration.name, batch, new Date().toISOString());
    });
    runInTransaction();
  }

  private rollbackMigration(migration: Migration): void {
    const schema = migrationSchema(this.db);
    const runInTransaction = this.db.transaction(() => {
      migration.down(schema);
      this.db.prepare('delete from migrations where migration = ?').run(migration.name);
    });
    runInTransaction();
  }

  private ensureMigrationTable(): void {
    this.db.exec(`
      create table if not exists migrations (
        id integer primary key autoincrement,
        migration text not null unique,
        batch integer not null,
        applied_at text not null
      );
    `);
  }

  private appliedRows(): MigrationRow[] {
    return this.db
      .prepare('select migration, batch from migrations order by batch asc, id asc')
      .all() as MigrationRow[];
  }

  private nextBatch(): number {
    return (this.latestBatch() ?? 0) + 1;
  }

  private latestBatch(): number | null {
    const row = this.db.prepare('select max(batch) as batch from migrations').get() as { batch: number | null };
    return row.batch;
  }
}

export class DatabaseNewerThanApplicationError extends Error {
  constructor(readonly database: string, readonly unknown: string[]) {
    super(`${database} was migrated by a newer version of Patterm (unknown migrations: ${unknown.join(', ')}). Install that version or restore a backup taken before it ran.`);
    this.name = 'DatabaseNewerThanApplicationError';
  }
}

// An older build must not open a database a newer build has migrated.
export function assertKnownMigrations(migrations: readonly Migration[], applied: ReadonlySet<string>, database: string): void {
  const known = new Set(migrations.map((migration) => migration.name));
  const unknown = [...applied].filter((name) => !known.has(name));
  if (unknown.length) throw new DatabaseNewerThanApplicationError(database, unknown);
}

// Reads migration state without creating the table, so it works on read-only connections.
export function migrationState(db: SqliteConnection, migrations: readonly Migration[]): { applied: string[]; pending: string[] } {
  const table = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'migrations'").get();
  const applied = table ? (db.prepare('select migration from migrations order by batch asc, id asc').all() as Array<{ migration: string }>).map((row) => row.migration) : [];
  const ran = new Set(applied);
  return { applied, pending: migrations.filter((migration) => !ran.has(migration.name)).map((migration) => migration.name) };
}

function migrationSchema(db: SqliteConnection): MigrationSchema {
  return {
    connection: db,
    sql: (statement) => db.exec(statement),
    dropTableIfExists: (name) => db.exec(`drop table if exists ${quoteIdentifier(name)}`),
    dropVirtualTableIfExists: (name) => db.exec(`drop table if exists ${quoteIdentifier(name)}`)
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
