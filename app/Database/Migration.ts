import type { SqliteConnection } from './SqliteConnection';

export interface MigrationSchema {
  connection: SqliteConnection;
  sql(statement: string): void;
  dropTableIfExists(name: string): void;
  dropVirtualTableIfExists(name: string): void;
}

export interface Migration {
  name: string;
  beforeUp?(connection: SqliteConnection): void;
  up(schema: MigrationSchema): void;
  down(schema: MigrationSchema): void;
}

export interface MigrationStatus {
  migration: string;
  batch: number | null;
  status: 'ran' | 'pending';
}
