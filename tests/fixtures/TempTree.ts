import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Removes a test directory. On Windows a just-stopped child or a closing SQLite
// handle can hold a file for a moment (EBUSY/EPERM), and on a loaded CI runner
// that moment lasts seconds, so retry for up to ten seconds before giving up.
export function removeTree(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  } catch (error) {
    if (process.platform === 'win32') reportHolders(target);
    throw error;
  }
}

// Names the processes that still mention a directory Windows will not remove,
// so a leaked host or CLI shows up in the test output.
function reportHolders(target: string): void {
  const name = path.basename(target).replace(/'/g, "''");
  try {
    const listing = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${name}*' } | ForEach-Object { "$($_.ProcessId) parent=$($_.ParentProcessId) $($_.Name): $($_.CommandLine)" }`
    ], { encoding: 'utf8', windowsHide: true }).trim();
    console.error(`processes still referring to ${target}:\n${listing || '(none)'}`);
  } catch (error) {
    console.error(`could not list processes holding ${target}: ${(error as Error).message}`);
  }
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
