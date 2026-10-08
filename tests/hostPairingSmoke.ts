import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HostActions, PEER_PAIR_PATH } from '../app/Actions/HostActions';
import { DatabaseService } from '../app/Services/DatabaseService';
import { defaultHostName, HostService, PEER_PROTOCOL_VERSION } from '../app/Services/HostService';
import { PEER_LINK_PATH, PeerLinkService } from '../app/Services/PeerLinkService';
import { ProjectLinkActions } from '../app/Actions/ProjectLinkActions';
import { GitService } from '../app/Services/GitService';
import { normaliseGitRemote, ProjectLinkService } from '../app/Services/ProjectLinkService';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';

const ID = (digit: string) => `host_${digit.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`;

async function until(check: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A host as the server runs it: pairing and link routes on a loopback port.
async function serve(actions: HostActions, links: PeerLinkService): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    if (request.url !== PEER_PAIR_PATH || request.method !== 'POST') { response.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    try {
      const accepted = actions.acceptPairing(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(accepted));
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  // Upgraded sockets leave the HTTP server, so a restart destroys them here.
  const upgraded = new Set<import('node:stream').Duplex>();
  server.on('upgrade', (request, socket, head) => {
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
    if (request.url === PEER_LINK_PATH) links.handleUpgrade(request, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise((resolve) => {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patterm-hosts-'));
  const databases: DatabaseService[] = [];
  const cleanup: Array<() => Promise<void> | void> = [];
  const open = (name: string) => {
    const database = new DatabaseService(path.join(dir, name));
    database.initialize();
    databases.push(database);
    return database;
  };
  try {
    assert.equal(defaultHostName('Workstation.tail123.ts.net'), 'workstation');
    assert.equal(defaultHostName('My_Laptop'), 'my-laptop');
    assert.equal(defaultHostName('---'), 'host');
    for (const remote of ['git@github.com:Org/Repo.git', 'ssh://git@github.com/Org/Repo', 'https://github.com/org/repo.git', 'https://user@github.com/Org/Repo/']) {
      assert.equal(normaliseGitRemote(remote), 'github.com/org/repo', remote);
    }
    assert.equal(normaliseGitRemote('ssh://git@git.example.com:2222/me/app.git'), 'git.example.com:2222/me/app');
    assert.equal(normaliseGitRemote(''), null);
    assert.equal(normaliseGitRemote('not a url'), null);

    // Codes, credentials, and names, without a network.
    let clock = Date.parse('2026-10-03T12:00:00.000Z');
    const server = new HostService(open('codes-server'), () => clock);
    const desktop = new HostService(open('codes-desktop'), () => clock);
    const first = server.identity();
    assert.match(first.host_id, /^host_[0-9a-f-]{36}$/);
    assert.deepEqual(server.identity(), first);
    assert.equal(server.rename(' Workstation ').name, 'workstation');
    assert.equal(server.identity().host_id, first.host_id);
    assert.throws(() => server.rename('dev:box'), /lowercase letters, digits, and hyphens/);
    assert.throws(() => server.rename('-dev'), /lowercase letters/);
    desktop.rename('desktop');

    assert.throws(() => server.redeemPairingCode('ABCD-EFGH', desktop.identity()), /No pairing code is active/);
    const { code, expires_at } = server.createPairingCode();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(expires_at, new Date(clock + 10 * 60_000).toISOString());
    const issued = server.redeemPairingCode(code.toLowerCase().replace('-', ' '), desktop.identity());
    assert.match(issued.credential, /^ptp_/);
    assert.throws(() => server.redeemPairingCode(code, desktop.identity()), /No pairing code is active/);
    assert.equal(server.verifyCredential(issued.credential)?.host_id, desktop.identity().host_id);
    assert.equal(server.verifyCredential('ptp_wrong'), null);
    assert.equal(server.verifyCredential('not-a-credential'), null);
    const stored = databases[0]!.connection.prepare('select token_hash from peer_grants').all() as Array<{ token_hash: string }>;
    assert.ok(stored.every((row) => !row.token_hash.includes(issued.credential.slice(4))), 'only a hash is stored');
    // The paired host appears as an inbound peer, shown by default.
    assert.deepEqual(server.peers().map((peer) => [peer.name, peer.direction, peer.show_agents]), [['desktop', 'inbound', true]]);

    const guarded = server.createPairingCode().code;
    for (let attempt = 0; attempt < 5; attempt++) assert.throws(() => server.redeemPairingCode('ZZZZ-ZZZZ', desktop.identity()), /incorrect/);
    assert.throws(() => server.redeemPairingCode(guarded, desktop.identity()), /No pairing code is active/, 'five wrong guesses discard the code');
    const expiring = server.createPairingCode().code;
    clock += 10 * 60_000;
    assert.throws(() => server.redeemPairingCode(expiring, desktop.identity()), /No pairing code is active/, 'codes expire');
    assert.throws(() => server.redeemPairingCode(server.createPairingCode().code, server.identity()), /cannot pair with itself/);
    const again = server.redeemPairingCode(server.createPairingCode().code, desktop.identity());
    assert.equal(server.verifyCredential(issued.credential), null, 'pairing again replaces the credential');
    assert.ok(server.verifyCredential(again.credential));
    assert.equal(server.peers().length, 1);
    assert.equal(server.setShowAgents(desktop.identity().host_id, false), true);
    assert.equal(server.peer(desktop.identity().host_id)?.show_agents, false);
    assert.equal(server.removePeer(desktop.identity().host_id), true);
    assert.equal(server.verifyCredential(again.credential), null);
    assert.deepEqual(server.peers(), []);
    // A server other tailnet users could reach does not pair or link until it
    // knows its owner.
    const blockedReason = 'Pairing is off because this server accepts any tailnet user.';
    const blockedHosts = new HostService(open('blocked'));
    let blockedNow: string | null = blockedReason;
    let passwordSet = false;
    const blockedLinks = new PeerLinkService(blockedHosts, { blocked: () => blockedNow });
    const blocked = new HostActions(blockedHosts, blockedLinks, { acceptsPairing: true, pairingBlocked: () => blockedNow, passwordSet: () => passwordSet });
    assert.equal(blocked.overview().pairing_blocked, blockedReason);
    assert.equal(blocked.overview().accepts_pairing, false);
    assert.throws(() => blocked.createPairingCode(), /accepts any tailnet user/);
    await assert.rejects(blocked.pair({ url: 'https://workstation.example.ts.net', code: 'ABCD-EFGH' }), /accepts any tailnet user/);
    assert.throws(() => blocked.acceptPairing({ protocol_version: PEER_PROTOCOL_VERSION, code: 'ABCD-EFGH', host_id: ID('4'), name: 'other' }), /not accepting pairing/);
    blockedHosts.savePairedHost({ host_id: ID('5'), name: 'stale', url: 'https://127.0.0.1:9', credential: 'ptp_x' });
    blockedLinks.start();
    assert.deepEqual(Object.values(blockedLinks.statuses()).map((status) => status.state), ['offline'], 'a blocked host does not dial');
    // Setting a password lifts the block without a restart, and the Hosts
    // page warns that pairing does not use it.
    blockedNow = null;
    passwordSet = true;
    assert.equal(blocked.overview().accepts_pairing, true);
    assert.equal(blocked.overview().password_set, true);
    assert.ok(blocked.createPairingCode().code, 'a server with a password shows pairing codes');
    await blockedLinks.dispose();

    // Names must stay unique, because they prefix remote addresses.
    desktop.savePairedHost({ host_id: ID('1'), name: 'workstation', url: 'https://workstation.example.ts.net', credential: 'ptp_x' });
    assert.throws(() => desktop.rename('workstation'), /already called workstation/);
    assert.throws(() => desktop.savePairedHost({ host_id: ID('2'), name: 'workstation', url: 'https://other.example.ts.net', credential: 'ptp_x' }), /already called workstation/);
    assert.throws(() => desktop.savePairedHost({ host_id: ID('3'), name: 'desktop', url: 'https://other.example.ts.net', credential: 'ptp_x' }), /also called desktop/);
    assert.equal(desktop.updatePeerName(ID('1'), 'desktop'), false, 'a clashing rename keeps the old name');
    assert.equal(desktop.updatePeerName(ID('1'), 'workstation-2'), true);
    assert.equal(desktop.peer(ID('1'))?.name, 'workstation-2');

    // Two hosts over real HTTP and WebSockets: the desktop pairs to the dev
    // box with the code it shows, then the link carries requests both ways.
    const changes = { workstation: 0, desktop: 0 };
    let hostCount = 0;
    const host = (name: 'workstation' | 'desktop', acceptsPairing: boolean) => {
      const database = open(`link-${name}-${++hostCount}`);
      const hosts = new HostService(database);
      hosts.rename(name);
      const links = new PeerLinkService(hosts, { onChange: () => { changes[name]++; }, backoffMs: [50], heartbeatMs: 200 });
      const projectLinks = new ProjectLinkService(database, new GitService());
      const actions = new HostActions(hosts, links, { acceptsPairing, projectLinks: (hostId) => projectLinks.links(hostId) });
      const projects = new ProjectLinkActions(projectLinks, hosts, links);
      // Projects as each machine checks them out.
      const project = (id: string, label: string, remote: string | null) => {
        const directory = path.join(dir, `${name}-${hostCount}-${id}`);
        fs.mkdirSync(directory);
        if (remote) {
          execFileSync('git', ['init', '-q'], { cwd: directory });
          execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: directory });
        }
        const now = new Date().toISOString();
        database.connection.prepare('insert into projects(id, name, path, created_at, updated_at) values(?, ?, ?, ?, ?)').run(id, label, directory, now, now);
      };
      cleanup.push(() => links.dispose());
      links.start();
      return { hosts, links, actions, projects, project };
    };
    const workstation = host('workstation', true);
    const laptop = host('desktop', false);
    const workstationServer = await serve(workstation.actions, workstation.links);
    cleanup.push(workstationServer.close);

    assert.throws(() => laptop.actions.createPairingCode(), /Only a Patterm server can accept pairing/);
    await assert.rejects(laptop.actions.pair({ url: 'http://workstation.example.ts.net', code: 'x' }), /Use an https:\/\/ address/);
    await assert.rejects(laptop.actions.pair({ url: workstationServer.url, code: 'ABCD-EFGH' }), /No pairing code is active/);
    const shown = workstation.actions.createPairingCode();
    const sent: unknown[] = [];
    const recording = new HostActions(laptop.hosts, laptop.links, { acceptsPairing: false, fetch: async (input, init) => { sent.push(JSON.parse(String(init!.body))); return fetch(input, init); } });
    const paired = await recording.pair({ url: `${workstationServer.url}/settings`, code: shown.code });
    assert.deepEqual(sent, [{ protocol_version: PEER_PROTOCOL_VERSION, code: shown.code, host_id: laptop.hosts.identity().host_id, name: 'desktop' }]);
    assert.deepEqual(paired.peers.map((peer) => [peer.name, peer.direction, peer.url]), [['workstation', 'outbound', workstationServer.url]]);
    assert.equal('credential' in paired.peers[0]!, false, 'the overview never returns credentials');

    const workstationId = workstation.hosts.identity().host_id;
    const laptopId = laptop.hosts.identity().host_id;
    await until(() => laptop.links.connected(workstationId) && workstation.links.connected(laptopId), 'the link');
    assert.equal(laptop.actions.overview().peers[0]!.link.state, 'connected');
    assert.equal(workstation.actions.overview().peers[0]!.link.state, 'connected');
    assert.ok(changes.workstation > 0 && changes.desktop > 0, 'link changes are announced');
    assert.ok(laptop.hosts.peer(workstationId)?.last_connected_at);

    // Requests and events work in both directions.
    assert.equal((await laptop.links.request(workstationId, 'peer.ping') as { name: string }).name, 'workstation');
    assert.equal((await workstation.links.request(laptopId, 'peer.ping') as { name: string }).name, 'desktop');
    workstation.links.handle('test.echo', (params, peer) => ({ params, from: peer.name }));
    assert.deepEqual(await laptop.links.request(workstationId, 'test.echo', { value: 1 }), { params: { value: 1 }, from: 'desktop' });
    workstation.links.handle('test.fail', () => { throw new Error('nope'); });
    await assert.rejects(laptop.links.request(workstationId, 'test.fail'), /nope/);
    await assert.rejects(laptop.links.request(workstationId, 'test.missing'), /Unknown peer method: test.missing/);
    const events: unknown[] = [];
    laptop.links.onEvent((event) => events.push(event));
    assert.equal(workstation.links.emit(laptopId, 'test.event', { n: 1 }), true);
    await until(() => events.length === 1, 'an event');
    assert.deepEqual(events[0], { host_id: workstationId, event: 'test.event', payload: { n: 1 } });

    // Projects link by git remote, or by hand for plain directories, and
    // both hosts record the link.
    workstation.project('dev-app', 'Acme App', 'git@github.com:acme/web-app.git');
    workstation.project('dev-scratch', 'scratch', null);
    workstation.project('dev-other', 'Other', 'https://github.com/acme/other.git');
    laptop.project('desk-app', 'acme-app', 'https://github.com/Acme/Web-App');
    laptop.project('desk-scratch', 'Scratch', null);
    const listed = await laptop.projects.projects({ host_id: workstationId });
    assert.deepEqual(listed.remote.map((project) => [project.id, project.git_remote]), [['dev-app', 'github.com/acme/web-app'], ['dev-other', 'github.com/acme/other'], ['dev-scratch', null]]);
    assert.deepEqual(listed.suggestions, [{ project_id: 'desk-app', remote_project_id: 'dev-app' }]);
    await laptop.projects.link({ host_id: workstationId, project_id: 'desk-app', remote_project_id: 'dev-app' });
    await laptop.projects.link({ host_id: workstationId, project_id: 'desk-scratch', remote_project_id: 'dev-scratch' });
    assert.deepEqual(laptop.actions.overview().peers[0]!.projects.map((link) => [link.project_name, link.remote_project_name]), [['acme-app', 'Acme App'], ['Scratch', 'scratch']]);
    assert.deepEqual(workstation.actions.overview().peers[0]!.projects.map((link) => [link.project_id, link.remote_project_id]), [['dev-app', 'desk-app'], ['dev-scratch', 'desk-scratch']]);
    assert.deepEqual((await laptop.projects.projects({ host_id: workstationId })).suggestions, [], 'linked projects are not suggested');
    await assert.rejects(laptop.projects.link({ host_id: workstationId, project_id: 'desk-app', remote_project_id: 'dev-missing' }), /no longer exists on workstation/);
    await assert.rejects(laptop.projects.link({ host_id: workstationId, project_id: 'desk-scratch', remote_project_id: 'dev-app' }), /already linked to another project/);
    await workstation.projects.unlink({ host_id: laptopId, project_id: 'dev-scratch' });
    assert.deepEqual(laptop.actions.overview().peers[0]!.projects.map((link) => link.project_id), ['desk-app'], 'unlinking reaches the other host');

    // Renames reach the other host while connected.
    workstation.actions.rename({ name: 'workstation-renamed' });
    await until(() => laptop.hosts.peer(workstationId)?.name === 'workstation-renamed', 'the rename');

    // The heartbeat keeps a quiet link open, and a dropped link reconnects.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(laptop.links.connected(workstationId));
    await workstationServer.close();
    await until(() => !laptop.links.connected(workstationId), 'the link to drop');
    assert.equal(laptop.actions.overview().peers[0]!.link.state, 'connecting');
    await assert.rejects(laptop.links.request(workstationId, 'peer.ping'), /is not connected/);
    const restarted = await serve(workstation.actions, workstation.links);
    cleanup.push(restarted.close);
    laptop.hosts.savePairedHost({ host_id: workstationId, name: 'workstation-renamed', url: restarted.url, credential: laptop.hosts.dialTarget(workstationId)!.credential });
    // Each side counts the link once it has the other's hello, so wait for both.
    await until(() => laptop.links.connected(workstationId) && workstation.links.connected(laptopId), 'the reconnect');
    // A stopping server ends links other hosts opened, or it cannot close.
    let reconnects = 0;
    const stopCounting = laptop.links.onConnected(() => { reconnects++; });
    workstation.links.closeInbound();
    await until(() => reconnects > 0 && laptop.links.connected(workstationId) && workstation.links.connected(laptopId), 'the reconnect after closing inbound links');
    stopCounting();

    // A socket another host opened is closed on shutdown even before its
    // hello, or the server could not stop.
    const silent = new WebSocket(`${restarted.url.replace('http', 'ws')}${PEER_LINK_PATH}`, { headers: { Authorization: `Bearer ${laptop.hosts.dialTarget(workstationId)!.credential}` } });
    silent.on('message', () => undefined);
    await new Promise((resolve, reject) => { silent.once('open', resolve); silent.once('error', reject); });
    const silentClosed = new Promise((resolve) => silent.once('close', resolve));
    workstation.links.closeInbound();
    // Well before the ten-second hello timeout would close it anyway.
    await Promise.race([silentClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('closeInbound left a socket that had not said hello')), 2000))]);
    await until(() => laptop.links.connected(workstationId) && workstation.links.connected(laptopId), 'the reconnect after closing every inbound socket');

    // Hiding a host's agents is a local choice.
    assert.equal(workstation.actions.setShowAgents({ host_id: laptopId, show_agents: false }).peers[0]!.show_agents, false);
    assert.equal(laptop.hosts.peer(workstationId)?.show_agents, true);

    // Unpairing on one host unpairs both while they are connected, and
    // drops their project links.
    workstation.actions.unpair({ host_id: laptopId });
    await until(() => laptop.hosts.peers().length === 0, 'the unpair to reach the desktop');
    assert.deepEqual(workstation.hosts.peers(), []);
    assert.equal(databases.every((database) => (database.connection.prepare('select count(*) as n from project_links').get() as { n: number }).n === 0), true);
    await until(() => !laptop.links.connected(workstationId) && !workstation.links.connected(laptopId), 'the link to close');

    // A credential revoked while the other host was away is refused.
    const code2 = workstation.actions.createPairingCode().code;
    await laptop.actions.pair({ url: restarted.url, code: code2 });
    await until(() => laptop.links.connected(workstationId) && workstation.links.connected(laptopId), 'the new link');
    await laptop.links.dispose();
    workstation.hosts.removePeer(laptopId);
    const offline = new PeerLinkService(laptop.hosts, { backoffMs: [50] });
    cleanup.push(() => offline.dispose());
    offline.start();
    await until(() => /no longer accepts this host/.test(offline.statuses()[workstationId]?.error ?? ''), 'the refusal');
    assert.match(laptop.hosts.peer(workstationId)?.last_error ?? '', /no longer accepts this host/);
    await offline.dispose();

    // When both hosts dial each other, they settle on one link.
    const left = host('desktop', true);
    const right = host('workstation', true);
    const leftServer = await serve(left.actions, left.links);
    const rightServer = await serve(right.actions, right.links);
    cleanup.push(leftServer.close, rightServer.close);
    await left.actions.pair({ url: rightServer.url, code: right.actions.createPairingCode().code });
    await right.actions.pair({ url: leftServer.url, code: left.actions.createPairingCode().code });
    const leftId = left.hosts.identity().host_id;
    const rightId = right.hosts.identity().host_id;
    await until(() => left.links.connected(rightId) && right.links.connected(leftId), 'the mutual link');
    let flaps = 0;
    const stop = [left.links.onEvent(() => undefined)];
    const before = { left: changes.desktop, right: changes.workstation };
    await new Promise((resolve) => setTimeout(resolve, 600));
    flaps = (changes.desktop - before.left) + (changes.workstation - before.right);
    stop.forEach((off) => off());
    assert.ok(left.links.connected(rightId) && right.links.connected(leftId));
    assert.ok(flaps <= 2, `the mutual link settles (${flaps} changes)`);
    assert.equal((await left.links.request(rightId, 'peer.ping') as { name: string }).name, 'workstation');
    console.log('host pairing smoke passed');
  } finally {
    for (const close of cleanup.reverse()) await close();
    for (const database of databases) database.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const deadline = setTimeout(() => { console.error('host pairing smoke timed out'); process.exit(1); }, 60_000);
void main().then(() => clearTimeout(deadline)).catch((error) => { console.error(error); process.exit(1); });
