import { execFile } from 'node:child_process';

// Ends a process. Windows has no signals: `kill()` ends only the one process and
// orphans its children (cmd.exe shims, node), so the whole tree is ended.
// POSIX sends `signal` to the process alone.
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}
