import fs from 'node:fs';
import path from 'node:path';

// Writes a fake native CLI implemented as a Node script and returns the path
// to launch. POSIX gets an executable `#!/usr/bin/env node` file at `file`.
// Windows cannot run a shebang script, so the script lands at `file.js` beside
// an npm-style `file.cmd` shim, which is what an npm-installed CLI looks like
// there and what Integrated hosts must resolve.
export function writeNodeCli(file: string, source: string): string {
  if (process.platform !== 'win32') {
    fs.writeFileSync(file, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
    return file;
  }
  const script = `${file}.js`;
  fs.writeFileSync(script, source);
  fs.writeFileSync(`${file}.cmd`, [
    '@ECHO off', 'SETLOCAL', 'SET dp0=%~dp0',
    `"node"  "%dp0%\\${path.basename(script)}" %*`, ''
  ].join('\r\n'));
  return `${file}.cmd`;
}
