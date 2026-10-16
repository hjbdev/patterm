import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../app/Services/DatabaseService';
import { verifyMinisign } from '../app/Services/Minisign';
import { SettingsService, type UpdateRecord, type UpdateSettings } from '../app/Services/SettingsService';
import { UpdateInstaller, updatePlan, type UpdatePlan } from '../app/Services/UpdateInstaller';
import { compareVersions, detectReleaseInstall, parseManifest, UpdateService, type ReleaseInstall, type UpdateApplier } from '../app/Services/UpdateService';
import { removeTree } from './fixtures/TempTree';

const fixtures = 'tests/fixtures/minisign';
const SHA = 'a'.repeat(64);

// Signs like minisign 0.11+ (prehashed "ED"), as in releaseInstallerSmoke.
function signer() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const id = crypto.randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return {
    publicKey: Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64'),
    sign(contents: Buffer, trusted: string) {
      const signature = crypto.sign(null, crypto.createHash('blake2b512').update(contents).digest(), privateKey);
      const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
      return `untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), id, signature]).toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`;
    }
  };
}

type Signer = ReturnType<typeof signer>;

function manifest(version: string, platforms = ['linux-x64', 'macos-arm64', 'windows-x64']): Buffer {
  const body: Record<string, unknown> = { version, prerelease: version.includes('-'), commit: '0'.repeat(40), published_at: '2026-10-14T00:00:00Z' };
  for (const platform of platforms) {
    body[platform] = `patterm-${version}-${platform}.${platform.startsWith('linux') ? 'tar.gz' : 'zip'}`;
    body[`${platform}-sha256`] = SHA;
  }
  return Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
}

// A fake GitHub: release assets by URL, plus the release listing.
class FakeReleases {
  readonly requests: string[] = [];
  readonly files = new Map<string, Buffer | string>();
  constructor(private readonly key: Signer) {}

  publish(version: string, { latest = true, trusted = `patterm ${version}`, tamper = false, platforms }: { latest?: boolean; trusted?: string; tamper?: boolean; platforms?: string[] } = {}) {
    const body = manifest(version, platforms);
    const signature = this.key.sign(tamper ? Buffer.from('other') : body, trusted);
    for (const base of [`https://releases.test/download/v${version}`, ...(latest ? ['https://releases.test/latest/download'] : [])]) {
      this.files.set(`${base}/manifest.json`, body);
      this.files.set(`${base}/manifest.json.minisig`, signature);
    }
  }

  list(tags: Array<{ tag_name: string; draft?: boolean }>) {
    this.files.set('https://api.test/releases?per_page=30', JSON.stringify(tags));
  }

  fetch: typeof fetch = async (input) => {
    const url = String(input);
    this.requests.push(url);
    const body = this.files.get(url);
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(typeof body === 'string' ? body : new Uint8Array(body));
  };
}

class MemorySettings {
  settings: UpdateSettings = { autoCheck: true, channel: 'stable' };
  record: UpdateRecord = { notifiedVersions: [], pending: null };
  updateSettings() { return this.settings; }
  saveUpdateSettings(input: unknown) { this.settings = input as UpdateSettings; return this.settings; }
  updateRecord() { return this.record; }
  saveUpdateRecord(record: UpdateRecord) { this.record = record; }
}

function install(version: string, key: Signer, platform: ReleaseInstall['platform'] = 'linux', arch = 'x64'): ReleaseInstall {
  return { platform, arch, root: '/opt/patterm/versions/' + version, version, publicKey: key.publicKey };
}

function service(options: { install: ReleaseInstall | null; releases: FakeReleases; settings?: MemorySettings; applier?: UpdateApplier | null }) {
  const notices: Array<{ version: string; canApply: boolean }> = [];
  let changes = 0;
  const settings = options.settings ?? new MemorySettings();
  const updates = new UpdateService({
    install: options.install,
    settings,
    applier: options.applier === undefined ? { unavailable: () => null, apply: async () => ({ quit: true, log: '/tmp/update.log' }) } : options.applier,
    restartDetail: () => 'Patterm quits.',
    notify: (release) => notices.push(release),
    changed: () => { changes++; },
    fetch: options.releases.fetch,
    releasesUrl: 'https://releases.test/',
    apiUrl: 'https://api.test/releases'
  });
  return { updates, notices, settings, changes: () => changes };
}

