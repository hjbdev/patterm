import path from 'node:path';
import { acquireApplicationLock } from '../../app/Runtime/ApplicationLock';
import { DatabaseService } from '../../app/Services/DatabaseService';

export function resolveAppDataPath(): string {
  const arg = process.argv.find((value) => value.startsWith('--app-data='));
  const appDataPath = arg?.slice('--app-data='.length) || process.env.PATTERM_APP_DATA_PATH;
  if (!appDataPath) {
    throw new Error('missing app data path: pass --app-data=/path or set PATTERM_APP_DATA_PATH');
  }

  return path.resolve(appDataPath);
}

// Holds the runtime lock, so these commands refuse to run while Patterm uses the directory.
export function withDatabase(run: (database: DatabaseService, appDataPath: string) => void): void {
  const appDataPath = resolveAppDataPath();
  const release = acquireApplicationLock(appDataPath);
  const database = new DatabaseService(appDataPath);
  try {
    database.initialize({ migrate: false });
    run(database, appDataPath);
  } finally {
    database.dispose();
    release();
  }
}

// Rolling back drops data, so only development directories allow it without --force.
export function assertDestructiveAllowed(appDataPath: string): void {
  if (path.basename(appDataPath).endsWith('-dev') || process.argv.includes('--force')) return;
  throw new Error(`${appDataPath} is not a development data directory. Rolling back migrations drops data; pass --force to continue.`);
}
