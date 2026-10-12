#!/usr/bin/env node
// Runs cargo with ~/.cargo/bin on PATH. Package scripts call this instead of a
// POSIX `PATH=... cargo` prefix, which cmd.exe cannot run.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const env = { ...process.env };
const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = [path.join(os.homedir(), '.cargo', 'bin'), env[pathKey]].filter(Boolean).join(path.delimiter);

const result = spawnSync('cargo', process.argv.slice(2), { env, stdio: 'inherit' });
if (result.error) {
  console.error(`cargo: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
