import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readEnvironment, renderService, validateOrigin } from '../scripts/install-service.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const linuxOnly = process.platform === 'win32' && 'it drives systemd units and POSIX paths, which Windows does not have';

test('installer validates origins before writing configuration', () => {
  assert.equal(validateOrigin('https://patterm.example.ts.net', 8787), 'https://patterm.example.ts.net');
  assert.equal(validateOrigin('http://localhost:8787', 8787), 'http://localhost:8787');
  for (const origin of ['', 'https://example.com', 'http://patterm.example.ts.net', 'https://patterm.example.ts.net/path', 'https://user:password@patterm.example.ts.net', 'http://localhost:8788', 'http://localhost:8787\n[Service]']) {
    assert.throws(() => validateOrigin(origin, 8787), origin);
  }
});

test('unit preserves spaces, quotes, dollar signs, and percent signs without expansion', { skip: linuxOnly }, () => {
  const { unit, terminalUnit, config } = renderService({
    root: '/tmp/project with %n and $HOME', node: '/usr/bin/node', envFile: '/tmp/config %n/patterm.env',
    environment: { PATTERM_DATA_DIR: '/tmp/"quoted" %n $HOME `command` \\ data' }
  });
  assert.ok(unit.includes('WorkingDirectory=/tmp/project with %%n and $HOME\n'));
  assert.ok(unit.includes('EnvironmentFile=/tmp/config %%n/patterm.env\n'));
  assert.ok(unit.includes('ExecStart="/usr/bin/node" "/tmp/project with %%n and $$HOME/dist/server/server/main.js"\n'));
  assert.ok(terminalUnit.includes('WorkingDirectory=/tmp/"quoted" %%n $HOME `command` \\ data/terminal-hosts/%i\n'));
  assert.ok(terminalUnit.includes(' --host-id %i\n'));
  assert.ok(terminalUnit.includes('%%n $$HOME `command`'));
  assert.ok(terminalUnit.includes('/terminal-hosts/%i/terminal-core" --socket '));
  assert.equal(config, 'PATTERM_DATA_DIR="/tmp/\\"quoted\\" %n \\$HOME \\`command\\` \\\\ data"\n');
  assert.deepEqual(readEnvironment(config), { PATTERM_DATA_DIR: '/tmp/"quoted" %n $HOME `command` \\ data' });
  for (const unsupported of ['X=unquoted', 'X="a"\nX="b"', 'X="unterminated', 'X="a\\nb"', 'X="a"\n[Service]']) assert.throws(() => readEnvironment(unsupported));
  assert.throws(() => renderService({ root: '/tmp/project\nExecStart=/bad', node: '/usr/bin/node', envFile: '/tmp/config', environment: {} }));
});

