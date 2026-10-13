import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../scripts/check-ci.mjs', import.meta.url));

function fixture(t, check, suite, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-ci-smoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { check, 'test:fixture': suite } }));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [runner], { cwd: root, env, encoding: 'utf8' });
  return { root, result };
}

test('CI expands suites, prepares once and runs duplicate test files once', t => {
  const { root, result } = fixture(t,
    'node prepare.mjs && pnpm run test:fixture && node prepare.mjs',
    'node tests/pass.mjs && node --test tests/pass.mjs tests/other.mjs', {
      'prepare.mjs': "import fs from 'node:fs'; fs.appendFileSync('prepared', '1');",
      'tests/pass.mjs': "import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(fs.readFileSync('prepared','utf8'), '1'); fs.appendFileSync('passed','1');",
      'tests/other.mjs': "import fs from 'node:fs'; fs.writeFileSync('other', '1');"
    });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'passed'), 'utf8'), '1');
  assert.equal(fs.readFileSync(path.join(root, 'other'), 'utf8'), '1');
});

test('a failing smoke file fails CI', t => {
  const { result } = fixture(t, 'pnpm run test:fixture', 'node tests/fail.mjs', {
    'tests/fail.mjs': 'process.exitCode = 1;'
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test('a failing preparation stops CI before tests', t => {
  const { root, result } = fixture(t, 'node prepare.mjs && pnpm run test:fixture', 'node tests/pass.mjs', {
    'prepare.mjs': 'process.exit(17);',
    'tests/pass.mjs': "import fs from 'node:fs'; fs.writeFileSync('passed', '1');"
  });
  assert.equal(result.status, 17, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(root, 'passed')), false);
});
