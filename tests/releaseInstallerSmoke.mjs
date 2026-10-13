import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { verifyMinisign } from '../scripts/release/verify-minisign.mjs';

const fixtures = 'tests/fixtures/minisign';
const linuxOnly = process.platform === 'win32' && 'it runs the bash release installer, which Windows does not use';

test('the verifier accepts real minisign signatures and rejects tampering', () => {
  const key = fs.readFileSync(path.join(fixtures, 'test.pub'), 'utf8').trim().split('\n')[1];
  const manifest = fs.readFileSync(path.join(fixtures, 'manifest.json'));
  assert.equal(verifyMinisign(key, manifest, fs.readFileSync(path.join(fixtures, 'manifest.json.minisig'), 'utf8')), 'patterm 1.2.0');
  assert.equal(verifyMinisign(key, manifest, fs.readFileSync(path.join(fixtures, 'manifest.json.legacy.minisig'), 'utf8')), 'legacy');
  const signature = fs.readFileSync(path.join(fixtures, 'manifest.json.minisig'), 'utf8');
  assert.throws(() => verifyMinisign(key, Buffer.from(manifest.toString().replace('1.2.0', '9.9.9')), signature), /Signature verification failed/);
  assert.throws(() => verifyMinisign(key, manifest, signature.replace('patterm 1.2.0', 'patterm 9.9.9')), /Trusted comment/);
  const other = Buffer.from(key, 'base64');
  other[2] ^= 1;
  assert.throws(() => verifyMinisign(other.toString('base64'), manifest, signature), /different key/);
});

// Signs like minisign 0.11+ (prehashed "ED"), checked above against real output.
function signer() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const id = crypto.randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return {
    publicKey: Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64'),
    sign(contents, trusted) {
      const signature = crypto.sign(null, crypto.createHash('blake2b512').update(contents).digest(), privateKey);
      const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
      return `untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), id, signature]).toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`;
    }
  };
}

test('the downgrade guard follows semantic version precedence', { skip: linuxOnly }, () => {
  const script = fs.readFileSync('scripts/release/install.sh', 'utf8');
  const functions = ['identifiers_lt', 'version_lt'].map((name) => new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(script)[0]).join('\n');
  // Ascending, from semver.org item 11, plus multi-digit numbers.
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
  const pairs = order.flatMap((a) => order.map((b) => `if version_lt ${a} ${b}; then echo 1; else echo 0; fi`));
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${functions}\n${pairs.join('\n')}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const answers = result.stdout.trim().split('\n');
  order.forEach((a, i) => order.forEach((b, j) => assert.equal(answers[i * order.length + j], i < j ? '1' : '0', `${a} < ${b}`)));
});

