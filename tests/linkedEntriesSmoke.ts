import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linkOrCopy } from '../app/Platform/LinkedEntries';

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-linked-'));
  try {
    const source = path.join(root, 'source.json');
    const destination = path.join(root, 'dest.json');
    fs.writeFileSync(source, '{"v":1}');
    assert.equal(linkOrCopy(source, destination), true, 'same-volume swap uses a hard link');
    assert.equal(fs.readFileSync(destination, 'utf8'), '{"v":1}');
    fs.writeFileSync(destination, '{"v":2}');
    assert.equal(fs.readFileSync(source, 'utf8'), '{"v":2}', 'writes through a hard link reach the source');

    // Across volumes a hard link fails with EXDEV and falls back to an atomic copy.
    const realLink = fs.linkSync;
    (fs as unknown as { linkSync: unknown }).linkSync = () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };
    try {
      const copied = path.join(root, 'copied.json');
      assert.equal(linkOrCopy(source, copied), false, 'EXDEV falls back to a copy');
      assert.equal(fs.readFileSync(copied, 'utf8'), '{"v":2}');
    } finally {
      (fs as unknown as { linkSync: unknown }).linkSync = realLink;
    }
    console.log('linked entries smoke passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
