import fs from 'node:fs';

// Creating a symlink on Windows needs Developer Mode or elevation. Returns false
// when the platform refuses, so a test can skip only its symlink assertions.
export function trySymlink(target: string, link: string, type?: 'file' | 'dir' | 'junction'): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}
