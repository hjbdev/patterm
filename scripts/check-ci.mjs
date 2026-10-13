#!/usr/bin/env node
// Run the same checks as `pnpm check`, preparing each build once and using
// Node's process-isolated test runner for the independent smoke test files.
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const { scripts } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const preparation = new Set();
const files = new Set();

function collect(command) {
  for (const part of command.split(' && ')) {
    const suite = /^pnpm run (test:\S+)$/.exec(part);
    if (suite) {
      if (!scripts[suite[1]]) throw new Error(`Missing check script: ${suite[1]}`);
      collect(scripts[suite[1]]);
      continue;
    }
    const args = part.split(/\s+/);
    if (args.shift() === 'node') {
      if (args[0] === '--test') args.shift();
      if (args.length && args.every(file => /^(dist\/tests\/tests\/|tests\/).+\.(js|mjs)$/.test(file))) {
        for (const file of args) files.add(file);
        continue;
      }
    }
    // Other commands run once before the test files.
    preparation.add(part);
  }
}

collect(scripts.check);
if (!files.size) throw new Error('No smoke test files found in pnpm check');
try {
  execSync([...preparation].join(' && '), { stdio: 'inherit' });
} catch (error) {
  process.exit(error.status ?? 1);
}
console.log(`Running ${files.size} Node smoke test files with eight workers.`);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=8', '--test-reporter=spec', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