test('preview writes only private files in the requested directory and produces a valid unit', { skip: linuxOnly }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm install % '));
  try {
    const output = path.join(directory, 'preview');
    const data = path.join(directory, 'data');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/install-service.mjs'), '--public-origin', 'http://localhost:8787', '--data-dir', data, '--output-dir', output], {
      encoding: 'utf8', env: { ...process.env, PATTERM_PORT: '8787', XDG_CONFIG_HOME: path.join(directory, 'untouched') }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(directory, 'untouched')), false);
    assert.deepEqual(fs.readdirSync(output).sort(), ['patterm-terminal@.service', 'patterm.env', 'patterm.service']);
    for (const name of fs.readdirSync(output)) assert.equal(fs.statSync(path.join(output, name)).mode & 0o777, 0o600);
    const unit = fs.readFileSync(path.join(output, 'patterm.service'), 'utf8');
    for (const directive of ['Restart=on-failure', 'KillMode=control-group', 'TimeoutStopSec=25', 'WantedBy=default.target']) assert.ok(unit.includes(directive));
    const verification = spawnSync('systemd-analyze', ['--user', 'verify', path.join(output, 'patterm.service')], { encoding: 'utf8' });
    if (verification.error?.code !== 'ENOENT') assert.equal(verification.status, 0, verification.stderr);
    const terminalUnit = fs.readFileSync(path.join(output, 'patterm-terminal@.service'), 'utf8');
    for (const directive of ['KillMode=control-group', 'TimeoutStopSec=25', 'UMask=0077']) assert.ok(terminalUnit.includes(directive));
    assert.doesNotMatch(terminalUnit, /^(PartOf|BindsTo|Requires|WantedBy|Restart)=/m);
    assert.match(fs.readFileSync(path.join(output, 'patterm.env'), 'utf8'), /^PATTERM_TERMINAL_SERVICE="patterm-terminal"$/m);
    assert.doesNotMatch(fs.readFileSync(path.join(output, 'patterm.env'), 'utf8'), /PATTERM_OWNER_LOGIN/);
    const owned = path.join(directory, 'owned');
    const ownedResult = spawnSync(process.execPath, [path.join(root, 'scripts/install-service.mjs'), '--public-origin', 'http://localhost:8787', '--owner-login', 'owner@example.com', '--data-dir', data, '--output-dir', owned], {
      encoding: 'utf8', env: { ...process.env, PATTERM_PORT: '8787' }
    });
    assert.equal(ownedResult.status, 0, ownedResult.stderr);
    assert.match(fs.readFileSync(path.join(owned, 'patterm.env'), 'utf8'), /^PATTERM_OWNER_LOGIN="owner@example.com"$/m);
    const badOwner = spawnSync(process.execPath, [path.join(root, 'scripts/install-service.mjs'), '--public-origin', 'http://localhost:8787', '--owner-login', 'two words', '--data-dir', data, '--output-dir', path.join(directory, 'bad-owner')], { encoding: 'utf8', env: { ...process.env, PATTERM_PORT: '8787' } });
    assert.notEqual(badOwner.status, 0);
    assert.match(badOwner.stderr, /Tailscale login name/);
    const hostDirectory = path.join(data, 'terminal-hosts/smoke');
    fs.mkdirSync(hostDirectory, { recursive: true });
    fs.writeFileSync(path.join(hostDirectory, 'terminal-core'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const instance = path.join(output, 'patterm-terminal@smoke.service');
    fs.writeFileSync(instance, terminalUnit);
    const terminalVerification = spawnSync('systemd-analyze', ['--user', 'verify', instance], { encoding: 'utf8' });
    if (terminalVerification.error?.code !== 'ENOENT') assert.equal(terminalVerification.status, 0, terminalVerification.stderr);
    const rejected = spawnSync(process.execPath, [path.join(root, 'scripts/install-service.mjs'), '--public-origin', 'https://example.com', '--output-dir', path.join(directory, 'rejected')], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.equal(fs.existsSync(path.join(directory, 'rejected')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('service updates preserve installed settings and preview does not change live configuration', { skip: linuxOnly }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-service-update-'));
  try {
    const configHome = path.join(directory, 'config');
    fs.mkdirSync(path.join(configHome, 'patterm'), { recursive: true });
    const previous = { PATTERM_PORT: '9797', PATTERM_PUBLIC_ORIGIN: 'http://localhost:9797', PATTERM_DATA_DIR: path.join(directory, 'data % " $'), PATH: '/kept/bin', CUSTOM_SETTING: 'retained' };
    const config = renderService({ root, node: process.execPath, envFile: '/tmp/config', environment: previous }).config;
    const envFile = path.join(configHome, 'patterm/patterm.env');
    fs.writeFileSync(envFile, config);
    const output = path.join(directory, 'preview');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/install-service.mjs'), '--update', '--output-dir', output], {
      encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: configHome, PATTERM_PORT: '8787' }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(envFile, 'utf8'), config);
    const updated = readEnvironment(fs.readFileSync(path.join(output, 'patterm.env'), 'utf8'));
    for (const [key, value] of Object.entries(previous)) assert.equal(updated[key], value);
    assert.equal(updated.PATTERM_TERMINAL_SERVICE, 'patterm-terminal');
    const rejected = spawnSync(process.execPath, [path.join(root, 'scripts/install-service.mjs'), '--update', '--data-dir', path.join(root, 'data'), '--output-dir', path.join(directory, 'rejected')], {
      encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: configHome }
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /An update cannot change PATTERM_DATA_DIR/);
    assert.equal(fs.existsSync(path.join(directory, 'rejected')), false);
    const unsafe = spawnSync(process.execPath, [path.join(root, 'scripts/install-service.mjs'), '--public-origin', 'http://localhost:8787', '--data-dir', path.join(root, 'data'), '--output-dir', path.join(directory, 'unsafe')], {
      encoding: 'utf8', env: { ...process.env, PATTERM_PORT: '8787' }
    });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /outside the application installation/);
    assert.equal(fs.existsSync(path.join(directory, 'unsafe')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a release install names its bundled Node and files through the current symlink', { skip: linuxOnly }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-release-service-'));
  try {
    const home = path.join(directory, 'home');
    const version = path.join(home, '.local/share/patterm/versions/1.2.0');
    for (const file of ['scripts/install-service.mjs', 'deploy/patterm.service', 'deploy/patterm-terminal@.service']) {
      fs.mkdirSync(path.dirname(path.join(version, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(version, file));
    }
    fs.mkdirSync(path.join(version, 'runtime'));
    fs.copyFileSync(process.execPath, path.join(version, 'runtime/node'));
    fs.chmodSync(path.join(version, 'runtime/node'), 0o755);
    fs.symlinkSync('versions/1.2.0', path.join(home, '.local/share/patterm/current'));
    const run = (data, output) => spawnSync(path.join(home, '.local/share/patterm/current/runtime/node'), [path.join(home, '.local/share/patterm/current/scripts/install-service.mjs'), '--public-origin', 'http://localhost:8787', '--data-dir', data, '--output-dir', output], {
      encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin', PATTERM_PORT: '8787' }
    });
    const output = path.join(directory, 'preview');
    const result = run(path.join(directory, 'data'), output);
    assert.equal(result.status, 0, result.stderr);
    const current = path.join(home, '.local/share/patterm/current');
    const unit = fs.readFileSync(path.join(output, 'patterm.service'), 'utf8');
    assert.ok(unit.includes(`WorkingDirectory=${current}\n`));
    assert.ok(unit.includes(`ExecStart="${current}/runtime/node" "${current}/dist/server/server/main.js"\n`));
    const environment = readEnvironment(fs.readFileSync(path.join(output, 'patterm.env'), 'utf8'));
    assert.equal(environment.PATTERM_NODE, `${current}/runtime/node`);
    assert.equal(environment.PATTERM_SIDECAR, `${current}/native/terminal-core/target/release/patterm-terminal-core`);
    assert.equal(environment.PATTERM_MCP_SHIM, `${current}/dist/mcp/patterm-mcp.js`);
    assert.equal(environment.PATH, '/usr/bin:/bin', 'the bundled Node stays off PATH');
    const inside = run(path.join(home, '.local/share/patterm/data'), path.join(directory, 'inside'));
    assert.notEqual(inside.status, 0);
    assert.match(inside.stderr, /outside the application installation/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the installer chooses Remote access and sets the password the server reads', { skip: linuxOnly }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-access-'));
  try {
    const data = path.join(directory, 'data');
    const install = (args, input) => spawnSync(process.execPath, [path.join(root, 'scripts/install-service.mjs'), '--data-dir', data, '--output-dir', path.join(directory, 'preview'), ...args], {
      // Agent shells inherit the live service's origin; leave it out.
      encoding: 'utf8', input, env: { ...process.env, PATTERM_PUBLIC_ORIGIN: '', PUBLIC_ORIGIN: '', PATTERM_PORT: '8787', XDG_CONFIG_HOME: path.join(directory, 'untouched') }
    });
    const access = () => JSON.parse(fs.readFileSync(path.join(directory, 'preview', 'server-access.json'), 'utf8'));
    let result = install(['--remote-access', 'tailscale', '--owner-login', 'owner@example.com']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(access().remote, { mode: 'tailscale', bind: null, owner_login: 'owner@example.com' });
    assert.equal(access().password, null);
    assert.match(fs.readFileSync(path.join(directory, 'preview', 'patterm.env'), 'utf8'), /^PATTERM_PUBLIC_ORIGIN="http:\/\/localhost:8787"$/m, 'the server works out its origin from the setting');
    assert.equal(fs.statSync(path.join(directory, 'preview', 'server-access.json')).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(data), false, 'a preview leaves the data directory alone');
    result = install(['--remote-access', 'network']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /needs --bind/);
    result = install(['--remote-access', 'network', '--bind', '203.0.113.7'], '');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not an address of this machine/);
    const address = Object.values(os.networkInterfaces()).flat().find((entry) => entry && !entry.internal && entry.family === 'IPv4')?.address;
    if (address) {
      result = install(['--remote-access', 'network', '--bind', address], '');
      assert.notEqual(result.status, 0, 'network access needs a password');
      result = install(['--remote-access', 'network', '--bind', address, '--password-stdin'], 'short\n');
      assert.match(result.stderr, /at least 8 characters/);
      result = install(['--remote-access', 'network', '--bind', address, '--password-stdin'], 'correct horse\n');
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(access().remote, { mode: 'network', bind: address, owner_login: null });
      assert.match(access().password, /^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
      assert.doesNotMatch(fs.readFileSync(path.join(directory, 'preview', 'server-access.json'), 'utf8'), /correct horse/);
    }
    assert.match(install(['--remote-access', 'anywhere']).stderr, /local, tailscale, or network/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
