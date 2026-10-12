import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { samePath } from '../app/Platform/Paths';
import { linkOrCopy } from '../app/Platform/LinkedEntries';
import { prepareOpenCodeTheme } from '../app/Services/OpenCodeThemeService';

// Patterm's OpenCode config directory links the user's config entries: symlinks
// on POSIX, and junctions (directories) plus hard links or copies (files) on
// Windows, where symlinks need Developer Mode. Either way the CLI must read the
// user's content, write-through must reach the user's files, and Patterm must
// never remove a file the CLI made or rewrote.

const exists = (file: string): boolean => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-linked-'));
  try {
    const source = path.join(root, 'source');
    const runtime = path.join(root, 'runtime');
    const prepare = (): string => prepareOpenCodeTheme(runtime, { OPENCODE_CONFIG_DIR: source });
    fs.mkdirSync(path.join(source, 'themes'), { recursive: true });
    fs.mkdirSync(path.join(source, 'plugins'));
    fs.writeFileSync(path.join(source, 'cli.json'), '{}');
    fs.writeFileSync(path.join(source, 'service.json'), '{"password":"a"}');
    fs.writeFileSync(path.join(source, 'package.json'), '{}');
    fs.writeFileSync(path.join(source, 'plugins', 'one.js'), '1');
    fs.writeFileSync(path.join(source, 'themes', 'custom.json'), '{}');
    fs.writeFileSync(path.join(source, 'themes', 'other.json'), '{}');
    const target = prepare();

    // Directories and files read as the user's.
    assert.ok(samePath(fs.realpathSync(path.join(target, 'plugins')), path.join(source, 'plugins')));
    assert.equal(fs.readFileSync(path.join(target, 'plugins', 'one.js'), 'utf8'), '1');
    assert.equal(fs.readFileSync(path.join(target, 'service.json'), 'utf8'), '{"password":"a"}');
    assert.equal(fs.readFileSync(path.join(target, 'themes', 'custom.json'), 'utf8'), '{}');
    // A write through the link reaches the user's file, as a CLI credential refresh needs.
    fs.writeFileSync(path.join(target, 'service.json'), '{"password":"b"}');
    assert.equal(fs.readFileSync(path.join(source, 'service.json'), 'utf8'), '{"password":"b"}', 'writes through the link reach the user config');
    // Patterm's own files stay out of the user's config.
    assert.equal(exists(path.join(source, '.patterm-links.json')), false);
    assert.equal(exists(path.join(source, 'themes', 'patterm-opencode.json')), false);
    assert.equal(exists(path.join(target, 'themes', '.patterm-links.json')), false, 'no manifest where OpenCode scans for themes');

    // Relaunching keeps everything linked.
    prepare();
    prepare();
    assert.equal(fs.readFileSync(path.join(target, 'service.json'), 'utf8'), '{"password":"b"}');
    assert.equal(fs.readFileSync(path.join(target, 'plugins', 'one.js'), 'utf8'), '1');

    // A user file replaced atomically is picked up again on the next launch.
    fs.rmSync(path.join(source, 'service.json'));
    fs.writeFileSync(path.join(source, 'service.json'), '{"password":"c"}');
    prepare();
    assert.equal(fs.readFileSync(path.join(target, 'service.json'), 'utf8'), '{"password":"c"}');

    // Removed source entries leave no links behind, but the CLI's own files stay.
    fs.writeFileSync(path.join(target, 'generated.json'), 'cli');
    fs.rmSync(path.join(source, 'package.json'));
    fs.rmSync(path.join(source, 'plugins'), { recursive: true });
    fs.rmSync(path.join(source, 'themes', 'other.json'));
    prepare();
    assert.equal(exists(path.join(target, 'package.json')), false, 'a stale linked file is removed');
    assert.equal(exists(path.join(target, 'plugins')), false, 'a stale linked directory is removed');
    assert.equal(exists(path.join(target, 'themes', 'other.json')), false, 'a stale linked theme is removed');
    assert.equal(fs.readFileSync(path.join(target, 'generated.json'), 'utf8'), 'cli', 'files the CLI made are left alone');
    assert.equal(fs.readFileSync(path.join(target, 'themes', 'custom.json'), 'utf8'), '{}');

    // A linked file the CLI replaced with its own is its file now, not Patterm's to remove.
    fs.writeFileSync(path.join(source, 'extra.json'), '{"user":true}');
    prepare();
    fs.rmSync(path.join(target, 'extra.json'));
    fs.writeFileSync(path.join(target, 'extra.json'), `{"written by the cli, and longer than the original":${'1'.repeat(40)}}`);
    fs.rmSync(path.join(source, 'extra.json'));
    prepare();
    assert.match(fs.readFileSync(path.join(target, 'extra.json'), 'utf8'), /written by the cli/, 'a replaced file survives');

    // The older layout linked the whole themes directory; it becomes a real directory.
    fs.rmSync(path.join(target, 'themes'), { recursive: true });
    fs.symlinkSync(path.join(source, 'themes'), path.join(target, 'themes'), process.platform === 'win32' ? 'junction' : 'dir');
    prepare();
    assert.equal(fs.lstatSync(path.join(target, 'themes')).isSymbolicLink(), false);
    assert.equal(exists(path.join(source, 'themes', 'patterm-opencode.json')), false, 'migration must not write through the old directory link');
    assert.equal(fs.readFileSync(path.join(target, 'themes', 'custom.json'), 'utf8'), '{}');

    if (process.platform === 'win32') {
      // Across volumes a hard link is impossible, so the file is copied. The copy
      // still reads as the user's file and is still removed when it goes stale.
      const realLink = fs.linkSync;
      (fs as unknown as { linkSync: unknown }).linkSync = () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };
      try {
        fs.writeFileSync(path.join(source, 'copied.json'), '{"copy":true}');
        prepare();
        assert.equal(fs.readFileSync(path.join(target, 'copied.json'), 'utf8'), '{"copy":true}');
        assert.equal(linkOrCopyKind(path.join(source, 'copied.json'), path.join(root, 'probe.json')), 'copy');
      } finally {
        (fs as unknown as { linkSync: unknown }).linkSync = realLink;
      }
      fs.rmSync(path.join(source, 'copied.json'));
      prepare();
      assert.equal(exists(path.join(target, 'copied.json')), false, 'a stale copy is removed');
    }
    console.log('linked entries smoke passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function linkOrCopyKind(source: string, destination: string): 'link' | 'copy' {
  return linkOrCopy(source, destination) ? 'link' : 'copy';
}

main();
