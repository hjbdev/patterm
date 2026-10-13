import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadElectron } from '../scripts/release/download-electron.mjs';

const bytes = Buffer.from('verified Electron archive');
const checksum = createHash('sha256').update(bytes).digest('hex');
const filename = 'electron-v1.2.3-darwin-arm64.zip';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-electron-smoke-'));
  const previous = process.env.electron_config_cache;
  const cache = path.join(root, 'cache with spaces');
  fs.mkdirSync(path.join(cache, 'upstream-url-hash'), { recursive: true });
  process.env.electron_config_cache = cache;
  t.after(() => {
    if (previous === undefined) delete process.env.electron_config_cache;
    else process.env.electron_config_cache = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { cache, cached: path.join(cache, 'upstream-url-hash', filename), file: path.join(root, filename) };
}

test('packaging reuses a matching, checksum-verified Electron archive', async t => {
  const { cached, file } = fixture(t);
  fs.writeFileSync(cached, bytes);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('cache hit must not download'); });
  await downloadElectron('https://example.invalid/electron.zip', file, checksum);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('a corrupt cached archive is downloaded again', async t => {
  const { cache, cached, file } = fixture(t);
  fs.writeFileSync(cached, 'corrupt');
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  await downloadElectron('https://example.invalid/electron.zip', file, checksum);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(fs.readFileSync(file), bytes);
  // A corrupt archive left by an older install must not hide the replacement.
  fs.rmSync(file);
  await downloadElectron('https://example.invalid/electron.zip', file, checksum);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(fs.readFileSync(path.join(cache, filename)), bytes);
});

test('an empty cache falls back to download and retries transient errors', async t => {
  const { cache, file } = fixture(t);
  fs.rmSync(cache, { recursive: true });
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++attempts < 3) throw new Error('temporary download failure');
    return new Response(bytes);
  });
  await downloadElectron('https://example.invalid/electron.zip', file, checksum);
  assert.equal(attempts, 3);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(path.join(cache, filename)), bytes);
  fs.rmSync(file);
  await downloadElectron('https://example.invalid/electron.zip', file, checksum);
  assert.equal(attempts, 3, 'the second package uses the saved download');
});

test('a bad download fails verification and never enters the cache', async t => {
  const { cache, file } = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('corrupt'));
  await assert.rejects(downloadElectron('https://example.invalid/electron.zip', file, checksum), /SHA-256/);
  assert.equal(fs.existsSync(path.join(cache, filename)), false);
});

test('the Linux packaging CLI reuses the same verified cache', t => {
  const { cached, file } = fixture(t);
  fs.writeFileSync(cached, bytes);
  const script = fileURLToPath(new URL('../scripts/release/download-electron.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'https://example.invalid/electron.zip', file, checksum], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(file), bytes);
});
