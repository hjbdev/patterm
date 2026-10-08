import type { SqliteConnection } from '../../Database/SqliteConnection';

export interface AgentHistoryDb {
  connection: SqliteConnection;
}
