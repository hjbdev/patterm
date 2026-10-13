import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseNulEnv, ShellEnvironmentService } from '../app/Services/ShellEnvironmentService';
import { removeTree } from './fixtures/TempTree';

async function main(): Promise<void> {
  const parsed = parseNulEnv(Buffer.from('PATH=/interactive/bin\0EMPTY=\0BROKEN\0SHELL=/bin/fish\0'));
  assert.deepEqual(parsed, { PATH: '/interactive/bin', EMPTY: '', SHELL: '/bin/fish' });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-shell-env-'));
  try {
    if (process.platform === 'win32') await windowsContract(tempDir);
    else await interactiveShell(tempDir);
  } finally {
    removeTree(tempDir);
  }

  console.log('shell environment smoke ok');
}

async function interactiveShell(tempDir: string): Promise<void> {
  const shellPath = path.join(tempDir, 'fake-shell');
  fs.writeFileSync(
    shellPath,
    [
      '#!/bin/sh',
      'if [ "$1" = "-ic" ] && [ "$2" = "env -0" ]; then',
      '  printf "PATH=/interactive/bin\\0COMPOSER_HOME=/composer\\0"',
      '  exit 0',
      'fi',
      'exit 2'
    ].join('\n')
  );
  fs.chmodSync(shellPath, 0o755);

  const service = new ShellEnvironmentService({
    env: { PATH: '/desktop/bin', SHELL: shellPath, KEEP: 'base' },
    shell: shellPath,
    timeoutMs: 1000
  });
  const env = await service.resolve();
  assert.equal(env.PATH, '/interactive/bin', 'interactive shell PATH overrides desktop PATH');
  assert.equal(env.COMPOSER_HOME, '/composer', 'interactive shell env is merged');
  assert.equal(env.KEEP, 'base', 'base env entries are preserved');
}

// Windows apps already receive the user's environment, so no shell is run and
// variable names stay case-insensitive.
async function windowsContract(tempDir: string): Promise<void> {
  const marker = path.join(tempDir, 'shell-ran');
  const shellPath = path.join(tempDir, 'fake-shell.cmd');
  fs.writeFileSync(shellPath, `@echo off\r\necho ran> "${marker}"\r\n`);

  const service = new ShellEnvironmentService({
    env: { Path: 'C:\\desktop\\bin', SHELL: shellPath, KEEP: 'base' },
    shell: shellPath,
    timeoutMs: 1000
  });
  const env = await service.resolve();
  assert.equal(env.PATH, 'C:\\desktop\\bin', 'the desktop PATH is read through any casing');
  assert.equal(env.Path, 'C:\\desktop\\bin');
  assert.equal(env.KEEP, 'base', 'base env entries are preserved');
  assert.equal(fs.existsSync(marker), false, 'no interactive shell is spawned on Windows');
  env.PATH = 'C:\\changed';
  assert.equal(env.Path, 'C:\\changed', 'writes keep the existing casing');
  assert.equal(await service.resolve(), env, 'the resolved environment is cached');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
