import path from 'node:path';

// The debug terminal sidecar `cargo build` leaves in the repository.
export function debugSidecarPath(): string {
  return path.resolve('native/terminal-core/target/debug', process.platform === 'win32' ? 'patterm-terminal-core.exe' : 'patterm-terminal-core');
}