async function testMinisignPort(): Promise<void> {
  const key = fs.readFileSync(path.join(fixtures, 'test.pub'), 'utf8').trim().split('\n')[1]!;
  const body = fs.readFileSync(path.join(fixtures, 'manifest.json'));
  assert.equal(verifyMinisign(key, body, fs.readFileSync(path.join(fixtures, 'manifest.json.minisig'), 'utf8')), 'patterm 1.2.0');
  assert.equal(verifyMinisign(key, body, fs.readFileSync(path.join(fixtures, 'manifest.json.legacy.minisig'), 'utf8')), 'legacy');
  assert.throws(() => verifyMinisign(key, Buffer.from(body.toString().replace('1.2.0', '9.9.9')), fs.readFileSync(path.join(fixtures, 'manifest.json.minisig'), 'utf8')), /Signature verification failed/);
}

// Electron's crypto provider can omit BLAKE2 even when standalone Node has it.
async function testWithoutNativeBlake2(): Promise<void> {
  const key = signer();
  const releases = new FakeReleases(key);
  releases.publish('1.3.0');
  const createHash = crypto.createHash;
  const digest = mock.method(crypto, 'createHash', (algorithm: string, options?: crypto.HashOptions) => {
    if (algorithm === 'blake2b512') throw new Error('Digest method not supported');
    return createHash(algorithm, options);
  });
  try {
    await testMinisignPort();
    const state = await service({ install: install('1.2.0', key, 'windows'), releases }).updates.check();
    assert.equal(state.status, 'available', state.error ?? undefined);
    assert.equal(state.latest?.version, '1.3.0');
  } finally {
    digest.mock.restore();
  }
}

function testVersionOrder(): void {
  // Ascending, from semver.org item 11, plus multi-digit numbers.
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
  order.forEach((a, i) => order.forEach((b, j) => assert.equal(compareVersions(a, b), Math.sign(i - j), `${a} vs ${b}`)));
}

function testDetection(directory: string): void {
  const root = path.join(directory, 'versions', '1.2.0');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  assert.equal(detectReleaseInstall(root, 'linux', 'x64'), null, 'a source tree without BUILD does not update itself');
  fs.writeFileSync(path.join(root, 'BUILD'), 'version=1.2.0\ncommit=abc\n');
  assert.equal(detectReleaseInstall(root, 'linux', 'x64'), null, 'a package without its signing key does not update itself');
  fs.copyFileSync('scripts/release/minisign.pub', path.join(root, 'scripts', 'minisign.pub'));
  const detected = detectReleaseInstall(root, 'darwin', 'arm64');
  assert.deepEqual(detected && { ...detected, root: undefined }, {
    platform: 'macos', arch: 'arm64', root: undefined, version: '1.2.0',
    publicKey: fs.readFileSync('scripts/release/minisign.pub', 'utf8').trim().split('\n')[1]
  });
  assert.equal(detectReleaseInstall(undefined), null);
}