const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('the release installer verifies, swaps versions, updates the service, and uninstalls', { skip: linuxOnly || !arch }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-release-'));
  const server = http.createServer((request, response) => { response.end(); });
  try {
    const key = signer();
    const releases = path.join(root, 'releases');
    const home = path.join(root, 'home');
    // ~/.local/share on another disk: /proc then reports paths the installer never spelled.
    fs.mkdirSync(path.join(root, 'storage'));
    fs.mkdirSync(path.join(home, '.local'), { recursive: true });
    fs.symlinkSync(path.join(root, 'storage'), path.join(home, '.local/share'));
    const share = path.join(root, 'storage');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const executable = (file, script) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `#!/bin/bash\n${script}\n`, { mode: 0o755 }); };
    executable(path.join(bin, 'systemctl'), 'echo "systemctl $*" >> "$CALLS"\ncase "$2" in is-active) exit "${ACTIVE:-3}" ;; is-failed) exit "${FAILED:-1}" ;; list-units) [[ -z "${LIST_FAIL:-}" ]] || exit 1; printf "%s" "${RUNNING_UNITS:-}" ;; esac');
    executable(path.join(bin, 'update-desktop-database'), 'exit 0');
    // Hosts may or may not have minisign; this one checks with the JS verifier.
    executable(path.join(bin, 'minisign'), `echo "minisign $*" >> "$CALLS"\nwhile (( $# )); do case "$1" in -P) key="$2"; shift ;; -m) file="$2"; shift ;; -x) sig="$2"; shift ;; esac; shift; done\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve('scripts/release/verify-minisign.mjs'))} "$key" "$file" "$sig" >/dev/null`);
    // Rendered as package.sh renders it, for the release asset and the tarball's copy.
    const publicKeyFile = path.join(root, 'minisign.pub');
    fs.writeFileSync(publicKeyFile, `untrusted comment: test\n${key.publicKey}\n`);
    const installer = path.join(root, 'install.sh');
    fs.writeFileSync(installer, execFileSync('scripts/release/render-installer.sh', ['example/patterm', publicKeyFile]));
    assert.doesNotMatch(fs.readFileSync(installer, 'utf8'), /@PATTERM_REPO@|@MINISIGN_PUBLIC_KEY@/);

    const release = (version, { tamper = false } = {}) => {
      const directory = path.join(releases, version);
      const name = `patterm-${version}-linux-${arch}`;
      const stage = path.join(root, 'stage', name);
      for (const file of ['scripts/install-service.mjs', 'scripts/patterm.sh', 'deploy/patterm.service', 'deploy/patterm-terminal@.service']) {
        fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
        fs.copyFileSync(file, path.join(stage, file));
      }
      fs.copyFileSync('scripts/release/verify-minisign.mjs', path.join(stage, 'scripts/verify-minisign.mjs'));
      fs.copyFileSync(installer, path.join(stage, 'scripts/install-release.sh'));
      executable(path.join(stage, 'runtime/node'), `exec ${JSON.stringify(process.execPath)} "$@"`);
      executable(path.join(stage, 'native/terminal-core/target/release/patterm-terminal-core'), 'exit 0');
      for (const file of ['dist/server/server/main.js', 'dist/renderer/index.html', 'dist/mcp/patterm-mcp.js']) {
        fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
        fs.writeFileSync(path.join(stage, file), version);
      }
      fs.writeFileSync(path.join(stage, 'BUILD'), `version=${version}\ncommit=${'a'.repeat(40)}\n`);
      fs.mkdirSync(directory, { recursive: true });
      execFileSync('tar', ['-czf', path.join(directory, `${name}.tar.gz`), '-C', path.dirname(stage), name]);
      fs.rmSync(path.dirname(stage), { recursive: true });
      execFileSync('bash', ['-c', `cd "${directory}" && sha256sum ${name}.tar.gz > ${name}.tar.gz.sha256`]);
      const manifest = execFileSync(process.execPath, ['scripts/release/manifest.mjs', version, 'a'.repeat(40), path.join(directory, `${name}.tar.gz.sha256`)]);
      fs.writeFileSync(path.join(directory, 'manifest.json'), manifest);
      fs.writeFileSync(path.join(directory, 'manifest.json.minisig'), key.sign(tamper ? Buffer.from('other') : manifest, `patterm ${version}`));
      return directory;
    };
    const calls = path.join(root, 'calls');
    const install = async (version, args = [], extra = {}) => {
      fs.writeFileSync(calls, '');
      const result = await run('bash', [installer, ...args], {
        PATH: `${bin}:/usr/bin:/bin`, HOME: home, CALLS: calls, PATTERM_RELEASE_URL: `file://${releases}/${version}`, ...extra
      });
      return { ...result, calls: fs.readFileSync(calls, 'utf8') };
    };
    const current = () => fs.readlinkSync(path.join(home, '.local/share/patterm/current'));
    const versions = () => fs.readdirSync(path.join(home, '.local/share/patterm/versions')).sort();

    release('1.2.0');
    let result = await install('1.2.0');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.calls, /^minisign -q -V -P /m, 'a fresh install checks the signature with minisign');
    assert.equal(current(), 'versions/1.2.0');
    assert.equal(fs.realpathSync(path.join(home, '.local/bin/patterm')), path.join(share, 'patterm/versions/1.2.0/scripts/patterm.sh'));
    assert.match(fs.readFileSync(path.join(home, '.local/share/applications/patterm.desktop'), 'utf8'), /^Exec=.*\/\.local\/bin\/patterm$/m);
    assert.doesNotMatch(result.calls, /stop|start/);
    assert.match((await install('1.2.0')).stdout, /already installed/);
    const holder = spawn('flock', [path.join(share, 'patterm/.install.lock'), process.execPath, '-e', "process.stdout.write('locked'); process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'inherit'] });
    t.after(() => holder.stdin.end());
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); });
    const concurrent = await install('1.2.0');
    assert.notEqual(concurrent.status, 0);
    assert.match(concurrent.stderr, /another Patterm installer/);
    assert.equal(current(), 'versions/1.2.0');
    await new Promise((resolve) => { holder.once('exit', resolve); holder.stdin.end(); });


    // A service installed by an earlier version is re-pointed and restarted.
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const configHome = path.join(home, '.config');
    fs.mkdirSync(path.join(configHome, 'patterm'), { recursive: true });
    const data = path.join(root, 'data $archive');
    fs.writeFileSync(path.join(configHome, 'patterm/patterm.env'), `PATTERM_PORT="${port}"\nPATTERM_PUBLIC_ORIGIN="http://localhost:${port}"\nPATTERM_DATA_DIR="${data}"\n`);
    release('1.3.0', { tamper: true });
    result = await install('1.3.0', ['--update'], { ACTIVE: '0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /signature does not match the installed key/);
    assert.equal(current(), 'versions/1.2.0');
    assert.doesNotMatch(result.calls, /stop/);
    release('1.3.0');
    result = await install('1.3.0', [], { ACTIVE: '0' });
    assert.notEqual(result.status, 0, 'a running service needs --update');
    // A from-source install goes once the new service is healthy, unless something still runs from it.
    const legacy = path.join(home, '.local/share/patterm-desktop');
    for (const directory of [legacy, `${legacy}.previous`]) {
      fs.mkdirSync(path.join(directory, 'dist/server/server'), { recursive: true });
      fs.writeFileSync(path.join(directory, 'dist/server/server/main.js'), 'legacy');
    }
    const host = spawn('sleep', ['60'], { cwd: `${legacy}.previous`, stdio: 'ignore' });
    result = await install('1.3.0', ['--update'], { ACTIVE: '0' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(legacy), false, 'the unused legacy install is removed');
    assert.ok(fs.existsSync(`${legacy}.previous`), 'a legacy install a process still uses is kept');
    assert.match(result.stderr, /Kept .*patterm-desktop\.previous: a running process still uses it/);
    const updateCalls = result.calls;
    // Once that process ends, rerunning the same update finishes the cleanup.
    await new Promise((resolve) => { host.once('exit', resolve); host.kill(); });
    const retry = await install('1.3.0', ['--update'], { ACTIVE: '0' });
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, /already installed/);
    assert.equal(fs.existsSync(`${legacy}.previous`), false, 'a same-version update removes it once nothing uses it');
    assert.doesNotMatch(retry.calls, /stop|start/, 'the retry leaves the running service alone');
    result = { ...result, calls: updateCalls };
    assert.equal(result.calls, 'systemctl --user is-active --quiet patterm.service\nsystemctl --user stop patterm.service\nsystemctl --user daemon-reload\nsystemctl --user start patterm.service\n');
    assert.equal(current(), 'versions/1.3.0');
    assert.deepEqual(versions(), ['1.2.0', '1.3.0']);
    const unit = fs.readFileSync(path.join(configHome, 'systemd/user/patterm.service'), 'utf8');
    assert.ok(unit.includes(`WorkingDirectory=${share}/patterm/current\n`), unit);

    result = await install('1.2.0', ['--update']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /newer than 1\.2\.0/);

    const retained = spawn('sleep', ['60'], { cwd: path.join(share, 'patterm/versions/1.2.0'), stdio: 'ignore' });
    t.after(() => retained.kill());
    await new Promise((resolve, reject) => { retained.once('spawn', resolve); retained.once('error', reject); });
    release('1.4.0');
    result = await install('1.4.0', ['--update'], { ACTIVE: '0' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(versions(), ['1.2.0', '1.3.0', '1.4.0'], 'a version still used by an agent is kept as well');
    assert.match(result.stderr, /Kept .*1\.2\.0.*running process/);
    await new Promise((resolve) => { retained.once('exit', resolve); retained.kill(); });
    release('1.4.1');
    result = await install('1.4.1', ['--update'], { ACTIVE: '0' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(versions(), ['1.4.0', '1.4.1'], 'unused older versions are removed on the next update');

    // A checksum mismatch changes nothing.
    release('1.5.0');
    const tarball = path.join(releases, `1.5.0/patterm-1.5.0-linux-${arch}.tar.gz`);
    fs.appendFileSync(tarball, 'x');
    result = await install('1.5.0', ['--update'], { ACTIVE: '0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the release's SHA-256/);
    assert.equal(current(), 'versions/1.4.1');

    // A failed start keeps the new version: it may have migrated the databases.
    release('1.5.0');
    server.close();
    result = await install('1.5.0', ['--update'], { ACTIVE: '0', FAILED: '0' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not healthy/);
    assert.match(result.stderr, /To roll back, point .* at versions\/1\.4\.1/);
    assert.equal(current(), 'versions/1.5.0');

    fs.writeFileSync(calls, '');
    fs.mkdirSync(data, { recursive: true });
    // The data directory's $ is escaped in patterm.env; a literal backslash path is someone else's.
    const lookalike = path.join(root, 'data \\$archive');
    fs.mkdirSync(lookalike);
    const uninstall = (args, extra = {}) => run('bash', ['scripts/release/uninstall.sh', '--yes', ...args], { PATH: `${bin}:/usr/bin:/bin`, HOME: home, CALLS: calls, ...extra });
    for (const uncertain of [{ RUNNING_UNITS: 'patterm-terminal@abc.service loaded active running' }, { LIST_FAIL: '1' }]) {
      const refused = await uninstall(['--delete-data'], uncertain);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /nothing was removed/);
      assert.ok(fs.existsSync(path.join(home, '.local/share/patterm/current')), 'the install is kept while Patterm may be running');
      assert.ok(fs.existsSync(data), 'data is kept while Patterm may be running');
    }
    let removal = await uninstall(['--keep-data']);
    assert.equal(removal.status, 0, removal.stderr);
    for (const removed of ['.local/share/patterm', '.local/bin/patterm', '.local/share/applications/patterm.desktop', '.config/patterm/patterm.env', '.config/systemd/user/patterm.service']) {
      assert.equal(fs.existsSync(path.join(home, removed)), false, removed);
    }
    assert.ok(fs.existsSync(data), 'data is kept');
    assert.match(fs.readFileSync(calls, 'utf8'), /stop patterm-terminal@\*\.service patterm-integrated-\*/);
    fs.mkdirSync(path.join(home, '.config/patterm'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config/patterm/patterm.env'), `PATTERM_DATA_DIR="${data.replaceAll('$', '\\$')}"\n`);
    removal = await uninstall(['--delete-data']);
    assert.equal(removal.status, 0, removal.stderr);
    assert.equal(fs.existsSync(data), false, 'the configured data directory is deleted');
    assert.ok(fs.existsSync(lookalike), 'a directory whose name matches the escaped text is not');
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
