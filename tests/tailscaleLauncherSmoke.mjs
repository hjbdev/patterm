import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkServe, tailscaleOrigin, tailscaleOwner } from '../scripts/start-tailscale-service.mjs';

const linuxOnly = process.platform === 'win32' && 'it runs the Tailscale launcher against a fake systemctl, which Windows does not have';
const origin = 'https://patterm.tail123.ts.net';
const endpoint = 'patterm.tail123.ts.net:443';
const route = { TCP: { 443: { HTTPS: true } }, Web: { [endpoint]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } } } } };

test('Tailscale discovery and route checks reject unsafe or conflicting configuration', () => {
  assert.equal(tailscaleOrigin({ BackendState: 'Running', Self: { DNSName: 'patterm.tail123.ts.net.' } }), origin);
  assert.throws(() => tailscaleOrigin({ BackendState: 'Stopped' }));
  assert.throws(() => tailscaleOrigin({ BackendState: 'Running', Self: { DNSName: 'example.com' } }));
  assert.equal(tailscaleOwner({ Self: { UserID: 42 }, User: { 42: { LoginName: 'owner@example.com' } } }), 'owner@example.com');
  assert.equal(tailscaleOwner({ Self: { UserID: 7 }, User: { 7: { LoginName: 'tagged-devices' } } }), null);
  assert.equal(tailscaleOwner({ Self: {} }), null);
  assert.equal(checkServe({}, origin, 8787), false);
  assert.equal(checkServe(route, origin, 8787), true);
  assert.throws(() => checkServe(route, origin, 9999), /another route/);
  const otherApps = { TCP: { 443: { HTTPS: true } }, Web: { [endpoint]: { Handlers: { '/roundup': { Proxy: 'http://127.0.0.1:3000' } } } } };
  assert.equal(checkServe(otherApps, origin, 8787), false, 'other apps\' paths on port 443 are left alone');
  assert.throws(() => checkServe({ ...route, AllowFunnel: { [endpoint]: true } }, origin, 8787), /Funnel/);
  assert.throws(() => checkServe({ TCP: { 443: { TCPForward: 'localhost:22' } } }, origin, 8787), /another route/);
  assert.throws(() => checkServe({ Foreground: { session: route } }, origin, 8787), /foreground/);
});