async function testChecks(): Promise<void> {
  const key = signer();
  const releases = new FakeReleases(key);
  releases.publish('1.3.0');

  // A source build never reaches the network.
  const source = service({ install: null, releases });
  assert.equal((await source.updates.check()).supported, false);
  assert.deepEqual(releases.requests, []);

  const run = service({ install: install('1.2.0', key), releases });
  const state = await run.updates.check();
  assert.equal(state.status, 'available');
  assert.equal(state.latest?.version, '1.3.0');
  assert.equal(state.latest?.notesUrl, 'https://releases.test/tag/v1.3.0');
  assert.equal(state.canApply, true);
  assert.deepEqual(run.notices, [{ version: '1.3.0', canApply: true }]);
  await run.updates.check();
  assert.equal(run.notices.length, 1, 'a release is announced once');
  // Or across restarts.
  const restarted = service({ install: install('1.2.0', key), releases, settings: run.settings });
  await restarted.updates.check();
  assert.equal(restarted.notices.length, 0);

  const current = service({ install: install('1.3.0', key), releases });
  assert.equal((await current.updates.check()).status, 'up_to_date');
  const newer = service({ install: install('1.4.0', key), releases });
  assert.equal((await newer.updates.check()).status, 'up_to_date', 'an older release is never offered');

  const missingPackage = service({ install: install('1.2.0', key, 'linux', 'arm64'), releases });
  const noPackage = await missingPackage.updates.check();
  assert.equal(noPackage.status, 'available');
  assert.equal(noPackage.canApply, false);
  assert.match(noPackage.applyUnavailable ?? '', /no package for linux-arm64/);

  const tampered = new FakeReleases(key);
  tampered.publish('1.3.0', { tamper: true });
  const rejected = await service({ install: install('1.2.0', key), releases: tampered }).updates.check();
  assert.equal(rejected.status, 'error');
  assert.match(rejected.error ?? '', /Signature verification failed/);

  const otherKey = await service({ install: install('1.2.0', signer()), releases }).updates.check();
  assert.match(otherKey.error ?? '', /different key/);

  const relabelled = new FakeReleases(key);
  relabelled.publish('1.3.0', { trusted: 'patterm 1.1.0' });
  assert.match((await service({ install: install('1.2.0', key), releases: relabelled }).updates.check()).error ?? '', /names a different version/);

  const offline = await service({ install: install('1.2.0', key), releases: new FakeReleases(key) }).updates.check();
  assert.equal(offline.status, 'error');
  assert.match(offline.error ?? '', /returned 404/);
}

// The updater reads what the release workflow's manifest script writes.
async function testReleaseManifest(directory: string): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  const sums = path.join(directory, 'sums');
  fs.mkdirSync(sums);
  const files = ['linux-x64.tar.gz', 'linux-arm64.tar.gz', 'macos-arm64.zip', 'macos-x64.zip', 'windows-x64.zip'].map((suffix, index) => {
    const file = path.join(sums, `patterm-1.3.0-${suffix}.sha256`);
    fs.writeFileSync(file, `${String(index).repeat(64)}  patterm-1.3.0-${suffix}\n`);
    return file;
  });
  const body = execFileSync(process.execPath, ['scripts/release/manifest.mjs', '1.3.0', 'b'.repeat(40), ...files]);
  const key = signer();
  const parsed = parseManifest(key.publicKey, body, key.sign(body, 'patterm 1.3.0'));
  assert.deepEqual(Object.keys(parsed.packages).sort(), ['linux-arm64', 'linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']);
  assert.deepEqual(parsed.packages['windows-x64'], { file: 'patterm-1.3.0-windows-x64.zip', sha256: '4'.repeat(64) });
  // install.sh reads the Linux entries with sed, one key per line.
  assert.match(body.toString(), /^  "linux-x64": "patterm-1\.3\.0-linux-x64\.tar\.gz",$/m);
  const wrong = path.join(sums, 'wrong.sha256');
  fs.writeFileSync(wrong, `${'0'.repeat(64)}  patterm-1.3.0-linux-x64.zip\n`);
  assert.throws(() => execFileSync(process.execPath, ['scripts/release/manifest.mjs', '1.3.0', 'b'.repeat(40), wrong], { stdio: 'pipe' }));
}

