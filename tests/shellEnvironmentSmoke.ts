import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseNulEnv, ShellEnvironmentService } from '../app/Services/ShellEnvironmentService';

async function main(): Promise<void> {
  const parsed = parseNulEnv(Buffer.from('PATH=/interactive/bin\0EMPTY=\0BROKEN\0SHELL=/bin/fish\0'));
  assert.deepEqual(parsed, { PATH: '/interactive/bin', EMPTY: '', SHELL: '/bin/fish' });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-shell-env-'));
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

  try {
    const service = new ShellEnvironmentService({
      env: { PATH: '/desktop/bin', SHELL: shellPath, KEEP: 'base' },
      shell: shellPath,
      timeoutMs: 1000
    });
    const env = await service.resolve();
    assert.equal(env.PATH, '/interactive/bin', 'interactive shell PATH overrides desktop PATH');
    assert.equal(env.COMPOSER_HOME, '/composer', 'interactive shell env is merged');
    assert.equal(env.KEEP, 'base', 'base env entries are preserved');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('shell environment smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
