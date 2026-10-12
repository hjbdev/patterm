import fs from 'node:fs';

// Removes a test directory. On Windows a just-stopped child or a closing SQLite
// handle can hold a file for a moment (EBUSY/EPERM), so retry before giving up.
export function removeTree(target: string): void {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

// Creates a symlink, or returns false where the OS refuses (Windows without
// Developer Mode or elevation raises EPERM), so a test can skip its link cases.
export function trySymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM' && process.platform === 'win32') return false;
    throw error;
  }
}