async function testPrereleaseChannel(): Promise<void> {
  const key = signer();
  const releases = new FakeReleases(key);
  releases.publish('1.3.0');
  releases.publish('1.4.0-beta.2', { latest: false });
  releases.publish('1.4.0-beta.10', { latest: false });
  releases.list([{ tag_name: 'v1.3.0' }, { tag_name: 'v1.4.0-beta.2' }, { tag_name: 'v1.4.0-beta.10' }, { tag_name: 'v9.0.0', draft: true }, { tag_name: 'nightly' }]);

  const run = service({ install: install('1.2.0', key), releases });
  assert.equal((await run.updates.check()).latest?.version, '1.3.0', 'stable skips prereleases');
  run.updates.updateSettings({ channel: 'prerelease' });
  const state = await run.updates.check();
  assert.equal(state.latest?.version, '1.4.0-beta.10');
  assert.equal(state.latest?.prerelease, true);
  assert.ok(releases.requests.includes('https://releases.test/download/v1.4.0-beta.10/manifest.json'));

  // Each release is announced once, even after switching channels and back.
  run.updates.updateSettings({ channel: 'stable' });
  await run.updates.check();
  assert.deepEqual(run.notices.map((notice) => notice.version), ['1.3.0', '1.4.0-beta.10']);

  // A check begun on the old channel never publishes after a switch.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowFetch = releases.fetch;
  const racing = service({ install: install('1.2.0', key), releases, settings: Object.assign(new MemorySettings(), { settings: { autoCheck: false, channel: 'prerelease' } }) });
  releases.fetch = async (input, init) => { await gate; return slowFetch(input, init); };
  const stale = racing.updates.check();
  racing.updates.updateSettings({ channel: 'stable' });
  const applying = racing.updates.apply('1.4.0-beta.10');
  release();
  await stale;
  await assert.rejects(applying, /1.3.0 is now the latest release/, 'a prerelease is never installed after opting out');
  assert.equal(racing.updates.state().latest?.version, '1.3.0');
  releases.fetch = slowFetch;

  // A listed tag whose manifest names another version is refused.
  const mismatched = new FakeReleases(key);
  mismatched.publish('1.3.0', { latest: false });
  mismatched.files.set('https://releases.test/download/v1.5.0/manifest.json', mismatched.files.get('https://releases.test/download/v1.3.0/manifest.json')!);
  mismatched.files.set('https://releases.test/download/v1.5.0/manifest.json.minisig', mismatched.files.get('https://releases.test/download/v1.3.0/manifest.json.minisig')!);
  mismatched.list([{ tag_name: 'v1.5.0' }]);
  const settings = new MemorySettings();
  settings.settings = { autoCheck: true, channel: 'prerelease' };
  assert.match((await service({ install: install('1.2.0', key), releases: mismatched, settings }).updates.check()).error ?? '', /is for 1.3.0, not 1.5.0/);
}

