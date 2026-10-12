import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApplication } from '../app/App';
import { WebServer } from '../app/Http/WebServer';
import { ServerAccess } from '../app/Http/ServerAccess';
import { applyTailscaleRoute, machineAddresses, planRemoteAccess } from '../app/Http/RemoteAccessPlan';
import { TailscaleService } from '../app/Services/TailscaleService';
import { acquireApplicationLock } from '../app/Runtime/ApplicationLock';
import { randomId } from '../resources/js/lib/randomId';
import { debugSidecarPath } from './fixtures/Sidecar';
import { removeTree } from './fixtures/TempTree';

const HOST = 'patterm.tail123.ts.net';
const STATUS = JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.`, UserID: 1 }, User: { 1: { LoginName: 'owner@example.com' } } });

// A fake tailscale CLI: never the real one, so tests cannot change routes.
function fakeTailscale(config: Record<string, unknown> = {}, status: string | null = STATUS) {
  const calls: string[][] = [];
  const service = new TailscaleService(async (args) => {
    calls.push(args);
    if (args[0] === 'status') {
      if (!status) throw new Error('tailscale: not running');
      return status;
    }
    if (args.join(' ') === 'serve status --json') return JSON.stringify(config);
    return '';
  });
  return { service, calls, writes: () => calls.filter((args) => args[0] === 'serve' && args[1] !== 'status') };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function main(): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-remote-access-'));
  try {
    // Tailscale Serve: only Patterm's root route is added or removed.
    const route = { TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } } } } };
    const others = { TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/roundup': { Proxy: 'http://127.0.0.1:3000' } } } } };
    let tailscale = fakeTailscale(others);
    assert.equal(await tailscale.service.ensureRoute(HOST, 8787), 'added');
    assert.deepEqual(tailscale.writes(), [['serve', '--bg', '--https=443', '--set-path=/', 'http://127.0.0.1:8787']], 'other apps\' paths are left alone');
    tailscale = fakeTailscale(route);
    assert.equal(await tailscale.service.ensureRoute(HOST, 8787), 'present');
    assert.deepEqual(tailscale.writes(), []);
    await assert.rejects(fakeTailscale(route).service.ensureRoute(HOST, 9999), /serves something else/);
    await assert.rejects(fakeTailscale({ ...route, AllowFunnel: { [`${HOST}:443`]: true } }).service.ensureRoute(HOST, 8787), /Funnel/);
    await assert.rejects(fakeTailscale({ TCP: { 443: { TCPForward: 'localhost:22' } } }).service.ensureRoute(HOST, 8787), /serves something else/);
    tailscale = fakeTailscale(route);
    assert.equal(await tailscale.service.removeRoute(HOST, 9999), false, 'another server\'s route is not removed');
    assert.equal(await tailscale.service.removeRoute(HOST, 8787), true);
    assert.deepEqual(tailscale.writes(), [['serve', '--https=443', '--set-path=/', 'off']]);
    assert.deepEqual(await fakeTailscale().service.state(), { hostname: HOST, ownerLogin: 'owner@example.com' });

    // Planning changes nothing; the route is applied once the lock is held.
    const plan = (input: Partial<Parameters<typeof planRemoteAccess>[0]>) => planRemoteAccess({ access: null, passwordSet: false, port: 8787, tailscale: fakeTailscale().service, addresses: () => ['192.0.2.10'], ...input });
    assert.deepEqual(await plan({}), { mode: 'local', origin: 'http://localhost:8787', listen: [], ownerLogin: null, route: null, warnings: [] }, 'a fresh server is open to this machine only');
    assert.deepEqual(await plan({ envOrigin: `https://${HOST}`, envOwnerLogin: 'owner@example.com' }), {
      mode: 'tailscale', origin: `https://${HOST}`, listen: [], ownerLogin: 'owner@example.com', route: null, warnings: []
    }, 'a server set up before the setting keeps its origin and its own Serve configuration');
    assert.equal((await plan({ envOrigin: `https://${HOST}`, tailscale: fakeTailscale({}, null).service })).origin, `https://${HOST}`, 'it keeps its origin while Tailscale is down');
    assert.equal((await plan({ envOrigin: 'https://review.tail123.ts.net:8443' })).origin, 'https://review.tail123.ts.net:8443', 'its origin is kept exactly, port and hostname too');
    const chosen = await plan({ access: { mode: 'tailscale', bind: null, owner_login: null } });
    assert.deepEqual(chosen.route, { action: 'ensure', hostname: HOST });
    const down = await plan({ access: { mode: 'tailscale', bind: null, owner_login: null }, tailscale: fakeTailscale({}, null).service });
    assert.equal(down.mode, 'local');
    assert.match(down.warnings[0]!, /Tailscale access is off: tailscale: not running/);
    assert.match((await plan({ access: { mode: 'network', bind: '192.0.2.10', owner_login: null } })).warnings[0]!, /no password/);
    assert.match((await plan({ access: { mode: 'network', bind: '192.0.2.99', owner_login: null }, passwordSet: true })).warnings[0]!, /no longer has the address/);
    assert.deepEqual(await plan({ access: { mode: 'network', bind: '192.0.2.10', owner_login: null }, passwordSet: true }), {
      mode: 'network', origin: 'http://192.0.2.10:8787', listen: ['192.0.2.10'], ownerLogin: null, route: { action: 'remove', hostname: HOST }, warnings: []
    }, 'leaving Tailscale removes Patterm\'s route');
    tailscale = fakeTailscale({ AllowFunnel: { [`${HOST}:443`]: true } });
    const funnel = await plan({ access: { mode: 'tailscale', bind: null, owner_login: null }, tailscale: tailscale.service });
    await applyTailscaleRoute(funnel, 8787, tailscale.service);
    assert.match(funnel.warnings[0]!, /Funnel/, 'a route that cannot be added becomes a warning');
    assert.deepEqual(tailscale.writes(), []);

    // install-service.mjs writes systemd units, so it only runs on Linux.
    if (process.platform !== 'win32') {
      // The installer writes the same password format the server reads.
      const preview = path.join(temp, 'preview');
      const installed = spawnSync(process.execPath, [path.resolve('scripts/install-service.mjs'), '--data-dir', path.join(temp, 'data'), '--output-dir', preview, '--remote-access', 'local', '--password-stdin'], {
        encoding: 'utf8', input: 'correct horse\n', env: { ...process.env, PATTERM_PUBLIC_ORIGIN: '', PUBLIC_ORIGIN: '', PATTERM_PORT: '8787', XDG_CONFIG_HOME: path.join(temp, 'config') }
      });
      assert.equal(installed.status, 0, installed.stderr);
      const fromInstaller = new ServerAccess(path.join(preview, 'server-access.json'));
      assert.equal(fromInstaller.remoteAccess()?.mode, 'local');
      assert.ok(await fromInstaller.signIn('correct horse'), 'a password set by the installer signs in');
      assert.equal(await fromInstaller.signIn('wrong horse'), null);
      // The installer changes the file only while no server holds the runtime lock.
      const lockedData = path.join(temp, 'locked');
      const releaseLocked = acquireApplicationLock(lockedData);
      const locked = spawnSync(process.execPath, [path.resolve('scripts/install-service.mjs'), '--data-dir', lockedData, '--remote-access', 'local'], {
        encoding: 'utf8', env: { ...process.env, PATTERM_PUBLIC_ORIGIN: '', PUBLIC_ORIGIN: '', PATTERM_PORT: '8787', XDG_CONFIG_HOME: path.join(temp, 'config') }
      });
      releaseLocked();
      assert.notEqual(locked.status, 0);
      assert.match(locked.stderr, /Patterm is using this data directory/);
      assert.equal(fs.existsSync(path.join(lockedData, 'server-access.json')), false);
    }

    // Pages served over plain HTTP have no crypto.randomUUID.
    const secure = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(crypto), 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      assert.match(randomId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
    assert.ok(secure && typeof crypto.randomUUID === 'function');

    // The server: Settings › Remote access reads and saves the setting, and
    // network mode listens on a second address.
    const appDataPath = path.join(temp, 'app');
    acquireApplicationLock(appDataPath)();
    const app = await createApplication({
      appDataPath, runtime: 'node',
      sidecarPath: debugSidecarPath(),
      mcpShimPath: path.resolve('dist/mcp/patterm-mcp.js')
    });
    const port = await freePort();
    const origin = `http://127.0.0.2:${port}`;
    let restarts = 0;
    const server = new WebServer(app, {
      port, publicOrigin: origin, rendererPath: temp, appDataPath, listen: ['127.0.0.2'], tailscale: fakeTailscale().service,
      remoteAccess: { mode: 'network', warnings: [] }, restart: () => { restarts++; }
    });
    try {
      await server.start();
      const get = (host: string, route: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        http.get({ host, port, path: route, headers: { Host: `${host}:${port}` } }, (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        }).on('error', reject);
      });
      assert.equal((await get('127.0.0.2', '/health')).status, 200, 'the network address answers');
      assert.equal((await get('127.0.0.1', '/health')).status, 200, 'loopback still answers');
      const view = JSON.parse((await get('127.0.0.1', '/api/access/remote')).body) as { saved: unknown; running: { mode: string; origin: string }; tailscale: { hostname: string }; can_restart: boolean };
      assert.deepEqual(view.saved, null);
      assert.deepEqual(view.running, { mode: 'network', origin, warnings: [] });
      assert.equal(view.tailscale.hostname, HOST);
      assert.equal(view.can_restart, true);
      const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/access/remote`, {
        method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      // The addresses the server offers, which leave out IPv6 link-local ones
      // (Windows often lists those first).
      const address = machineAddresses()[0];
      if (address) {
        const refused = await post({ mode: 'network', bind: address, owner_login: null });
        assert.equal(refused.status, 400);
        assert.match(await refused.text(), /Set a password/);
      }
      assert.match(await (await post({ mode: 'network', bind: '203.0.113.7', owner_login: null })).text(), /this machine/);
      assert.match(await (await post({ mode: 'tailscale', bind: null, owner_login: 'someone@example.com' })).text(), /own Tailscale login/);
      const saved = await post({ mode: 'tailscale', bind: null, owner_login: 'owner@example.com' });
      assert.equal(saved.status, 200);
      assert.equal(((await saved.json()) as { restarting: boolean }).restarting, true);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(restarts, 1, 'saving restarts the server to apply the setting');
      assert.deepEqual(app.serverAccess.remoteAccess(), { mode: 'tailscale', bind: null, owner_login: 'owner@example.com' });
      const onDisk = JSON.parse(fs.readFileSync(path.join(appDataPath, 'server-access.json'), 'utf8')) as { remote: unknown };
      assert.deepEqual(onDisk.remote, { mode: 'tailscale', bind: null, owner_login: 'owner@example.com' });
      // Removing the password is refused while a network listener runs, even
      // after another mode is saved and before the restart applies it.
      const cookie = `patterm_session=${await app.serverAccess.setPassword('correct horse', null)}`;
      const removal = await fetch(`http://127.0.0.1:${port}/api/access/password`, {
        method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ current: 'correct horse', password: null })
      });
      assert.equal(removal.status, 400);
      assert.match(await removal.text(), /open to a network/);
      assert.equal(app.serverAccess.passwordSet(), true);
      app.serverAccess.setRemoteAccess({ mode: 'network', bind: '192.0.2.10', owner_login: null });
      await assert.rejects(app.serverAccess.setPassword(null, 'correct horse'), /needs a password/);
      // Another account on this machine reaching the network listener is
      // checked too: its connection comes from one of this machine's addresses.
      const assigned = Object.values(os.networkInterfaces()).flat().find((entry) => entry && !entry.internal && entry.family === 'IPv4')?.address;
      if (assigned && process.getuid) {
        const networkPort = await freePort();
        const lookups: string[] = [];
        const network = new WebServer(app, {
          port: networkPort, publicOrigin: `http://${assigned}:${networkPort}`, rendererPath: temp, appDataPath, listen: [assigned],
          loopbackPeerUid: (ends) => { lookups.push(ends.clientAddress); return 4242; }
        });
        await network.start();
        try {
          await assert.rejects(fetch(`http://${assigned}:${networkPort}/health`), 'a local client of the network listener is refused');
          assert.ok(lookups.some((address) => address.endsWith(assigned)), 'its owner was looked up');
        } finally {
          await network.stop();
        }
      }
    } finally {
      await server.stop();
      await app.dispose();
    }
    console.log('remote access smoke passed');
  } finally {
    removeTree(temp);
  }
}

void main().catch((error) => { console.error(error); process.exit(1); });
