import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Local IPC endpoints are named by a filesystem path such as `<dir>/mcp.sock`.
// POSIX listens on that path. Windows has no filesystem sockets, so the path
// maps to a named pipe unique to its resolved location; two data directories
// never share a pipe. Listener and client must both call ipcPath().

const PIPE_PREFIX = '\\\\.\\pipe\\';

export function ipcPath(socketPath: string): string {
  if (process.platform !== 'win32' || socketPath.startsWith(PIPE_PREFIX)) return socketPath;
  const resolved = path.resolve(socketPath).toLowerCase();
  const digest = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return `${PIPE_PREFIX}patterm-${digest}-${path.basename(resolved)}`;
}

// Removes a stale POSIX socket file before listening. Pipes vanish with their
// listener, so there is nothing to remove on Windows.
export function removeStaleIpc(socketPath: string): void {
  if (process.platform === 'win32') return;
  fs.rmSync(socketPath, { force: true });
}

// Restricts a POSIX socket to its owner. Pipes keep their default ACL, so
// callers must still authenticate peers.
export function restrictIpc(socketPath: string): void {
  if (process.platform === 'win32') return;
  fs.chmodSync(socketPath, 0o600);
}
