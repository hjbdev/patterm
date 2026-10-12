import fs from 'node:fs';
import path from 'node:path';
import { storedPath } from '../Platform/PathIdentity';
import type { DatabaseService } from './DatabaseService';

// The Personal project holds agents that belong to no repository. It lives in
// Patterm's data directory, so agents ask before working anywhere else.
export const PERSONAL_PROJECT_ID = 'project_personal';

// Project kinds the user sees and works in. The assistant's internal project is not one.
export const USER_PROJECT_KINDS_SQL = `('workspace', 'personal')`;

export function isUserProjectKind(kind: string | undefined): boolean {
  return kind === 'workspace' || kind === 'personal';
}

export function ensurePersonalProject(database: DatabaseService, appDataPath: string): void {
  const cwd = storedPath(path.join(appDataPath, 'personal'));
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const at = new Date().toISOString();
  database.connection.prepare(`insert into projects (id, name, path, kind, created_at, updated_at) values (?, 'Personal', ?, 'personal', ?, ?)
    on conflict(id) do update set path = excluded.path, kind = 'personal'`).run(PERSONAL_PROJECT_ID, cwd, at, at);
}
