import fs from 'node:fs';
import path from 'node:path';
import { openSqliteConnection } from '../Database/SqliteConnection';

// SQLite releases the OS lock even after a crash. Keep the file: unlinking it
// would let another process lock a different inode for the same directory.
export function acquireApplicationLock(directory: string): () => void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = openSqliteConnection(path.join(directory, 'runtime.lock.db'));
  try {
    lock.exec('pragma busy_timeout = 0; begin exclusive');
  } catch (error) {
    lock.close();
    throw new Error(`Patterm is already using ${directory}, or its runtime lock is unavailable`, { cause: error });
  }
  return () => lock.close();
}
