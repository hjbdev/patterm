import type { DatabaseService } from './DatabaseService';
import type { SqliteConnection, SqliteStatement } from '../Database/SqliteConnection';

interface ProcessIdentityStatements {
  session: SqliteStatement;
  process: SqliteStatement;
  // Input ID to stable process ID. Session rows never change their process,
  // so only the process-to-PTY step is read on every call.
  stableIds: Map<string, string>;
}

// Terminal IPC resolves IDs several times per tab switch. Reuse the prepared
// statements, and skip the session lookup, which scans sessions by process_id.
const MAX_REMEMBERED_STABLE_IDS = 512;
const identityStatements = new WeakMap<SqliteConnection, ProcessIdentityStatements>();

function statementsFor(connection: SqliteConnection): ProcessIdentityStatements {
  let statements = identityStatements.get(connection);
  if (!statements) {
    statements = {
      session: connection.prepare(`select process_id from sessions where process_id = ? or id = ?`),
      process: connection.prepare(`select pty_process_id from processes where id = ? or pty_process_id = ?`),
      stableIds: new Map()
    };
    identityStatements.set(connection, statements);
  }
  return statements;
}

export function resolvePtyProcessId(database: DatabaseService, processId: string): string {
  const statements = statementsFor(database.connection);
  const rememberedStableId = statements.stableIds.get(processId);
  let stableProcessId = rememberedStableId;
  let sessionFound = false;
  if (stableProcessId === undefined) {
    const session = statements.session.get(processId, processId) as
      | { process_id: string | null }
      | undefined;
    sessionFound = Boolean(session?.process_id);
    stableProcessId = session?.process_id ?? processId;
  }

  const process = statements.process.get(stableProcessId, processId) as
    | { pty_process_id: string | null }
    | undefined;
  // Remember the session step once the ID is known to belong to a session or
  // process. Unknown IDs are looked up again because a row may appear later.
  if (rememberedStableId === undefined && (sessionFound || process)) {
    if (statements.stableIds.size >= MAX_REMEMBERED_STABLE_IDS) statements.stableIds.clear();
    statements.stableIds.set(processId, stableProcessId);
  }
  // Raw sidecar IDs are still accepted for debug/direct terminal calls.
  return process?.pty_process_id ?? stableProcessId;
}

export function withResolvedPtyProcessId<T extends { process_id: string }>(database: DatabaseService, payload: T): T {
  return { ...payload, process_id: resolvePtyProcessId(database, payload.process_id) };
}