async function testApply(): Promise<void> {
  const key = signer();
  const releases = new FakeReleases(key);
  releases.publish('1.2.0');
  const applied: Array<{ version: string; sha256: string }> = [];
  const applier: UpdateApplier = { unavailable: () => null, apply: async (release) => { applied.push(release); return { quit: true, log: '/data/update.log' }; } };
  const run = service({ install: install('1.2.0', key), releases, applier });
  await assert.rejects(run.updates.apply('1.3.0'), /No update is available/, 'an install never starts without a fresh check finding one');
  assert.deepEqual(applied, []);

  releases.publish('1.3.0');
  // A release published after the owner confirmed one needs its own confirmation.
  releases.publish('1.4.0');
  await assert.rejects(run.updates.apply('1.3.0'), /1.4.0 is now the latest release/);
  assert.deepEqual(applied, []);
  releases.publish('1.3.0');
  const result = await run.updates.apply('1.3.0');
  assert.equal(result.quit, true);
  assert.equal(result.state.status, 'installing');
  assert.deepEqual(applied, [{ version: '1.3.0', sha256: SHA }]);
  assert.equal(run.settings.record.pending?.version, '1.3.0');
  assert.equal(run.settings.record.pending?.log, '/data/update.log');

  // The next launch confirms the update, or reports that it failed.
  const failed = service({ install: install('1.2.0', key), releases, settings: run.settings });
  assert.equal(failed.updates.state().status, 'error');
  assert.match(failed.updates.state().error ?? '', /1.3.0 was not installed. See \/data\/update.log/);
  assert.equal(run.settings.record.pending, null);
  run.settings.record = { ...run.settings.record, pending: { version: '1.3.0', from: '1.2.0', startedAt: '', log: '' } };
  const updated = service({ install: install('1.3.0', key), releases, settings: run.settings });
  assert.equal(updated.updates.state().status, 'idle');
  assert.equal(run.settings.record.pending, null);

  // The server's installer reports back only when it fails before restarting the service.
  const serverRun = (done: Promise<'finished' | 'lost'>) => service({
    install: install('1.2.0', key), releases,
    applier: { unavailable: () => null, apply: async () => ({ quit: false, log: 'journalctl', done }) }
  });
  // Losing the watch, as when the installer stops this service, is not a failure.
  const lost = serverRun(Promise.resolve('lost'));
  await lost.updates.apply('1.3.0');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lost.updates.state().status, 'installing');
  assert.equal(lost.settings.record.pending?.version, '1.3.0', 'the next launch still confirms the update');
  const finished = serverRun(Promise.resolve('finished'));
  await finished.updates.apply('1.3.0');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished.updates.state().status, 'idle');
  assert.equal(finished.settings.record.pending, null);
  // Nothing is written once the service is disposed.
  let failLater: (error: Error) => void = () => undefined;
  const disposed = serverRun(new Promise((_resolve, reject) => { failLater = reject; }));
  await disposed.updates.apply('1.3.0');
  disposed.updates.dispose();
  failLater(new Error('killed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed.settings.record.pending?.version, '1.3.0');
  let fail: (error: Error) => void = () => undefined;
  const server = serverRun(new Promise((_resolve, reject) => { fail = reject; }));
  assert.equal((await server.updates.apply('1.3.0')).quit, false);
  fail(new Error('the installer exited with 1'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.updates.state().status, 'error');
  assert.match(server.updates.state().error ?? '', /Could not install Patterm 1.3.0: the installer exited with 1/);
  assert.equal(server.settings.record.pending, null);

  const blocked = service({ install: install('1.2.0', key), releases, applier: { unavailable: () => 'Not here.', apply: async () => { throw new Error('unreachable'); } } });
  const blockedState = await blocked.updates.check();
  assert.equal(blockedState.canApply, false);
  assert.equal(blockedState.applyUnavailable, 'Not here.');
  await assert.rejects(blocked.updates.apply('1.3.0'), /Not here/);
}

function plan(input: Partial<Parameters<typeof updatePlan>[0]> & { install: ReleaseInstall }): UpdatePlan {
  const result = updatePlan({ mode: 'desktop', version: '1.3.0', sha256: SHA, pid: 42, logPath: '/data/update.log', env: { HOME: '/home/me' }, unit: 'patterm-update-1', ...input });
  assert.ok(!('unavailable' in result), JSON.stringify(result));
  return result;
}

// Paths use the host's separators, as the plans do on each platform.
function testPlans(): void {
  const key = signer();
  const home = path.resolve('/home/me/.local/share/patterm');
  const linux = { ...install('1.2.0', key), root: path.join(home, 'versions', '1.2.0') };
  const desktop = plan({ install: linux });
  assert.equal(desktop.command, path.join(linux.root, 'scripts', 'apply-update.sh'));
  assert.deepEqual(desktop.args, ['42', '/data/update.log', path.join(home, 'current', 'scripts', 'patterm.sh'), '--', path.join(linux.root, 'scripts', 'install-release.sh'), '--version', '1.3.0']);
  assert.equal(desktop.env.PATTERM_HOME, home);
  assert.equal(desktop.detached, true);

  assert.match((updatePlan({ install: linux, mode: 'server', version: '1.3.0', sha256: SHA, pid: 1, logPath: '', env: {}, unit: 'u' }) as { unavailable: string }).unavailable, /not running as the patterm service/);
  const server = plan({ install: linux, mode: 'server', env: { INVOCATION_ID: 'x', PATTERM_PORT: '9000', SECRET: 'no' } });
  assert.equal(server.command, 'systemd-run');
  assert.deepEqual(server.args, ['--user', '--quiet', '--unit=patterm-update-1', '--setenv=PATTERM_PORT=9000', `--setenv=PATTERM_HOME=${home}`, path.join(linux.root, 'scripts', 'install-release.sh'), '--version', '1.3.0', '--update']);
  assert.equal(server.detached, false);
  assert.equal(server.log, 'journalctl --user -u patterm-update-1');

  const unversioned = updatePlan({ install: { ...linux, root: path.resolve('/home/me/src/patterm') }, mode: 'desktop', version: '1.3.0', sha256: SHA, pid: 1, logPath: '', env: {}, unit: 'u' });
  assert.ok('unavailable' in unversioned);

  const applications = path.resolve('/Applications');
  const macRoot = path.join(applications, 'Patterm.app', 'Contents', 'Resources', 'app');
  const mac = plan({ install: { ...install('1.2.0', key, 'macos', 'arm64'), root: macRoot } });
  assert.equal(mac.command, '/bin/bash');
  assert.deepEqual(mac.args, [path.join(macRoot, 'scripts', 'apply-update.sh'), '42', '/data/update.log', path.join(applications, 'Patterm.app'), '--',
    '/bin/bash', path.join(macRoot, 'scripts', 'install-macos.sh'), '--version', '1.3.0', '--sha256', SHA]);
  assert.equal(mac.env.PATTERM_MAC_APPLICATIONS_DIR, applications);

  const windowsRoot = path.join('C:', 'Users', 'me', 'AppData', 'Local', 'Patterm', 'versions', '1.2.0');
  const windows = plan({ install: { ...install('1.2.0', key, 'windows'), root: windowsRoot } });
  assert.equal(windows.command, 'powershell.exe');
  assert.deepEqual(windows.args.slice(-12), ['-File', path.join(windowsRoot, 'scripts', 'apply-update.ps1'), '-WaitPid', '42', '-Log', '/data/update.log',
    '-InstallRoot', path.join('C:', 'Users', 'me', 'AppData', 'Local', 'Patterm'), '-Version', '1.3.0', '-Sha256', SHA]);
}

async function testInstaller(directory: string): Promise<void> {
  const key = signer();
  const root = path.join(directory, 'home', 'versions', '1.2.0');
  const spawned: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const fakeSpawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    spawned.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { unref: () => undefined });
    setImmediate(() => child.emit('spawn'));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  const installer = new UpdateInstaller({ install: { ...install('1.2.0', key), root }, mode: 'desktop', logPath: path.join(directory, 'logs', 'update.log'), spawn: fakeSpawn, pid: 7 });
  assert.match(installer.unavailable() ?? '', /no apply-update.sh/, 'an older package without the helper cannot update itself');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const file of ['apply-update.sh', 'install-release.sh']) fs.writeFileSync(path.join(root, 'scripts', file), '');
  assert.equal(installer.unavailable(), null);
  assert.deepEqual(await installer.apply({ version: '1.3.0', sha256: SHA }), { quit: true, log: path.join(directory, 'logs', 'update.log') });
  assert.equal(spawned[0]?.options.detached, true);
  assert.ok(fs.existsSync(path.join(directory, 'logs')), 'the log directory exists before the helper writes to it');
}

