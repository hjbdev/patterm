import { createHash, randomBytes } from 'node:crypto';
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
  const digest = createHash('sha256').update(ipcKey(path.dirname(resolved))).update(resolved).digest('hex').slice(0, 32);
  return `${PIPE_PREFIX}patterm-${digest}-${path.basename(resolved)}`;
}

// Node cannot restrict who may create a pipe, so another local user could
// listen on a predictable name first and receive clients' identity tokens.
// A secret kept beside the endpoint, inside the user's own profile, makes
// the name unguessable; every process of this user derives the same name.
const keys = new Map<string, string>();

function ipcKey(directory: string): string {
  const cached = keys.get(directory);
  if (cached) return cached;
  const file = path.join(directory, '.ipc-key');
  let key = readKey(file);
  if (!key) {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
    fs.writeFileSync(temporary, randomBytes(32).toString('hex'), { mode: 0o600 });
    try {
      // A hard link publishes the complete key atomically, and never replaces
      // one another process published first.
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    key = readKey(file);
    if (!key) throw new Error(`Could not read the IPC key in ${directory}`);
  }
  keys.set(directory, key);
  return key;
}

function readKey(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
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