test('Tailscale launcher prepares a fresh service, preserves settings, and avoids live restarts', { skip: linuxOnly }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-tailscale-'));
  try {
    for (const dir of ['scripts', 'deploy', 'bin', 'config/patterm', 'dist/server/server', 'dist/renderer', 'dist/mcp', 'native/terminal-core/target/release']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    for (const file of ['scripts/start-tailscale-service.mjs', 'scripts/install-service.mjs', 'deploy/patterm.service', 'deploy/patterm-terminal@.service']) fs.copyFileSync(file, path.join(root, file));
    for (const file of ['dist/server/server/main.js', 'dist/renderer/index.html', 'dist/mcp/patterm-mcp.js', 'native/terminal-core/target/release/patterm-terminal-core']) fs.writeFileSync(path.join(root, file), '', { mode: 0o755 });
    const stub = `#!${process.execPath}
const args = process.argv.slice(2).join(' ');
const tool = process.argv[1].split('/').pop();
const fs = require('node:fs');
fs.appendFileSync(process.env.CALLS, tool + ' ' + args + '\\n');
if (tool === 'tailscale') {
  if (args === 'status --json') console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'patterm.tail123.ts.net.'}}));
  else if (args === 'serve status --json') console.log(process.env.SERVE_CONFIG || '{}');
  else if (process.env.SERVE_FAIL) process.exit(1);
} else if (args.includes('LoadState')) console.log(process.env.LOAD_STATE || 'loaded');
else if (args.includes('ActiveState')) console.log(process.env.ACTIVE_STATE || 'inactive');
else if (args.includes('is-active')) process.exit(process.env.ACTIVE_STATE === 'active' ? 0 : 3);
`;
    for (const tool of ['tailscale', 'systemctl']) fs.writeFileSync(path.join(root, 'bin', tool), stub, { mode: 0o755 });
    const envFile = path.join(root, 'config/patterm/patterm.env');
    const before = 'PATTERM_PORT="8787"\nPATTERM_PUBLIC_ORIGIN="http://localhost:8787"\nPATTERM_DATA_DIR="/keep/my/data"\n';
    const run = (extra = {}) => {
      let config = extra.CONFIG_ORIGIN ? before.replace('http://localhost:8787', extra.CONFIG_ORIGIN) : before;
      if (extra.CONFIG_DATA) config = config.replace('/keep/my/data', extra.CONFIG_DATA);
      fs.writeFileSync(envFile, config);
      fs.writeFileSync(path.join(root, 'calls'), '');
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/start-tailscale-service.mjs')], {
        encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'),
          PATH: `${root}/bin:${process.env.PATH}`, CALLS: path.join(root, 'calls'), PATTERM_PORT: '8787',
          // Never the live data directory that agent shells inherit.
          PATTERM_DATA_DIR: `${root}-data`, ...extra },
      });
      return { ...result, calls: fs.readFileSync(path.join(root, 'calls'), 'utf8'), config: fs.readFileSync(envFile, 'utf8') };
    };
    let result = run();
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.equal(result.config, before.replace('http://localhost:8787', origin));
    assert.match(result.calls, /systemctl --user start patterm.service/);
    assert.match(result.calls, /tailscale serve --bg --https=443 --set-path=\/ http:\/\/127.0.0.1:8787/);
    assert.doesNotMatch(result.calls, /restart|sudo|funnel|reset/);
    result = run({ ACTIVE_STATE: 'active' });
    assert.equal(result.status, 1);
    assert.equal(result.config, before);
    assert.doesNotMatch(result.calls, /--user start|serve --bg/);
    result = run({ SERVE_CONFIG: JSON.stringify({ TCP: { 443: { TCPForward: 'localhost:22' } } }) });
    assert.equal(result.status, 1);
    assert.equal(result.config, before);
    assert.doesNotMatch(result.calls, /--user start|serve --bg/);
    result = run({ SERVE_CONFIG: JSON.stringify(route) });
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.doesNotMatch(result.calls, /serve --bg/);
    result = run({ CONFIG_ORIGIN: origin, ACTIVE_STATE: 'active', SERVE_CONFIG: JSON.stringify(route) });
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.doesNotMatch(result.calls, /ActiveState|serve --bg|restart/);
    result = run({ LOAD_STATE: 'not-found' });
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.match(result.config, /PATTERM_PUBLIC_ORIGIN="https:\/\/patterm.tail123.ts.net"/);
    assert.match(result.calls, /daemon-reload/);
    const access = JSON.parse(fs.readFileSync(path.join(`${root}-data`, 'server-access.json'), 'utf8'));
    assert.deepEqual(access.remote, { mode: 'tailscale', bind: null, owner_login: null }, 'a fresh install chooses Tailscale access');
    assert.equal(fs.statSync(path.join(`${root}-data`, 'server-access.json')).mode & 0o777, 0o600);
    assert.ok(fs.existsSync(path.join(root, 'config/systemd/user/patterm.service')));
    // An install whose saved setting names another mode switches to Tailscale,
    // but only while it is stopped.
    const data = `${root}-data`;
    fs.writeFileSync(path.join(data, 'server-access.json'), JSON.stringify({ version: 1, password: null, secret: 'x'.repeat(43), remote: { mode: 'local', bind: null, owner_login: null } }), { mode: 0o600 });
    result = run({ CONFIG_DATA: data, ACTIVE_STATE: 'active' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /set to this machine only access/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'server-access.json'), 'utf8')).remote.mode, 'local', 'a running server\'s setting is left alone');
    result = run({ CONFIG_DATA: data });
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'server-access.json'), 'utf8')).remote.mode, 'tailscale');
    assert.match(result.config, /PATTERM_PUBLIC_ORIGIN="https:\/\/patterm.tail123.ts.net"/);
    result = run({ SERVE_FAIL: '1' });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Patterm: https/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}-data`, { recursive: true, force: true });
  }
});