// A server watches its installer's unit, and losing the watch is not a failure.
async function testServerInstaller(directory: string): Promise<void> {
  const key = signer();
  const root = path.join(directory, 'server', 'versions', '1.2.0');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'install-release.sh'), '');
  const outcome = async (states: Array<{ code: number | null; stdout?: string }>) => {
    const calls: string[] = [];
    const fakeSpawn = ((command: string, args: readonly string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      const reply = command === 'systemd-run' ? { code: 0 } : states.shift() ?? { code: 1 };
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
      setImmediate(() => {
        if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout));
        child.emit('close', reply.code);
      });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const installer = new UpdateInstaller({ install: { ...install('1.2.0', key), root }, mode: 'server', logPath: '', env: { INVOCATION_ID: 'x' }, spawn: fakeSpawn, pollMs: 1, now: () => 5 });
    const result = await installer.apply({ version: '1.3.0', sha256: SHA });
    assert.equal(result.quit, false);
    assert.match(calls[0]!, /^systemd-run --user --quiet --unit=patterm-update-5 /);
    return result.done!.then((value) => value, (error: Error) => error.message);
  };
  const running = { code: 0, stdout: 'LoadState=loaded\nActiveState=active\nResult=success\n' };
  assert.equal(await outcome([running, { code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\nResult=success\n' }]), 'finished');
  assert.equal(await outcome([running, { code: null }]), 'lost', 'a watch killed with the service is not a failure');
  assert.match(await outcome([running, { code: 0, stdout: 'LoadState=loaded\nActiveState=failed\nResult=exit-code\n' }]), /the installer ended with exit-code; see journalctl --user -u patterm-update-5/);
}

// The helper waits for the app to quit, installs, and opens it again.
async function testHelperScript(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const { spawn, spawnSync } = await import('node:child_process');
  const marker = path.join(directory, 'helper');
  fs.mkdirSync(marker);
  const app = spawn('sleep', ['30']);
  const launcher = path.join(marker, 'launcher.sh');
  fs.writeFileSync(launcher, `#!/bin/sh\necho launched > ${JSON.stringify(path.join(marker, 'launched'))}\n`, { mode: 0o755 });
  const installer = path.join(marker, 'installer.sh');
  fs.writeFileSync(installer, `#!/bin/sh\n[ -e ${JSON.stringify(path.join(marker, 'quit'))} ] || exit 9\necho "$@" > ${JSON.stringify(path.join(marker, 'installed'))}\nexit 3\n`, { mode: 0o755 });
  const log = path.join(marker, 'logs', 'update.log');
  const helper = spawn('scripts/release/apply-update.sh', [String(app.pid), log, launcher, '--', installer, '--version', '1.3.0'], { stdio: 'ignore' });
  const exited = new Promise<number | null>((resolve) => helper.once('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(fs.existsSync(path.join(marker, 'installed')), false, 'the installer waits for the app to quit');
  fs.writeFileSync(path.join(marker, 'quit'), '');
  app.kill();
  assert.equal(await exited, 3, 'the helper exits with the installer status');
  assert.equal(fs.readFileSync(path.join(marker, 'installed'), 'utf8').trim(), '--version 1.3.0');
  for (let tries = 0; tries < 50 && !fs.existsSync(path.join(marker, 'launched')); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(path.join(marker, 'launched')), 'Patterm opens again even when the install failed');
  assert.match(fs.readFileSync(log, 'utf8'), /installer exited with 3/);
  assert.equal(spawnSync('bash', ['-n', 'scripts/release/apply-update.sh']).status, 0);
}

function testSettingsDefaults(directory: string): void {
  const database = new DatabaseService(path.join(directory, 'db'));
  try {
    database.initialize();
    const settings = new SettingsService(database);
    assert.deepEqual(settings.updateSettings(), { autoCheck: true, channel: 'stable' }, 'update checks are on by default');
    assert.throws(() => settings.saveUpdateSettings({ autoCheck: true, channel: 'nightly' }));
    settings.saveUpdateSettings({ autoCheck: false });
    assert.deepEqual(settings.updateSettings(), { autoCheck: false, channel: 'stable' });
    assert.deepEqual(settings.updateRecord(), { notifiedVersions: [], pending: null });
  } finally {
    database.dispose();
  }
}

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-update-test-'));
  try {
    await testMinisignPort();
    await testWithoutNativeBlake2();
    testVersionOrder();
    testDetection(directory);
    await testChecks();
    await testReleaseManifest(directory);
    await testPrereleaseChannel();
    await testApply();
    testPlans();
    await testInstaller(directory);
    await testServerInstaller(directory);
    await testHelperScript(directory);
    testSettingsDefaults(directory);
    console.log('update smoke passed');
  } finally {
    removeTree(directory);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
