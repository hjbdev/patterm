import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  return { cached: path.join(cache, 'upstream-url-hash', filename), file: path.join(root, filename) };
}

test('packaging reuses a matching, checksum-verified Electron archive', async t => {
  const { cached, file } = fixture(t);
  fs.writeFileSync(cached, bytes);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('cache hit must not download'); });
  await downloadElectron('https://example.invalid/electron.zip', file, checksum);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('a corrupt cached archive is downloaded again', async t => {
  const { cached, file } = fixture(t);
  fs.writeFileSync(cached, 'corrupt');
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  await downloadElectron('https://example.invalid/electron.zip', file, checksum);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('an empty cache falls back to download and retries transient errors', async t => {
  const { file } = fixture(t);
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++attempts < 3) throw new Error('temporary download failure');
    return new Response(bytes);
  });
  await downloadElectron('https://example.invalid/electron.zip', file, checksum);
  assert.equal(attempts, 3);
  assert.deepEqual(fs.readFileSync(file), bytes);
});
