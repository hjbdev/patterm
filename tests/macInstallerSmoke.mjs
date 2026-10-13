import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Exercise the real installer against isolated archives. Native signature and
// plist tools are stubbed here; macPackageSmoke verifies the actual Mac bundle.
test('Mac installer repeats, updates, rejects downgrades, and preserves the old app on failure', {
  skip: process.platform === 'win32' && 'requires bash and Python'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm mac installer '));
  try {
    const bin = path.join(root, 'bin');
    const releases = path.join(root, 'releases');
    const downloads = path.join(root, 'downloads');
    const applications = path.join(root, 'Applications with spaces');
    fs.mkdirSync(bin);
    fs.mkdirSync(releases);
    const executable = (file, script) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `#!/bin/bash\n${script}\n`, { mode: 0o755 });
    };
    executable(path.join(bin, 'uname'), 'if [[ "$1" == -s ]]; then echo Darwin; else echo arm64; fi');
    executable(path.join(bin, 'codesign'), '[[ -z "${BAD_SIGNATURE:-}" ]]');
    executable(path.join(bin, 'plutil'), 'case "$2" in tag_name) echo "v$LATEST" ;; CFBundleIdentifier) echo cloud.bayliss.patterm ;; esac');
    executable(path.join(bin, 'ditto'), 'exec unzip -q "$3" -d "$4"');
    executable(path.join(bin, 'pgrep'), '[[ -z "${PS_FAILED:-}" ]] || exit 2; [[ -n "${RUNNING_APP:-}" ]]');
    executable(path.join(bin, 'curl'), `while (( $# )); do
      case "$1" in --output) output="$2"; shift ;; https://*|file://*) url="$1" ;; esac; shift
    done
    printf "%s\\n" "$url" >> "$DOWNLOAD_CALLS"
    if [[ "$url" == */releases/latest ]]; then printf '{}' > "$output"; else cp "$RELEASES/\${url##*/}" "$output"; fi`);
    // Fail only the final new-app rename; restoration must still work.
    executable(path.join(bin, 'mv'), 'if [[ -n "${FAIL_SWITCH:-}" && "$1" == */extracted/Patterm.app ]]; then exit 1; fi\nexec /bin/mv "$@"');
    const versionAt = (bundle) => fs.readFileSync(path.join(applications, bundle, 'Contents/Resources/app/BUILD'), 'utf8').trim();
    const release = (version, { unsafe = false, badHash = false } = {}) => {
      const stage = path.join(root, 'stage');
      fs.rmSync(stage, { recursive: true, force: true });
      executable(path.join(stage, 'Patterm.app/Contents/MacOS/Patterm'), 'exit 0');
      const app = path.join(stage, 'Patterm.app/Contents/Resources/app');
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'BUILD'), `version=${version}\n`);
      fs.writeFileSync(path.join(stage, 'Patterm.app/Contents/Info.plist'), 'fixture');
      const name = `patterm-${version}-macos-arm64.zip`;
      const archive = path.join(releases, name);
      fs.rmSync(archive, { force: true });
      execFileSync('python3', ['-c', 'import pathlib, sys, zipfile; root = pathlib.Path(sys.argv[1]); z = zipfile.ZipFile(sys.argv[2], "w"); [z.write(p, p.relative_to(root)) for p in (root / "Patterm.app").rglob("*")]; z.close()', stage, archive]);
      if (unsafe) {
        fs.writeFileSync(path.join(stage, 'outside.txt'), 'escaped');
        execFileSync('python3', ['-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1], "a"); z.writestr("outside.txt", "escaped"); z.close()', archive]);
      }
      const hash = badHash ? '0'.repeat(64) : createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
      fs.writeFileSync(`${archive}.sha256`, `${hash}  ${name}\n`);
    };
    const install = (version, extra = {}, args = []) => spawnSync('bash', ['scripts/release/install-macos.sh', ...args], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PATTERM_MAC_APPLICATIONS_DIR: applications,
        PATTERM_MAC_RELEASE_URL: `file://${releases}`, LATEST: version, RELEASES: releases, DOWNLOAD_CALLS: downloads, ...extra }
    });
    release('1.2.3');
    let result = install('1.2.3');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(versionAt('Patterm.app'), 'version=1.2.3');
    fs.writeFileSync(downloads, '');
    result = install('1.2.3');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already installed/);
    assert.doesNotMatch(fs.readFileSync(downloads, 'utf8'), /\.zip/, 'a verified same-version rerun does not download the archive');
    fs.rmSync(path.join(applications, 'Patterm.app/Contents/MacOS/Patterm'));
    result = install('1.2.3');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Downloading Patterm/);
    assert.ok(fs.statSync(path.join(applications, 'Patterm.app/Contents/MacOS/Patterm')).isFile(), 'same-version rerun repairs an incomplete app');

    release('1.2.4');
    result = install('1.2.4', { RUNNING_APP: `${applications}/Patterm.app/Contents/MacOS/Patterm --flag` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Patterm is running/);
    assert.equal(versionAt('Patterm.app'), 'version=1.2.3');
    result = install('1.2.4', { RUNNING_APP: './Patterm --flag' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Patterm is running/);
    assert.equal(versionAt('Patterm.app'), 'version=1.2.3');
    result = install('1.2.4', { PS_FAILED: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot check running apps/);
    fs.mkdirSync(path.join(applications, '.patterm-install.lock'));
    result = install('1.2.4');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another installer/);
    fs.rmdirSync(path.join(applications, '.patterm-install.lock'));
    result = install('1.2.4', { FAIL_SWITCH: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(versionAt('Patterm.app'), 'version=1.2.3', 'failed rename restores the old app');
    result = install('1.2.4');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(versionAt('Patterm.app'), 'version=1.2.4');
    assert.equal(versionAt('Patterm.previous.app'), 'version=1.2.3');
    result = install('1.2.3');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /newer than/);
    for (const options of [{ badHash: true }, { unsafe: true }]) {
      release('1.2.5', options);
      result = install('1.2.5');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, options.badHash ? /checksum verification failed/ : /unsafe archive entry/);
      assert.equal(versionAt('Patterm.app'), 'version=1.2.4');
    }
    release('1.2.5');
    result = install('1.2.5', { BAD_SIGNATURE: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /signature verification failed/);
    assert.equal(versionAt('Patterm.app'), 'version=1.2.4');
    for (const version of ['1.2.5-beta.2', '1.2.5-beta.10', '1.2.5']) {
      release(version);
      result = install(version, {}, ['--version', version]);
      assert.equal(result.status, 0, result.stderr);
    }
    result = install('1.2.5-beta.10');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /newer than/);
    result = install('1.2.5-beta.10', {}, ['--allow-downgrade']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(versionAt('Patterm.app'), 'version=1.2.5-beta.10');
    assert.deepEqual(fs.readdirSync(applications).sort(), ['Patterm.app', 'Patterm.previous.app'], 'no lock or staging directories remain');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
